# SnowGlider Tests

This directory contains tests for the SnowGlider game. The tests are designed to verify core game functionality including terrain generation, physics, collision detection, and user controls.

## Test Types

There are eight main types of tests:

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
   - Tests for the native HTML5 `<audio>` integration (Howler.js was removed; see [`CHANGELOG.md`](../CHANGELOG.md))
   - Module init, status, and mute/unmute
   - Volume control
   - Backward-compatibility stubs for the previous Howler.js API
   - Mute-button UI creation

5. **Regression Tests** (`regression-tests.js` and `browser-regression-tests.js`)
   - Targets specific functionality that may have regressed based on git history
   - Tests fixes for known issues to prevent regressions
   - Includes both Node.js and browser-based tests

6. **Tree Collision Tests** (`tree-collision-tests.js` and `browser-tree-tests.js`)
   - Specialized tests focused on tree collision detection issues
   - Verifies consistency between visual tree rendering and collision detection
   - Tests tree collision in extended ski run area
   - Validates snow splash effect interaction with collision detection

7. **Avalanche Tests** (`avalanche-tests.js` and `browser-avalanche-tests.js`)
   - Node.js tests for core avalanche physics and logic
   - Browser tests for avalanche UI integration
   - Tests avalanche trigger mechanics, burial detection, visual rendering
   - Verifies avalanche reset and game over behavior

8. **Verification Harness** (`tests/verification/`)
   - Headless, deterministic checks that guard the physics contract and the DOM modules
   - Run via `npm run test:verify` (also included in `npm test`)
   - See [Verification Harness](#verification-harness) below

## Running Tests

### Command-line Tests

Run the full Node suite:
```bash
npm test
```
This runs, in order: `test:terrain`, `test:physics`, `test:regression`,
`test:tree-collision`, `test:avalanche`, `test:controls` (a stub — controls are
browser-only), and `test:verify` (the verification harness).

Run specific test categories:
```bash
npm run test:terrain        # Terrain generation / height-consistency tests
npm run test:physics        # Physics simulation tests
npm run test:regression     # Regression tests
npm run test:tree-collision # Tree collision tests
npm run test:avalanche      # Avalanche physics tests
npm run test:verify         # Verification harness (physics invariant + DOM smoke)
```

Other useful commands:
```bash
npm run test:coverage       # Node suite under c8 coverage
npm run test:browser        # Puppeteer browser suite
npm run test:all            # Node suite + Puppeteer
```

### Browser Tests

1. Open the game with the test parameter:
```
open index.html?test=true
```
   Or load the game in a browser with `?test=true` appended to the URL

2. The tests will run automatically and display results in the top-left corner of the screen

### Browser Regression Tests

1. Open the game with the regression test parameter:
```
open index.html?test=regression
```
   Or load the game in a browser with `?test=regression` appended to the URL

2. The regression tests will run automatically and display results in the top-left corner of the screen

### Browser Tree Collision Tests

1. Open the game with the tree tests parameter:
```
open index.html?test=trees
```
   Or load the game in a browser with `?test=trees` appended to the URL

2. The tree collision tests will run automatically and display results in the top-left corner of the screen

### Browser Audio Tests

1. Open the game with the audio tests parameter:
```
open index.html?test=audio
```
   Or load the game in a browser with `?test=audio` appended to the URL

2. The audio tests will run automatically and display results on the screen

### Browser Avalanche Tests

1. Open the game with the avalanche tests parameter:
```
open index.html?test=avalanche
```
   Or load the game in a browser with `?test=avalanche` appended to the URL

2. The avalanche tests will run automatically and display results on the screen

### Unified Test Runner

Run all tests in sequence:
```
open index.html?test=unified
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
  [`PHYSICS.md` §6](../PHYSICS.md) for the seam this protects.
- **`snowman_baseline.js`** — the frozen pre-feature snapshot of `updateSnowman`.
  Regenerate it **only** on a deliberate physics change:
  `git show <ref>:src/snowman.js > tests/verification/snowman_baseline.js`
  (re-add the file header), then re-run `npm run test:verify`.
- **`dom_smoke_test.js`** — boots `effects.js` + `course.js` under jsdom with a
  mocked THREE: both modules build their DOM/gates, the per-frame loop runs, every
  checkpoint and the finish are reached, the ghost trajectory and best splits
  persist, and a faster second run is reported as a new record.
- **`results.txt`** — the recorded output from the last full verification run.

```bash
npm run test:verify   # physics_invariant_harness.js + dom_smoke_test.js
```

## Test Implementation Details

- **Command-line tests** use Node.js with minimal dependencies to test core functionality.
- **Browser tests** run in the actual game environment to test integrated behavior.
- **Audio tests** verify the native HTML5 `<audio>` integration (Howler.js was removed — see [`CHANGELOG.md`](../CHANGELOG.md)):
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