# SnowGlider — Architecture

How the pieces fit together: the static module system, load order, the global
namespace and injection seams, the per-frame data flow, and the Firebase/scoring
subsystem. For the simulation itself see [`PHYSICS.md`](PHYSICS.md); for how snow is
lit and shaded see [`SNOW_RENDERING.md`](SNOW_RENDERING.md); for tests see
[`tests/README.md`](../tests/README.md).

---

## 1. Big picture

SnowGlider is a **Vite-bundled browser app written in TypeScript**. Every module
under `src/` is a `.ts` ES module compiled under `strict: true` (issues #84/#98);
the game modules link to each other through real ES `import`s, and Vite bundles
them into the hashed `dist/` artifact deployed to GitHub Pages. `npm start` /
`npm run dev` serve the raw `.ts` source through the same Vite pipeline.
`file://` is **no longer a supported run path** for the game — the module graph
and import map don't load from a `null` origin — so the only scripts that still
run as classic (non-module) scripts are the two boot scripts in `<head>` (see §2).

Two HTML entry points:

- **`index.html`** — the game. Contains the UI markup, links `styles/main.css`,
  loads the two classic boot scripts, then loads the ES-module bundle entry
  `src/main.ts` (which import-maps/bundles three.js).
- **`auth.html`** — a standalone Firebase auth page that loads `src/auth.js` (a
  `.ts` module; Vite resolves the `.js` specifier to `auth.ts`).

All logic lives in `src/*.ts` (the only `.js` left are the two `src/boot/*`
classic scripts); page styles live in `styles/`; tests in `tests/`.
`npm run build` emits the deployable Vite artifact to `dist/`.

---

## 2. Module loading

The game modules no longer have a hand-maintained load order — they are an ES
module graph rooted at `src/main.ts`, so the bundler/browser resolves
dependencies. `index.html` loads scripts in two places.

### 2.1 Classic boot scripts (`<head>`, protocol-branching)

`src/boot/local-auth.js` and `src/boot/firebase-bootstrap.js` are the only
remaining **classic** (non-module) scripts. They branch on protocol:

- **`file://`** — Firebase is unavailable, so `local-auth.js` defines mock
  `ScoresModule`/`AuthModule` implementations (localStorage-only). The game
  modules themselves no longer load from `file://`, so this path now matters only
  as the auth/score fallback, not as a way to run the whole game offline.
- **`http(s)://`** — `firebase-bootstrap.js` `loadAuthModules()` injects
  `src/scores.js` then `src/auth.js` as `type="module"` scripts. These two are
  loaded *conditionally at runtime* (the game runs without Firebase) rather than
  from the `main.ts` bundle graph, and they fall back to the `local-auth.js`
  stubs if they don't load in time.

`firebase-bootstrap.js` also sets `window.FIREBASE_MANUAL_INIT = true` and
intercepts the `/__/firebase/init.json` fetch to stop Firebase's auto-init 404s.

### 2.2 The ES-module bundle (bottom of `<body>`)

After the markup, `index.html` loads three `type="module"` scripts (deferred, run
in document order before `DOMContentLoaded`):

- `src/main.ts` — the **bundle entry**. It eagerly `import`s every game module
  (mountains, trees, snow, camera, snowman, audio, controls, avalanche, effects,
  course) so they join the graph, and three.js is bundled by Vite (or import-mapped
  from `node_modules` in raw source). The orchestrator `snowglider.ts` imports them
  too and drives the game.
- `src/boot/script-loader.ts` — the **startup driver**, and still load-bearing for
  normal play. Its `DOMContentLoaded` handler `initializeGameScripts()` sequences
  boot: it waits for the auth fallback (`SnowGliderFirebase.waitForAuthModule()`),
  initializes Auth (`initializeAuthModule()`), then dynamically imports and runs the
  `snowglider.ts` orchestrator through `window.__loadSnowGliderOrchestrator` (set by
  `main.ts`; if the hook is missing the chain rejects rather than hanging), and
  finally announces readiness (`window.SnowGliderGameScriptsReady` + the
  `snowglider:game-scripts-ready` event) and pre-loads audio. Its
  `GAME_SCRIPT_ORDER` is now **empty** (every game module loads via `main.ts`) and
  it appends the browser-test suite only when a `?test=` parameter is present — but
  **do not mistake it for a test-only shim**: bypass or remove it outside `?test=`
  and the orchestrator never runs, so the game never starts.
- `src/ui/start-menu.ts` — owns the start/about menu handlers and forwards game
  start to `window.initializeGameWithAudio()`.

The old fixed chain (`mountains → trees → … → snowglider`) is **obsolete**:
modules resolve each other through ES imports (e.g. `camera.ts` imports
`Mountains`; `snow.ts` imports `Mountains`/`Trees`; `snowglider.ts` imports the
rest), so import order is no longer load-bearing. Test scripts are still appended
only when a `?test=` parameter is present (see [`tests/README.md`](../tests/README.md)).

> **If you add a module,** `import` it from `src/main.ts` (so it joins the bundle
> graph) and from whichever module consumes it — not from a script-order list.

---

## 3. Module exports & the global surface

Each game module `export`s a single top-level symbol that other modules `import`
by name. The per-module `window.*` namespace bridges that used to link them were
**removed in the TypeScript migration** (#84) — `camera.ts` does
`import { Mountains } from './mountains.js'`, not `window.Mountains`. The exports:

| Export | File | Style | Responsibility |
|--------|------|-------|----------------|
| `Mountains` | `mountains.ts` (facade → `src/mountains/*`) | object + fns | Terrain height field, gradient, mesh, rocks / `rockPositions`, `SimplexNoise` |
| `Trees` | `trees.ts` | object + fns | Tree meshes + placement; returns `treePositions` |
| `Snow` | `snow.ts` | object + fns | Snowflakes + ski snow-splash particles |
| `Sky` | `sky.ts` | object + fns | Preetham atmospheric sky + sun & horizon distance fog (gradient-dome fallback), issue #2 |
| `Camera` | `camera.ts` | `class Camera` | Chase/orbit camera positioning & look-ahead |
| `Snowman` | `snowman.ts` | object + fns | Snowman model, `updateSnowman` physics, test hooks |
| `Flex` | `snowman-flex.ts` | object + fns | Cosmetic snowman flex (squash/jiggle, head-cluster bob/lean, landing settle); runs after physics, never touches the kernel (#53) |
| `Physics` | `player-state.ts` | object + fns | Typed per-frame `PlayerState` container over the snowman kernel |
| `AudioModule` | `audio.ts` | IIFE | Native HTML5 background music (gated by `AUDIO_ENABLED`) |
| `Sfx` | `sfx.ts` | IIFE | Procedural Web Audio sound effects (wind/carve/jump/land/avalanche/crash/finish, gated by `SFX_ENABLED`); synthesised at runtime (no assets), unlocked on the start gesture, off under automation, reads physics result only (#158) |
| `Controls` | `controls.ts` | object + fns | Keyboard + touch input → shared `controls` state |
| `AvalancheSystem` | `avalanche.ts` | `class` | Instanced snow-boulder physics & burial |
| `SnowTrails` | `snowtracks.ts` | `class` | Cosmetic **temporary** ski tracks: instanced grooves carved behind the skis that fade after a few seconds (transient feedback, not a snow-accumulation model); terrain-aware, reduced-motion-aware, never touches physics (#17) |
| `SnowmanDebris` | `debris.ts` | `class` | Crash-shatter wipeout: owned snow-ball fragments + puff, own settle loop, terrain-aware, disposable (#53) |
| `EffectsModule` | `effects.ts` | IIFE | Avalanche warning UI + camera FOV/shake |
| `IntroModule` | `intro.ts` | IIFE | Cinematic "fly over the mountain" intro at game start (issue #51) |
| `CourseModule` | `course.ts` | IIFE | Gates, split timing, ghost racing, result screen |
| `AuthModule` | `auth.ts` | ES module | Multi-provider Firebase auth (Google/GitHub/Apple/anonymous), user UI, Firestore lifecycle (also `window.AuthModule`) |
| `ScoresModule` | `scores.ts` | ES module | Best-time recording, leaderboard, Firestore writes (also `window.ScoresModule`) |

### What still lives on `window`

The migration kept a small, deliberate global surface:

- **Auth/scores public API** — `window.AuthModule` (`auth.ts`) and
  `window.ScoresModule` (`scores.ts`), because they're injected conditionally
  (§2.1), consumed by `auth.html`, and stubbed by `local-auth.js`.
- **Boot helpers** — `window.SnowGliderLocalAuth` (`boot/local-auth.js`),
  `window.SnowGliderFirebase` (`boot/firebase-bootstrap.js`),
  `window.SnowGliderScriptLoader` (`boot/script-loader.ts`),
  `window.SnowGliderStartMenu` (`ui/start-menu.ts`).
- **Orchestrator runtime/test hooks** — `snowglider.ts` exposes `resetSnowman`,
  `restartGame`, `showGameOver`, `toggleCameraView`, `initializeGameWithAudio`,
  plus `window.terrainMesh`, `window.treePositions`, `window.rockPositions`,
  `window.isTestMode`, and the `window.testHooks` / `window.testCollisionDetected`
  collision hooks (shared with `snowman.ts`) that the browser tests read.

> The touch/keyboard handlers in `controls.ts` and the browser tests still key off
> these symbols (e.g. `window.toggleCameraView`, `window.resetSnowman`). Preserve
> them until those callers are migrated — this is what the Refactoring Roadmap's
> R2/R3 stages are gated on.

---

## 4. Injection seams (avoid hard coupling)

Modules now `import` each other's exports directly (§3), but the cross-cutting
*runtime* dependencies are still passed in as parameters rather than hard-wired —
which is what keeps physics testable and terrain swappable:

- **Terrain into physics.** `getTerrainHeight`, `getTerrainGradient`,
  `getDownhillDirection` are passed into `Snowman.updateSnowman(...)`.
- **Obstacle positions into physics.** `treePositions` and `rockPositions` are
  passed into the typed physics wrapper and then into `Snowman.updateSnowman(...)`;
  these arrays are the collision source of truth for rendered obstacles.
- **Terrain into avalanche.** `avalanche.setTerrainFunction(getTerrainHeight)` —
  without it boulders fall to `y = 0` instead of following the slope.
- **Course init.** `CourseModule.init({ scene, getTerrainHeight, createSnowman })`;
  per frame `CourseModule.update(pos, elapsed, snowman)`; on finish
  `CourseModule.onFinish(elapsed, previousBest)`.
- **Effects.** `EffectsModule.updateAvalanche(active, distance)` and
  `EffectsModule.tickCamera(camera, dt, speed)` — the loop applies the returned
  shake offset for the render, then reverts it.
- **Auth ↔ Scores.** `AuthModule` delegates score operations to `ScoresModule`
  and calls `ScoresModule.setCurrentUser(user)` on auth state changes. They must
  init in that dependency order (Auth first).

This is also what lets the headless harnesses substitute a deterministic terrain
and a mocked `THREE`.

---

## 5. The game loop (`snowglider.ts`)

`snowglider.ts` owns the Three.js `scene`, `renderer`, `camera`/`cameraManager`,
the shared mutable run state (now a typed `GameState` + the `Physics`
player-state layer in `player-state.ts`, see #118–#121: `pos`, `velocity`, `isInAir`,
timers, avalanche flags),
and the lifecycle: `initializeGameWithAudio()` (entry from the Start button) →
`resetSnowman()` → `animate()`; `showGameOver(reason)` / `restartGame()`.

On the first real start, `initializeGameWithAudio()` plays a **cinematic intro
fly-over** (`IntroModule.play`, `intro.ts`, issue #51) before `animate()` runs:
the camera sweeps over the mountain and settles into the gameplay chase pose, then
`startGameplayLoop()` flips the run flags and starts the loop. The fly-over runs
its own short animation loop and only renders the static scene — it never calls
the physics kernel, so the run timer and the no-input invariant are untouched. It
is skipped (reproducing the original Loading/Get-Ready timing exactly) for the
`?test=` suites (`window.isTestMode`), automated runs (`navigator.webdriver`), and
`prefers-reduced-motion`; `?intro=force` / `?intro=off` override that for QA.

Per-frame order in `animate(time)` (each step depends on the previous):

```
delta = min((time - lastTime)/1000, 0.1)        // clamp
updateSnowman(delta)                             // input + physics → pos/velocity
  Flex.update(...)                               // cosmetic flex (reads result only)
  Sfx.jump()/land(force)/updateSkiing(...)       // SFX: takeoff/touchdown + wind/edge bed (reads result only)
Snow.updateSnowflakes(...)
snowTrails.update(delta, snowman, isInAir)       // carve/fade ski grooves (cosmetic, reads pos only)
CourseModule.update(pos, elapsed, snowman)       // splits, progress HUD, ghost
avalanche.trigger/update/checkBurial/hasPassed   // + EffectsModule.updateAvalanche + Sfx.setAvalanche
Snow.updateSnowSplash(...)  (position restored after, so particles can't move player)
updateCamera()                                   // cameraManager follows snowman
updateTimerDisplay()
shake = EffectsModule.tickCamera(camera, delta, speed)   // FOV + shake offset
renderer.render(scene, camera)
camera.position -= shake                          // revert so smoothing stays clean
```

```
 input (Controls) ─┐
 terrain fns ──────┤→ updateSnowman ─→ pos/velocity ─┬─→ Course (timing/ghost)
                   │                                  ├─→ Avalanche (trigger/burial)
                   │                                  ├─→ Effects (warning + shake)
                   │                                  └─→ Camera ─→ render ─→ revert shake
 showGameOver(reason) ─→ Course.onFinish ─→ Scores.recordScore ─→ (localStorage + Firestore)
```

> **Coordinator split (Stages R2/R3) — complete.**
> `snowglider.ts` was thinned into `src/game/*` (scene / loop / lifecycle) and
> `src/ui/*` (HUD, overlays), and `snowman.ts` into `src/snowman/*`. Mechanical,
> behavior-preserving moves only — the published `window.*` hooks and the
> `publishGameGlobals()` proxy set stay in the coordinator. The extracted modules:
> **`src/ui/collapsible-panel.ts`** (the shared collapse / resize / horizontal-swipe
> behavior for the Game Stats and Game Controls panels, previously duplicated across
> `initializeGameStats()` and `initializeControlsToggle()`), **`src/ui/hud.ts`**
> (the Game Stats / Controls panel init plus the per-frame speed/position/technique
> readouts and the live run timer), and **`src/ui/result-overlay.ts`** (score-time
> validation, the best-time / leaderboard / login-prompt game-over screen, and
> `CourseModule.onFinish` — `createShowGameOver(deps)` returns the `showGameOver`
> the coordinator still publishes on `window`), and **`src/game/scene-setup.ts`**
> (the one-shot `setupScene()` builder: scene / renderer / camera / overlay DOM /
> lighting / terrain / avalanche / trees / snowman / snow / course+effects; it also
> owns the `GameState` type and the eager `window.terrainMesh` / `treePositions` /
> `rockPositions` / `isTestMode` data globals), and **`src/game/main-loop.ts`**
> (the per-frame run loop: `createMainLoop(deps)` returns `updateSnowman` /
> `updateCamera` / `animate` / `startLoop` / `handleResize`; it owns the private
> `lastTime`, and lifecycle code calls `startLoop()` to seed+kick the loop), and
> **`src/game/lifecycle.ts`** (`createLifecycle(deps)` returns `resetSnowman` /
> `restartGame` / `toggleCameraView` + `initLifecycleUI()`, which wires the reset /
> camera-toggle / restart DOM controls). The coordinator calls `setupScene()` once,
> destructures the handles the loop/lifecycle/proxies use, builds the loop and
> lifecycle, and passes run state + overlay DOM nodes into the modules as parameters
> rather than letting them reach back into its bindings.
>
> After R2, `snowglider.ts` is a ~380-line coordinator: imports + `setupScene()` /
> `createMainLoop()` / `createLifecycle()` wiring, the eager `Snowman.addTestHooks`
> calls, `window.initializeGameWithAudio`, `publishGameGlobals()`, and the test-mode
> auto-start. (The dead local `addTestHooks` shim was deleted — the real browser hooks
> come from `Snowman.addTestHooks`.)
>
> Stage R3 split `snowman.ts`: the implementation moved to
> **`src/snowman/index.ts`** behind a thin **`src/snowman.ts`** facade
> (`export * from './snowman/index.js'`) so every `./snowman.js` importer keeps
> resolving a sibling file. R3.8 moved model construction into
> **`src/snowman/model.ts`**, and R3.9 moved heading/tilt/ski-pose animation into
> **`src/snowman/pose.ts`**. R3.10 moved reset + movement integration into
> **`src/snowman/physics.ts`**. R3.11 moved tree/rock/bounds/end-of-run checks
> into **`src/snowman/collision.ts`**, and R3.12 moved browser-test hook wiring
> into **`src/snowman/test-hooks.ts`**. The verification harness self-registers
> the same `.js` -> `.ts` resolver as the Node suites before importing the facade,
> so the public seam remains the thing under test while `index.ts` keeps the
> exported snowman contract types and update orchestration.
>
> **`mountains.ts`** got the same treatment (issue #34): the 1000-line module is now
> a thin **`src/mountains.ts`** facade (`export * from './mountains/index.js'`) over
> **`src/mountains/*`**, so every `./mountains.js` importer keeps resolving a sibling
> file. **`noise.ts`** holds `SimplexNoise` plus the deterministic fixed-seed fBm
> (`terrainRidgeField` / `forestDensityField`); **`terrain.ts`** holds the analytic
> height field (`getTerrainHeight` / `getTerrainGradient` / `getDownhillDirection`)
> and the shared `heightMap` cache — the physics seam, kept byte-identical to the
> mesh-vertex formula (the *two-formula terrain contract*); **`snow-surface.ts`**
> holds the snow albedo/normal CanvasTextures and the vertex-colour / smoothed-normal
> passes; **`terrain-mesh.ts`** holds `createTerrain` (which pre-populates `heightMap`
> and scatters rocks + trees); and **`rocks.ts`** holds rock meshes/colours/placement
> plus the collision-hazard subset. `src/mountains/index.ts` is the assembly hub that
> builds the `Mountains` object and re-exports the named/type surface
> (`terrainRidgeField`, `forestDensityField`, `TerrainVec2`, `RockPosition`). The
> terrain/regression suites and the physics-invariant harness pin the math, so the
> split is behaviour-preserving.

### What the type system won't catch

`strict` TypeScript closed the structural-type gaps, but the bugs that matter most
here are **semantic** and compile clean either way — keep them under the test suite
and the `PHYSICS.md` discipline, not the compiler:

- **Radians vs degrees** in `heading` / rotation math — types see `number` either way.
- **Coordinate-system / up-axis assumptions** in terrain and camera-follow logic.
- **Aliasing of shared mutable state** (`scene`, `velocity`, `snowman`): types the
  reference, not action-at-a-distance from cross-module mutation. The typed
  `GameState` + `src/player-state.ts` `PlayerState` container is the mitigation, not types
  alone.
- **Disposal you don't already do** — watch new geometry / material / texture
  creation in `snow.ts` / `effects.ts` / `mountains.ts`.

---

## 6. Input

`Controls` (`controls.ts`) writes a shared `controls` state object
(`left/right/up/down/jump`) from both keyboard (Arrows/WASD, Space, `V`) and touch
(screen quadrants), using `{ passive: false }` handlers. Physics reads only that
state, so keyboard and touch are interchangeable. Button touch handlers wire
`resetSnowman`, `toggleCameraView`, and `restartGame` via the `window.*` exports.
The full input → effect → technique map (keyboard + touch) is consolidated in
[`CONTROLS.md`](CONTROLS.md).

---

## 7. Auth, scoring & persistence

**Sign-in providers.** `auth.ts` offers popup-based **Google, GitHub, and Apple**
sign-in plus an **anonymous "Play as Guest"** option. Each `#authUI` button is wired
by id from a `PROVIDER_BUTTONS` table (Google `signInWithPopup`, GitHub
`GithubAuthProvider`, Apple `OAuthProvider('apple.com')`) with `signInAsGuest`
calling `signInAnonymously`; a button absent from the DOM is skipped, so markup can
ship ahead of the server-side provider config. A signed-in **anonymous guest who
picks a real provider is upgraded in place via `linkWithPopup`** (same uid, progress
carries over); if that provider account already exists it falls back to a normal
`signInWithPopup`. Anonymous guests are deliberately kept **out of Firestore and the
global leaderboard** — `auth.ts` passes `null` to `ScoresModule.setCurrentUser` and
`scores.ts` `getActiveUser()` skips `isAnonymous` users — so a guest's best time
stays in `localStorage` until they upgrade, at which point `syncUserData` backfills it.

Three runtime modes, auto-detected:

| Mode | Trigger | Auth | Firestore | Source |
|------|---------|------|-----------|--------|
| **File** | `file://` | mock (Local Mode banner) | no | `src/boot/local-auth.js` |
| **Local dev** | `localhost`/`127.0.0.1` | real | disabled (avoids 400s) | `auth.ts` / `scores.ts` |
| **Production** | GitHub Pages (https) | real | enabled | `auth.ts` / `scores.ts` |

> The **File** row is now only the auth/score fallback: the game's ES-module
> graph won't load from `file://`, so you serve the game through Vite
> (`npm start`) even in "local" development. The mock still matters for
> graceful degradation when Firebase is unreachable on a real origin.

Scoring flow (`scores.ts` `recordScore(time)`): always writes a new local best to
`localStorage` first; then, only when the user is signed in, Firestore is
available, **and** this run matches or beats the local best
(`shouldSyncBestTime`), it syncs the run's `time` via `updateUserBestTime` (which
also updates the `leaderboard` collection). Otherwise the Firestore write is
skipped.

Persistence keys:

- `localStorage`: `snowgliderBestTime`, `snowgliderBestSplits`, `snowgliderGhost`.
- Firestore collections: `users` (profiles + best times), `leaderboard` (top times).

When reviewing auth/scoring changes, **preserve the `file://` and `localhost`
fallbacks** — they are what keep the game runnable without a Firebase project.

---

## 8. Testing & deployment seams

- **Node suites** (`tests/*-tests.js`) import the physics/terrain `.ts` modules
  directly (transpiled for Node) and run headless. The **verification harness**
  (`tests/verification/`) compares live physics against a frozen baseline and
  smoke-tests the DOM modules.
- **Browser suites** load inside the real game via `?test=…`, served through Vite
  so the `.ts` modules resolve, and are appended by the loader after the bundle
  (`main.ts`).
- **End-to-end** Playwright specs (`tests/e2e/`) run cross-browser + mobile
  viewports alongside the Puppeteer suite.
- **Deployment** is GitHub Pages, gated so Pages publishes only after the test job
  passes. Vite builds the Pages artifact into `dist/`; a CI guard rejects raw
  TypeScript in the artifact. Workflows must stay least-privileged and must not
  publish `node_modules/`, `coverage/`, or test artifacts.

See [`tests/README.md`](../tests/README.md) for the full matrix and commands.
