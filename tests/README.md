# SnowGlider Tests

This directory contains tests for the SnowGlider game. The tests are designed to verify core game functionality including terrain generation, physics, collision detection, and user controls.

## Test Types

There are seven main types of tests:

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
   - Tests for Howler.js audio integration
   - Audio loading and playback verification
   - Audio controls (mute, volume, track switching)
   - Audio context state management
   - Mobile audio unlock patterns

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

## Running Tests

### Command-line Tests

Run all tests:
```bash
npm test
```

Run specific test categories:
```bash
npm run test:terrain        # Run terrain tests only
npm run test:physics        # Run physics tests only
npm run test:regression     # Run regression tests only
npm run test:tree-collision # Run tree collision tests only
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

## Test Implementation Details

- **Command-line tests** use Node.js with minimal dependencies to test core functionality.
- **Browser tests** run in the actual game environment to test integrated behavior.
- **Audio tests** verify the Howler.js audio system integration:
  - **Test 1: Audio Loading and Playback** - AudioModule initialization, pre-loading, buffer management, track setting
  - **Test 2: Audio Controls** - Mute/unmute toggle, volume control (min/max/custom), sound enable/disable, track switching
  - **Test 3: Audio Context State Management** - Howler.js availability, context existence, state validation, resume functionality, retry UI
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