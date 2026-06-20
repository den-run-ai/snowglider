# SnowGlider - Coding Assistant Guidelines

> This file is the single source of truth for AI coding assistants. `AGENTS.md` is a
> symlink to this file, so Claude Code and Codex (and other agents) read identical guidance.

## Project Overview
SnowGlider is a Three.js animation/game featuring a snowman skiing on natural backcountry mountain terrain. It is a **Vite-bundled, ES-module TypeScript** app — the TypeScript migration is complete (all `src/` is `.ts` under `"strict": true`): `index.html` loads the bundle entry `src/main.ts` (plus the `boot/`/`ui/` module scripts) as `<script type="module">`, and `npm run build` emits static `dist/` output for GitHub Pages. The core files are:
- `index.html` - Main entry point and UI (loads the Vite bundle entry `src/main.ts`)
- `auth.html` - Standalone Firebase authentication page (loads the `auth.ts` module)
- `src/main.ts` - ES-module bundle entry; imports every game module into one graph
- `src/snowglider.ts` - Game logic and Three.js implementation (the orchestrator)
- `src/physics.ts` - Typed per-frame `PlayerState` layer over the `snowman.ts` kernel
- `src/snow.ts` - Utility functions and snow effects
- `src/mountains.ts` - Natural backcountry terrain generation code
- `src/trees.ts` - Tree creation and placement throughout the mountain
- `src/avalanche.ts` - Avalanche system with snow boulder physics and burial detection
- `src/course.ts` - Checkpoint gates, split timing, ghost racing, and result screen
- `src/effects.ts` - Avalanche warning UI and camera juice (speed FOV, shake)
- `src/intro.ts` - Cinematic "fly over the mountain" intro at game start (issue #51; skippable, skipped under test/automation/reduced-motion)
- `src/camera.ts` - Camera management system
- `src/snowman.ts` - Snowman model and physics
- `src/controls.ts` - Keyboard and touch controls implementation
- `src/audio.ts` - Background music and audio controls
- `src/auth.ts` - Firebase authentication implementation
- `src/scores.ts` - User scoring and leaderboard functionality
- `src/boot/` - Classic-script local-auth fallback + Firebase bootstrap (the only remaining `.js`), and `script-loader.ts` (startup driver)
- `assets/` - Media (audio, video) tracked with Git LFS
- `tests/` - Test files for terrain, physics, camera, avalanche, and collision detection
- `tests/verification/` - Headless physics-invariant and DOM smoke harnesses (`npm run test:verify`)
- `docs/ARCHITECTURE.md` - Module system, load order, game loop, and Firebase/scoring subsystem
- `docs/PHYSICS.md` - Terrain, skiing, jumps, collision, and avalanche simulation model
- `docs/CHANGELOG.md` - Notable changes, including the skill/structure layer (#56) and the audio history
- `docs/ROADMAP.md` - Phased P0–P3 feature roadmap and gap analysis (includes the now-shipped R2/R3 refactor stages)

## Commands
- Install dependencies: `npm ci`
- Run development server: `npm start` (Vite dev server on port 8080) or `npm run dev`
- Open locally through a server (`npm run dev`, `npm start`, or serve `dist/` after `npm run build`).
  These go through Vite, which transpiles the TypeScript modules (Phase 3); a plain static
  file server can no longer serve raw `src/` once any module is `.ts`.
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
- Browser tests (serve first with `npm start`, then append `?test=` — `file://` no longer works):
 - All tests: `http://localhost:8080/?test=unified`
 - Camera tests: `http://localhost:8080/?test=camera`
 - Gameplay tests: `http://localhost:8080/?test=true`
 - Tree tests: `http://localhost:8080/?test=trees`
 - Avalanche tests: `http://localhost:8080/?test=avalanche`
 - Regression tests: `http://localhost:8080/?test=regression`

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
- **Include screenshots in the PR for any user-visible / UI / visual change** (new
  UI, layout, terrain/lighting/snowman visuals, share/result screens, etc.). Drive
  the real app locally (vite dev server + puppeteer with `PUPPETEER_EXECUTABLE_PATH`
  pointing at system Chrome — see [`tests/puppeteer-runner.js`](tests/puppeteer-runner.js))
  to capture the actual rendered feature, and embed the image(s) in the PR body.
  Show before/after when changing existing visuals.
- **Do not commit screenshots/PNGs into the repo tree** (keep `main` text-only;
  media uses Git LFS). Host PR screenshots off-tree and embed them by URL: push the
  PNG(s) to a throwaway `assets/*` branch via the Git Data API (create blob →
  tree → a parentless commit → `refs/heads/assets/<name>`), then embed
  `https://raw.githubusercontent.com/<owner>/<repo>/assets/<name>/<file>.png`.
  Confirm each raw URL returns HTTP 200 before relying on it in the PR body.

## Code Style Guidelines
- **Indentation**: 2 spaces
- **Semicolons**: Required at end of statements
- **Naming**: camelCase for variables/functions/methods, PascalCase for classes
- **Functions**: Use function declarations with descriptive names
- **Documentation**: JSDoc-style comments for public functions
- **Classes**: ES6 class syntax with clear method responsibilities
- **Dependencies**: Three.js via npm (`three@0.184.0`) — bundled by Vite, import-mapped from `node_modules` in raw source (no CDN); Firebase v11.5.0
- **Imports**: ES module `import`/`export` throughout; cross-module imports use a `.js` specifier that resolves to the `.ts` source (e.g. `import { Mountains } from './mountains.js'`)
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
- **Audio is enabled** via `AUDIO_ENABLED = true` in `src/audio.ts`. The current implementation is the simplified, dependency-free native HTML5 `<audio>` approach: a single background-music track (`assets/skullbeatz_bad_cat.mp3`), two state variables (`muted`, `initialized`), loaded on first play, with no visibility-change handling (the browser manages it). Howler.js and Three.js Audio were both removed.
- To disable: set `AUDIO_ENABLED = false` in `src/audio.ts` (all public methods early-exit).
- The previous Howler.js API surface is kept as no-op/Promise stubs for backward compatibility (`preloadAudio`, `playPreloadedAudio`, `resumeAudioContext`, `changeTrack`, `addAudioListener`, …), so the existing callers in `index.html` keep working without change.
- **Caveats:** the in-page audio control button CSS is still commented out in `index.html`, and while desktop and the automated suite pass, mobile playback (iOS Safari silent switch, Android Chrome) is **not yet verified on real devices** — test thoroughly there before relying on it.
- Treat audio changes as high risk: mobile browsers require a user gesture to start audio and can suspend the context.
- The full audio history (Three.js → Howler.js → disabled → native) and the root-cause analysis live in [`CHANGELOG.md`](docs/CHANGELOG.md).
- Use consistent UI patterns for collapsible panels (Game Controls and Game Stats)
- Implement horizontal swipe gestures for mobile panel interaction
- Always check for existing/duplicated event listeners when setting up UI controls

## Authentication Implementation
- Use popup-only authentication flow for all devices (mobile and desktop)
- Multiple sign-in providers wired in `auth.ts` from a `PROVIDER_BUTTONS` table:
  Google, GitHub (`GithubAuthProvider`), Apple (`OAuthProvider('apple.com')`), plus
  anonymous "Play as Guest" (`signInAnonymously`). Add a provider by extending that
  table and adding a button with the matching id; a button absent from the DOM is skipped.
  The **Apple button is currently omitted from `index.html`** (its Service ID isn't
  configured) — `PROVIDER_BUTTONS` still lists it, so re-adding the `<button
  id="appleLoginBtn">` re-enables it. Unconfigured providers also fail gracefully
  (`auth/operation-not-allowed` → friendly message, not the raw Firebase error).
- Signed-in UI is a compact **account chip** (`#profileChip`): a generated avatar
  (`renderAvatar` — the real provider photo, else initials or a snow glyph on a
  deterministic random color) + name + logout, with the provider buttons folded away.
- Anonymous guests are kept OUT of Firestore and the global leaderboard: `auth.ts`
  passes `null` to `ScoresModule.setCurrentUser` and `scores.ts` `getActiveUser()`
  skips `isAnonymous` users. A guest who later signs in with a real provider is
  upgraded in place via `linkWithPopup` (same uid), and `syncUserData` backfills
  their local best time to the leaderboard. Preserve this guard when touching auth/scores.
  For guests the provider buttons are **folded behind the chip** (click `#profileChip`
  to unfold `#authUI`) so the upgrade stays reachable without cluttering the panel.
- Set `window.FIREBASE_MANUAL_INIT = true` to prevent 404 errors 
- Implement specialized handling for popup-blocked and popup-closed-by-user errors
- Provide graceful degradation to localStorage when Firebase is unavailable
- Include visual state indicators during the authentication process
- Maintain automatic detection between development and production environments
- GitHub/Apple require server-side Firebase console config (OAuth app; Apple Service ID).
  GitHub + Google + Anonymous are enabled on the `sn0wglider` project; Apple is not,
  which is why its button is omitted for now.

## Scoring and Leaderboard Implementation
- User scoring and leaderboard functionality is managed by the ScoresModule in `scores.ts`
- AuthModule delegates to ScoresModule for all score-related operations
- Both modules maintain backward compatibility with existing code
- Best times are stored locally in localStorage by default
- When authenticated, best times are synced to Firebase Firestore
- Leaderboard displays top 10 fastest times from all players
- ScoresModule handles Firebase service availability gracefully
- Supports local development mode with localStorage fallback
- Auth and Scores modules initialize in the correct dependency order

## Avalanche System Implementation
- AvalancheSystem class in `avalanche.ts` manages snow boulder physics
- Uses THREE.InstancedMesh for efficient rendering of 120 snow boulders
- Triggered when player travels far enough downhill (distance threshold)
- Boulders spawn behind player (uphill) and tumble downhill following terrain
- Physics includes gravity, ground collision, bounce, friction, and slide acceleration
- Burial detection: collision between player and boulder = game over
- Methods: `trigger(playerPos)`, `update(dt)`, `checkBurial(playerPos)`, `hasPassed(playerPos)`, `reset()`
- Requires terrain height function via `setTerrainFunction(fn)` for terrain-aware physics
- Browser tests: serve with `npm start`, then `http://localhost:8080/?test=avalanche`

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
- Match the existing ES-module TypeScript style — every `src/` file is `.ts` under `"strict": true` (only the two classic `src/boot/*.js` bootstrap scripts stay JS).
- Use 2-space indentation and semicolons.
- Use camelCase for variables/functions and PascalCase for classes.
- Do **not** re-introduce the removed per-module `window.*` namespace bridges (`window.Mountains`, `window.Controls`, `window.Camera`, `THREE`, …) — modules `import` each other directly now. Only `window.AuthModule`/`window.ScoresModule` and the deliberate game↔test handles remain on `window` as boot/test seams (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3).
- Use `THREE.Vector3` and existing helper functions for position and terrain calculations instead of duplicating math ad hoc.
