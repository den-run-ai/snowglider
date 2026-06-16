# ❄️ SnowGlider ❄️

[![CI/CD](https://github.com/den-run-ai/snowglider/actions/workflows/ci.yml/badge.svg)](https://github.com/den-run-ai/snowglider/actions/workflows/ci.yml)
<!-- Coverage badge disabled until tests are refactored to use ES modules for proper instrumentation -->
<!-- [![codecov](https://codecov.io/gh/den-run-ai/snowglider/branch/main/graph/badge.svg)](https://codecov.io/gh/den-run-ai/snowglider) -->

A cheerful snowman shredding mountain snow powder in a playful Three.js animation. ⛄️🎿

www.snowglider.ai



https://github.com/user-attachments/assets/6eed3feb-0352-42bc-9768-91654e93b5e1




## Overview
SnowGlider is a Three.js-based skiing game featuring a snowman gliding down a procedurally generated mountain. The game includes realistic physics, terrain generation, tree obstacles, and specialized camera tracking.

## Features
- Smooth snowman skiing with realistic physics and terrain interaction
- Procedurally generated backcountry mountain terrain with natural features
- Tree obstacle detection with collision physics
- **Avalanche system** - triggered when player travels far enough downhill, with tumbling snow boulders that can bury the player (game over)
- Snow particle effects that respond to speed and turning
- Tracking camera that follows the snowman's movements
- Background music (simplified native HTML5 audio; see the audio history in [`CHANGELOG.md`](CHANGELOG.md))
- Timer with best time tracking
- Comprehensive test suite for verifying game mechanics

## Roadmap
[`ROADMAP.md`](ROADMAP.md) tracks the feature roadmap and gap analysis — a phased P0–P3 plan mapped to the open [GitHub issues](https://github.com/den-run-ai/snowglider/issues). The **P0 "skill & structure" layer** (checkpoint gates + finish line, split timing, a result screen, ghost racing, an avalanche warning UI, and a first ski-technique pass) shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56); see [`CHANGELOG.md`](CHANGELOG.md) for that work.

## Documentation
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — module system, load order, the per-frame game loop, and the Firebase/scoring subsystem
- [`PHYSICS.md`](PHYSICS.md) — terrain, skiing, jumps, collisions, and the avalanche model, with a constants reference
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes, including the skill/structure layer (#56) and the full audio history
- [`tests/README.md`](tests/README.md) — test types, commands, and the verification harness
- [`ROADMAP.md`](ROADMAP.md) — feature roadmap and gap analysis

## Project Structure
- `index.html` - Main entry point and HTML structure (loads modules from `src/`)
- `auth.html` - Standalone authentication page
- `src/` - Application JavaScript modules:
  - `snowglider.js` - Core game loop and initialization
  - `snowman.js` - Snowman model creation and physics
  - `mountains.js` - Terrain generation and mountain features
  - `trees.js` - Tree creation and placement
  - `avalanche.js` - Avalanche system with snow boulder physics and burial detection
  - `course.js` - Course structure: checkpoint gates, split timing, ghost racing, and result screen
  - `effects.js` - Avalanche warning UI (banner, danger meter, vignette) and camera juice (speed FOV, shake)
  - `camera.js` - Camera management and tracking
  - `snow.js` - Utility functions and snow effects
  - `controls.js` - Keyboard and touch controls
  - `audio.js` - Background music and sound control system
  - `auth.js` - Firebase authentication and user management
  - `scores.js` - User scoring and leaderboard functionality
- `assets/` - Media (audio, video) tracked with Git LFS
- `tests/` - Testing framework for game components
- `tests/verification/` - Headless physics-invariant and DOM smoke harnesses (run via `npm run test:verify`)
- `ARCHITECTURE.md`, `PHYSICS.md`, `CHANGELOG.md` - Project documentation (see [Documentation](#documentation))

## Controls

### Keyboard Controls (Desktop)
- **Arrow Keys / WASD**: Control snowman direction
  - **Left Arrow / A**: Turn left
  - **Right Arrow / D**: Turn right
  - **Up Arrow / W**: Increase speed
  - **Down Arrow / S**: Slow down
- **Space**: Jump over obstacles
- **V**: Toggle camera view
- **Reset Button**: Start a new run

### Touch Controls (Mobile)
- **Left Side of Screen**: Turn left
- **Right Side of Screen**: Turn right
- **Top of Screen**: Increase speed
- **Bottom of Screen**: Slow down
- **Center of Screen**: Jump
- **Camera Toggle Button**: Switch camera view
- **Audio Button**: Toggle music on/off
- **Reset Button**: Start a new run

The game automatically detects mobile devices and enables touch controls with visual indicators for easier gameplay.

## Testing
Run the Node suite with `npm test`. In-browser suites run by appending a URL parameter:
- `?test=true` - Run basic gameplay tests
- `?test=trees` - Run tree collision tests
- `?test=camera` - Run camera tracking tests
- `?test=audio` - Run audio playback tests
- `?test=controls` - Run controls tests
- `?test=avalanche` - Run avalanche system tests
- `?test=regression` - Run regression tests
- `?test=unified` - Run all tests

See [`tests/README.md`](tests/README.md) for the full test matrix, the verification harness, and per-suite details.

## Development

### Local Development Setup
1. Clone the repository
2. Install dependencies with `npm install`
3. Run locally using one of these options:
   - **Option 1:** Run with local server: `npm start` (full features)
   - **Option 2:** Open `index.html` directly in your browser (limited features)

#### Local Development Notes
- **Server mode (`npm start`):** 
  - Runs on `localhost` with HTTP protocol
  - Firebase Authentication works, but Firestore service is automatically disabled to prevent connection errors
  - A "Local Dev Mode: Firestore disabled" indicator will be displayed in the bottom-right corner
  - Best times are stored in localStorage and can be synced to Firebase when online

- **Direct browser mode (opening `index.html` directly):**
  - Uses the `file://` protocol 
  - All Firebase services (Authentication and Firestore) are automatically disabled
  - A "Local File Mode: Firebase disabled" indicator will be displayed
  - Login UI is hidden and replaced with a "Local Mode" message
  - Best times are only stored in localStorage
  - Perfect for quick testing without server setup

### Firebase Setup and Deployment

#### Firebase Configuration
1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/)
2. Enable Google Authentication in the Firebase console
3. Create a Firestore database in the Firebase console
4. Register your web app in Firebase to get configuration keys
5. Update the Firebase configuration in `index.html`:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

#### Firestore Database Structure
The application uses the following Firestore collections:
- `users` - User profiles and best times
- `leaderboard` - Global leaderboard entries

#### GitHub Pages Deployment
1. Push your changes to GitHub repository
2. Enable GitHub Pages in repository settings
3. Make sure to add your GitHub Pages domain to the authorized domains in Firebase Authentication settings
4. Your game will be accessible at `https://[your-username].github.io/[repo-name]/`

## Troubleshooting

### Firebase Connection Issues
- If you see 400 errors when connecting to Firestore, ensure you're not running on `localhost` or `file://` protocol
- For local development, the app will automatically disable Firestore
- For production deployment, ensure your domain is authorized in Firebase console
- Check the browser console for specific error messages and Firebase status

### Mobile Authentication Issues
- If you're experiencing issues with the sign-in button on mobile, try the following:
  - Ensure cookies and local storage are enabled in your mobile browser
  - Try using the "Retry Login" button if it appears after a failed authentication attempt
  - Clear browser cache and cookies, then try again
  - Ensure you have a stable internet connection
- For detailed debugging:
  - Add `?debug=auth` to the URL to enable the authentication debug overlay
  - Check the debug overlay for specific error messages and authentication status
  - Console logs will provide additional details about the authentication process
- Mobile devices now use popup-based authentication for better compatibility with Chrome and other mobile browsers

### CORS Errors When Opening Directly
- If you previously saw CORS errors when opening the game directly with `file://` protocol, this has been fixed
- The game now automatically detects the file:// protocol and provides a fallback implementation
- Authentication UI is hidden in this mode and replaced with a "Local Mode" indicator
- All core gameplay features will work without authentication

### GitHub Pages Deployment
- The GitHub Pages deployment will continue to work normally with the full set of features
- Authentication and leaderboard functionality will work properly on GitHub Pages as it uses HTTPS
- No special configuration is needed for GitHub Pages beyond the existing Firebase domain authorization
