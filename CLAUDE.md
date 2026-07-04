# SnowGlider - Coding Assistant Guidelines

> This file is the single source of truth for AI coding assistants. `AGENTS.md` is a
> symlink to this file, so Claude Code and Codex (and other agents) read identical guidance.

## Project Overview
SnowGlider is a Three.js animation/game featuring a snowman skiing on natural backcountry mountain terrain. It is a **Vite-bundled, ES-module TypeScript** app — the TypeScript migration is complete (all `src/` is `.ts` under `"strict": true`): `index.html` loads the bundle entry `src/main.ts` (plus the `boot/`/`ui/` module scripts) as `<script type="module">`, and `npm run build` emits static `dist/` output for GitHub Pages. The core files are:
- `index.html` - Main entry point and UI (loads the Vite bundle entry `src/main.ts`)
- `auth.html` - Standalone Firebase authentication page (loads the `auth.ts` module)
- `src/main.ts` - ES-module bundle entry; imports every game module into one graph
- `src/snowglider.ts` - Game logic and Three.js implementation (the orchestrator)
- `src/player-state.ts` - Typed per-frame `PlayerState` layer over the `snowman.ts` kernel
- `src/snow.ts` - Utility functions and snow effects
- `src/mountains.ts` - Natural backcountry terrain generation code
- `src/trees.ts` - Tree creation and placement throughout the mountain (facade over `src/mountains/trees.ts`)
- `src/mountains/ez-forest.ts` - EZ-Tree evergreen archetype provider (issue #282): seeded low-poly pine geometry from `@dgreenheck/ez-tree` (lazy ~4 MB chunk), rendered by `trees.ts` through the shared instanced/tint/sway/snow pipeline with a static near/far LOD split. Default for players; automation/headless keep the stylized cones (`?eztrees=1` opts in, `?classictrees` opts out) so seeded RNG streams and existing suites stay byte-identical. Headless-safe (scoped `document` shim) and RNG-stream-neutral (private xorshift for THREE uuid draws); perf pinned by the `?eztrees=1` budget in `tests/e2e/perf-budget.spec.ts` (`npm run test:ez-forest` for the unit suite)
- `src/avalanche.ts` - Avalanche system with snow boulder physics and burial detection
- `src/snowtracks.ts` - Temporary ski tracks (cosmetic fading grooves, terrain-aware, never touches physics; not a snow-accumulation model)
- `src/course.ts` - Checkpoint gates, split timing, ghost racing, and result screen
- `src/effects.ts` - Avalanche warning UI and camera juice (speed FOV, shake)
- `src/intro.ts` - Cinematic "fly over the mountain" intro at game start (issue #51; skippable, skipped under test/automation/reduced-motion)
- `src/camera.ts` - Camera management system. Six viewpoint modes cycled by `V` (auto/follow/orbit/firstPerson/cameraman/drone; `toggleCameraMode()` is a back-compat wrapper that advances the cycle). Layers a full-360° orbit yaw + clamped pitch and a distance/height `zoom` multiplier on the classic follow rig — all neutral at their defaults, so spawn framing is unchanged. **Auto** recenters the orbit behind travel and frames the action *situationally* (issue #305 P3+): it eases a transient distance `autoZoom` + overhead `autoPitch` toward a target profile built from cosmetic-only signals — speed, terrain steepness (biggest pull-back + lift on **expert/steep** lines so the drop stays in shot), **jumps** (`isInAir` → pull back + lift to keep the landing framed), avalanche proximity, turn rate (tight tree-line carves pull *in*), and portrait screen aspect. The situational transients never write the persisted manual `zoom`/`orbitPitch` and are dropped on mode-change/restart, so Follow/Orbit/FP and the next run's spawn stay neutral. **Orbit** holds the player's manual yaw/pitch/zoom. **Cameraman** and **Drone** are two cinematic follow cameras (issue #315): cameraman is a low/close/side-trailing handheld chase (gentle weave), drone is a high/far slowly-circling aerial chase — both compute their own framing every frame via the pure `cinematicTargets`/`cinematicOffset` (mirroring `followOffset`'s math + terrain clamp), lean into **steep/expert terrain and jumps** with extra pull-back + overhead lift (motion-gated so the steep spawn stays neutral), and drive the deterministic oscillation/circle off the camera's own `frameCount` (no wall-clock, sim byte-identical). `usesOrbitControls(mode)` (auto/follow/orbit only) gates the manual view controls, so FP + the cinematic modes ignore Q/E/±/wheel/drag and the tray orbit/zoom widgets. The loop feeds the jump/avalanche signals via an optional `AutoFrameContext` on `cameraManager.update`; slope/turn/aspect the camera derives itself. Input (Q/E orbit, C recenter, +/−/wheel zoom, mouse-drag orbit, and the `#cameraControls` tray) is wired in `src/game/lifecycle.ts`; camera math (incl. the pure `autoFrameTargets`/`cinematicTargets` profiles) is headless-tested (`npm run test:camera`).
- `src/scenery/` - Background scenery system (issue #320): the distant, non-interactive alpine world (planned: ridge panorama, valley/frozen lake, decorative forest belts, cliff bands, imported props, ambient birds/clouds/spindrift). `scenery.ts` is the `ScenerySystem` facade (`createScenery()`); built in `game/scene-setup.ts` **after** the collision arrays, ticked cosmetic-only in the `game/main-loop.ts` render-frame zone (never the fixed physics substep), and disposed in `game/teardown.ts`. Every layer must stay **render-only, collision-neutral, physics-neutral, `Math.random`-stream-neutral, and teardown-safe**: placement draws from the seeded `makeSceneryRng()` (never global `Math.random`) and all THREE construction is wrapped in `withPrivateThreeRandom()` (`scenery-rng.ts`) so object-UUID draws can't perturb the seeded harness stream (mirrors the `getSwayDepthMaterial` guard in `mountains/trees.ts`); the seed is keyed off the run tier via `scenerySeedFor()` (`scenery-budget.ts`). Headless-tested: `npm run test:scenery` (facade/seam invariants) and `npm run test:scenery-rng` (RNG neutrality). PR 1 landed the empty integration seam; later PRs add the visual layers.
- `src/snowman.ts` - Snowman model and physics
- `src/controls.ts` - Keyboard and touch controls implementation
- `src/audio.ts` - Background music and audio controls
- `src/sfx.ts` - Procedural Web Audio sound effects (wind/carve/jump/land/avalanche/crash/finish)
- `src/diagnostics.ts` - Read-only runtime physics/frame-rate telemetry (`Diag`): catches the frame-rate-dependence bug class (#209) live — runaway low-FPS speed, per-frame steps past a collision radius (tunnel risk), NaN. Dev overlay (`?debug`), `window.__snowgliderDiag.dump()` JSON export; off under automation. See `docs/DIAGNOSTICS.md`.
- `src/ui/feedback.ts` - In-game feature-request / bug-report form (issue #258): opens a GitHub prefilled new-issue URL (keyless — the player submits under their own account) and fires a `feedback_submitted` Firebase Analytics event via the shared `window.firebaseModules.logEvent` seam. Pure helpers are headless-tested (`npm run test:feedback`); issue templates live in `.github/ISSUE_TEMPLATE/`.
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
- `.claude/skills/webgpu-threejs-tsl/` - Vendored Claude Code skill: WebGPU renderer + TSL (Three.js Shading Language) reference for any future WebGPU work. Reference docs only (excluded from eslint); provenance and local API corrections are recorded in its `UPSTREAM.md`.

## Commands
- Install dependencies: `npm ci`
- Run development server: `npm start` (Vite dev server on port 8080) or `npm run dev`
- Open locally through a server (`npm run dev`, `npm start`, or serve `dist/` after `npm run build`).
  These go through Vite, which transpiles the TypeScript modules (Phase 3); a plain static
  file server can no longer serve raw `src/` once any module is `.ts`.
  Direct `file://` opens are not supported after the ES-module migration because browser module graphs
  and the import map do not load reliably from a null origin.
- Run lint: `npm run lint` (eslint)
- Run all Node tests: `npm test` (auto-discovering runner — see below)
- Run Node tests with coverage: `npm run test:coverage`
- Run browser tests: `npm run test:browser` (puppeteer)
- Run specific tests: 
  - `npm run test:terrain` - Terrain generation tests
  - `npm run test:physics` - Physics simulation tests
  - `npm run test:regression` - Regression tests
  - `npm run test:tree-collision` - Tree collision tests
- `npm test` runs `tests/run-node-suite.js`, an **auto-discovering** runner: it finds
  every `tests/*-tests.js` and `tests/verification/*.js` suite and runs each in its own
  child `node` process. **Adding a Node suite needs no `package.json` edit — just drop
  the `tests/<name>-tests.js` file in and it's picked up.** Browser suites
  (`browser-*`, `audio`/`camera`/`controls-tests.js`) and the emulator-only
  `firestore-rules-tests.js` are intentionally skipped (documented denylists in the
  runner header). Every suite loads with the superset
  `register-firebase-mock.mjs` hook (both its sub-hooks are no-ops unless triggered),
  so no per-suite loader wiring is needed. Filter with `node tests/run-node-suite.js
  <substring>`; list with `--list`. The individual `test:*` scripts remain for
  targeted runs.
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
- **Screenshots MUST show the real PLAYER path, not the automation fallback.** The game
  intentionally serves a degraded/stylized scene under automation so seeded test streams
  stay byte-identical — most importantly, the EZ-Tree gameplay forest (`src/mountains/ez-forest.ts`)
  falls back to the stylized cone trees whenever it detects automation (`navigator.webdriver`,
  `window.isTestMode`, or a `?test=` URL). **Headless puppeteer/Playwright always set
  `navigator.webdriver = true`**, so a naive screenshot captures the *cone* forest and
  MISREPRESENTS the game (it looks like the realistic EZ trees are gone when they are not).
  Before capturing, force the player path: append `?eztrees=1` (the URL opt-in overrides the
  automation gate — see `resolveEzForestEnabled`) and/or defeat the gate in an init script
  (`Object.defineProperty(navigator, 'webdriver', { get: () => false })`). Sanity-check the
  shot before embedding it: e.g. assert the EZ branch instances actually attached
  (`terrainMesh.parent.children.some(c => c.userData.forestPart === 'ezBranches')`). Never
  use a plain `?test=` URL for a visual screenshot. The same "automation serves a reduced
  scene" caveat applies to any feature gated off under `isTestMode`/`webdriver` (intro,
  debris, sfx) — screenshot the mode the player actually sees.
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
- **Sound effects (`src/sfx.ts`, issue #158)** are a SEPARATE subsystem from the music: a procedural Web Audio engine that synthesises every effect at runtime (oscillators + filtered noise), so it ships **no binary assets**. Coverage: a speed-scaled wind/ambient bed, a ski-edge swish keyed off technique, an avalanche rumble that crescendos with proximity, and jump/land/crash/finish one-shots. Disable with `SFX_ENABLED = false` in `src/sfx.ts`.
  - The Web Audio **context is created/resumed only inside the start/restart-button gesture** (`Sfx.unlock()`), which is what mobile autoplay policy requires. iOS still routes Web Audio through the hardware silent switch — same caveat as the music; **mobile not yet verified on real devices.**
  - It is **inert without Web Audio** (Node/jsdom no-op) and **gated off under automation** (`window.isTestMode`/`navigator.webdriver`) unless a test opts in via `window.testHooks.sfxEnabled`, mirroring `debris`/`intro`, so existing tests keep their music-only, byte-identical path. Every hook reads the per-frame physics result only — never `pos`/`velocity` — so the physics-invariant harness is unaffected.
  - The single mute button (`audio.ts`) mutes BOTH subsystems via the shared `snowgliderMuted` key. Gain-mapping math lives in exported pure functions (`windGainForSpeed`, `carveGainForTechnique`, `avalancheGainForDistance`, `landGainForForce`) so it unit-tests headlessly (`npm run test:sfx`); the live-context paths are covered by the browser audio suite.
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
