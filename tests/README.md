# SnowGlider Tests

This directory contains tests for the SnowGlider game. The tests are designed to verify core game functionality including terrain generation, physics, collision detection, and user controls.

## Test Types

There are three main types of tests:

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

## Running Tests

### Command-line Tests

Run all tests:
```bash
npm test
```

Run specific test categories:
```bash
npm run test:terrain   # Run terrain tests only
npm run test:physics   # Run physics tests only
```

### Browser Tests

1. Open the game with the test parameter:
```
open index.html?test=true
```
   Or load the game in a browser with `?test=true` appended to the URL

2. The tests will run automatically and display results in the top-left corner of the screen

## Test Implementation Details

- **Command-line tests** use Node.js with minimal dependencies to test core functionality.
- **Browser tests** run in the actual game environment to test integrated behavior.
- The tests are designed to be non-invasive and not require modifications to the core game code.