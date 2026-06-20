# ❄️ SnowGlider ❄️

[![CI/CD](https://github.com/den-run-ai/snowglider/actions/workflows/ci.yml/badge.svg)](https://github.com/den-run-ai/snowglider/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/den-run-ai/snowglider/branch/main/graph/badge.svg)](https://codecov.io/gh/den-run-ai/snowglider)

A cheerful snowman shredding mountain snow powder in a playful Three.js animation. ⛄️🎿

www.snowglider.ai



https://github.com/user-attachments/assets/6eed3feb-0352-42bc-9768-91654e93b5e1




## Overview
SnowGlider is a Three.js-based skiing game featuring a snowman gliding down a procedurally generated mountain. The game includes realistic physics, terrain generation, tree obstacles, and specialized camera tracking.

## Features
- Smooth snowman skiing with realistic physics and terrain interaction
- Procedurally generated backcountry mountain terrain with natural features
- Tree and exposed-rock obstacle detection with collision physics
- **Avalanche system** - triggered when player travels far enough downhill, with tumbling snow boulders that can bury the player (game over)
- Snow particle effects that respond to speed and turning
- Cinematic intro fly-over of the mountain at game start (skippable)
- Tracking camera that follows the snowman's movements
- Background music (simplified native HTML5 audio; see the audio history in [`CHANGELOG.md`](docs/CHANGELOG.md))
- Timer with best time tracking
- Comprehensive test suite for verifying game mechanics

## Roadmap
[`ROADMAP.md`](docs/ROADMAP.md) tracks the feature roadmap and gap analysis — a phased P0–P3 plan mapped to the open [GitHub issues](https://github.com/den-run-ai/snowglider/issues). The **P0 "skill & structure" layer** (checkpoint gates + finish line, split timing, a result screen, ghost racing, an avalanche warning UI, and a first ski-technique pass) shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56); see [`CHANGELOG.md`](docs/CHANGELOG.md) for that work.

## Documentation
- [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module system, load order, the per-frame game loop, and the Firebase/scoring subsystem
- [`PHYSICS.md`](docs/PHYSICS.md) — terrain, skiing, jumps, collisions, and the avalanche model, with a constants reference
- [`CHANGELOG.md`](docs/CHANGELOG.md) — notable changes, including the skill/structure layer (#56) and the full audio history
- [`tests/README.md`](tests/README.md) — test types, commands, and the verification harness
- [`ROADMAP.md`](docs/ROADMAP.md) — feature roadmap and gap analysis (incl. the now-shipped R2/R3 refactor stages)

> The TypeScript/ES-module migration and the three.js r134→0.184 upgrade are
> complete; the current module architecture lives in
> [`ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project Structure
- `index.html` - Main entry point and HTML structure (loads the Vite ES-module bundle entry `src/main.ts` plus the boot/UI module scripts)
- `auth.html` - Standalone authentication page
- `styles/` - Page-level CSS for the static site shell
- `src/` - Application TypeScript ES modules (bundled by Vite):
  - `boot/` - Classic-script local-auth fallback + Firebase bootstrap (`.js`), and `script-loader.ts` (the startup driver: sequences auth, the orchestrator import, and audio preload)
  - `ui/start-menu.ts` - Start/about menu behavior
  - `snowglider.ts` - Core game loop and initialization
  - `snowman.ts` - Snowman model creation and physics
  - `mountains.ts` - Terrain generation and mountain features
  - `trees.ts` - Tree creation and placement
  - `avalanche.ts` - Avalanche system with snow boulder physics and burial detection
  - `course.ts` - Course structure: checkpoint gates, split timing, ghost racing, and result screen
  - `effects.ts` - Avalanche warning UI (banner, danger meter, vignette) and camera juice (speed FOV, shake)
  - `intro.ts` - Cinematic "fly over the mountain" intro at game start (skippable; skipped under test/automation/reduced-motion)
  - `camera.ts` - Camera management and tracking
  - `snow.ts` - Utility functions and snow effects
  - `controls.ts` - Keyboard and touch controls
  - `audio.ts` - Background music and sound control system
  - `auth.ts` - Firebase authentication and user management
  - `scores.ts` - User scoring and leaderboard functionality
- `assets/` - Media (audio, video) tracked with Git LFS
- `tests/` - Testing framework for game components
- `tests/verification/` - Headless physics-invariant and DOM smoke harnesses (run via `npm run test:verify`)
- `docs/` - Project documentation: `ARCHITECTURE.md`, `PHYSICS.md`, `CHANGELOG.md`, `ROADMAP.md` (see [Documentation](#documentation))

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
Run the Node suite with `npm test`; in-browser suites load via `?test=…` URL parameters. See [`tests/README.md`](tests/README.md) for the full test matrix, the browser parameters, the verification harness, and per-suite details.

Coverage is reported to Codecov against the entire `src/` tree and is
intentionally non-gating in CI. It combines two passes: `npm run test:coverage`
measures the Node + verification suites with c8 (`--all --src src`), and the
browser suite collects Chromium V8 coverage that is mapped back to `src/*.ts` and
line-merged into the same `coverage/lcov.info`. Run the whole pipeline locally
with `npm run test:coverage:all`. Browser-only modules are therefore counted, not
shown as `0%`; remaining gaps reflect untested code rather than uninstrumented
files.

## Development

### Local Development Setup
1. Clone the repository
2. Install dependencies with `npm ci`
3. Run locally using one of these options:
   - **Option 1:** `npm run dev` — Vite dev server (full features)
   - **Option 2:** `npm start` — the same Vite dev server, pinned to port 8080 (full features)
   - Direct `file://` opens are not supported after the ES-module migration.

#### Local Development Notes
- **Server mode (`npm run dev` or `npm start`):**
  - Runs on `localhost` with HTTP protocol
  - Firebase Authentication works, but Firestore service is automatically disabled to prevent connection errors
  - A "Local Dev Mode: Firestore disabled" indicator will be displayed in the bottom-right corner
  - Best times are stored in localStorage and can be synced to Firebase when online

- **Direct browser mode (opening `index.html` directly):**
  - Not supported. Browser module graphs and the import map do not load reliably from a `file://` origin.
  - Use `npm run dev`, `npm start`, or `npm run build` plus a static server.

### Firebase Setup and Deployment

#### Firebase Configuration
1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/)
2. Enable the sign-in providers you want in the Firebase console. SnowGlider wires
   buttons for Google, GitHub, Apple, and Anonymous ("Play as Guest"):
   - **Google** / **Anonymous** — enable in Authentication → Sign-in method (no extra setup).
   - **GitHub** — register a GitHub OAuth app and paste its client ID/secret into Firebase.
   - **Apple** — requires a paid Apple Developer account and an Apple Service ID.
   A provider button whose backend isn't enabled simply errors on click; `auth.ts`
   skips any button absent from the DOM, so you can ship buttons incrementally. Guests
   are anonymous: their best time stays local and is backfilled to the leaderboard only
   if they later upgrade to a real provider (same uid, via account linking).
3. Create a Firestore database in the Firebase console
4. Register your web app in Firebase to get configuration keys
5. Update the Firebase configuration in `src/boot/firebase-bootstrap.js`:

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

Firestore Security Rules are tracked in `firestore.rules`. Run
`npm run test:firebase` to validate the rules against the Firebase emulator
(requires a local Java runtime).

#### GitHub Pages Deployment
1. Push your changes to GitHub repository
2. Enable GitHub Pages in repository settings
3. Make sure to add your GitHub Pages domain to the authorized domains in Firebase Authentication settings
4. The CI workflow runs tests, builds the Vite static artifact with `npm run build`, and deploys `dist/` to GitHub Pages after the test job succeeds
5. Your game will be accessible at `https://[your-username].github.io/[repo-name]/`

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
- Direct `file://` opens are no longer a supported run mode.
- Use `npm run dev`, `npm start`, or serve the `dist/` output from `npm run build`.

### GitHub Pages Deployment
- The GitHub Pages deployment will continue to work normally with the full set of features
- Authentication and leaderboard functionality will work properly on GitHub Pages as it uses HTTPS
- No special configuration is needed for GitHub Pages beyond the existing Firebase domain authorization
