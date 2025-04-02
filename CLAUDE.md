# CLAUDE.md - Coding Assistant Guidelines

## Project Overview
SnowGlider is a Three.js animation/game project with HTML/JS implementation featuring a snowman skiing on natural backcountry mountain terrain. The core files are:
- `index.html` - Main entry point and UI
- `snowglider.js` - Game logic and Three.js implementation
- `snow.js` - Utility functions and snow effects
- `mountains.js` - Natural backcountry terrain generation code
- `trees.js` - Tree creation and placement throughout the mountain
- `camera.js` - Camera management system
- `snowman.js` - Snowman model and physics
- `controls.js` - Keyboard and touch controls implementation
- `audio.js` - Background music and audio controls
- `auth.js` / `auth.html` - Firebase authentication implementation
- `scores.js` - User scoring and leaderboard functionality
- `tests/` - Test files for terrain, physics, camera, and collision detection

## Commands
- Run development server: `npm start` (uses http-server on port 8080)
- Open locally: `open index.html` or use URL parameters for tests
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
- **Dependencies**: Three.js loaded via CDN (r128), Firebase v11.5.0
- **Imports**: Use ES6 module imports when adding new functionality
- **Error Handling**: Validation with boundary checks, meaningful console logging
- **Testing**: Browser-based with visual feedback, unified test runner
- **Firebase**: Authentication and leaderboard implementation via Firebase

## Best Practices
- Follow existing patterns in the codebase
- Keep camera position and animation logic separate
- Use THREE.Vector3 for position calculations
- Include tolerances in position-based tests (±0.001 for float comparisons)
- Properly clean up THREE.js objects when no longer needed
- Maintain test isolation to prevent state interference
- Signal test completion using callbacks
- Ensure consistent terrain height calculation between functions
- Maintain natural terrain variation while keeping it skiable
- Include downhill gradient for proper skiing experience
- Avoid duplicating tree position logic between files
- Maintain compatibility between keyboard and touch controls
- Use standard touch event handlers with { passive: false }
- Provide visual feedback for touch controls on mobile devices
- Automatically detect device type to enable appropriate controls
- Use THREE.AudioListener and THREE.Audio for game sound effects
- Store audio preferences in localStorage for persistence

## Authentication Implementation
- Use popup-only authentication flow for all devices (mobile and desktop)
- Set `window.FIREBASE_MANUAL_INIT = true` to prevent 404 errors 
- Implement specialized handling for popup-blocked and popup-closed-by-user errors
- Provide graceful degradation to localStorage when Firebase is unavailable
- Include visual state indicators during the authentication process
- Maintain automatic detection between development and production environments

## Scoring and Leaderboard Implementation
- User scoring and leaderboard functionality is managed by the ScoresModule in `scores.js`
- AuthModule delegates to ScoresModule for all score-related operations
- Both modules maintain backward compatibility with existing code
- Best times are stored locally in localStorage by default
- When authenticated, best times are synced to Firebase Firestore
- Leaderboard displays top 10 fastest times from all players
- ScoresModule handles Firebase service availability gracefully
- Supports local development mode with localStorage fallback
- Auth and Scores modules initialize in the correct dependency order