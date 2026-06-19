# Refactoring Proposal — `snowglider.ts` and `snowman.ts`

> **Status:** proposal. This document *operationalizes* the existing
> [Refactoring Roadmap](ROADMAP.md#refactoring-roadmap) (Stage R2 — thin the
> orchestrator, issue **#34**; Stage R3 — split the snowman, part of the
> `snowman.ts` cleanup) by mapping today's source line-ranges to concrete target
> modules and a mergeable PR sequence. It does **not** propose new behavior, new
> physics, a framework rewrite, or new dependencies. The roadmap's stage names,
> guardrails, and tracking issues remain authoritative; this is the implementation
> detail under them.

## Why these two files

`src/snowglider.ts` (1373 lines) and `src/snowman.ts` (1023 lines) are by a wide
margin the two largest modules in the tree — the next largest is `src/scores.ts`
at 649 lines. Both are "god modules" that mix several unrelated concerns, which is
exactly the friction the roadmap flags: every gameplay or UI change has to touch a
1000+ line file, and the physics math is buried in the same file as DOM and test
plumbing.

```
1373  src/snowglider.ts   <-- Stage R2 target
1023  src/snowman.ts      <-- Stage R3 target
 655  src/course.ts
 649  src/scores.ts
 568  src/auth.ts
 ...
```

The prior infrastructure work already did the *state* slice of R2: the typed
`GameState` (#118/#119/#121) and the player-physics state container in
`src/physics.ts` (#120). The *scene / loop / UI* extraction (R2) and the
`snowman/` split (R3) are still open. No `src/game/` directory exists yet and
`src/ui/` currently holds only `start-menu.ts`.

---

## Part A — `snowglider.ts` (Stage R2, issue #34)

### Current anatomy (by line range)

| Lines | Concern | Moves to |
|------:|---------|----------|
| 45–131 | Scene, renderer, camera manager, game-over overlay DOM | `src/game/scene-setup.ts` |
| 132–143 | Audio early-init | `src/game/scene-setup.ts` |
| 144–213 | `GameState` literal, avalanche construction, trigger constants | `src/game/scene-setup.ts` |
| 214–252 | `addTreesWithPositions()` + tree/rock/test `window.*` globals | `src/game/scene-setup.ts` |
| 254–283 | Snowman, snow splash, course + effects init | `src/game/scene-setup.ts` |
| 285–297 | Player physics state (`Physics.createPlayerState`) | stays (already `src/physics.ts`) |
| 299–327 | `isValidScoreTime()`, `readStoredBestTime()` | `src/ui/result-overlay.ts` |
| 329–419 | `initializeGameStats()` + best-time display DOM | `src/ui/hud.ts` |
| 420–457 | `resetSnowman()` + `window.resetSnowman` | `src/game/lifecycle.ts` |
| 458–488 | Controls init + camera-toggle button | `src/game/lifecycle.ts` |
| 489–586 | `updateSnowman(delta)`, `updateCamera()` | `src/game/main-loop.ts` |
| 587–687 | `animate(time)` + resize handler | `src/game/main-loop.ts` |
| 688–710 | `getSignedInUser()`, `removeLoginPrompt()` | `src/ui/result-overlay.ts` |
| 711–875 | `showGameOver(reason)` | `src/ui/result-overlay.ts` |
| 876–926 | `restartGame()` + `window.restartGame` | `src/game/lifecycle.ts` |
| 927–959 | `toggleCameraView()` + `window.toggleCameraView` | `src/game/lifecycle.ts` |
| 960–1003 | `addTestHooks(...)` | `src/game/test-hooks.ts` |
| 1004–1133 | `initializeControlsToggle()` | `src/ui/collapsible-panel.ts` |
| 1134–1153 | `updateTimerDisplay()` | `src/ui/hud.ts` |
| 1154–1303 | `window.initializeGameWithAudio` boot hook | stays in `snowglider.ts` (coordinator) |
| 1304–1357 | `publishGameGlobals()` — `Object.defineProperty` proxies for ~21 test/runtime globals | stays in `snowglider.ts` (coordinator) |
| 1358–end | test-mode auto-start | stays in `snowglider.ts` (coordinator) |

### Target layout

```
src/
  snowglider.ts            # thin coordinator: wires the pieces, owns the boot hook
  game/
    scene-setup.ts         # scene, renderer, lights, terrain, trees, snowman,
                           # snow particles, avalanche, course/effects construction
    main-loop.ts           # animate() ordering, updateSnowman/updateCamera, resize
    lifecycle.ts           # reset, restart, game-active transitions, camera toggle
    test-hooks.ts          # window.testHooks / collision flags for browser tests
  ui/
    hud.ts                 # stats panel, timer, speed color, position, technique
    result-overlay.ts      # game-over/finish overlay, best-time, login prompt,
                           # leaderboard insertion, CourseModule.onFinish(...)
    collapsible-panel.ts   # shared Game Stats / Game Controls collapse+swipe
    start-menu.ts          # (exists)
```

The `collapsible-panel.ts` extraction is worth its own note: `initializeGameStats`
(329) and `initializeControlsToggle` (1004) implement *two copies* of the same
collapse / resize / horizontal-swipe behavior. Unifying them removes real
duplication, not just lines.

### Contracts to preserve (R2)

`controls.ts` and the browser test suites (camera / regression / tree / avalanche /
gameplay) still drive the live game by bare name — both **reading and reassigning**
several of these — so the *entire* published surface must survive the split, not
just the function hooks. There are two groups; both must be preserved.

**1. Eagerly assigned globals** (plain `window.x = …` near where each is created):

- Functions: `window.resetSnowman`, `window.restartGame`, `window.showGameOver`,
  `window.toggleCameraView`, `window.initializeGameWithAudio`
- Data/flags: `window.terrainMesh`, `window.treePositions`, `window.rockPositions`,
  `window.isTestMode`, `window.testHooks`, `window.testCollisionDetected`

**2. The `publishGameGlobals()` proxy set** (lines 1304–1357 — `Object.defineProperty`
getters/setters that bridge module-local bindings to `window`). The suites read
*and reassign* the scalars by bare name (e.g. `gameActive = true`,
`verticalVelocity = 0`, `jumpCooldown = 0`) and mutate the shared objects in place
(`pos.x = …`, `avalanche.trigger(...)`), so dropping any of these breaks the
deployed browser/unified tests even though the *function* surface looks unchanged:

- **Read/write proxied scalars** (test reassignments must flow back to live state):
  `gameActive`, `isInAir`, `verticalVelocity`, `jumpCooldown`, `bestTime`,
  `startTime`, `avalancheTriggered`, `lastAvalancheZ`
- **Get-only object/function refs** (read or mutated by identity, never reassigned):
  `scene`, `camera`, `cameraManager`, `snowman`, `velocity`, `pos`, `avalanche`,
  `snowSplash`, `terrain`, `getTerrainHeight`, `getControls`, `updateCamera`,
  `updateSnowman`

Because these proxies bridge bindings owned by the *extracted* modules (e.g. `pos`/
`velocity` from `src/physics.ts`, `updateCamera`/`updateSnowman` from
`src/game/main-loop.ts`, `state.*` from `GameState`), **`publishGameGlobals()` must
stay in the coordinator** and import/receive those bindings rather than be split
apart. Extracted modules should accept their dependencies as parameters and let the
coordinator re-publish every name above, so the public surface stays byte-identical.
Treat this proxy block — not this prose — as the authoritative list, and re-grep
`publishGameGlobals()` before each PR in case it has grown.

---

## Part B — `snowman.ts` (Stage R3)

This is the higher-risk file: it owns the physics kernel and the deterministic
verification seam. `tests/verification/snowman_baseline.js` is a frozen copy of
the original module and the physics-invariant harness compares against it, so the
no-input physics path must stay **byte-identical** through the split.

### Current anatomy (by line range)

| Lines | Concern | Moves to |
|------:|---------|----------|
| 25–99 | Shared interfaces/types (`PlayerPos`, `UpdateResult`, …) | `src/snowman/types.ts` |
| 100–290 | `createSnowman()` — spheres, eyes, nose, buttons, stick arms, hat, skis | `src/snowman/model.ts` |
| 291–326 | `resetSnowman()` | `src/snowman/physics.ts` |
| 327–856 | `updateSnowman()` — gravity, friction, jump/air control, ski technique, snowplow braking, skid/carve, idle turning **(physics)** + heading, terrain tilt, jump tilt, turn lean, ski-wedge pose **(pose)** | split: `src/snowman/physics.ts` + `src/snowman/pose.ts` |
| 857–1014 | `addTestHooks()` — tree collision, boundary, finish detection, crash/finish reason strings, browser hooks | `src/snowman/collision.ts` + `src/snowman/test-hooks.ts` |
| 1015–1023 | `Snowman` export object | `src/snowman/index.ts` (re-export) |

`updateSnowman` is ~530 lines and is the crux. It has a clean internal seam
already marked by comments: everything up to *"Update snowman position and
rotation"* is the physics integration that produces the new `pos`/`velocity`/air
state; everything after is **pose** (heading smoothing, terrain/jump tilt, turn
lean, ski-wedge). The pose section reads the post-physics state and writes only to
the `THREE.Object3D` — it does not feed back into physics — so it can move to
`pose.ts` as a pure `applyPose(snowman, state)` call at the end of the step.

### Target layout

```
src/
  snowman.ts          # ROOT FACADE — re-exports { Snowman } (+ types) from ./snowman/index.js
                      # so existing `./snowman.js` / `../src/snowman.js` importers keep resolving
  snowman/
    index.ts          # export const Snowman = { createSnowman, resetSnowman,
                      #   updateSnowman, addTestHooks } — public surface unchanged
    types.ts          # PlayerPos, PlanarVelocity, UpdateResult, *Fn types, ...
    model.ts          # createSnowman() geometry/materials/arms/hat/skis
    physics.ts        # resetSnowman() + the integration half of updateSnowman()
    pose.ts           # heading/tilt/lean/ski-wedge animation
    collision.ts      # tree/boundary/finish detection + reason strings
    test-hooks.ts     # browser collision hooks (window.testHooks)
```

**Keep a root `src/snowman.ts` facade.** The live importers — `src/main.ts`
(side-effect import `import './snowman.js';` that keeps the module in the bundle
graph), `src/snowglider.ts` (`import { Snowman } from './snowman.js'`),
`src/physics.ts` (which also imports the *types*: `PlayerPos`, `UpdateResult`, …),
and `tests/browser-tests.js` (`'../src/snowman.js'`) — use specifiers that resolve
to a **sibling file**, not a directory index. A bare `src/snowman/index.ts` would *not* satisfy `./snowman.js`
(no directory-index resolution here), so the scaffold would fail module resolution.
The mechanical fix is a thin `src/snowman.ts` that does
`export * from './snowman/index.js';` (re-exporting `Snowman` **and** the types
`physics.ts` consumes). A later cleanup PR may instead repoint the three importers
to `./snowman/index.js` and delete the facade — but that is an import change, not
"no change," so do it deliberately. `tests/verification/snowman_baseline.js` is a
frozen standalone copy and is unaffected either way.

Note `src/physics.ts` (the per-frame *state container*, #120) is a different file
and stays where it is; `src/snowman/physics.ts` is the *math kernel*. Keeping the
names distinct in this doc avoids confusion — consider naming the kernel file
`src/snowman/step.ts` if the duplicate `physics.ts` basename proves confusing in
review.

### Contracts to preserve (R3)

- `Snowman.createSnowman`, `Snowman.resetSnowman`, `Snowman.updateSnowman`,
  `Snowman.addTestHooks` — same names, same signatures. `src/main.ts` (side-effect
  import), `snowglider.ts`, `src/physics.ts`, and `tests/browser-tests.js` import
  `./snowman.js` / `../src/snowman.js` (the object, and `physics.ts` also the types). Those
  specifiers resolve to a **sibling file**, so a root `src/snowman.ts` facade
  re-exporting from `src/snowman/index.ts` (see Target layout above) must remain
  until the importers are deliberately repointed — `src/snowman/index.ts` alone
  does **not** satisfy `./snowman.js`.
- The finish reason string **`"You reached the end of the slope!"`** (snowman.ts
  produces it at line 782; snowglider.ts keys three branches off it). Do not
  re-word, re-case, or re-derive it.
- No change to the no-input physics path. The physics-invariant harness and the
  `snowman_baseline.js` baseline are the contract; coasting must stay
  byte-identical.

---

## Suggested PR sequence

Small, independently reviewable, behavior-preserving. Each PR re-runs the full
suite (below) and updates `docs/ARCHITECTURE.md` in the same PR.

**R2 (snowglider) — do first, it is lower-risk than touching physics:**

1. `src/ui/collapsible-panel.ts` — unify the two collapse/swipe copies. Pure
   move + dedupe; good first PR because it deletes real duplication.
2. `src/ui/hud.ts` — stats panel + timer + speed/position/technique display.
3. `src/ui/result-overlay.ts` — game-over/finish overlay, best-time, login
   prompt, leaderboard, `onFinish`. (Carries the score-validation helpers.)
4. `src/game/scene-setup.ts` — construction of scene/objects/systems.
5. `src/game/main-loop.ts` — `animate()` + per-frame update helpers.
6. `src/game/lifecycle.ts` + `src/game/test-hooks.ts` — reset/restart/toggle and
   the test globals. `snowglider.ts` is now a thin coordinator.

**R3 (snowman) — only after R2 lands:**

7. `src/snowman/types.ts` + `src/snowman/index.ts` scaffold, **and convert
   `src/snowman.ts` into a `export * from './snowman/index.js';` facade** (re-export
   only; no logic moves yet). This first PR proves the import seam is invisible —
   `./snowman.js` must keep resolving and the full suite must stay green before any
   logic moves in steps 8–11.
8. `src/snowman/model.ts` — `createSnowman()` (no physics touched).
9. `src/snowman/pose.ts` — pull the pose half out of `updateSnowman()` as
   `applyPose(...)`; physics integration stays put. **Verify byte-identical.**
10. `src/snowman/physics.ts` (or `step.ts`) — the integration half + `resetSnowman`.
11. `src/snowman/collision.ts` + `src/snowman/test-hooks.ts`.

Each snowman PR keeps `Snowman.*` and `window.Snowman.*` as the stable surface;
internals delegate to the new modules without changing signatures.

## Verification (run after every PR)

```bash
npm run lint
npm test                 # Node suites
npm run test:verify      # physics-invariant + DOM smoke (the R3 safety net)
npm run test:browser     # puppeteer (51/51 expected; see memory note)
npm run build            # Vite production build must stay green
```

For the R3 physics PRs specifically, the pass/fail bar is the physics-invariant
harness staying green against `snowman_baseline.js`. If any no-input path changes,
that is a real regression — not a baseline to update — unless the change is
deliberate and documented in `docs/PHYSICS.md`.

## Non-goals / guardrails

- No physics-constant, timing, scoring, or UI-behavior changes. Mechanical moves
  only.
- No framework migration (React Three Fiber #36, rapier #38, Needle #41 stay
  exploratory).
- Preserve the Vite/GitHub Pages deploy path and the Local Mode boot fallback
  (`src/boot/local-auth.js`, `src/boot/firebase-bootstrap.js` stay classic scripts).
- Keep every `window.*` test/runtime hook until its callers are migrated.
