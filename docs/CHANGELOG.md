# Changelog

All notable changes to SnowGlider. This is a continuously deployed static site
with no formal release versions, so entries are grouped by the pull request or
dated milestone that introduced them, most recent first.

This file consolidates two reports that previously lived under `docs/`: the
skill-&-structure implementation report (#56) and the audio implementation /
diagnostic history. For the current design see [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`PHYSICS.md`](PHYSICS.md), and [`tests/README.md`](../tests/README.md).

---

## Unreleased

### Fixed-timestep accumulator: frame-rate-independent physics (no tunneling)
- **The live run loop (`src/game/main-loop.ts`) now steps physics on a fixed grid.**
  The old loop advanced the kernel once per render frame with a variable `delta`
  (`Math.min((time-lastTime)/1000, 0.1)`), so the steady state was frame-rate dependent:
  terminal speed ballooned at low FPS and a single large step (`pos += v*delta`) could
  exceed the tree collision radius (2.5) and tunnel straight through the trees (the #209
  bug class that `diagnostics.ts` watches live). `animate()` now runs a **fixed-timestep
  accumulator**: physics advances only in `FIXED_DT = 1/60` s substeps (the exact rate
  the invariant/stress harnesses pin), so the per-step displacement is `v/60` — far under
  2.5 at any sane speed — and `tunnelRisk` frames go to **zero by construction**,
  regardless of render rate. `MAX_SUBSTEPS = 8` is the spiral-of-death guard (~133 ms
  ceiling): below ≈8 FPS the game *slows down* rather than tunnelling, the same ceiling
  the old 0.1 s clamp imposed — a strictly better failure mode.
- **Physics and cosmetics are split.** `stepFixed(1/60)` runs on the grid (physics +
  in-kernel collision/finish, `CourseModule.update`, and the avalanche burial check — the
  two run-outcome gates that live in the loop rather than the kernel — plus per-step
  `Diag.record`). The cosmetic/observer layer (`renderObservers`: HUD, `Flex`, `Sfx`,
  camera shake/toast) and the avalanche advance/UI, snow particles, sky cycle, camera, and
  render run **once per render frame** on the real frame delta. Jump/land events are
  **reduced across the frame's substeps** so a landing that completes mid-frame still
  fires its whoosh/thump/toast/shake (never dropped).
- **Render interpolation.** The snowman/camera render at `lerp(prevState, curState, alpha)`
  (the leftover-accumulator fraction), removing temporal aliasing on render rates that
  don't divide 60 (144 Hz, 50 Hz). Physics state stays authoritative on the grid; the
  authoritative position is restored after the render.
- **The kernel (`snowman/physics.ts`) is unchanged** — the accumulator lives entirely in
  the loop. The invariant harness (which drives the kernel directly at 1/60) is therefore
  unaffected, and the live build now advances physics at exactly the rate the tests pin:
  the thing tested is the thing that runs. `window.updateSnowman(delta)` is retained as a
  single-step test seam with the pre-accumulator single-call behavior (physics + telemetry
  + cosmetics, no course/avalanche), so the browser suites that drive it are unchanged.
- **New test:** `tests/verification/fixed_timestep_harness.js` (in `npm run test:stress`)
  drives the real kernel through the accumulator at 30/50/144 FPS and a jittery rate and
  asserts the trajectory is **byte-identical** to the 60 FPS run, that every fixed step
  stays under the tree radius, and that all state stays finite. `npm run test:verify`,
  `test:physics`, `test:regression`, and the rest stay green untouched.

### Three.js rendering perf: shared tree geometry/material pools + renderer tuning
- **Trees (`src/mountains/trees.ts`) were the forest's odd one out.** The avalanche
  boulders and ski tracks already share a single geometry/material, but each of the
  ~230 trees is a `Group` of ~24 meshes and `createTree()` minted a *fresh*
  `CylinderGeometry`/`ConeGeometry`/`SphereGeometry` **and** a fresh
  `MeshStandardMaterial` for almost every one — thousands of unique GPU geometries and
  materials, all re-bound every frame (shadow pass included). They now draw from tiny
  shared pools: canonical base geometries resized per mesh via `mesh.scale`, and a small
  quantised colour palette (6 bark / 12 foliage shades + one snow material) picked at
  random. GPU resource count collapses from thousands to ~20. The scene graph is
  unchanged — each tree is still a `Group` of individual meshes — so tree collision and
  the visual-tree count are byte-identical; only the colour granularity changes (palette
  vs. fully-continuous random), which is imperceptible across hundreds of small trees.
  Branches now hang off the tree group instead of the cone (so the shared unit branch
  geometry can be sized in world units); the only thing they no longer inherit is the
  cone's ±0.05 rad tilt. Also removed dead code in `addTrees` (an unused `Raycaster` /
  `downDirection` / terrain-mesh lookup).
- **Renderer (`src/game/scene-setup.ts`).** Added `setPixelRatio(min(dpr, 2))` so the
  scene is crisp on HiDPI/Retina displays instead of rendering at 1 device-pixel-per-CSS-
  pixel and looking soft (capped at 2 to bound GPU cost on 3× phone screens). Dropped the
  permanent `preserveDrawingBuffer: true`, which taxed *every* frame purely so the result
  screen's "Save image" could read the back buffer — the share path (`src/share-card.ts`)
  already re-renders one fresh frame immediately before the read (same tick, no yield), so
  the buffer is valid then without the flag.

### Runtime physics / frame-rate diagnostics (`src/diagnostics.ts`)
- PR #209 and its avalanche follow-up fixed two instances of the **same bug class** — a
  per-frame multiplier (`v *= 1 − k`) mixed in with dt-scaled forces, so a steady state
  scaled with frame rate. Both were invisible to every existing test (none *varied the
  frame time*) and invisible in play (they only bite on a slow/mobile device the
  developer never runs on). The offline stress harnesses now sweep dt in CI; this adds
  the **runtime counterpart** so the *next* bug in this class is diagnosed, not guessed.
- **`Diag`** is a read-only telemetry observer wired into the main loop beside
  `Sfx`/`Flex` (`Diag.record(...)` in `game/main-loop.ts`). It reads the per-frame
  physics result + position **only** — never `pos`/`velocity` — so the physics-invariant
  harness is byte-identical and it is a no-op under automation (off unless
  `window.testHooks.diagnosticsEnabled`, mirroring `debris`/`sfx`). It watches the dt the
  real device produces and the speed/step that ride on it, and surfaces the three
  frame-rate smells **live**: (1) a per-frame **step ≥ an obstacle's collision radius**
  (the discrete point-vs-disk check could miss it → tunnel risk — the runtime analog of
  the harness's offline tunneling probe); (2) terminal **speed that climbs as FPS
  drops**, computed as the max-speed ratio between low- and high-FPS frame bands (the
  #209 signature); (3) **NaN/Infinity** in the state.
- **How you use it.** Throttled `console.warn` breadcrumbs fire on any anomaly during
  normal play. Add `?debug` (or press `` ` ``) for a live HUD overlay — fps, dt cap hits,
  max step vs radius, and the speed-by-FPS-band table. `window.__snowgliderDiag.dump()`
  downloads a JSON trace (config, summary, health verdict, recent frames) to attach to a
  bug report — turning "the game froze / I drove through a tree" into hard numbers.
- **Broadened beyond the one bug + aggregated off-device** (review follow-up). The
  detector gained an **absolute speed-ceiling** invariant (a runaway is caught even at a
  steady frame rate, where the fps-band ratio sees nothing) and a generic
  `Diag.note(category, detail)` seam so **other subsystems** (asset loaders, avalanche,
  camera) can report into the same pipeline. Crucially, findings now leave the device: a
  `report` sink routes a **once-per-run `physics_anomaly`** verdict — plus **`client_error`
  / `unhandled_rejection`** from newly-added global handlers (the app had none, so an
  uncaught throw in the rAF loop previously vanished) — into the **existing Firebase
  Analytics** pipeline (`window.firebaseModules.logEvent`). Aggregated across real devices,
  that is how the #209 class would have surfaced in the wild rather than via a stress
  harness. The sink is wrapped so telemetry can never throw into the game loop, gated like
  the other `logEvent` call sites (modular SDK present, not `file://`), and swappable for a
  dedicated error monitor (Sentry / GlitchTip) with a one-line change at the `init()` site.
- **Healthy runs are sampled too** (`session_health`). Reporting only anomalies leaves
  nothing to compare a BAD verdict against, so a sampled baseline now fires on a periodic
  heartbeat through a long run (`healthSampleSec`, default 30s) and once at run-end — same
  shape as `physics_anomaly`, flattening the **FPS-band distribution**
  (`fps_ge50_frames`/`fps_30_50_frames`/`fps_15_30_frames`/`fps_lt15_frames`) so the
  real-world frame-rate spread is chartable and anomalies can be sliced against it. A short
  healthy run is sampled exactly once; an empty reset emits nothing.
- **Review hardening (codex P2s).** (a) The analytics sink targeted
  `window.firebaseModules.logEvent`, which **only `auth.html` ever populated** — so on the
  main game page the sink (and the pre-existing `game_start`/`game_over`/`game_reset`
  calls) silently no-oped. `auth.ts` now publishes a `logEvent` wrapper bound to the real
  Analytics instance on the main page, so all of them actually deliver. (b) The fps→speed
  ratio compared max speed across *any* populated bands, so a device fast at startup (slow
  snowman) that settled below 30 FPS at cruising speed could read as frame-rate-dependent
  from acceleration alone; the ratio now counts only **settled** (cruising-speed) frames
  and requires a minimum per band, with a regression test for the accel artifact.
  A follow-up tightened this further: the cruising floor is now near the expected terminal
  speed (so a mid-acceleration ~5 m/s frame is not "cruising"), and a BAD `physics_anomaly`
  requires an egregious, #209-scale gap (≥2×, the bug was ~4×) — a milder gap (≥1.5×) is
  WARN-only, since it can come from normal run progression / technique. Regression tests
  cover a 5→8 m/s progression (not flagged) and a modest gap (WARN, not BAD).
- **The first codex P2 was fixed:** `resetSnowman()` teleports the player to spawn, so
  `Diag.reset()` is now called in the lifecycle reset path — otherwise the first frame of a
  restarted run read as a ~135u step (old finish → spawn) and was falsely flagged a tunnel
  risk, permanently marking the run BAD. Regression-tested both ways.
- **Two more codex P2s fixed.** (c) `session_health` was only flushed on `reset()`, so a
  one-and-done run that ended via game-over/finish and was then abandoned (player never
  presses Reset) contributed no baseline. `Diag.endRun()` now flushes at run-end (called
  from `showGameOver`) and a `pagehide` listener flushes if the player just navigates away;
  all three paths share one de-duped flush so a run is never double-counted. (d) The tunnel
  check used the tree radius (2.5u) alone, but collidable rocks can be as small as
  ≈1.69u (`rockCollisionRadius(ROCK_COLLISION_MIN_SIZE)`), so a ~2u step could skip a small
  rock while diagnostics reported no tunnel risk. `Diag` is now initialised with the
  **smallest** collidable obstacle radius (`min(treeRadius, smallest-rock-radius)`).
  Both are regression-tested in `tests/diagnostics-tests.js`.
- **Analytics are pure + headlessly tested.** `percentile`, `classifyFrame`, `foldFrame`,
  `fpsSpeedRatio`, and `frameRateHealth` are exported pure functions (no DOM), unit-tested
  in `tests/diagnostics-tests.js` (`npm run test:diagnostics`, also in `npm test`). The
  tests prove the detector **fires on the real #209 numbers** (8 → 32 m/s across a 60→10
  FPS drop grades BAD; a 3.2 u step past the 2.5 u tree radius flags a tunnel risk) and
  stays **quiet on a healthy steady-60-FPS run** and on a merely-slow-but-bounded device
  (no fast band to compare against → no false "frame-rate-dependent" accusation). See
  [`DIAGNOSTICS.md`](DIAGNOSTICS.md).

### Avalanche friction made frame-rate independent (follow-up to PR #209)
- The snowman drag fix in PR #209 corrected a per-frame multiplier mixed in with
  dt-scaled forces. Stress-testing turned up the **same bug class still live in the
  avalanche kernel**: `src/avalanche.ts` applied the ground `friction = 0.98` once per
  frame instead of integrating it per second. So boulders decayed ~4× less at the
  capped 10 FPS delta than at 60 FPS, and the grounded-slide terminal speed
  `2·dt / (1 − friction)` scaled ~6× with frame time — the avalanche reached farther
  and faster on slow devices, **skewing burial (game-over) fairness by frame rate**.
- **Fix:** `friction → frictionFactor = Math.pow(0.98, dt * 60)`, mirroring the
  snowman's `dragFactor`. Byte-identical at the 60 Hz baseline (`dt·60 == 1` when
  `dt == 1/60`, `x ** 1 === x`), so the existing avalanche tests are unchanged; only
  off-60 Hz frames are corrected. The debris/powder loop (`_updatePowder`) already
  drag-scaled correctly — this brings the boulders in line.
- **New gate:** `tests/verification/avalanche_framerate_harness.js` (`npm run
  test:stress`, also in `npm test`) triggers one deterministic, seeded avalanche on flat
  terrain (so the grounded-slide regime dominates cleanly) and asserts the 10-FPS/60-FPS
  front-travel ratio stays near 1 and all boulder state stays finite. Verified to **fail
  on the pre-fix kernel (ratio ≈ 2.9) and pass on the fix (≈ 0.95)** — a passing test on
  the old code would have proven nothing.
- **Forward stress harness broadened to an input × frame-rate matrix.**
  `tests/verification/forward_stress_harness.js` (also `npm run test:stress`) — which PR
  #209 added as a hold-Up-only probe — now sweeps five input policies (hold-Up,
  deterministic slalom, time-keyed wander, an adversarial steer-into-the-nearest-tree,
  and jump-spam) across 60/30/10 FPS **plus a bursty frame-hitching run** (60 FPS with
  occasional 0.1 s GC-pause spikes). New gating checks beyond the original
  tree-tunneling + speed-ratio: **rock tunneling** (the segment probe now replays every
  rock disk at its `rockCollisionRadius`, not just trees), **speed-bounded under every
  policy** (not just hold-Up), **no NaN/Infinity** in any run, and **every descent
  terminates** (finish/crash/off-side, never spins — the closest reproducible proxy for
  the "freezes at the end" report). The broadened matrix found **no new defects** (the
  steered slalom path is frame-rate-sensitive by coarse-dt Euler integration, not a bug —
  the steer force is delta-scaled — so it is reported as a diagnostic, not gated).
  Verified to still fail hard on a reverted drag fix (3.16 m step → tunneling; speed
  ratio 3.83).

### Snowplow: stop vs. slow-down + steep-slope failure, aligned to the Slope HUD (#54)
- The snowplow was a single on/off "pizza" brake that stopped you on **any** skiable
  pitch. It is now a **graded wedge** with two real behaviors, tied to the terrain.
- **Stop vs. slow-down (hold ramp).** A new `plowCharge ∈ [0,1]` on `snowman.userData`
  builds while Brake (↓ / S) is held and decays on release (mirroring `carveCharge`).
  The brake deceleration scales with it, so a **tap only trims speed** while a
  **sustained hold deepens the wedge to a full stop**. The ski-wedge pose deepens with
  the same charge (`wedge = 0.18 + 0.32·plowCharge`), so the intent reads on the skis.
- **Steep-slope failure.** The full wedge's deceleration is **capped**, so where the
  slope's gravity component exceeds it the wedge can only hold a slow **terminal
  speed**, not stop — "you can't pizza a black diamond." This falls straight out of the
  force balance (no special-casing) and makes the steep upper mountain / avalanche
  escape demand carving or hop turns instead of a free stop anywhere.
- **Aligned to the Slope HUD tiers (#201).** The two thresholds are the slope gravity
  at the HUD's tier edges (`0.32 ≈ 18°` → `3.14 m/s²`, `0.58 ≈ 30°` → `5.68 m/s²`), so
  the readout doubles as a "can I stop here?" cue: 🟢 green (<18°) a tap stops you;
  🔵 blue (18–30°) needs a full wedge; ◆ black diamond (>30°) can only be slowed.
- **Slope HUD relabeled to ski difficulty.** The Game Stats slope readout now shows the
  familiar trail marks — `● Green` / `■ Blue` / `◆ Black` — instead of generic
  green/yellow/red, matching the snowplow thresholds (`src/ui/hud.ts`).
- **Slope readout de-flickered.** The raw per-frame gradient is noisy, so the readout
  (and its tier) used to jump several degrees every frame. It is now an exponential
  moving average, with hysteresis on the tier edges so the difficulty mark only flips
  once the pitch is clearly past a boundary. Display-only — the physics still uses the
  raw per-frame gradient.
- Removed the old fixed `+3 m/s²` uphill nudge that rode alongside the brake: as a
  constant it applied even to a feather-light wedge, which both stopped you on terrain
  too steep to wedge and pushed the stop threshold past anything the run skis (defeating
  both the gradation and the steep failure). The no-reverse guarantee comes from the
  impulse clamp, which is retained.
- **Invariant-safe**: all of this is gated on `controls.down`, so the no-input coasting
  path stays byte-identical to the frozen baseline (no `snowman_baseline.js` regen).
  New gating harness checks: the stop-vs-slow-down gradation (hold < tap < coast) and
  steep-slope failure (a full wedge stalls on a black-diamond constant slope but stops
  on a gentler one). Model + tier table in
  [`PHYSICS.md` §3.4](PHYSICS.md#34-snowplow-brake-stop-slow-down-and-steep-slope-failure).

### Realistic rock colours + cliff outcrops + terrain/tree biome alignment
- **Varied stone colours** — rocks no longer share one uniform grey. `createRock`
  now draws each rock's bare-stone base from a small weighted palette of realistic
  mountain tones (granite grey, slate/charcoal, warm brown/tan, iron-stained
  reddish, faint olive lichen), jittered per rock. Snow still accumulates on the
  up-facing faces, so the colour reads on the exposed pitches. Purely cosmetic
  (`vertexColors`); no physics/determinism path touched.
- **Cliff outcrops** — `addRocks` gains a sparse pass that places larger, more
  angular, darker `createRock(size, { cliff: true })` blocks (in tight 2–3 block
  clusters) on the steepest flanks, kept well clear of the central ski corridor and
  spawn pocket. Big-enough blocks register as collision hazards via the existing
  `rockIsCollisionHazard` rule (radius capped at 3u, in sync with snowman collision).
- **Terrain ↔ tree biome alignment** — a new deterministic `Mountains.forestDensityField(x, z)`
  (a fixed-seed fbm, like the ridge field) drives two consumers off one shared signal:
  the terrain snow shading tints gentle, forested ground with a faint warm treeline
  cast, and `Trees.addTrees` biases placement into the same stands (with a floor so
  clearings never go fully bare). Trees now gather into stands with open snowfields
  between, and the ground beneath them ties to the trees instead of a uniform sprinkle.
- All cosmetic/scenery: the physics-invariant harness still reports coasting IDENTICAL,
  and the Node + browser (94/0) suites stay green.

### Meaningful jumps — Phase 1 (#47)
- Turns the already-bound but rewardless Jump into a real risk/reward mechanic.
  Design doc: [`docs/MEANINGFUL_JUMPS.md`](MEANINGFUL_JUMPS.md); model in
  [`PHYSICS.md` §4](PHYSICS.md).
- **Jump provenance** — a `snowman.userData.playerJump` flag with a fully-specified
  lifecycle (set true at a deliberate straight-jump takeoff, false at auto-jump /
  hop takeoffs, cleared on landing and in `resetSnowman`). Every reward is gated on
  it, so auto-jump / hop / coasting paths are byte-identical and the physics-invariant
  harness still reports coasting IDENTICAL to the frozen baseline (no regen).
- **Takeoff precedence** — a deliberate Jump now wins over the terrain auto-jump on a
  combined lip+jump frame (the auto-jump branch is skipped while Jump is held); a no-op
  on every no-input frame.
- **Landing-quality grade + clean boost** — a *manual* jump's landing is graded
  CLEAN / OK / SKETCHY from how well the heading aligns with the fall line at touchdown.
  CLEAN replaces the airtime scrub with a small, capped (≤6%) forward impulse (a
  well-aimed jump becomes a speed tool, mirroring the #136 model); OK is neutral;
  SKETCHY keeps today's scrub.
- **Scoring surface** — `CourseModule` gains a public `flashAir(quality, seconds)`
  toast and an `addAirScore()` accumulator; the main loop toasts `✈ AIR <t>s · <grade>`
  on a graded landing and banks a per-run **air score** shown on the result screen. The
  score is banked from *inside* the kernel step (before its synchronous finish check),
  so a jump that lands on the finish frame still counts on the result screen.
- **New gating harness checks**: takeoff precedence, landing-grade (clean faster than
  sketchy), and the provenance gate (a non-player landing earns no boost / score).
- Phases 2 (obstacle-clear scoring + avalanche-dodge window) and 3 (#32 tricks) remain
  proposed.

### Carve vs. parallel turns — make the two distinct (follow-up to #185)
- The carve/parallel split shipped in #146/#185 was **almost indistinguishable and
  not faithful to real skiing**: both were the same input (just hold a turn), they
  differed only by a tiny turn-tax fading out, "carve" had *no* distinct pose at all,
  and the hierarchy was backwards (it treated parallel as the mastery tier *above*
  carve — in reality a carve is the advanced form of a parallel turn).
- Reworked into **two clearly distinct steered turns** (snowplow unchanged):
  - **Parallel (skidded)** — the default/uncommitted turn: brushes the skis, **scrubs
    speed**, and turns **tighter** (`turnForce → 19`); skis stay flatter, body upright.
  - **Carve** — a committed, smoothly-held turn (`carveCharge > 0.6`): **holds speed**
    (sheds ~92% of the edge wash-out) and draws a **wider** arc (`turnForce → 10`),
    with the skis rolled onto edge + drawn together and a **deep body inclination**
    into the turn (lean clamp raised to ~0.42 rad). The mastery turn above a parallel.
  - Turn **radius** is now the inverse of commitment (a carve can't be whipped tight),
    so the two *feel* different to drive, not just post different numbers.
- Input is unchanged (no new keys): hold a smooth line → it locks into a carve; abrupt
  or reversed steering stays a skidded parallel turn. HUD + the in-game/start-menu
  technique guides + `PHYSICS.md` §3.3 updated to match.
- **Test-safe.** Every change stays behind the steering gate, so the no-input coasting
  path is **byte-identical to the frozen baseline** (no baseline regen needed); the
  invariant harness still reports `max abs diff 0` and all technique gating checks pass
  (the "parallel-reachable" check is now "carve-reachable"). A new side-by-side
  technique-comparison harness (`npm run test:turn-styles`) drives a held carve vs. a
  skidded parallel turn from the same start and asserts the carve holds more speed and
  arcs wider, with the parallel scrubbing more and turning tighter.

### Fix: start-screen leaderboard rows clipped at full height
- The **Global Top Times** preview (`#startLeaderboard`) on the start screen was
  truncated — only the header and the first few of the top-5 rows showed, with the
  rest cut off and no usable scrollbar. `#startGameContainer` is a column flexbox,
  so the leaderboard (a flex item) was being shrunk *below its own `max-height`*
  whenever the panel was taller than the viewport, clipping the bottom rows. Same
  flex-overflow class of bug as the build badge (`#buildBadge`) fix.
- Fix is CSS-only (`styles/main.css`): add `flex-shrink: 0` so the leaderboard
  keeps its natural height and the container scrolls instead (`overflow-y: auto` +
  `justify-content: safe center` already keep the top reachable), and bump
  `max-height` 168px → 200px so the full top-5 (h3 + header + 5 rows) fits without
  an internal scrollbar.

### Shaped skis — sidecut / camber / shovel / tail + cosmetic flex (#189)
- The snowman's skis were two flat red `BoxGeometry` slabs with an angled box glued
  on the front. They are now real ski shapes built from a **custom lofted
  `BufferGeometry`** (`src/snowman/model.ts`, `buildSkiArm`): a sidecut top view
  (wide shovel → narrow waist → medium tail), a smooth shovel/tip rise, a small tail
  kick, rounded end caps, and a visible binding (plate + boot). Three materials give
  a red top-sheet, a dark sintered base, and a steel-edge line accent (geometry
  material groups).
- Each ski is a **pose-owned root group** holding two pivot arms (tip + tail) that
  overlap at the waist and are hidden under the binding, so the surface reads as one
  continuous ski with no visible seam. `pose.ts` still owns the root transform
  (snowplow wedge / parallel edge + draw); the arms only bend.
- The cosmetic flex layer (`src/snowman-flex.ts`) gains a **ski-flex pass** that writes
  *only* the arms' `rotation.x`: a gentle camber arch while gliding (with speed-chatter),
  a reverse-camber compression spring on landings, tip-pressure in carves (scaled by
  turn rate), a flatter/planted snowplow, and a de-cambered airborne ski. It never
  touches position/velocity, honors `prefers-reduced-motion`, and leaves the
  physics-invariant harness byte-identical (no baseline regeneration).
- Tests: `tests/snowman-flex-tests.js` adds ski arms to the stub and asserts the
  flex writes rotation only (position/scale/yaw/roll stay at base), a glide arch
  appears, a carve adds tip-pressure, and `reset()` restores the arms.

### Aperiodic terrain ridge — kills the grey "corduroy" banding source (#188 step 3)
- The terrain ridge in `mountains.ts` was the **periodic** `sin(x*0.2)*cos(z*0.3)`.
  A low directional sun raked that regular plaid into repeated grey bands (the
  `Grey corduroy` failure mode in [`SNOW_RENDERING.md`](SNOW_RENDERING.md)) and was the
  reason the sun cycle's low-sun guard (`SUN_ELEV_MIN_DEG`, `src/sky.ts`) had to sit
  at 14°.
- Replaced it with a **deterministic, domain-warped fBm** (`terrainRidgeField`): the
  ridges now meander instead of forming a lattice, so a raking light has no periodicity
  left to band. The field uses a fixed-seed integer hash (not the `Math.random`-seeded
  `SimplexNoise`), so the terrain is stable across page loads and the Node
  terrain/regression tests pin its shape; it is damped toward the peak with the same
  `(1 - exp(-distance/60))` falloff as the existing perlin layer, so the summit stays
  smooth and relief grows down the slope.
- Applied to **both** the physics sampler (`getTerrainHeight`, ×0.8) and the visual
  mesh (`createTerrain`, ×1.5), keeping their existing amplitude relationship.
- **Invariant preserved:** the no-input coasting kernel is untouched, so the physics
  invariant harness stays byte-identical; full Node suite, production build, and the
  browser suite (89/89) all pass. The companion change — dropping the low-sun guard
  toward 8° and retuning golden hour — is the separate **NS2** follow-up.

### Social sharing — link previews + screenshot in the mobile share
- Follow-up to "desktop platform menu + screenshot card" below. Three gaps made
  sharing feel broken: shared links had no preview at all, Facebook/LinkedIn
  shared "just a link" with no text, and the screenshot only ever reached the
  "Save image" button.
- **Open Graph + Twitter Card meta tags** added to `index.html`. The web
  share-intent URLs (and Facebook/LinkedIn especially, which ignore any prefilled
  text by policy) render a shared link from these tags, not from the share dialog
  — so without them every shared link unfurled bare. Now X/Facebook/LinkedIn/
  WhatsApp/Telegram/Reddit show a real card (branded image + title + description).
  The `og:image` is a 1200×630 promo card hosted off-tree on the long-lived
  `assets/og-image` branch (keeps `main` binary-free; **do not delete that branch**).
- **The mobile "Share Result" now carries the screenshot.** The primary share on
  touch devices builds the run card and file-shares the PNG via the native sheet
  (which lists Instagram / Stories), falling back to the text+link share when the
  image can't be built or the browser can't file-share. Previously the screenshot
  was only reachable through the separate "Save image" button.
- **Instagram clarity.** Instagram has no web share-intent URL, so desktop can
  only "Save image" + manual upload; the desktop menu now says so, and the
  saved-image confirmation points the player at Instagram. (On mobile the file
  share reaches the Instagram app directly.)
- **Real brand icons.** The per-platform buttons now render the official brand
  logos (Simple Icons, CC0) as inline SVG in each brand's color, replacing the
  earlier synthetic text glyphs (𝕏 / f / in / ✆ / r/ / ✈).
- Tests: `tests/share-menu-tests.js` updated — the mobile primary now asserts a
  file (image) share plus a text+link fallback path; `share`/`share-card` suites
  unchanged and green.

### Codex review follow-ups on the snow/light stack (#163, #181)
- **Golden hour no longer renders muddy (sky.ts, #163).** The cycle's golden-hour
  `THREE.Color` endpoints were built at module load — *before* `scene-setup` opts out
  of three's colour management (`ColorManagement.enabled = false`) — so they were
  sRGB→linear converted while the captured midday colours (built after the opt-out)
  stayed raw. `lerpColors` then mixed two colour spaces and darkened/muddied golden
  hour. The endpoints are now constructed inside `applyAtmosphericSky` under the same
  opted-out regime, so the authored hues survive. Guarded by a new `test:sky` check.
- **Ski trails no longer clump on fast/hitchy frames (snowtracks.ts, #181).** The
  stamping loop emitted every missed `STAMP_SPACING` dab at the *current* position, so
  a fast glide, a frame hitch, or the capped `0.1 s` delta stacked a clump of dabs
  under the snowman and left the crossed segment untracked. Missed stamps are now
  interpolated along the segment travelled that frame, with the residual carried
  across frames so spacing stays even. New `test:snowtrails` regression check. Both
  fixes are render-only — the physics-invariant harness stays byte-identical.

### Golden-hour ↔ midday sun cycle (#163)
- The atmospheric sky (#2) now **gently breathes between the static midday and a
  low, warm golden hour and back** on a 90 s loop, so the light feels alive without
  re-balancing how snow reads. It is a **bounded atmospheric layer on top of the
  settled static snow-lighting look** (#181 / [`SNOW_RENDERING.md`](SNOW_RENDERING.md)),
  not a readability pass — re-integrated onto the `src/game/*` structure that the old
  PR predated.
- **Captures the merged static state as its bright endpoint.** At setup
  `Sky.applyAtmosphericSky(scene, directionalLight)` snapshots the directional sun's
  position/colour/intensity, the Preetham `sunPosition`/`exposure`, and the fog /
  background, then drives **only** those toward warmer, dimmer golden-hour values and
  back. Midday and every frozen state are a **bit-for-bit copy** of that snapshot.
- **Stays in its lane.** The cycle never touches the `HemisphereLight` (the snow's
  cool-shadow fill), the `AmbientLight`, snow albedo/vertex tint, or terrain — so the
  warm-sun / cool-shadow snow form is preserved and the mountain is never washed warm
  or pushed back toward the old `0.5 * Math.PI` ambient whiteout. Advanced by
  `Sky.update(delta)` in `game/main-loop.ts`; **frozen at midday** under
  `prefers-reduced-motion` and the `SUN_CYCLE_ENABLED` switch.
- **Low-sun guard.** The golden-hour sun is held at `SUN_ELEV_MIN = 14°` while the
  periodic `sin(x*0.2)*cos(z*0.3)` terrain ridge survives (issue #188: `12–15°` until
  fBm/domain-warp terrain lands; `8°` only after). Purely visual — the physics-invariant
  harness stays byte-identical. Covered by `tests/sky-cycle-tests.js`
  (`npm run test:sky`): captured-midday equality, reduced-motion / disabled freeze,
  hemisphere & ambient untouched, sun above the horizon, warmer/dimmer golden hour,
  monotonic half-cycles, and periodicity.

### Snow rendering & lighting guide (docs)
- Added [`docs/SNOW_RENDERING.md`](SNOW_RENDERING.md) plus
  `docs/snow-lighting-model.svg`, versioning the rationale behind the snow-lighting
  stack (issues #17/#18/#2): warm sun + cool skylight + AO for snow form, the
  whiteout / grey-corduroy / muddy-snow failure modes to avoid, the merged static
  light values, and the per-layer ownership boundaries the sun cycle (#163) must
  respect. Linked from [`ARCHITECTURE.md`](ARCHITECTURE.md). Docs-only.

### Avalanche powder cloud (issue #49)
- An approaching avalanche now kicks up a **billowing cloud of snow powder** as it
  tumbles down the slope, so it reads as a rolling wall of snow instead of a bare
  cluster of boulder spheres. This is the "in-scene cloud" remaining item under
  ROADMAP Finding 3 (avalanche telegraphing) / issue #49 — complementing the
  warning banner, danger meter, vignette and proximity shake shipped in #56.
- Self-contained in `src/avalanche.ts`: a pool of `260` alpha-blended powder
  sprites (`depthWrite: false`) — the same sprite approach as the ski snow-splash
  in `snow.ts` — emitted from the tumbling boulders each frame from inside
  `update()`, so no game-loop wiring changed. Each puff lofts, billows (drag +
  light gravity), expands and fades over ~1–2.5 s.
- **Purely cosmetic and test-safe.** The powder never touches `pos`/`velocity` or
  the boulder physics, so the physics-invariant harness stays byte-identical and
  the burial / `getClosestDistance` / `hasPassed` contracts are unchanged. The
  pool builds only when a `document` is present, so the headless Node avalanche
  tests are unaffected (powder is a no-op there). New DOM-smoke coverage exercises
  the pool's build / activate / reset / dispose lifecycle under jsdom; existing
  Node (12), browser-avalanche (19) and full browser (89) suites stay green. See
  [`PHYSICS.md`](PHYSICS.md) §7.5.

### Ski techniques in the UI + snowplow wedge fix + slightly faster skiing
- **Techniques exposed.** The skill layer (carve, parallel turn, snowplow/pizza,
  tuck, hop turn) existed in the physics but was never explained to the player. A
  new **"Ski Techniques"** subsection now lists each one — with the input that
  triggers it — in both the start-menu controls guide and the in-game **Game
  Controls** collapsible widget. The widget content now scrolls (`overflow-y:
  auto`, taller `max-height`) so every technique row stays reachable.
- **Snowplow wedge direction fixed.** The cosmetic snowplow pose had the ski
  **tips splayed apart and tails together** — a reverse wedge, the opposite of a
  real "pizza". `src/snowman/pose.ts` swung each ski the wrong way (the comment
  said "tips inward" but the math pushed them out). Swapping the two `rotation.y`
  signs makes the **tips converge and the tails splay out**, a proper snowplow.
  Purely visual — no physics change.
- **Slightly faster skiing.** Lowered coast friction (`baseFriction 0.015 → 0.012`,
  high-speed term `0.025 → 0.020`, so the range is `0.012 .. 0.032`) for glidier
  sustained skiing and a higher top speed. This changes the no-input coasting path,
  so the frozen verification baseline (`tests/verification/snowman_baseline.js`)
  was regenerated in lockstep — the invariant harness still reports the current
  coasting trajectory as byte-identical to the baseline, and every technique gating
  check holds. Constants updated in [`PHYSICS.md`](PHYSICS.md).

### Realistic snow surface — de-striped + smoothed shading + softer light (#17)
All changes are **render-only**; the terrain height field, the two-formula contract,
and the physics-invariant harness (byte-identical no-input coasting) are untouched.
- **Killed the diagonal texture stripes.** The procedural snow normal map
  (`createSnowNormalTexture` in `src/mountains.ts`) summed wind-ripple waves all
  biased to one diagonal and tiled `8×10`, so the directional light raked them into
  regular diagonal stripes. It is now **subtle, isotropic, high-frequency powder
  grain** (mixed-direction waves, repeat `16×20`, `normalScale 0.12`) that mip-maps
  to smooth at distance — close-up sparkle, no stripes.
- **Smoothed snow *shading* normals (the real fix for the "grey lines").** The
  remaining grey banding wasn't a texture — it was the bumpy terrain's own facet
  normals being raked by the hard light (every mogul lit on one side, grey on the
  other; the regular `sin(x*0.2)*cos(z*0.3)` ridge made it periodic). New
  `applySmoothShadingNormals` low-passes a throwaway clone of the height field and
  copies its normals onto the real geometry, so the **silhouette stays the exact
  skiable terrain (physics rides the unchanged `heightMap`) but the light sees a
  soft surface.** Physics never reads mesh normals (slope forces use the analytic
  `getTerrainGradient`), so this is purely visual.
- **Softer, less-raking light.** The hard sun is dialed down (`0.8π → 0.5π`) and the
  orientation-aware sky fill raised (`HemisphereLight 0.45π → 0.62π`, neutral-er
  tint; `AmbientLight 0.15π → 0.26π`) in `game/scene-setup.ts`, so deep powder reads
  low-contrast (bright with gentle shadows) the way real snow does under an open sky.
- **Near-white slope tint.** The per-vertex "wind crust" went from a strong grey-blue
  (`0.66,0.72,0.82` @ ≤0.6) to a barely-cool near-white (`0.93,0.95,0.99` @ ≤0.5)
  derived from the *smoothed* normals — it shapes without painting grey into the snow.
- **Snow-capped rocks.** `applyRockSnowColors` widens/saturates the up-facing snow
  band and the rock material drops to `metalness 0`, so rocks read as snow-covered
  stone instead of shiny grey crystals.
- **Temporary ski tracks — new `src/snowtracks.ts` (not an accumulation model).**
  `SnowTrails` carves faint grooves behind the skis that fade over a few seconds
  (reading as fresh snow settling back). It is **transient track feedback**, not
  snow building up — a real accumulation pass (a persistent low-res `SnowDepthField`
  fed into the terrain material) is a separate follow-up. Fixed instanced-quad
  ring-buffer (one draw call), terrain-aware, `prefers-reduced-motion`-aware, cleared
  on reset, and purely cosmetic (reads `snowman.position` only). Threaded through
  `GameState.snowTrails` (`scene-setup` → `main-loop` → `lifecycle`). Covered by
  `tests/snowtrails-tests.js` (`npm run test:snowtrails`).

### Rename `src/physics.ts` → `src/player-state.ts` (#178)
- The repo had two files named `physics.ts` at different levels: the top-level
  one (the typed per-frame `PlayerState` container + step/reset wiring) and the
  physics *math* kernel at `src/snowman/physics.ts`. The top-level file holds no
  physics math, so the shared name was confusing.
- Renamed it to `player-state.ts` (and the matching `tests/physics-state-tests.js`
  → `tests/player-state-tests.js` plus its `test:physics` script). Pure rename:
  all import specifiers, the contract-surface seam, and doc references were
  updated; the `snowman/physics.ts` kernel and the exported `Physics` API object
  are unchanged.

### Social sharing — desktop platform menu + screenshot card
- Fixes the original "Share Result" being useless for social on desktop. The
  native Web Share API was the only path, but on macOS/desktop the OS share sheet
  only lists system targets (AirDrop / Mail / Messages) — never social sites —
  and Messages often opened with an empty body. The native sheet is still used on
  mobile/touch (where it surfaces installed social apps), but desktop now gets an
  explicit menu of web share-intent links.
- `src/share.ts` additions:
  - `buildShareLinks(data)` — deterministic, URL-encoded web share-intent links
    for **X/Twitter, Facebook, LinkedIn, WhatsApp, Reddit, Telegram** (Facebook
    and LinkedIn carry only the URL per their policy; the rest carry the brag
    text too). `SHARE_PLATFORMS` drives the menu order/labels.
  - `prefersNativeShare()` — true only on touch/mobile (where `navigator.share`
    lists social apps and can file-share to Instagram), so desktop falls through
    to the explicit menu.
  - `shareImageFile(blob, data)` — shares a rendered run image via the native
    file-share sheet (the only way to reach Instagram, which has no web
    share-intent URL); returns `'unavailable'` so the caller can fall back to a
    download. `copyShareMessage(data)` backs the explicit "Copy link" action.
- New `src/share-card.ts` — the **screenshot + card overlay**: `captureGameFrame`
  re-renders the live frame and reads it back as a PNG (enabled by
  `preserveDrawingBuffer: true` on the renderer in `game/scene-setup.ts`), and
  `composeShareCard` draws it as the background of a 1080×1350 (Instagram-portrait)
  card with the time/branding overlaid. `buildShareCardBlob` + `downloadBlob`
  tie it together; everything degrades to a gradient card if capture is
  unavailable.
- New `src/ui/share-menu.ts` — the hybrid result-screen control: a primary
  **🔗 Share Result** button that calls the native sheet on mobile or toggles the
  per-platform menu (social links + **📸 Save image (Instagram)** + **🔗 Copy
  link**) on desktop. Every menu button stops `touchstart` propagation so
  `controls.ts`'s document-level `preventDefault` can't kill its synthesized
  click on mobile (same class of fix as #173). `course.ts` now receives the
  `renderer`/`camera` (via `CourseModule.init`) to feed frame capture.
- Tests: `tests/share-tests.js` extended to 54 checks (`buildShareLinks`,
  `prefersNativeShare`, `shareImageFile`, `copyShareMessage`, `formatRunSeconds`);
  `tests/verification/dom_smoke_test.js` updated for the menu UX (menu hidden →
  opens on click, six platforms present, Copy link copies a stable public link).
### Intro fly-over — cinematic mountain establishing shot at game start (#51)
- On the first real "Start Game" the camera now flies over the mountain before
  the run begins: a wide establishing shot high above the peak that sweeps down
  the course and settles into the gameplay chase pose. This turns the old blank
  ~1.8 s "Loading…" pause into a cinematic, in a new `src/intro.ts` module
  (`IntroModule.play`).
- **Camera-only, zero gameplay impact.** The fly-over runs its own short
  animation loop and renders the static scene; it never calls the physics kernel,
  the snowman stays seated at the start gate, and the run timer does not start
  until the fly-over hands off to the game loop. The no-input physics invariant is
  therefore untouched (and the verification harness is unchanged).
- **Skippable.** A "Skip ▶" button plus a pointer / Escape / Enter listener jumps
  straight to the gameplay pose; movement keys (arrows/WASD/Space/V) are left for
  the controls layer and never skip. The in-game HUD/buttons are hidden during the
  fly-over (`body.intro-active`) so the shot reads cleanly.
- **Automation- and motion-safe, by design.** The cinematic is skipped — and the
  original Loading/Get-Ready timing reproduced byte-for-byte — for the `?test=`
  browser suites (`window.isTestMode`), automated runs (`navigator.webdriver`,
  i.e. Playwright/Puppeteer), and `prefers-reduced-motion`. So every existing
  Node/browser/e2e test runs on the unchanged path (browser suite stays 87/0).
  `?intro=force` plays it under automation (manual QA); `?intro=off` disables it.
- **Tested without a browser.** The path math is plain-number Catmull-Rom (no
  three.js, no DOM) and the clock / animation-frame scheduler are injectable
  seams, so `tests/intro-tests.js` drives the whole fly-over to completion
  deterministically (endpoint interpolation, skip path, mid-flight skip, terrain
  clearance, single `onComplete`).

### Social sharing — "Share Result" on the finish screen (#157)
- New `src/share.ts` module: lightweight sharing of a finished run with no
  sign-in, backend, or per-platform SDK.
  - `buildResultShareData(time, isNewBest, href?)` builds deterministic share
    copy ("I finished SnowGlider in 42.13s…" / "New SnowGlider personal best:…").
  - `cleanShareUrl(href)` keeps shared links stable and public: it strips
    local-only query params (`?test=…`) and the hash, and collapses
    local/dev/`file:`/unparseable URLs to the canonical `https://snowglider.ai/`.
  - `shareResult(data)` uses the native Web Share API when available (from the
    button's user gesture) and falls back to `navigator.clipboard.writeText()`
    on absence or any non-cancel failure; a user-cancelled share sheet
    (`AbortError`) is respected (no clipboard write). It never rejects.
- The course result panel (`src/course.ts`) appends one **🔗 Share Result**
  button, so it appears only on a valid successful finish and is cleaned up with
  the panel on restart. The button label reflects the outcome (Shared / Link
  copied / unavailable) and a best-effort `share_result` Analytics event is
  logged through the existing `window.firebaseModules.logEvent` seam.
- Fixed a latent touch-binding bug surfaced by the nested button: the game-over
  `MutationObserver` in `src/controls.ts` selected `#gameOverOverlay button`
  (first descendant, depth-first), which would now match the nested Share button
  and misbind restart on touch devices. Switched to the child combinator
  `#gameOverOverlay > button` so it always targets the direct-child restart
  button.
- Tests: new `tests/share-tests.js` (`npm run test:share`, 31 checks) for copy
  formatting, URL cleanup, and the share/clipboard/Analytics outcomes; the
  `dom_smoke_test` now asserts the Share button appears only in finish panels and
  copies a stable public link; the controls test guards the restart/share
  touch-binding regression.

### Visible sky — gradient sky, atmospheric sky + sun, distance fog (#2)
- Replaced the flat `scene.background = Color(0x87CEEB)` (and no fog) with a
  graduated sky and matching horizon fog, in a new `src/sky.ts` module.
- **Tier 1 — gradient sky + fog (`Sky.applyGradientSky`, kept as a fallback):**
  a large `BackSide` dome whose vertex shader pins it to the far plane
  (`gl_Position.z = gl_Position.w`), so it behaves as a skybox: it never clips
  against the camera far plane and fills every pixel not covered by scene
  geometry. The gradient is evaluated per-pixel from the view direction so it
  tracks the chase camera's pitch.
- **Tier 2 — atmospheric sky + sun (`Sky.applyAtmosphericSky`, what the game
  uses):** the Preetham daylight model ported from three.js's
  `examples/jsm/objects/Sky.js`, inlined so it imports only bare `three` (a
  `three/addons/*` specifier would 404 on the verbatim-copied dist `?test=`
  pages). The sun direction is the scene's directional-light position, so the
  visible sun disc and the cast shadows agree. Scattering params lean slightly
  clearer than three's ACES demo because the project runs the legacy colour
  pipeline (no tone mapping); an `exposure` uniform stands in for
  `renderer.toneMappingExposure`.
- `scene.fog` is a linear fog tinted to the horizon colour, tuned to keep the
  gameplay area crisp (`near = 140`) and fade only distant terrain / the far
  peak (`far = 750`) so the slope no longer hard-cuts at the far plane.
- Purely visual: no physics, collision, scoring, or lighting changes (the
  directional light and its shadows are untouched).
- The exact sky look (turbidity / rayleigh / exposure / fog tint) was set under
  the legacy pipeline and is tunable — eyeball on-device and adjust the
  constants in `src/sky.ts` if needed.

### Skiing skill — parallel turns & hop turns (completes #48)
- Added the two remaining ski techniques from #48 (P1 of [`ROADMAP.md`](ROADMAP.md)),
  on top of the carve/skid/snowplow/tuck model: **parallel turns** and **hop turns**.
- **Parallel turn** — the mastery tier above a carve. Once a committed carve locks
  the edge fully in (`carveCharge > 0.85`, the `PARALLEL_LOCK` threshold), the
  always-on turn tax fades out so a perfectly-held turn is nearly free, and the HUD
  reads `🎿 Parallel`. The snowman draws its skis together and rolls them onto edge
  (angulation), visually distinct from the beginner snowplow wedge. The pose is
  cosmetic; the only physics change (tax relief) is confined to `carveCharge > 0.85`,
  so carve/skid feel below that — and the gating carve-vs-skid check — are unchanged.
- **Hop turn** — Jump **+** Left/Right while grounded performs a quick edge-set
  pivot instead of a straight jump: it snaps the heading ~0.4 rad toward the steer
  direction, scrubs ~18% of speed, gives a small pop, and lands you on a fresh edge
  committed to the new line (`carveCharge` reset). It trades speed for a sharper
  direction change than carving can give — the steep-terrain / tight-spot move.
  Plain Jump (no steer) is unchanged.
- Determinism preserved: both mechanics are gated behind steering or jump+steer
  input, so no-input coasting stays byte-for-byte identical to the frozen baseline.
  The verification harness gains two **gating** checks — a held committed carve must
  reach the `parallel` tier, and a hop turn must pivot far harder than a plain steer
  frame *and* scrub speed. `npm test` (incl. verify + contract) and the 87-test
  browser suite stay green.

### Skiing skill — carve vs. skid speed trade-off (#48 / #54)
- Deepened the ski-technique model (P1 of [`ROADMAP.md`](ROADMAP.md)) from the
  intentionally-thin #56 first pass into a real speed-management trade-off: a
  committed carve holds speed, while panic-steering (reversing the edge or
  yanking a fresh one) scrubs it.
- Added a `carveCharge` edge-engagement state that builds while the player holds
  one steering direction (~0.66 s to lock in) and collapses on any reversal; the
  edge wash-out scales down with it, plus a small always-on turn tax so
  straight-lining stays the fastest line. The HUD `technique` now reads `carve`
  only once the edge is locked, otherwise `skid`.
- No-input coasting stays byte-for-byte identical to the frozen baseline (the
  load-bearing verification invariant). The verification harness's old
  terrain-dependent "turn vs. coast" diagnostic is replaced by a **gating**
  carve-vs-skid check: linked carves must finish meaningfully faster (>12%;
  measured ≈40%) than chatter-skidding the same fall line.

### Gameplay
- Large exposed rocks now participate in collision detection with a distinct rock
  crash reason, while small half-buried stones remain decorative terrain detail.
- Rock collision data is returned from terrain generation and threaded through the
  typed physics wrapper so the behavior lands cleanly after the TypeScript
  migration stack.
- Collidable rocks are kept off the central ski line (`|x| < 5`) and the spawn
  pocket (within 10u of the start) so the unseeded random placement can never wall
  off the run or crash the player on spawn; decorative rocks still render anywhere.

### Honest full-source coverage — Node + browser merged (#122)
- `npm run test:coverage` now runs c8 with `--all --src src`, so the Node and
  verification suites count every migrated `src/` file instead of only the ones
  Node tests `import`.
- The browser suite collects Chromium V8 coverage (`BROWSER_COVERAGE=1` →
  `tests/coverage/browser-coverage.js`) and attributes it back to `src/*.ts` via
  Vite's inline source maps. `tests/coverage/merge-lcov.js` line-merges that with
  the c8 LCOV into a single `coverage/lcov.info` (`npm run test:coverage:all` runs
  the whole pipeline; CI runs it across the existing test/browser steps).
- Line-level merge is deliberate: c8 instruments Node's type-stripped `.ts` while
  Vite instruments its esbuild output, so the two emit different statement
  structures for the same file; an Istanbul-object merge would mis-attribute hits.
- Net effect: browser-only modules (snowglider, course, effects, main, the boot
  and start-menu modules) and the auth/scores browser suites now report real
  coverage instead of `0%`; the merged report rose from ~28% (Node-only) to ~76%.
  Coverage stays informational and non-gating (`fail_ci_if_error: false`, no
  threshold); the Codecov badge is re-enabled now that the denominator is honest.

### TypeScript migration — Phase 2 (conversion) complete (#84)
- Every game module is now an ES module that imports `three` from npm (the CDN
  UMD global is gone) and imports the others directly. The final classic module
  `audio.js` was converted, and the last consumers reading it as a global — the
  boot script-loader (`src/boot/script-loader.js`) and the start menu
  (`src/ui/start-menu.js`) — became ES modules that `import { AudioModule }`.
- **All per-module `window.*` namespace bridges are retired** (`THREE`,
  `Avalanche`, `Camera`, `Controls`, `CourseModule`, `EffectsModule`,
  `Snow`/`Utils`, `Snowman`, `Mountains`, `Trees`, the `getTerrainHeight*`
  samplers, and finally `AudioModule`). Remaining `window.*` handles are
  deliberate boot/auth/test seams, not module-namespace bridges.
- Build, lint, `tsc --noEmit`, the Node suite, and the puppeteer browser suite
  stay green; the Vite bundle and `CNAME`/Pages artifact are unchanged.

### Onboarding / start screen
- **Self-updating build badge.** The hand-maintained `build-id` meta (stuck at
  `2025.10.06-mobile-audio-v3`) is now a `dev` placeholder that the new
  `inject-build-id` Vite plugin rewrites to the actual build timestamp at
  serve/build time — so it can never go stale again. The badge also moved off the
  primary "Start Game" CTA into an unobtrusive footer (`#buildBadge`).
- **Refreshed copy** for the description and About panel to match the shipped
  game (checkpoints, split times, ghost racing, the avalanche chase) instead of
  the old "go downhill, avoid trees" framing; removed a stale `TODO` comment.
- **Touch-controls note** added below the keyboard controls guide.
- **Global Top Times preview** on the start screen (`#startLeaderboard`),
  populated from `ScoresModule.getLeaderboard()` once scores load; hidden when no
  leaderboard is available (file:// / localhost / offline).
- **Optional sign-in** surfaced on the start screen: the existing
  `#authContainer` (login ↔ profile, managed by `auth.js`) is lifted above the
  start overlay via a `body.start-screen-active` class, plus a hint pointing to
  it. No auth wiring is duplicated — the start menu only reads auth/score state.

### Documentation
- Added [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`PHYSICS.md`](PHYSICS.md);
  folded the `docs/` implementation and audio reports into this changelog.

---

## Skill & Structure layer — gates, ski technique, avalanche drama, ghost racing (#56)

The roadmap's top recommendation: turn a pleasant Three.js snowman demo into a
game with skill, tension, and a reason to replay — shipped *before* more content.

**Files:** new `course.js` (~560 lines) and `effects.js` (~190 lines); modified
`snowman.js`, `snowglider.js`, `index.html`. No new dependencies, no build step,
no changes to the Firebase/auth/audio/scores subsystems.

### Added — a legible, timed course (`course.js`)
- **Checkpoint gates** at `z = -60, -105, -150` plus a gold **finish arch** at
  `z = -195`. Gates are **purely decorative — they never collide**, so they can't
  fight the tree-collision system.
- **Progress bar + "m to finish"** HUD (1 world unit = 1 m, ~180 m course).
- **Live split times** at each checkpoint with ±delta vs. your best split
  (green/red), and a **result screen** with total time, medal, improvement line,
  and a per-checkpoint split table.

### Added — ghost racing & progression (`course.js`)
- Your best run's trajectory is recorded (~20 Hz) and replayed as a translucent
  blue **ghost**, with an AHEAD/BEHIND-by-seconds readout at your current depth.
- **Medals** relative to your own pace (first descent / new record / silver within
  +10% / bronze within +25% / finished) — robust without a hand-tuned global par.
- Best splits (`snowgliderBestSplits`) and the ghost (`snowgliderGhost`) persist to
  `localStorage`, committed **only when a run beats the stored best**. Complements,
  and does not change, the existing `snowgliderBestTime` flow.

### Changed — skiing skill, not just steering (`snowman.js`)
- **Snowplow brake (Down):** decelerates along the actual direction of travel,
  shedding real speed while granting tighter, planted turns; skis form a wedge.
- **Carve vs. skid (Left/Right):** smooth turns hold speed; hard turns at speed
  wash the edges out and scrub speed, scaled by speed and grip.
- **Tuck (Up, no steer):** least friction, most speed, least control.
- No keys added or remapped. See [`PHYSICS.md` §3](PHYSICS.md) for the model.

### Added — avalanche telegraphing & game feel (`effects.js`)
- Red **warning banner** (escalates to "RIGHT BEHIND YOU!"), a **danger meter**
  showing metres behind you, a red **vignette**, and **camera shake** that all
  scale with proximity — driven by the avalanche system's existing
  `getClosestDistance()`/`active`, so `avalanche.js` was unchanged.
- **Speed-based FOV** (75°→88°) and landing/proximity camera shake. All motion
  respects `prefers-reduced-motion`.

### Design note — the test-safe physics seam
The ski-technique model is layered so that **with no steering/brake input the
grounded physics is byte-for-byte identical to the original**, preserving the
existing test suite. This is verified, not assumed:
`tests/verification/physics_invariant_harness.js` reports max abs trajectory
difference `0` for the coasting case and gates its exit code on it. See
[`PHYSICS.md` §6](PHYSICS.md).

### Verification
- Node regression suite **31/31** (terrain 7, physics 6, regression 5,
  tree-collision 3, avalanche 10), before and after.
- Physics-invariant harness: coasting identical; snowplow brakes to a near-stop;
  edge scrub active under steering.
- DOM smoke test **16/16** (jsdom + mocked THREE): both modules build their DOM,
  the per-frame loop runs, every checkpoint and the finish are reached, ghost and
  splits persist, and a faster second run is reported as a new record.
- Puppeteer suite **51/51** against the integrated game.

### Deliberately out of scope (follow-ups)
Ski snow-trails, a day→night skybox and weather, a "Yeti" chaser, arcade
power-ups, and the AI-coach / natural-language course ideas.

---

## Audio

SnowGlider now has two independent audio subsystems: **background music** (a
single track on a native HTML5 `<audio>` element — see below) and, new in #158,
**procedural sound effects** (`src/sfx.ts`). Music has a long, troubled history
across three implementations and is currently the **simplified native HTML5**
implementation; the `AUDIO_ENABLED` flag in [`src/audio.js`](src/audio.js) gates
it, and `CLAUDE.md` documents the operational guidance for re-enabling/testing on
mobile.

### Procedural sound effects (#158, Jun 2026)
A new `src/sfx.ts` engine adds the long-open "sound effects beyond music" item:
wind/whoosh that scales with speed, a ski-edge swish keyed off the carving
technique, an avalanche rumble that crescendos as the slide closes in, and
jump/land/crash/finish one-shots. Every effect is **synthesised at runtime** from
Web Audio oscillators + filtered noise, so it ships **zero binary assets**.

Deliberately separate from the music and from the THREE.Audio/Howler approaches
that caused the failures below: effects need low-latency, overlapping one-shots,
which raw Web Audio handles well and HTML5 `<audio>` does badly. The
`AudioContext` is created/resumed only inside the start/restart-button gesture
(`Sfx.unlock()`) — the thing modern mobile actually requires — and the single
mute button now governs both subsystems (shared `snowgliderMuted` key). It is
inert without Web Audio (Node/jsdom) and gated off under automation unless a test
opts in (`window.testHooks.sfxEnabled`), mirroring `debris`/`intro`, so the
physics-invariant harness and every existing suite keep their byte-identical,
music-only path. Tests: `npm run test:sfx` (27 headless unit assertions on the
exported gain-mapping pure functions + the defensive no-op/mute behaviour) plus a
live-`AudioContext` section in the browser audio suite. **iOS silent-switch and
real-device mobile playback are not yet verified** — same caveat as the music.

### Simplified native HTML5 audio (Jan 2026)
A deliberate rewrite to the simplest thing that works: native `<audio>`, no
library. **182 lines** (down from 734), a single track (`drum_loop`), two state
variables (`muted`, `initialized`), no pre-loading (loads on first play), no
visibility-change handling (the browser manages it). Howler.js and its CDN tag
were removed, along with the conflicting `initAudioContext()` in `index.html`.
Automated audio tests updated to the simplified API: **19/19 passing**. Remaining:
manual verification on real iOS/Android devices.

### Audio disabled on main — `ccdbad4` (Jan 26 2026)
After ~10 months and 8+ fix attempts, audio was intentionally disabled on `main`
(`AUDIO_ENABLED = false`, all public methods early-exit) while the approach was
reconsidered — which led to the simplified rewrite above.

### Howler.js migration — `88ee638` (Nov 23 2025)
Migrated from THREE.Audio to Howler.js for better mobile/iOS handling (automatic
unlock, HTML5-audio fallback, `onplayerror`/`onloaderror`). Public `AudioModule`
API kept stable; `addAudioListener()` became a no-op. **It did not solve the
problems** — see root-cause notes below.

### Initial Three.js audio — `1e3bf97` (Apr 2025)
First implementation using `THREE.AudioListener`/`AudioLoader`/`Audio`.

### Why it kept failing (root-cause notes, kept for whoever re-enables audio)
- **THREE.Audio:** thin Web-Audio wrapper with no mobile-quirk handling; required
  manual `AudioContext.resume()` at exactly the right time; no HTML5 fallback.
  Mobile contexts suspended and wouldn't reliably resume; no reliable iOS silent-
  switch detection; inconsistent autoplay-policy enforcement; flag sprawl.
- **Howler.js:** `html5: true` (needed for iOS) raised latency → audible lag;
  Howler's own `AudioContext` fought the page's temporary unlock context; pre-load
  vs. lazy-load race conditions; visibility-change resume sometimes failed silently
  with no retry. Code grew to 734 lines with overlapping flags.
- **Takeaway / current approach:** the simplest native implementation (Option 1)
  was chosen over Tone.js or raw Web Audio. When re-enabling, test thoroughly on
  iOS Safari (silent switch on/off), Android Chrome, and desktop, and verify the
  unlock happens inside a user gesture.

### References
- Howler.js: https://howlerjs.com/ · https://github.com/goldfire/howler.js
- Autoplay policy: https://developer.chrome.com/blog/autoplay/
- Web Audio API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

---

## Earlier improvements

Foundational work that predates the structured entries above, consolidated here
from the README. Audio-related items live in the [Audio](#audio) section.

### Gameplay, terrain & effects
- Avalanche system: snow boulders triggered when traveling far enough downhill,
  with physics simulation and burial detection (game over on collision).
- Converted the terrain from a groomed ski run to a natural backcountry mountain;
  distributed trees and rocks across the whole mountain; strengthened the downhill
  gradient for a consistent skiing experience.
- Fixed tree-collision detection in the extended terrain areas.
- Enhanced the snow particle effects.

### Camera
- Improved camera tracking with smooth transitions.

### Auth & leaderboard
- Added Firebase authentication and a user account system; a global leaderboard
  with the top 10 player times; and automatic score syncing between `localStorage`
  and Firebase.
- Split scoring/leaderboard into a separate `scores.js` module, with clearer
  separation of concerns and backward-compatible interfaces.
- Hardened error handling and Firebase service-availability management.
- Mobile auth: improved Chrome popup handling, popup-blocked / cancellation
  recovery with automatic retry, an optimized mobile auth flow, responsive visual
  feedback, and a debug overlay (`?debug=auth`).

### Mobile & controls
- Mobile-friendly touch controls with on-screen visual indicators; an adaptive
  layout for screen size / orientation; and automatic mobile-device detection.

### UI
- Collapsible Game Controls panel matching the Game Stats panel; consistent
  left/right swipe gestures to collapse panels; and cross-device fixes for the
  collapsible panels.

### Code structure & testing
- Renamed `utils.js` → `snow.js`; extracted tree logic into `trees.js`; separated
  the snowman into its own module.
- Added comprehensive test hooks for verifying game mechanics.
