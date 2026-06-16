# SnowGlider — Architecture

How the pieces fit together: the static module system, load order, the global
namespace and injection seams, the per-frame data flow, and the Firebase/scoring
subsystem. For the simulation itself see [`PHYSICS.md`](PHYSICS.md); for tests see
[`tests/README.md`](../tests/README.md).

---

## 1. Big picture

SnowGlider is a **static browser app**. The source remains plain browser
scripts — the game modules are not bundled together, and each module attaches
itself to a global on `window`. Vite provides the local dev server and GitHub
Pages artifact (`dist/`), while the source entry point still runs straight from
`file://`, at the cost of a hand-maintained load order.

Two HTML entry points:

- **`index.html`** — the game. Contains the UI markup, links
  `styles/main.css`, loads the boot scripts, then loads Three.js.
- **`auth.html`** — a standalone Firebase auth page that loads `src/auth.js`.

All logic lives in `src/*.js`; page styles live in `styles/`; tests in `tests/`.
`npm run build` emits the deployable Vite artifact to `dist/` and copies the
static app directories needed by the existing classic-script loader.

---

## 2. Module loading & order

`index.html` loads scripts in three groups.

### 2.1 Firebase modules (ES modules, conditional)

In `<head>`, `src/boot/local-auth.js` and `src/boot/firebase-bootstrap.js`
branch on protocol:

- **`file://`** — Firebase is unavailable, so `local-auth.js` defines mock
  `ScoresModule` and `AuthModule` implementations (localStorage-only) and loads
  no module scripts. This is what makes `open index.html` work with no server.
- **`http(s)://`** — it injects `src/scores.js` and `src/auth.js` as
  `type="module"` scripts. These are the only true ES modules in the project
  (`export default` **and** `window.*` assignment, for dual use).

`firebase-bootstrap.js` also sets `window.FIREBASE_MANUAL_INIT = true` and
intercepts the `/__/firebase/init.json` fetch to stop Firebase's auto-init 404s.

### 2.2 Boot UI and game modules (classic scripts, strict sequence)

At the bottom of `index.html`, after the Three.js CDN script, the page loads:

- `src/boot/script-loader.js` — waits for `AuthModule`, initializes auth, then
  loads game scripts with `loadScriptsInOrder([...])`.
- `src/ui/start-menu.js` — owns the start/about menu handlers and forwards game
  start to `window.initializeGameWithAudio()`.

The game-script order still matters because later modules read globals set by
earlier ones:

```
mountains → trees → snow → camera → snowman → audio → controls
          → avalanche → effects → course → snowglider   → (test scripts if ?test=)
```

`snowglider.js` is last because it is the orchestrator that consumes all the
others. Test scripts (`tests/*.js`) are appended only when a `?test=` parameter is
present (see [`tests/README.md`](../tests/README.md)).

> **If you add a module,** insert it at the right point in
> `src/boot/script-loader.js` (and load it before `snowglider.js` if the game
> loop uses it).

---

## 3. The global namespace

Each module exposes a single top-level symbol. Most attach it to `window`; two are
**bare globals** (see the note after the table). Two styles coexist; match the file
you edit.

| Symbol | File | Style | Responsibility |
|--------|------|-------|----------------|
| `window.Mountains` | `mountains.js` | object + fns | Terrain height field, gradient, mesh, rocks, `SimplexNoise` |
| `window.Trees` | `trees.js` | object + fns | Tree meshes + placement; returns `treePositions` |
| `Snow` (bare global; on `window` only as `window.Utils`) | `snow.js` | object + fns | Snowflakes + ski snow-splash particles |
| `Camera` (bare global; not on `window`) | `camera.js` | `class Camera` | Chase/orbit camera positioning & look-ahead |
| `window.Snowman` | `snowman.js` | object + fns | Snowman model, `updateSnowman` physics, test hooks |
| `window.AudioModule` | `audio.js` | IIFE | Native HTML5 background music (gated by `AUDIO_ENABLED`) |
| `window.Controls` | `controls.js` | object + fns | Keyboard + touch input → shared `controls` state |
| `window.Avalanche` | `avalanche.js` | `class AvalancheSystem` | Instanced snow-boulder physics & burial |
| `window.EffectsModule` | `effects.js` | IIFE | Avalanche warning UI + camera FOV/shake |
| `window.CourseModule` | `course.js` | IIFE | Gates, split timing, ghost racing, result screen |
| `window.AuthModule` | `auth.js` | ES module | Firebase auth, user UI, Firestore lifecycle |
| `window.ScoresModule` | `scores.js` | ES module | Best-time recording, leaderboard, Firestore writes |
| `window.SnowGliderLocalAuth` | `boot/local-auth.js` | object + fns | `file://` auth and score fallbacks |
| `window.SnowGliderFirebase` | `boot/firebase-bootstrap.js` | object + fns | Firebase config/init guard and auth-module wait/init helpers |
| `window.SnowGliderScriptLoader` | `boot/script-loader.js` | object + fns | Ordered classic-script loader and browser-test appender |
| `window.SnowGliderStartMenu` | `ui/start-menu.js` | object + fns | Start/about menu DOM handlers |

> **Bare globals vs. `window` properties.** A classic-script top-level `const`/`class`
> (e.g. `Snow`, `Camera`) is shared across scripts by its bare name but is **not** a
> property of `window` — `window.Snow` and `window.Camera` are `undefined`. Only the
> explicit `window.* =` assignments above (plus `window.Utils`, the legacy alias for
> `Snow`) are real `window` properties. Reference those two as bare `Snow`/`Camera`,
> the way `snowglider.js` does (`new Camera(scene)`, `Snow.createTerrain(...)`).

`snowglider.js` itself exports several functions on `window` for cross-module and
test use: `resetSnowman`, `restartGame`, `showGameOver`, `toggleCameraView`,
`initializeGameWithAudio`, plus `window.terrainMesh`, `window.treePositions`,
`window.isTestMode`.

---

## 4. Injection seams (avoid hard coupling)

Rather than importing each other, modules receive their dependencies:

- **Terrain into physics.** `getTerrainHeight`, `getTerrainGradient`,
  `getDownhillDirection` are passed into `Snowman.updateSnowman(...)`.
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

## 5. The game loop (`snowglider.js`)

`snowglider.js` owns the Three.js `scene`, `renderer`, `camera`/`cameraManager`,
the shared mutable state (`pos`, `velocity`, `isInAir`, timers, avalanche flags),
and the lifecycle: `initializeGameWithAudio()` (entry from the Start button) →
`resetSnowman()` → `animate()`; `showGameOver(reason)` / `restartGame()`.

Per-frame order in `animate(time)` (each step depends on the previous):

```
delta = min((time - lastTime)/1000, 0.1)        // clamp
updateSnowman(delta)                             // input + physics → pos/velocity
Snow.updateSnowflakes(...)
CourseModule.update(pos, elapsed, snowman)       // splits, progress HUD, ghost
avalanche.trigger/update/checkBurial/hasPassed   // + EffectsModule.updateAvalanche
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

---

## 6. Input

`Controls` (`controls.js`) writes a shared `controls` state object
(`left/right/up/down/jump`) from both keyboard (Arrows/WASD, Space, `V`) and touch
(screen quadrants), using `{ passive: false }` handlers. Physics reads only that
state, so keyboard and touch are interchangeable. Button touch handlers wire
`resetSnowman`, `toggleCameraView`, and `restartGame` via the `window.*` exports.

---

## 7. Auth, scoring & persistence

Three runtime modes, auto-detected:

| Mode | Trigger | Auth | Firestore | Source |
|------|---------|------|-----------|--------|
| **File** | `file://` | mock (Local Mode banner) | no | `src/boot/local-auth.js` |
| **Local dev** | `localhost`/`127.0.0.1` | real | disabled (avoids 400s) | `auth.js` / `scores.js` |
| **Production** | GitHub Pages (https) | real | enabled | `auth.js` / `scores.js` |

Scoring flow (`scores.js` `recordScore(time)`): always writes a new local best to
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

- **Node suites** (`tests/*-tests.js`) import the physics/terrain modules directly
  and run headless. The **verification harness** (`tests/verification/`) compares
  live physics against a frozen baseline and smoke-tests the DOM modules.
- **Browser suites** load inside the real game via `?test=…` and are appended by
  the loader after `snowglider.js`.
- **Deployment** is GitHub Pages, gated so Pages publishes only after the test job
  passes. Vite builds the Pages artifact into `dist/`; workflows must stay
  least-privileged and must not publish `node_modules/`, `coverage/`, or test
  artifacts.

See [`tests/README.md`](../tests/README.md) for the full matrix and commands.
