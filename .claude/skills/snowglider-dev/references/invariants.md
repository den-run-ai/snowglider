# SnowGlider — The Hard Invariants (with WHY and concrete evidence)

Each invariant below states the rule, *why* it exists (the failure it prevents), and the concrete
guard/API and commit/issue evidence. These are the load-bearing walls; changes that ignore them
have repeatedly caused regressions.

---

## 1. No-input coasting physics is byte-for-byte identical to the frozen baseline

**Rule.** With no steering/brake input, grounded physics must trace a trajectory bit-identical to
the frozen `tests/verification/snowman_baseline.js`. Any new mechanic must be gated behind an
input flag, a per-tier tuning field, or a provenance tag so the *default* coasting path is
unchanged.

**Why.** `tests/verification/physics_invariant_harness.js` (`npm run test:verify`) gates its exit
code on **max-abs trajectory diff == 0** for coasting/no-input runs. This is how the entire
skill/technique/jump/difficulty layer was added without regressing the base feel. It is the single
most-repeated constraint across issues (#253 wind, #247 difficulty, #244 heading-relative,
#286 jumps).

**Guards.**
- `skidScrub == 0` with no input; snowplow gated on `controls.down`; `turnForce` only under
  Left/Right; freestyle/parallel/hop gated on steering or `playerJump`.
- Per-tier tuning: "omitting `tuning` (or passing `BLUE_PHYSICS_TUNING`) must produce a
  bit-identical trajectory" (#247). Bunny/Blue stay identical; Black/Expert add gated behavior.
- Verbatim (PHYSICS.md §6): *"If you add randomness to the grounded path, keep it behind an input
  gate or the invariant harness will (correctly) fail."*
- Verbatim (#244): *"If any no-input byte changes in `npm run test:verify`, the gating leaked —
  stop."*

**Baseline regeneration is deliberate and fiddly.** Only regenerate on an *intentional* physics
change — and **never** by `git show :src/snowman.ts > baseline.js`. The baseline is a *classic
script* (global `THREE`, `window.Snowman`, loaded via `vm.runInContext`); a raw copy writes ESM
`import`/`export` and silently populates nothing, failing the next run (#137). Port the changed
`updateSnowman` into the classic-wrapper shape.

---

## 2. Seeded `Math.random` stream neutrality

**Rule.** Cosmetic/scenery/tree systems must never consume the global `Math.random` stream that
seeded harnesses observe. Placement randomness uses a *private seeded* PRNG; all THREE object
construction is wrapped so its UUID draws hit a private stream.

**Why.** THREE mints object UUIDs via `THREE.MathUtils.generateUUID`, which draws `Math.random()`
~4× per `Group`/`Mesh`/`Material`/`BufferGeometry`/`clone()`. The Node `forward_stress_harness.js`
seeds `Math.random` then places obstacles on that one stream; browser perf/teardown specs seed
before the bundle loads. Unguarded UUID draws shift every downstream seeded draw → broken
byte-identical trajectories, screenshots, and perf counts. Scenery tests assert *"zero global
`Math.random` on build AND per frame."*

**Guards / APIs.**
- `withPrivateThreeRandom(fn)` — swaps `Math.random` for a private xorshift during THREE
  construction, restores in a `finally` (restore-on-throw). `src/scenery/scenery-rng.ts`. Original
  proven instance: `getSwayDepthMaterial` / `depthUuidRandom` in `src/mountains/trees.ts` (wraps
  `new MeshDepthMaterial()`).
- `makeSceneryRng(seed)` — mulberry32 PRNG for placement; coerces non-finite/float seeds to a
  stable 32-bit int so `NaN`/`Infinity` can't wedge it. `scenerySeedFor(tier)` derives the seed.
- Each guard uses a **distinct** private-stream seed constant so two guards never share a stream.

**Async footgun (#285, P2).** A lazy dynamic `import()` that swaps `Math.random` must scope the
swap to the *synchronous* generation only — **never hold it across the `await`**. Codex:
*"`loadEzTreeModule()` … replaces global `Math.random` until the 4 MB dynamic import resolves;
because the build is not awaited, `setupScene()` continues immediately into later random consumers
such as `Snow.createSnowflakes()`."* Hold the swap only across the synchronous `generate()` calls.

---

## 3. Fixed-timestep physics & frame-rate independence (the #209 bug class)

**Rule.** Physics advances **only** in `FIXED_DT = 1/60` s steps via an accumulator
(`src/game/main-loop.ts`); cosmetics run once per render frame. Never mix a per-frame multiplier
(`v *= 1−k`) with delta-scaled forces (`v += a·dt`). Delta-scale cosmetic animation too.

**Why.** Mixing the two makes steady-state speed scale with frame rate — terminal speed ballooned
~8→32 m/s from 60→10 FPS — and a per-frame step exceeding an obstacle's collision radius
**tunnels straight through trees**. It only bites slow/mobile devices, so a 60-FPS dev machine
never reproduces it (DIAGNOSTICS.md, PHYSICS.md §1). Fixing it *also silently rebalanced
difficulty*: PR #209 "removed a low-FPS speed bonus mobile players were unknowingly riding," making
the avalanche unwinnable on ~70% of seeds (#229) — which forced a boulder-speed retune gated by a
new winnability harness. **A speed-touching change needs a downstream winnability/plausibility
check, not just a green invariant harness.**

**Guards / APIs.**
- `FIXED_DT = 1/60`, `MAX_SUBSTEPS = 8` (~133 ms ceiling = spiral-of-death guard). Per-step
  displacement `v/60` can never exceed the tree collision radius (2.5) → no tunneling *by
  construction*.
- Friction is a continuous per-second factor so `dt·60==1` stays byte-identical at 60 Hz
  (PHYSICS.md §7.3).
- `src/diagnostics.ts` (`Diag`) is the **runtime** detector: flags step ≥ collision radius,
  fps→speed ratio ≥ 2.0, speed past a ceiling, NaN/Infinity. **Read-only** — `record()` never
  writes `pos`/`velocity`. Off under automation. Feed it *real* `frameDelta`, not `FIXED_DT`
  (else it reports ~60 FPS forever and never flags a clamped session — #224).
- Delta-scale cosmetics too: snow sideways wobble was `WOBBLE_RATE=60`-scaled after 120 Hz drifted
  flakes 2× too fast (commit `0579189`) — the #209 class alive in *visuals*.

**Refactor-onto-substeps hazards (PR #224, 6 P2 findings).**
- Interpolation state must **persist** across render frames; don't reseed `prev = current` on
  no-step frames (120/144 Hz) or the snowman holds then jumps. Use a persistent two-state window.
- Preserve subsystem update **ordering**: avalanche burial must be checked *after* boulders
  advance but *before* `hasPassed()` resets the slide.
- A decision that used to run per render frame must not become frame-rate-dependent when moved to
  the fixed grid (or vice-versa) — a landing that clears `playerJump` in an early substep can flip
  a dodge from awarded (60 Hz) to buried (low FPS) (#289).
- To claim two rates are equivalent, assert **equal step counts + full trajectory**, not a common
  prefix; pick total time to land mid-step (`(N+0.5)·FIXED_DT`) so step count is deterministic.

---

## 4. Terrain height two-formula "MUST MATCH" contract

**Rule.** The two height paths — `createTerrain()` (rendered mesh) and `getTerrainHeight(x,z)`
(physics/camera/tree sampler) — must keep the **base peak term and downhill term byte-identical**
(commented `MUST MATCH` in source). Edit them in lockstep.

**Why.** Change one and not the other and the snowman floats above or sinks into the terrain
between vertices — *"the single most common terrain regression"* (PHYSICS.md §2.2). The
`heightMap` reconciles high-freq noise at vertices. `terrain-tests.js` asserts consistency.
`mountains.ts` is "high-risk because camera, trees, snow, and physics all depend on the same
sampler" (#98). Early bugs #15 (cliff-like hill breaking ski control) and #14 (jittery control)
are the historical symptoms.

**Cache-staleness sub-bug (#247).** The `heightMap` key is `${x},${z}` with **no tier dimension**;
adding per-tier terrain must key by tier or reset the cache per run *or it serves stale heights.*

---

## 5. Collision arrays & the course centerline are the single source of truth

**Rule.** Only `treePositions` / `rockPositions` drive collisions; only `course-line.ts`'s seeded
`laneX(z)` defines the racing path. Cosmetic layers may **read** `getTerrainHeight()` but never
write the collision arrays, and path math is never duplicated.

**Why.** Fair ranked times/ghosts depend on one path definition; invisible or phantom obstacles
appear when placement and collision diverge. Verbatim (#320): *"collision-neutral — never writes
`treePositions` / `rockPositions`; may only read `getTerrainHeight()`."* Decorative forest belts
"borrow tree style, not collision semantics" — **no entries in `treePositions`**. Verbatim (#247):
*"One centerline, many consumers — gates/terrain/obstacles/winnability all read `course-line.ts`;
never duplicate the path math."*

---

## 6. Cosmetic layers are render-only, physics-neutral, and tick outside the substep

**Rule.** Camera, snow, flex, tracks, wind, scenery, powder, sfx read the per-frame physics
*result* only — never `pos`/`velocity` — never write kernel state, and tick in the render-frame
cosmetic zone, **never** inside the fixed physics substep. Scenery is built *after* the collision
arrays and disposed in teardown.

**Why.** This is what keeps trajectories byte-identical while the visible world grows. Verbatim
(#305): *"the camera reads the per-frame result only, never `pos`/`velocity`."* Collision detection
"triggers game-over but never mutates `pos`/`velocity`, so trajectories are byte-identical."
Snow-splash restores the player position after moving its particles. Reparenting snowman
accessories (#338) rebased positions into the parent's local frame so "world placement is
byte-identical at rest."

**Camera specifics.** Generalize the follow rig, don't replace it; defaults neutral so spawn
framing is byte-identical to the classic camera. Zoom is distance+height, **not FOV** (FOV fights
the speed-FOV juice in `effects.ts`). Preserve the terrain-floor clamp. Cinematic oscillation is
driven off the camera's own `frameCount` — no wall-clock — so the sim stays byte-identical.
Transient Auto framing (`autoZoom`/`autoPitch`) is *never* written into persisted manual
`zoom`/`orbitPitch` and is reset on mode-change/restart.

---

## 7. Everything is teardown-safe, idempotent, and cancels in-flight async

**Rule.** Every subsystem is idempotently disposable, frees shared resources exactly once, cancels
in-flight async before appending to a torn-down scene, and nulls the module singletons / `window.*`
handles that keep the scene graph reachable.

**Why / concrete bugs.**
- `InstancedMesh` owns per-instance GPU buffers freed only by `InstancedMesh.dispose()`, not
  `geometry.dispose()` (#226/#221). A generic scene sweep leaves those buffers behind.
- `0351cda`: an in-flight EZ-tree chunk load appended fresh meshes (recreating just-freed material
  pools) into a scene whose renderer was already disposed → fixed with a **build epoch** bumped by
  `resetTreePools` that in-flight builds check before appending. A follow-on: abandoning only *one*
  pending build left a stale double-scheduled build gating `treeCollidersReady()` false → track
  pending builds in a `Set`.
- `0579189`: `teardownSnowflakes` must **dedup** disposal via a `Set` sweep — 1000 flakes share 3
  opacity-bucket materials + 1 texture; per-sprite dispose frees shared buckets hundreds of times.
- Module-level singletons (Sky, Course, Diagnostics, Snow pool, Controls, Audio) and `window.*`
  closures keep the disposed graph rooted; teardown must null/reset each. Even a `noopDispose`
  *allocated in the module* keeps the module's lexical env (and thus `scene`/`renderer`) rooted —
  use `Function.prototype` or an external module.
- Keep teardown **scene-local** when a module can serve multiple scenes (#221): scan the passed
  scene's own children, don't hold a module-global mesh list (else you dispose another live
  scene's objects).
- Idempotent public dispose + input/audio reset: `window.disposeGame()` survives a double-call;
  teardown calls `resetControls()` (else a held key leaves `left=true` stuck for the next mount)
  and stops music/SFX/toasts. The fatal-error path must route through the normal cleanup (#262) or
  wind/avalanche SFX and music keep playing under the recovery overlay.
- Cancel pending timers/callbacks/observers on teardown; guard a delayed `MutationObserver.observe`
  on `signal.aborted`; a stale intro closure could call `startGameplayLoop()` against a disposed
  renderer (#226).

`dispose(` appears 56× in `src/`; `test:leak` and `test:teardown` pin these contracts.

---

## 8. Automation serves a reduced, deterministic scene

**Rule.** Non-deterministic / heavy visual features (intro, sfx, debris, diagnostics, EZ-forest
trees, tab-hide pause) are gated **off under automation** so seeded test streams stay
byte-identical, unless a test opts in.

**Why.** Determinism for tests. Predicate: `window.isTestMode || navigator.webdriver || ?test=` in
the URL; opt-in via `window.testHooks.*` (`sfxEnabled`, `diagnosticsEnabled`, …).

**Two footguns.**
- The gate must be *effective*: set the flag **before** the gated code runs (`setupScene()` called
  `addTrees` before assigning `window.isTestMode` — #285), and remember Node 20+ exposes a built-in
  `navigator` so a jsdom harness may not read as headless. Derive from `window.location.search` at
  the check site where possible.
- **Screenshots/visual checks must exercise the real player path.** Headless puppeteer/Playwright
  always set `navigator.webdriver = true`, so the EZ forest serves stylized *cones*; a naive
  screenshot reads as "the realistic trees were destroyed" when they render fine for real players
  (#336). Force the player path with `?eztrees=1` (`resolveEzForestEnabled`) and/or override
  `navigator.webdriver`, and sanity-check that `ezBranches` instances attached. Same caveat for
  intro/debris/sfx.

---

## 9. The `window.*` seam boundary

**Rule.** Do **not** re-introduce the removed per-module `window.*` namespace bridges
(`window.Mountains`, `window.Controls`, `window.Camera`, `THREE`, …). Modules `import` each other
directly. Only a deliberate small surface stays global: `window.AuthModule`/`window.ScoresModule`
(consumed by `auth.html` + `local-auth.js`), boot helpers, and orchestrator/test hooks
(`resetSnowman`, `restartGame`, `showGameOver`, `toggleCameraView`, `window.terrainMesh`,
`treePositions`, `rockPositions`, `isTestMode`, `testHooks`). ARCHITECTURE.md §3.

**Why.** Untyped `any` boot bridges poison every downstream `.uid`/`.displayName` into
`no-unsafe-*` lint (`e4969ef`); the direct-import graph is what lets headless harnesses substitute
deterministic terrain + mocked `THREE`. Cross-cutting deps are passed as *parameters*
(`getTerrainHeight`/`treePositions` into `Snowman.updateSnowman`; `avalanche.setTerrainFunction`),
not hard-wired — that injection seam is the whole reason the sim is headless-testable
(ARCHITECTURE.md §4).

---

## 10. Timing integrity & anti-cheat

**Rule.** Wall-clock run time and fixed-step physics pause **together**, and score validity is
enforced on **both** client and server.

**Why.** On tab-hide, physics froze but the wall clock didn't → inflated times, teleported ghost,
ruined PBs; and a throttled background rAF against a frozen clock banks free distance — a cheat
vector (`437f8b6`, #278). Fix (`src/game/run-clock.ts`): shift `state.startTime` forward by the
hidden span, skip stepping while hidden, and capture hidden-state even if the tab was hidden before
`gameActive` flipped true; all elapsed-time consumers derive from one origin.

Implausible top times (~14s on a 180m course where a clean line is ~22–26s) exposed a
jump/landing speed-boost exploit (#229/#235). Response: `MIN_VALID_SCORE_TIME = 18` in
`src/score-limits.ts`, enforced **client + server** (`firestore.rules`). Never trust the client — a
forged client can still write a sub-floor time if only the display filters. And merging to `main`
auto-deploys the Pages client but **not** `firestore.rules` (#235) — deploy rules first, and a
clean-looking board doesn't prove a purge ran (the client filter hides a bad doc identically
whether it was deleted or not).
