# SnowGlider Tests

This directory contains tests for the SnowGlider game. The tests are designed to verify core game functionality including terrain generation, physics, collision detection, and user controls.

## Test Types

There are five main types of tests:

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

4. **Regression Tests** (`regression-tests.js` and `browser-regression-tests.js`)
   - Targets specific functionality that may have regressed based on git history
   - Tests fixes for known issues to prevent regressions
   - Includes both Node.js and browser-based tests

5. **Tree Collision Tests** (`tree-collision-tests.js` and `browser-tree-tests.js`)
   - Specialized tests focused on tree collision detection issues
   - Verifies consistency between visual tree rendering and collision detection
   - Tests tree collision in extended ski run area
   - Validates snow splash effect interaction with collision detection

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

## Test Implementation Details

- **Command-line tests** use Node.js with minimal dependencies to test core functionality.
- **Browser tests** run in the actual game environment to test integrated behavior.
- **Regression tests** focus on specific fixes identified in the git history to prevent regressions.
- **Tree collision tests** specifically target tree collision detection issues:
  - Mismatch between tree positions in `snowglider.js` and `utils.js`
  - Tree collision in extended ski run areas (z < -80)
  - Snow splash effect interference with collision detection (fixed in commit a6d88c5)
  - Testing edge cases like jumping over trees

## Tree Collision Issue Analysis

Based on git history analysis, the tree collision detection issue stems from:

1. **Code Duplication**: There are two functions that place trees:
   - `addTreesWithPositions()` in `snowglider.js` (places trees from z=-80 to z=80)
   - `addTrees()` in `utils.js` (places trees from z=-180 to z=80)

2. **Position Mismatch**: The visual trees and collision detection trees have different ranges:
   - Visual trees exist in the extended ski run (z < -80), but collision detection doesn't check there
   - This causes "phantom trees" that are visible but don't have collision detection

3. **Coordinate Range Differences**:
   - `snowglider.js` uses x-range of ±60 units
   - `utils.js` uses x-range of ±100 units
   - This causes inconsistent tree placement

4. **Snow Effect Interference**: Fixed in commit a6d88c5, but requires testing to ensure it stays fixed

## Issue Fix

The tree collision detection issue has been fixed by:

1. **Eliminating Code Duplication**: The `addTreesWithPositions()` function in `snowglider.js` now directly calls `Utils.addTrees()` instead of duplicating the logic with different parameters.

2. **Using a Single Source of Truth**: Instead of maintaining separate tree position arrays for visuals and collision detection, we now use the tree positions returned by `Utils.addTrees()` for both purposes.

3. **Ensuring Complete Coverage**: All visible trees now have proper collision detection, including trees in the extended ski run (z < -80) and wider terrain (beyond x=±60).

The tests verify that these issues are properly detected and resolved.

The tests are designed to be non-invasive and not require modifications to the core game code.