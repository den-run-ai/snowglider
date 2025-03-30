# CLAUDE.md - Coding Assistant Guidelines

## Project Overview
SnowGlider is a Three.js animation/game project with HTML/JS implementation. The core files are:
- `index.html` - Main entry point and UI
- `snowglider.js` - Game logic and Three.js implementation
- `utils.js` - Utility functions and helpers
- `mountains.js` - Terrain generation code
- `trees.js` - Tree creation and placement
- `camera.js` - Camera management system
- `snowman.js` - Snowman model and physics
- `tests/` - Test files for terrain, physics, camera, and collision detection

## Commands
- Run locally: Open `index.html` in a browser or use a simple HTTP server
- Run all tests: `npm test`
- Run specific tests: 
  - `npm run test:terrain` - Terrain generation tests
  - `npm run test:physics` - Physics simulation tests
  - `npm run test:regression` - Regression tests
  - `npm run test:tree-collision` - Tree collision tests
- Browser tests: 
  - All tests: `index.html?test=unified`
  - Camera tests: `index.html?test=camera`
  - Gameplay tests: `index.html?test=true`
  - Tree tests: `index.html?test=trees`
  - Regression tests: `index.html?test=regression`

## Code Style Guidelines
- **Indentation**: 2 spaces
- **Semicolons**: Required at end of statements
- **Naming**: camelCase for variables/functions/methods, PascalCase for classes
- **Functions**: Use function declarations with descriptive names
- **Documentation**: JSDoc-style comments for public functions
- **Classes**: ES6 class syntax with clear method responsibilities
- **Dependencies**: Three.js loaded via CDN (r128)
- **Imports**: Use ES6 module imports when adding new functionality
- **Error Handling**: Validation with boundary checks, meaningful console logging
- **Testing**: Browser-based with visual feedback, unified test runner

## Best Practices
- Follow existing patterns in the codebase
- Keep camera position and animation logic separate
- Use THREE.Vector3 for position calculations
- Include tolerances in position-based tests (±0.001 for float comparisons)
- Properly clean up THREE.js objects when no longer needed
- Maintain test isolation to prevent state interference
- Signal test completion using callbacks
- Avoid duplicating tree position logic between files