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
at 649 lines. Both are large, multi-responsibility modules that mix several
unrelated concerns, which is exactly the friction the roadmap flags: every
gameplay or UI change has to touch a
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
| 960–1003 | local `addTestHooks(...)` shim — **DEAD/incomplete duplicate**: never called by bare name (all live sites call `Snowman.addTestHooks` at 606/1005/1203); installs only `forceTreeCollision` + an "Other test hooks…" placeholder | **delete — do not extract** |
| 1004–1133 | `initializeControlsToggle()` | `src/ui/collapsible-panel.ts` |
| 1134–1153 | `updateTimerDisplay()` | `src/ui/hud.ts` |
| 1154–1303 | `window.initializeGameWithAudio` boot hook | stays in `snowglider.ts` (coordinator) |
| 1304–1357 | `publishGameGlobals()` — `Object.defineProperty` proxies for ~21 test/runtime globals | stays in `snowglider.ts` (coordinator) |
| 1358–end | test-mode auto-start | stays in `snowglider.ts` (coordinator) |

### Target layout

```
src/
  snowglider.ts            # thin coordinator: wires the pieces, owns the boot hook,
                           # publishGameGlobals(), isTestMode flag + test-mode auto-start,
                           # and the eager Snowman.addTestHooks(...) wiring calls
  game/
    scene-setup.ts         # scene, renderer, lights, terrain, trees, snowman,
                           # snow particles, avalanche, course/effects construction
    main-loop.ts           # animate() ordering, updateSnowman/updateCamera, resize
    lifecycle.ts           # reset, restart, game-active transitions, camera toggle
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
  `window.isTestMode`

(`window.testHooks` and `window.testCollisionDetected` are **not** eager snowglider
globals — they are installed/set by `Snowman.addTestHooks` and its hook callbacks,
so they are preserved by R3 step 12, not by anything R2 extracts. The dead local
`addTestHooks` shim that also touched them is deleted in step 6.)

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
| 327–605 | `updateSnowman()` **physics** — gravity, friction, jump/air control, ski technique, snowplow braking, skid/carve, idle turning, apply-velocity, store terrain height | `src/snowman/physics.ts` |
| 606–690 | `updateSnowman()` **pose** — heading smoothing, terrain tilt, jump tilt, turn lean, ski-wedge | `src/snowman/pose.ts` |
| 691–838 | `updateSnowman()` **gameplay collision + finish** — off-terrain/fall, tree collision, rock collision, boundary check, crash/finish **reason strings**, and the in-loop `showGameOver(reason)` call | `src/snowman/collision.ts` |
| 839–855 | `updateSnowman()` return of updated state (`UpdateResult`) | `src/snowman/physics.ts` (it is the step's return) |
| 857–1014 | `addTestHooks()` — **browser test hooks only** (`window.testHooks.forceTreeCollision` / `checkTreeCollision` / `checkExtendedTerrainCollision`); duplicate test-only collision shims, **not** the live gameplay checks above | `src/snowman/test-hooks.ts` |
| 1015–1023 | `Snowman` export object | `src/snowman/index.ts` (re-export) |

`updateSnowman` is ~530 lines and is the crux. It runs **three** blocks in order,
each marked by comments:

1. **Physics integration** (up to *"Update snowman position and rotation"*, ~327–605)
   produces the new `pos`/`velocity`/air state → `physics.ts`.
2. **Pose** (*"Update snowman position and rotation"* through the jump-lean, ~606–690)
   reads the post-physics state and writes only to the `THREE.Object3D`; it does not
   feed back into physics, so it can move to `pose.ts` as a pure
   `applyPose(snowman, state)` call → `pose.ts`.
3. **Gameplay collision + finish detection** (*"Check if snowman is off the terrain
   or falling"* through the reason block, ~691–838) is the *real* tree/rock/boundary/
   end-of-slope logic — it builds the reason string and calls `showGameOver(reason)`
   in the loop → `collision.ts`.

Block 3 is the part the earlier draft mis-routed: it is **not** in `addTestHooks`.
`addTestHooks` (857–1014) only installs duplicate test-only collision shims on
`window.testHooks`. So `collision.ts` must take the in-loop block from
`updateSnowman` (otherwise crashes and course completion break), and `test-hooks.ts`
takes `addTestHooks`. Because the collision check is part of the per-frame step,
`collision.ts` exports something the step calls each frame (e.g.
`detectCollisionsAndFinish(snowman, pos, isInAir, verticalVelocity,
terrainHeightAtPosition, treePositions, rockPositions, gameActive, showGameOver)`),
not a teardown hook. Two seam inputs are **load-bearing**, not conveniences:

- **Air state** (`isInAir`, `verticalVelocity`): the block gates hazard clearance on
  it — a high jump over a tree is `isInAir && verticalVelocity > 0 && pos.y > treeTop+5`
  (snowman.ts:751–780), rock clearance is `isInAir && pos.y > rockTop+0.5`, and the
  fall check is `!isInAir && pos.y < terrain - fallThreshold`. Omitting it would treat
  valid jumps over hazards as crashes.
- **The pre-step terrain sample** (`terrainHeightAtPosition`): `updateSnowman` samples
  it once at snowman.ts:345 using the **pre-step** `pos.x/pos.z`, then advances `pos`
  by velocity (snowman.ts:598–600), and the fall / off-terrain checks at 815 and 831
  reuse that **same pre-step value** — they do *not* resample at the advanced position.
  So pass the sampled height through (or a small collision-state object carrying it);
  do **not** hand the block only `getTerrainHeight` and resample with the post-step
  `pos`, which would shift fall/off-terrain outcomes on steep terrain and break the
  "mechanical" guarantee.

Keep the `showGameOver` wiring and every reason string byte-identical (see Contracts
below).

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
    collision.ts      # IN-LOOP tree/rock/boundary/finish detection + reason strings
                      # + showGameOver call (extracted from updateSnowman, ~691-838)
    test-hooks.ts     # browser TEST hooks only (window.testHooks), from addTestHooks
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
- The finish reason string **`"You reached the end of the slope!"`** (produced by
  the in-loop collision block in `snowman.ts` at line 828, moving to `collision.ts`;
  `snowglider.ts` keys three branches off it). Do not re-word, re-case, or re-derive
  it. The full reason set — `"BANG!!! You hit a tree!"`, `"BANG!!! You hit a rock!"`,
  `"You went off the mountain!"`, `"You fell off the terrain!"`, `"You crashed!"` —
  and the `showGameOver(reason)` call must move with that block intact.
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
6. `src/game/lifecycle.ts` — reset/restart/toggle. **Delete the dead local
   `addTestHooks` shim (960–1003)** rather than extracting it — it is never called
   and is a stale, incomplete duplicate of `Snowman.addTestHooks`. The real browser
   tree/regression hooks (`checkTreeCollision`, `checkExtendedTerrainCollision`, …)
   come from `Snowman.addTestHooks`, whose *implementation* moves later in R3 step 12
   (`src/snowman/test-hooks.ts`); the coordinator just keeps calling it. `publishGameGlobals()`,
   the `isTestMode` flag, and the test-mode auto-start stay in the coordinator (they
   proxy the coordinator's own bindings). `snowglider.ts` is now a thin coordinator.

**R3 (snowman) — only after R2 lands:**

7. **Relocate the implementation behind the facade — do not scaffold an empty one.**
   `src/snowman.ts` is currently the *only* module that defines `Snowman` and the
   exported types, so flipping it to `export * from './snowman/index.js';` before any
   code moves would leave nothing to re-export and break every `./snowman.js` import.
   Instead, in one PR `git mv src/snowman.ts src/snowman/index.ts` (the whole
   implementation moves wholesale — `Snowman` + types land in `index.ts`), then add a
   thin new `src/snowman.ts` that re-exports it. Nothing is *decomposed* yet
   (`model`/`physics`/`pose`/`collision` still live inside `index.ts`); steps 8–12
   carve pieces out of `index.ts` into siblings afterward. This PR's only job is to
   prove the import seam is invisible, so the full suite must stay green first.

   **Two resolution gotchas this PR must handle (both verified in the tree):**
   - `tests/verification/physics_invariant_harness.js:100` imports the live module
     **directly** as `import('../../src/snowman.ts')` and reads `.Snowman.updateSnowman`.
     The new `src/snowman.ts` facade keeps that path valid only if it actually
     re-exports `Snowman` — confirm with `npm run test:verify`.
   - `npm run test:verify` runs under bare Node with **no `.js`→`.ts` resolve hook**
     (that is why the harness uses an explicit `.ts` specifier). A facade body of
     `export * from './snowman/index.js'` would try to resolve a non-existent
     `index.js`. So either give `test:verify` the same resolve hook the other suites
     use, or repoint the harness import to the relocated implementation
     (`src/snowman/index.ts`). Pick one in this PR and note it in `package.json`/docs.
8. `src/snowman/model.ts` — `createSnowman()` (no physics touched).
9. `src/snowman/pose.ts` — pull the pose block (~606–690) out of `updateSnowman()`
   as `applyPose(...)`; physics integration stays put. **Verify byte-identical.**
10. `src/snowman/physics.ts` (or `step.ts`) — the integration block (~327–605) +
    the step return + `resetSnowman`.
11. `src/snowman/collision.ts` — extract the **in-loop** gameplay collision/finish
    block (~691–838) from `updateSnowman` as a per-frame `detectCollisionsAndFinish(...)`
    call. Highest-risk gameplay move: it owns crash + course-completion behavior and
    the `showGameOver` reason strings, so gate it on the puppeteer crash/finish tests,
    not just the physics-invariant harness.
12. `src/snowman/test-hooks.ts` — extract `addTestHooks` (browser `window.testHooks`
    shims only).

Each snowman PR keeps the **ESM `Snowman` named export from `./snowman.js`** as the
stable surface (`Snowman.createSnowman` / `resetSnowman` / `updateSnowman` /
`addTestHooks`); internals delegate to the new modules without changing signatures.
There is **no** `window.Snowman` to preserve — the ESM app exposes no such global
(it exists only in the frozen `tests/verification/snowman_baseline.js` snapshot), and
re-adding one would violate the project's no-per-module-`window`-bridge rule. (The
live `window.testHooks` shims from `addTestHooks` are the only window surface here,
and they stay.)

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
