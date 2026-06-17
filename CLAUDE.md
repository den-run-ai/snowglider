# SnowGlider - Coding Assistant Guidelines

> This file is the single source of truth for AI coding assistants. `AGENTS.md` is a
> symlink to this file, so Claude Code and Codex (and other agents) read identical guidance.

## Project Overview
SnowGlider is a Three.js animation/game project with HTML/JS implementation featuring a snowman skiing on natural backcountry mountain terrain. It is a no-build static site: `index.html` loads the application modules from `src/` via dynamic script tags. The core files are:
- `index.html` - Main entry point and UI (loads modules from `src/`)
- `auth.html` - Standalone Firebase authentication page (loads `src/auth.js`)
- `src/snowglider.js` - Game logic and Three.js implementation
- `src/snow.js` - Utility functions and snow effects
- `src/mountains.js` - Natural backcountry terrain generation code
- `src/trees.js` - Tree creation and placement throughout the mountain
- `src/avalanche.js` - Avalanche system with snow boulder physics and burial detection
- `src/course.js` - Checkpoint gates, split timing, ghost racing, and result screen
- `src/effects.js` - Avalanche warning UI and camera juice (speed FOV, shake)
- `src/camera.js` - Camera management system
- `src/snowman.js` - Snowman model and physics
- `src/controls.js` - Keyboard and touch controls implementation
- `src/audio.js` - Background music and audio controls
- `src/auth.js` - Firebase authentication implementation
- `src/scores.js` - User scoring and leaderboard functionality
- `assets/` - Media (audio, video) tracked with Git LFS
- `tests/` - Test files for terrain, physics, camera, avalanche, and collision detection
- `tests/verification/` - Headless physics-invariant and DOM smoke harnesses (`npm run test:verify`)
- `docs/ARCHITECTURE.md` - Module system, load order, game loop, and Firebase/scoring subsystem
- `docs/PHYSICS.md` - Terrain, skiing, jumps, collision, and avalanche simulation model
- `docs/CHANGELOG.md` - Notable changes, including the skill/structure layer (#56) and the audio history
- `docs/ROADMAP.md` - Phased P0–P3 feature roadmap and gap analysis
- `docs/TYPESCRIPT_MIGRATION.md` - Incremental `@ts-check`/TypeScript migration plan and phase status
- `docs/THREEJS_UPGRADE.md` - Staged three.js upgrade plan from r160 to latest

## Commands
- Install dependencies: `npm ci`
- Run development server: `npm start` (uses http-server on port 8080)
- Open locally through a server (`npm run dev`, `npm start`, or serve `dist/` after `npm run build`).
  Direct `file://` opens are not supported after the ES-module migration because browser module graphs
  and the import map do not load reliably from a null origin.
- Run lint: `npm run lint` (eslint)
- Run all Node tests: `npm test`
- Run Node tests with coverage: `npm run test:coverage`
- Run browser tests: `npm run test:browser` (puppeteer)
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
 - Avalanche tests: `index.html?test=avalanche`
 - Regression tests: `index.html?test=regression`

## GitHub & Pull Requests (for AI agents)
- The `gh` CLI is **not installed** here and there is no `GITHUB_TOKEN`/`GH_TOKEN` env var, so `gh pr create` will fail. Do not assume you cannot open a PR.
- `git push` works because GitHub credentials are stored in git's credential helper (`osxkeychain` + `store`). Reuse that token to drive the GitHub REST API directly.
- Extract the token without printing it, then create the PR:
  ```bash
  TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | sed -n 's/^password=//p')
  curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/repos/<owner>/<repo>/pulls \
    -d '{"title":"...","head":"<branch>","base":"main","body":"..."}'
  ```
- Use the same `Authorization: Bearer $TOKEN` for other GitHub API calls (PR status, `commits/<sha>/check-runs`, comments).
- Never echo the token into normal output, logs, or commits.

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
## Audio Implementation (ENABLED — simplified native HTML5)
- **Audio is enabled** via `AUDIO_ENABLED = true` in `src/audio.js`. The current implementation is the simplified, dependency-free native HTML5 `<audio>` approach: a single background-music track (`assets/drum_loop_are_you_heaven.wav`), two state variables (`muted`, `initialized`), loaded on first play, with no visibility-change handling (the browser manages it). Howler.js and Three.js Audio were both removed.
- To disable: set `AUDIO_ENABLED = false` in `src/audio.js` (all public methods early-exit).
- The previous Howler.js API surface is kept as no-op/Promise stubs for backward compatibility (`preloadAudio`, `playPreloadedAudio`, `resumeAudioContext`, `changeTrack`, `addAudioListener`, …), so the existing callers in `index.html` keep working without change.
- **Caveats:** the in-page audio control button CSS is still commented out in `index.html`, and while desktop and the automated suite pass, mobile playback (iOS Safari silent switch, Android Chrome) is **not yet verified on real devices** — test thoroughly there before relying on it.
- Treat audio changes as high risk: mobile browsers require a user gesture to start audio and can suspend the context.
- The full audio history (Three.js → Howler.js → disabled → native) and the root-cause analysis live in [`CHANGELOG.md`](docs/CHANGELOG.md).
- Use consistent UI patterns for collapsible panels (Game Controls and Game Stats)
- Implement horizontal swipe gestures for mobile panel interaction
- Always check for existing/duplicated event listeners when setting up UI controls

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

## Avalanche System Implementation
- AvalancheSystem class in `avalanche.js` manages snow boulder physics
- Uses THREE.InstancedMesh for efficient rendering of 120 snow boulders
- Triggered when player travels far enough downhill (distance threshold)
- Boulders spawn behind player (uphill) and tumble downhill following terrain
- Physics includes gravity, ground collision, bounce, friction, and slide acceleration
- Burial detection: collision between player and boulder = game over
- Methods: `trigger(playerPos)`, `update(dt)`, `checkBurial(playerPos)`, `hasPassed(playerPos)`, `reset()`
- Requires terrain height function via `setTerrainFunction(fn)` for terrain-aware physics
- Browser tests: `index.html?test=avalanche`

## Review Guidelines
- Focus on serious correctness, security, deployment, and user-visible behavior issues.
- Flag changes that can break skiing physics, terrain height consistency, tree collision detection, avalanche behavior, camera tracking, touch controls, authentication, score syncing, or GitHub Pages deployment.
- Treat missing tests as important when gameplay mechanics, shared module contracts, Firebase behavior, or CI/CD workflows change.
- Check that GitHub Actions remain least-privileged and do not publish generated folders, dependency directories, coverage reports, test artifacts, or local-only files.
- Verify that GitHub Pages deployment runs only after the test job succeeds.
- Preserve local development and `file://` fallbacks when reviewing Firebase/auth changes.
- Treat audio changes as high risk because mobile browsers require user gestures and can suspend audio contexts.
- Prefer concrete bug findings over style-only comments. Avoid broad refactor suggestions unless they directly reduce a clear risk in the changed code.

## Style Notes
- Match the existing browser-script style unless a file already uses ES modules.
- Use 2-space indentation and semicolons.
- Use camelCase for variables/functions and PascalCase for classes.
- Preserve global module exports such as `window.Mountains`, `window.Controls`, `window.AuthModule`, and `window.ScoresModule` when touching existing modules.
- Use `THREE.Vector3` and existing helper functions for position and terrain calculations instead of duplicating math ad hoc.
