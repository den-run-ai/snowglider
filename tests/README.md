# SnowGlider Tests

This directory contains tests for the SnowGlider game. The tests are designed to verify core game functionality including terrain generation, physics, collision detection, and user controls.

## Test Types

There are eleven main types of tests:

1. **Terrain Tests** (`terrain-tests.js`)
   - Tests for terrain height calculations
   - Downhill direction vector validation
   - Terrain gradient calculations
   - Ski path width and smoothness
   - Noise implementation

2. **Physics Tests** (`physics-tests.js`)
   - Tests for player movement physics
   - Jump mechanics and gravity
   - Collision detection
   - Boundary checks
   - Friction and deceleration

3. **Browser Tests** (`browser-tests.js`)
   - In-browser tests that run within the actual game context
   - Tests real gameplay interactions
   - Visual feedback in the browser

4. **Audio Tests** (`audio-tests.js`)
   - Tests for the native HTML5 `<audio>` integration (Howler.js was removed; see [`CHANGELOG.md`](../docs/CHANGELOG.md))
   - Module init, status, and mute/unmute
   - Volume control
   - Backward-compatibility stubs for the previous Howler.js API
   - Mute-button UI creation

5. **Auth Tests** (`auth-tests.js`)
   - Loads the real `src/auth.js` module under jsdom with mocked Firebase
   - Tests popup sign-in, touch sign-in, sign-out, and auth error handling

6. **Scores Tests** (`scores-tests.js`)
   - Loads the real `src/scores.js` module under jsdom with mocked Firestore
   - Tests score validation, local best-time storage, leaderboard reconciliation, and leaderboard filtering

7. **Regression Tests** (`regression-tests.js` and `browser-regression-tests.js`)
   - Targets specific functionality that may have regressed based on git history
   - Tests fixes for known issues to prevent regressions
   - Includes both Node.js and browser-based tests

8. **Tree Collision Tests** (`tree-collision-tests.js` and `browser-tree-tests.js`)
   - Specialized tests focused on tree collision detection issues
   - Verifies consistency between visual tree rendering and collision detection
   - Tests tree collision in extended ski run area
   - Validates snow splash effect interaction with collision detection

9. **Avalanche Tests** (`avalanche-tests.js` and `browser-avalanche-tests.js`)
   - Node.js tests for core avalanche physics and logic
   - Browser tests for avalanche UI integration
   - Tests avalanche trigger mechanics, burial detection, visual rendering
   - Verifies avalanche reset and game over behavior

10. **Verification Harness** (`tests/verification/`)
   - Headless, deterministic checks that guard the physics contract and the DOM modules
   - Run via `npm run test:verify` (also included in `npm test`)
   - See [Verification Harness](#verification-harness) below

11. **Playwright E2E** (`tests/e2e/`)
   - Cross-browser (Chromium + WebKit) end-to-end tests that drive the real game
   - Added *alongside* the Puppeteer suite, not as a replacement — for the things
     the in-page `?test=` runner can't reach: the Safari engine, real menu+keyboard
     user flows, and emulated mobile touch
   - Run via `npm run test:e2e` (not part of `npm test`; runs as its own CI job)
   - See [Playwright E2E](#playwright-e2e-cross-browser--mobile) below

## Running Tests

### Command-line Tests

Run the full Node suite:
```bash
npm test
```
This runs, in order: `test:terrain`, `test:physics`, `test:regression`,
`test:tree-collision`, `test:avalanche`, `test:auth`, `test:scores`,
`test:controls` (a stub — controls are browser-only), and `test:verify` (the
verification harness).

Run specific test categories:
```bash
npm run test:terrain        # Terrain generation / height-consistency tests
npm run test:physics        # Physics simulation tests
npm run test:regression     # Regression tests
npm run test:tree-collision # Tree collision tests
npm run test:avalanche      # Avalanche physics tests
npm run test:auth           # Auth module tests with mocked Firebase
npm run test:scores         # Scores module tests with mocked Firestore
npm run test:intro          # Intro fly-over module (path math, skip, completion)
npm run test:firebase       # Firestore Security Rules tests (requires Java)
npm run test:verify         # Verification harness (physics invariant + DOM smoke)
```

Other useful commands:
```bash
npm run test:coverage       # Node + verification suites under c8 coverage
npm run test:browser        # Puppeteer browser suite
npm run test:browser:coverage  # Puppeteer suite with Chromium V8 coverage
npm run coverage:merge      # Line-merge c8 + browser LCOV -> coverage/lcov.info
npm run test:coverage:all   # Full pipeline: c8 + browser + merge
npm run test:all            # Node suite + Puppeteer (no coverage)
```

Coverage is collected from every suite and merged into a single
`coverage/lcov.info`:

- `npm run test:coverage` passes `--all --src src` to c8 so the Node and
  verification suites count every source file in the migrated `src/` tree, not
  only files imported by Node tests.
- `npm run test:browser:coverage` sets `BROWSER_COVERAGE=1`, so
  `tests/puppeteer-runner.js` records Chromium V8 coverage while the unified
  browser suite runs. `tests/coverage/browser-coverage.js` converts that V8
  coverage to Istanbul/LCOV, using Vite's inline source maps to attribute it back
  to `src/*.ts` lines, and writes `coverage/browser/lcov.info`.
- `npm run coverage:merge` (`tests/coverage/merge-lcov.js`) unions the two reports
  at the LCOV line level — required because c8 (Node type-stripping) and Vite
  (esbuild) emit different statement structures for the same file, so an
  Istanbul-object merge would mis-attribute hits.

This keeps Codecov honest: browser-only game modules are counted instead of
showing as `0%`. The auth/scores modules are exercised by the browser auth/scores
suites, so they now report real browser coverage too. CI runs `test:coverage`,
then the browser suite with `BROWSER_COVERAGE`, then `coverage:merge`, and uploads
the merged LCOV to Codecov as an informational, non-gating report; no coverage
threshold is enforced.

`npm run test:firebase` starts the Firestore emulator with `firebase-tools` and
runs `firestore.rules` through `tests/firestore-rules-tests.js`. It is separate
from `npm test` because the emulator requires a local Java runtime.

### Browser Tests

Append a `?test=` parameter to the game URL to load a suite in-browser; results
display on-screen. The game must be **served** — `npm start` runs Vite on port 8080
(the `?test=` URLs below assume that port); `npm run dev` also works but uses the
port Vite prints. After the ES-module migration the suites can no longer load from a
`file://` / `open index.html` null origin (see
[`ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §2.2). Available parameters:

| Parameter | Suite |
|-----------|-------|
| `?test=true` | Basic gameplay tests |
| `?test=trees` | Tree collision tests |
| `?test=camera` | Camera tracking tests |
| `?test=audio` | Audio playback tests |
| `?test=controls` | Controls tests |
| `?test=avalanche` | Avalanche system tests |
| `?test=regression` | Regression tests |
| `?test=unified` | All suites (controls, camera, audio, gameplay, tree, avalanche, regression) |

1. Serve the game, then open the test URL:
```
http://localhost:8080/?test=true
```
   (run `npm start` first; the suites need the Vite-served origin, not `file://`)

2. The tests will run automatically and display results in the top-left corner of the screen

### Browser Regression Tests

1. Serve the game, then open the regression test URL:
```
http://localhost:8080/?test=regression
```
   (run `npm start` first; the suites need the Vite-served origin, not `file://`)

2. The regression tests will run automatically and display results in the top-left corner of the screen

### Browser Tree Collision Tests

1. Serve the game, then open the tree tests URL:
```
http://localhost:8080/?test=trees
```
   (run `npm start` first; the suites need the Vite-served origin, not `file://`)

2. The tree collision tests will run automatically and display results in the top-left corner of the screen

### Browser Audio Tests

1. Serve the game, then open the audio tests URL:
```
http://localhost:8080/?test=audio
```
   (run `npm start` first; the suites need the Vite-served origin, not `file://`)

2. The audio tests will run automatically and display results on the screen

### Browser Avalanche Tests

1. Serve the game, then open the avalanche tests URL:
```
http://localhost:8080/?test=avalanche
```
   (run `npm start` first; the suites need the Vite-served origin, not `file://`)

2. The avalanche tests will run automatically and display results on the screen

### Unified Test Runner

Run all tests in sequence (serve first with `npm start`):
```
http://localhost:8080/?test=unified
```
   This will run all test suites (controls, camera, audio, gameplay, tree, avalanche, regression) in sequence with a unified results display

## Verification Harness

`tests/verification/` holds headless, deterministic harnesses that run under Node
(no browser) and are wired into `npm test` via `npm run test:verify`. They guard
the two contracts that the browser/Node unit tests can't easily assert end-to-end.

- **`physics_invariant_harness.js`** — loads the frozen baseline
  `snowman_baseline.js` and the live `src/snowman.js` against a shared
  deterministic terrain and a seeded RNG, then compares trajectories. The
  load-bearing check is that **coasting with no input is byte-for-byte identical**
  to the baseline (max abs difference `0`); the harness's exit code gates on it.
  It also confirms the snowplow brake and edge-skid scrub behave as designed. See
  [`PHYSICS.md` §6](../docs/PHYSICS.md) for the seam this protects.
- **`snowman_baseline.js`** — the frozen pre-feature snapshot of `updateSnowman`,
  kept as a **classic script** (global `THREE`, ends in
  `window.Snowman = { … }`, no ESM `import`/`export`) because the harness loads it via
  `vm.runInContext` and reads `window.Snowman.updateSnowman`. Regenerate it **only** on a
  deliberate physics change, and **not** by copying `src/snowman.ts` verbatim — that file
  is an ES module, so a raw `git show <ref>:src/snowman.ts > …snowman_baseline.js` would
  write `import`/`export` with no `window.Snowman` and break `npm run test:verify`. Instead
  port the changed `updateSnowman` (and the helpers it calls) into the classic-wrapper shape
  above: drop the `import * as THREE from 'three'` line (the harness supplies a global
  `THREE` stub) and the `export`s, keep the trailing
  `const Snowman = { … }; if (typeof window !== 'undefined') window.Snowman = Snowman;`
  block, re-add the file header, then re-run `npm run test:verify`.
- **`dom_smoke_test.js`** — boots `effects.ts` + `course.ts` under jsdom with a
  mocked THREE: both modules build their DOM/gates, the per-frame loop runs, every
  checkpoint and the finish are reached, the ghost trajectory and best splits
  persist, and a faster second run is reported as a new record.
- **`turn_styles_compare.js`** — drives the real `Snowman.updateSnowman` (physics
  **and** `applySnowmanPose`) to compare the two steered turns — a committed
  **carve** vs. a skidded **parallel** turn — side by side. It animates both as a
  top-down ASCII map for human review and gates the distinctions the carve-vs-parallel
  rework promises: the carve locks in (the parallel never does), the parallel pivots
  harder (tighter) while the carve draws a wider arc, the carve leans the body deeper
  and rolls/draws the skis together, and — via linked turns around the fall line —
  the carve holds clearly more speed. Run via `npm run test:turn-styles` (also
  included in `npm test`).
- **`forward_stress_harness.js`** — frame-rate robustness gate for the "floor it
  forward and blow past the obstacles" bug class (PR #209), broadened in the #209
  follow-up to a full **input × frame-rate matrix**: it drives the real kernel over the
  real terrain + procedurally placed trees **and** rocks under five input policies
  (hold-Up, deterministic slalom, time-keyed wander, an adversarial steer-into-the-
  nearest-tree, and jump-spam) at 60/30/10 FPS plus a bursty frame-hitching run (60 FPS
  with occasional 0.1 s GC-pause spikes). Gates: **no collision tunneling** (trees and
  rocks; replays each prev→cur segment against every obstacle disk), **speed does not
  balloon at low FPS under any policy** (the #209 drag bug), **no NaN/Infinity**, and
  **every descent terminates** (finish/crash/off-side, never spins — the closest proxy
  for the "freezes at the end" report). Steered-path convergence is reported as a
  diagnostic, not gated (coarse-dt Euler on the radial fall line drifts the slalom path
  by design). Run via `npm run test:stress` (also in `npm test`).
- **`avalanche_framerate_harness.js`** — frame-rate-independence gate for the avalanche
  boulder kernel (`AvalancheSystem.update`). Triggers one deterministic, seeded
  avalanche on **flat** terrain (so the grounded-slide regime — where the friction term
  dominates — shows cleanly, mirroring how the invariant harness pins the snowman on a
  synthetic slope) and asserts the 10-FPS/60-FPS front-travel ratio stays near 1 and all
  boulder state stays finite. Guards the per-frame-friction regression fixed alongside
  this harness (the same bug class as PR #209). Also run via `npm run test:stress`.
- **`fixed_timestep_harness.js`** — frame-rate **equivalence** gate for the live loop's
  fixed-timestep accumulator (`src/game/main-loop.ts`). Drives the real kernel through
  the *same* accumulator the loop uses at 30/50/144 FPS and a jittery variable rate, and
  asserts the per-fixed-step trajectory is **byte-identical** to the 60 FPS run (the
  accumulator steps physics only at 1/60, so render rate can't move the path), that every
  fixed step stays under the tree collision radius (**no tunneling by construction** —
  the `tunnelRiskFrames == 0` guarantee), and that all state stays finite. A diagnostic
  contrasts the pre-accumulator variable-`dt` loop (which drifts the path). Where
  `forward_stress_harness.js` *bounds the damage* of a variable `dt`, this proves the
  accumulator *removes the cause*. Also run via `npm run test:stress`.
- **`results.txt`** — the recorded output from the last full verification run.

```bash
npm run test:verify        # physics_invariant_harness.js + dom_smoke_test.js
npm run test:turn-styles   # carve vs. parallel turn side-by-side comparison
npm run test:stress        # forward_stress + avalanche_framerate + fixed_timestep harnesses
```

## Playwright E2E (cross-browser + mobile)

`tests/e2e/` holds Playwright specs that drive the **real game** in real browser
engines. They were added *alongside* the Puppeteer suite, not as a replacement:
the Puppeteer runner still owns the in-page `?test=` suites and the honest-coverage
pipeline, while Playwright covers what that setup structurally can't —

- **Cross-browser / Safari** — specs run on **Chromium and WebKit** (`webkit` is
  the closest CI proxy for desktop/iOS Safari; nothing ran on the Safari engine
  before). It does **not** cover the iOS hardware silent-switch audio caveat in
  `CLAUDE.md` — that still needs a real device.
- **Real user flows** — start from the menu, ski with real keyboard input, observe
  the snowman move / the timer advance / reset — black-box, not poking unit suites.
- **Mobile touch** — emulated iPhone (WebKit) verifying touch regions drive the
  shared controls state and the mobile HUD renders.

Specs (each maps to one PR commit):

- `boot.spec.ts` — boot smoke: menu loads, the three.js WebGL canvas mounts, WebGL2
  is available, no uncaught errors. (chromium + webkit)
- `gameplay.spec.ts` — start → ski downhill → timer advances; arrow keys steer;
  reset returns to start. (chromium + webkit)
- `mobile.spec.ts` — touch regions drive controls; canvas + on-screen touch
  controls render. (emulated iPhone / WebKit)

```bash
npm run test:e2e          # all specs, all projects (boots its own Vite server)
npm run test:e2e:webkit   # WebKit (Safari engine) only
npm run test:e2e:ui       # interactive Playwright UI mode
```

`playwright.config.ts` boots a dedicated Vite dev server (port 8082, separate from
the Puppeteer runner's 8081) so the two suites can run side by side. The shared
helpers in `tests/e2e/helpers.ts` use the live `window.*` game/test handles the
orchestrator re-publishes (see [`ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §3).
First run needs the browsers: `npx playwright install chromium webkit`.

`npm run test:e2e` is intentionally **not** part of `npm test`; CI runs it as its
own `e2e` job that does not gate the Pages deploy.

## Test Implementation Details

- **Command-line tests** use Node.js with minimal dependencies to test core functionality.
- **Browser tests** run in the actual game environment to test integrated behavior.
- **Audio tests** verify the native HTML5 `<audio>` integration (Howler.js was removed — see [`CHANGELOG.md`](../docs/CHANGELOG.md)):
  - **Module init & status** - `AudioModule.init()`/`isEnabled()`/`getStatus()` and default track
  - **Controls** - mute/unmute toggle and volume control
  - **Backward-compatibility stubs** - the previous Howler.js API surface (`preloadAudio`, `playPreloadedAudio`, `resumeAudioContext`, `changeTrack`, `addAudioListener`, …) is retained as no-ops/Promises so existing callers keep working
  - **UI** - mute button is created in the DOM with the correct icon
- **Regression tests** focus on specific fixes identified in the git history to prevent regressions.
- **Tree collision tests** specifically target tree collision detection issues:
  - Mismatch between tree positions in `snowglider.js` and `snow.js`
  - Tree collision in extended ski run areas (z < -80)
  - Snow splash effect interference with collision detection (fixed in commit a6d88c5)
  - Testing edge cases like jumping over trees

## Tree Collision Issue Analysis

Based on git history analysis, the tree collision detection issue stems from:

1. **Code Duplication**: There are two functions that place trees:
   - `addTreesWithPositions()` in `snowglider.js` (places trees from z=-80 to z=80)
   - `addTrees()` in `snow.js` (places trees from z=-180 to z=80)

2. **Position Mismatch**: The visual trees and collision detection trees have different ranges:
   - Visual trees exist in the extended ski run (z < -80), but collision detection doesn't check there
   - This causes "phantom trees" that are visible but don't have collision detection

3. **Coordinate Range Differences**:
   - `snowglider.js` uses x-range of ±60 units
   - `snow.js` uses x-range of ±100 units
   - This causes inconsistent tree placement

4. **Snow Effect Interference**: Fixed in commit a6d88c5, but requires testing to ensure it stays fixed

## Issue Fix

The tree collision detection issue has been fixed by:

1. **Eliminating Code Duplication**: The `addTreesWithPositions()` function in `snowglider.js` now directly calls `Snow.addTrees()` instead of duplicating the logic with different parameters.

2. **Using a Single Source of Truth**: Instead of maintaining separate tree position arrays for visuals and collision detection, we now use the tree positions returned by `Snow.addTrees()` for both purposes.

3. **Ensuring Complete Coverage**: All visible trees now have proper collision detection, including trees in the extended ski run (z < -80) and wider terrain (beyond x=±60).

The tests verify that these issues are properly detected and resolved.

The tests are designed to be non-invasive and not require modifications to the core game code.
