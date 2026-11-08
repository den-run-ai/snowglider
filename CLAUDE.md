# SnowGlider - Coding Assistant Guidelines

> This file is the single source of truth for AI coding assistants. `AGENTS.md` is a
> symlink to this file, so Claude Code and Codex (and other agents) read identical guidance.

## Project Overview
SnowGlider is a Three.js animation/game featuring a snowman skiing on natural backcountry mountain terrain. It is a **Vite-bundled, ES-module TypeScript** app — the app modules are TypeScript under `"strict": true` (two classic boot scripts remain `.js`): `index.html` loads the bundle entry `src/main.ts` (plus the `boot/`/`ui/` module scripts) as `<script type="module">`, and `npm run build` emits static `dist/` output for GitHub Pages. The core files are:
- `index.html` - Main entry point and UI (loads the Vite bundle entry `src/main.ts`)
- `auth.html` - Standalone Firebase authentication page (loads the `auth.ts` module)
- `src/main.ts` - ES-module bundle entry; imports every game module into one graph
- `src/snowglider.ts` - Game logic and Three.js implementation (the orchestrator)
- `src/player-state.ts` - Typed per-frame `PlayerState` layer over the `snowman.ts` kernel
- `src/snow.ts` - Utility functions and snow effects
- `src/mountains.ts` - Natural backcountry terrain generation facade. Mesh and gameplay sample one triangle-interpolated height field; the bounded grid-corner cache is read-order independent. `heightMap` is a diagnostic mesh snapshot, not gameplay memoization.
- `src/trees.ts` - Tree creation and placement throughout the mountain (facade over `src/mountains/trees.ts`)
- `src/mountains/ez-forest.ts` - EZ-Tree evergreen archetype provider (issue #282): seeded low-poly pine geometry from `@dgreenheck/ez-tree` (lazy ~4 MB chunk), rendered by `trees.ts` through the shared instanced/tint/sway/snow pipeline with a static near/far LOD split. Default for players; automation/headless keep the stylized cones (`?eztrees=1` opts in, `?classictrees` opts out) so seeded RNG streams and existing suites stay byte-identical. Headless-safe (scoped `document` shim) and RNG-stream-neutral (private xorshift for THREE uuid draws); perf pinned by the `?eztrees=1` budget in `tests/e2e/perf-budget.spec.ts` (`npm run test:ez-forest` for the unit suite)
- `src/run-context.ts` - Canonical world identity, physics version and private named RNG streams. The live game always selects a concrete world seed (`CANONICAL_WORLD_SEED` by default); arbitrary `?seed=` worlds are practice-only. World streams (`hazards`/`course`) derive from that seed, while canonical runs use a fresh crypto-sourced nonce for run-scoped `physics`/`avalanche` variation. Cosmetic streams are always private. Global-`Math.random` passthrough is a harness compatibility mode via `setRunSeed(null)`, not the production default. Current `PHYSICS_VERSION = 4`; physics/world changes that affect comparable results require coordinated record/rules versioning. See `docs/PHYSICS.md`, `tests/run-context-tests.js` and `tests/verification/rng_frame_rate_harness.js`.
- `src/avalanche.ts` - Avalanche system with snow boulder physics and burial detection
- `src/snowtracks.ts` - Transient, terrain-aware fresh-cut ski grooves; persistent visual memory is implemented separately by `src/mountains/snow-depth.ts` (compaction/refill, material sampling and mobile scaling). Neither layer changes terrain height, friction or scoring.
- `src/difficulty.ts` - Bunny, Blue, Black and Expert tuning, course layouts and separate ranked score namespaces. Measure all-tier finish distributions with `npm run test:floor` before changing floors/ranking.
- `src/course.ts` - Checkpoint gates, splits, ghost trajectory persistence and result screen. Visible ghost rendering and its live delta are intentionally disabled (`GHOST_VISIBLE = false`); do not describe them as a currently visible feature.
- `src/effects.ts` - Avalanche warning UI and camera juice (speed FOV, shake)
- `src/intro.ts` - Cinematic "fly over the mountain" intro at game start (issue #51; skippable, skipped under test/automation/reduced-motion)
- `src/camera.ts` - Camera management system. Six viewpoint modes cycled by `V` (auto/follow/orbit/firstPerson/cameraman/drone; `toggleCameraMode()` is a back-compat wrapper that advances the cycle). Layers a full-360° orbit yaw + clamped pitch and a distance/height `zoom` multiplier on the classic follow rig — all neutral at their defaults, so spawn framing is unchanged. **Auto** recenters the orbit behind travel and frames the action *situationally* (issue #305 P3+): it eases a transient distance `autoZoom` + overhead `autoPitch` toward a target profile built from cosmetic-only signals — speed, terrain steepness (biggest pull-back + lift on **expert/steep** lines so the drop stays in shot), **jumps** (`isInAir` → pull back + lift to keep the landing framed), avalanche proximity, turn rate (tight tree-line carves pull *in*), and portrait screen aspect. The situational transients never write the persisted manual `zoom`/`orbitPitch` and are dropped on mode-change/restart, so Follow/Orbit/FP and the next run's spawn stay neutral. **Orbit** holds the player's manual yaw/pitch/zoom. **Cameraman** and **Drone** are two cinematic follow cameras (issue #315): cameraman is a low/close/side-trailing handheld chase (gentle weave), drone is a high/far slowly-circling aerial chase — both take their pose profile (angle/pitch/distance) from the pure `cinematicTargets`, lean into **steep/expert terrain and jumps** with extra pull-back + overhead lift (motion-gated so the steep spawn stays neutral), and drive the deterministic oscillation/circle off the camera's own `frameCount` (no wall-clock, sim byte-identical). **Drone** places itself via `cinematicOffset` (mirroring `followOffset`'s math + terrain clamp), circling the rider. **Cameraman** instead follows the snowman's ACTUAL travelled path (issue #357): it records distance-spaced path samples (`recordCameramanPath`, frame-rate independent like SnowTrails), samples a point a fixed distance back along the trail (`sampleCameramanTrail`, keyed off the rider's **continuous** travelled distance so the trail point never stalls-then-jumps a sample spacing) and sits just off to one side of it — the side/trailing basis comes from the path's **distance-windowed average direction** (chord of the last `CAMERAMAN_HEADING_WINDOW` units of path, eased — **not the instantaneous `playerRotation.y`**, and not the local tangent either), so neither a terrain/pose yaw flip (the old `yaw + angle` orbit bug) nor ordinary carved S-turns swing the camera around the rider: it **holds its lane while the rider turns** and comes around only when the new direction persists for ~a window of travel (a collapsed chord — hairpin doubling back / near-stop — just holds the heading). Its situational slope/jump pull-back profile is **eased** (`CAMERAMAN_PROFILE_EASE`, mirroring Auto's `autoZoom`/`autoPitch`) rather than stepped, so a terrain-gradient change glides the framing instead of lunging it — and all three cameraman eases (profile/heading/look) are **dt-scaled** off the loop's `AutoFrameContext.frameDt` (the camera updates on the render frame, so a constant per-call factor would converge faster at 144 Hz than 30 Hz); the lifecycle mode-switch passes the live `player.velocity` into `cameraManager.initialize` so a mid-run cinematic entry frames from real travel, not a momentarily-flipped yaw. Its look-at is eased too (the shared `desiredLookAt` scratch, ease factor 1.0 for every other mode = byte-identical copy). The path state resets on `initialize`/`resetView`/`setMode('cameraman')` so a restart or mode re-entry never trails a stale point. `usesOrbitControls(mode)` (auto/follow/orbit only) gates the manual view controls, so FP + the cinematic modes ignore Q/E/±/wheel/drag and the tray orbit/zoom widgets. The loop feeds the jump/avalanche signals via an optional `AutoFrameContext` on `cameraManager.update`; slope/turn/aspect the camera derives itself. Input (Q/E orbit, C recenter, +/−/wheel zoom, mouse-drag orbit, and the `#cameraControls` tray) is wired in `src/game/lifecycle.ts`; camera math (incl. the pure `autoFrameTargets`/`cinematicTargets` profiles) is headless-tested (`npm run test:camera`).
- `src/scenery/` - Background scenery system (issue #320): the distant, non-interactive alpine world (planned: ridge panorama, valley/frozen lake, decorative forest belts, cliff bands, imported props, ambient birds/clouds/spindrift). `scenery.ts` is the `ScenerySystem` facade (`createScenery()`); built in `game/scene-setup.ts` **after** the collision arrays, ticked cosmetic-only in the `game/main-loop.ts` render-frame zone (never the fixed physics substep), and disposed in `game/teardown.ts`. Every layer must stay **render-only, collision-neutral, physics-neutral, `Math.random`-stream-neutral, and teardown-safe**: placement draws from the seeded `makeSceneryRng()` (never global `Math.random`) and all THREE construction is wrapped in `withPrivateThreeRandom()` (`scenery-rng.ts`) so object-UUID draws can't perturb the seeded harness stream (mirrors the `getSwayDepthMaterial` guard in `mountains/trees.ts`); the seed is keyed off the run tier via `scenerySeedFor()` (`scenery-budget.ts`). Headless-tested: `npm run test:scenery` (facade/seam invariants) and `npm run test:scenery-rng` (RNG neutrality). All six layers shipped; the ambient layer rewinds on every run reset.
- `src/snowman.ts` - Snowman model and physics
- `src/snowman/face.ts` - Procedural face rig (issue #364): the thin silhouette-line mouth (7 tiny joint spheres + 6 line segments under a `mouth` Group; layout constants + the pure `layoutMouthLine` refit math live in `src/snowman/mouth-line.ts`, shared with the expression controller — the joints are the animation control points, and refitting the segments each frame means bending the line never regenerates geometry), twig eyebrows, frosty cheeks, and white eye-highlight dots. Parented **under the head mesh** (like the eyes/nose) so they ride the flex layer's per-frame head squash, and registered in `userData.parts` **before** `recordBaseTransforms` so the expression controller animates them as offsets from neutral. Purely additive cosmetic geometry — geometry is pooled across repeats (one sphere for all 7 joints, one unit cylinder for all 6 segments, etc.) and both new materials are colour-only `MeshStandardMaterial`s that share the standard shader program (**+0 programs**); the snowman is built last in scene-setup so its UUID draws have no downstream seeded consumer. Headless-tested (`npm run test:face`).
- `src/snowman-expression.ts` - Cosmetic facial-expression + body-acting layer (issue #364), a **sibling of `snowman-flex.ts`**. Same render-observer contract as flex: reads the per-frame physics result (speed/technique/turn/air) + this frame's aggregated events (landing grade, trick, obstacle clear, avalanche distance) and writes **only** the face/arm/hat/nose child transforms — a part-set **disjoint from flex** (which never touches those) **and from `pose.ts`** (which owns only the ski roots + root yaw), so the three cosmetic layers compose without fighting; never touches `pos`/`velocity`. A small technique→face state machine (idle/carve/snowplow/tuck/skid/parallel/air) drives the mouth/brows/eyes/pupils/cheeks and the arm/hat/nose poses; short-lived **event reactions** (clean/ok/sketchy landing, obstacle "woo", freestyle-trick celebration, avalanche panic, reserved finish) layer on top by a fixed priority. Deterministic (blink/wobble/windmill off an internal time accumulator, hat bounce a dt-integrated spring — never `Math.random`/wall-clock) and frame-rate independent, so the sim stays byte-identical. Called after `Flex.update` in `game/main-loop.ts`; reset alongside flex in `game/lifecycle.ts`. Headless-tested (`npm run test:expression`, plus the real-model `tests/snowman-expression-integration-tests.js`).
- `src/controls.ts` - Keyboard and touch controls implementation
- `src/audio.ts` - Background music and audio controls
- `src/sfx.ts` - Procedural Web Audio sound effects (wind/carve/jump/land/avalanche/crash/finish)
- `src/diagnostics.ts` - Read-only runtime physics/frame-rate telemetry (`Diag`): catches the frame-rate-dependence bug class (#209) live — runaway low-FPS speed, per-frame steps past a collision radius (tunnel risk), NaN. Dev overlay (`?debug`), `window.__snowgliderDiag.dump()` JSON export; off under automation. See `docs/DIAGNOSTICS.md`.
- `src/ui/feedback.ts` - In-game feature-request / bug-report form (issue #258): opens a GitHub prefilled new-issue URL (keyless — the player submits under their own account) and fires a `feedback_submitted` Firebase Analytics event via the shared `window.firebaseModules.logEvent` seam. Pure helpers are headless-tested (`npm run test:feedback`); issue templates live in `.github/ISSUE_TEMPLATE/`.
- `src/auth.ts` - Firebase authentication implementation
- `src/scores.ts` - User scoring and leaderboard functionality
- `src/boot/` - Classic-script local-auth fallback + Firebase bootstrap (the only remaining `.js`), and `script-loader.ts` (startup driver)
- `assets/` - Media stored as ordinary Git blobs; `.gitattributes` does not configure Git LFS. Third-party assets retain their own licenses (see THIRD_PARTY_NOTICES.md).
- `tests/` - Test files for terrain, physics, camera, avalanche, and collision detection
- `tests/verification/` - Headless physics-invariant and DOM smoke harnesses (`npm run test:verify`)
- `docs/ARCHITECTURE.md` - Module system, load order, game loop, and Firebase/scoring subsystem
- `docs/PHYSICS.md` - Terrain, skiing, jumps, collision, and avalanche simulation model
- `docs/CHANGELOG.md` - Notable changes, including the skill/structure layer (#56) and the audio history
- `docs/ROADMAP.md` - Current delivery sequence, shipped foundations and remaining acceptance/architecture work; start/replay and all-level saving precede the daily mountain/friend challenge.
- `docs/ASSETS.md` - Release-based screenshot hosting tools and the migration runbook; existing branch URLs remain live until migrated.
- `.claude/skills/webgpu-threejs-tsl/` - Vendored Claude Code skill: WebGPU renderer + TSL (Three.js Shading Language) reference for any future WebGPU work. Reference docs only (excluded from eslint); provenance and local API corrections are recorded in its `UPSTREAM.md`.
- `.claude/skills/snowglider-dev/` - Claude Code skill: SnowGlider's engineering-discipline playbook, distilled from the commit history, Codex review threads, and issues. Encodes the hard invariants (byte-identical no-input physics, seeded-`Math.random` neutrality, fixed-timestep frame-rate independence, terrain two-formula `MUST MATCH`, teardown safety, automation gating, the `window.*` seam) and the recurring Codex/regression bug classes (shared-flag repurposing, state leaking across mode/run boundaries, teardown gaps, async races, incomplete consumer updates, within-frame ordering, perf-budget, deploy ordering). `SKILL.md` is the pre-flight checklist + bug-class self-check; `references/` holds the depth (`invariants.md`, `bug-classes.md`, `workflow.md`). Complements this file (the *what*) with the *how not to break it*.

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
- Run browser tests: `npm run test:browser` (Puppeteer)
- Run all TypeScript checks: `npm run typecheck:all` (source, checked JS/tests, worker and E2E)
- Run cross-browser/mobile flows: `npm run test:e2e` (the script supplies the required Playwright loader environment)
- Run production-build offline acceptance: `npm run test:pwa`
- Capture exact-revision rendering evidence: `npm run test:render-review`; follow `.github/workflows/render-review.yml` for BASE/HEAD comparison and approved-baseline mode
- Run specific tests: 
  - `npm run test:terrain` - Terrain generation tests
  - `npm run test:physics` - Physics simulation tests
  - `npm run test:regression` - Regression tests
  - `npm run test:tree-collision` - Tree collision tests
  - `npm run test:face` - Static snowman face-rig geometry tests (issue #364)
  - `npm run test:expression` - Snowman facial-expression / body-acting controller tests (issue #364)
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

## Agent Autonomy (for AI agents)
Work fully autonomously, end to end: verify the claim against the code, implement, test, commit,
push, open the PR, and respond to review/CI feedback — without pausing mid-task for confirmation.
The maintainer reviews *outcomes* (PRs, issues, review replies), not intermediate questions.

- **Do NOT use interactive or approval-gated tools.** No mid-task question prompts
  (`AskUserQuestion` or equivalents), and no tool calls that block on a user approval dialog
  (e.g. approval-gated MCP scheduling calls). If a tool call unexpectedly requires interactive
  approval, do not retry it — pick a non-blocking alternative (event subscriptions over
  approval-gated schedulers, direct API calls over interactive CLIs) and note the substitution
  in your final summary.
- **Decide, then document.** When a judgement call comes up (naming, scope of a comment update,
  which suite a test belongs in, how to sequence commits), make the reasonable choice and record
  the rationale where the maintainer will see it: the commit message, PR body, or issue thread.
  The review round — Codex and the maintainer — is where course corrections happen.
- **The only stop-and-ask cases** are destructive/irreversible operations (force-pushing over
  someone else's work, deleting branches/issues/data, rewriting `main` history, publishing
  secrets) and genuine scope changes that alter what was asked for. Everything reversible that
  follows from the request: just do it.
- **Monitoring is event-driven.** Watch PRs via the PR-activity subscription (webhook events),
  not by polling loops or sleep timers. Follow through on every event until the PR is merged
  or closed: fix + push if confident, reply on the thread with the fixing commit, resolve the
  thread. Report a diagnosis instead of going quiet when something is out of scope or stuck.
- **Blocked ≠ done.** If one path is blocked (a missing CLI, a denied call, a failing sandbox),
  find the supported alternative (see the token/REST recipe below) rather than reporting the
  task as impossible — and never end a turn with unexecuted "next steps" that you could have
  executed yourself.

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
- **Do not commit screenshots/PNGs into the repo tree** (avoid adding new binary media to `main`;
  Git LFS is not configured). New screenshots can be hosted on the `assets` **GitHub Release**
  with `node scripts/upload-release-asset.mjs shot.png --name pr<NN>-<label>.png`.
  Embed the printed URL in the PR body, and confirm it returns HTTP 200 first.
  Prefix names with the PR/issue number because the asset namespace is flat.
  Preserve existing `assets/*` branches and their URLs until the migration in
  [`docs/ASSETS.md`](docs/ASSETS.md) is explicitly run and verified. The live `og:image`
  still uses its branch URL until the separate production meta-tag update.

### Stacked PRs (large features)

Land a big feature as a **staged stack of small PRs**, each independently reviewable and
each holding this repo's invariants (byte-identical `test:verify`, seeded-`Math.random`
neutrality, the perf budget). This is how the persistent snow-depth field (#246) shipped
(`snow-depth.ts` PRs 1–5). Shape the stack so risk *climbs*: pure dependency-free logic
first (Node-testable, no renderer/physics), then the wiring, then the risky renderer /
shader / GPU work, then perf-scaling, then cleanup — so the low-risk layers can merge while
the risky one is still in review.

- Each PR's base is the branch **below** it, not `main`: PR 1 → `main`; PR 2 → PR-1 branch;
  PR 3 → PR-2 branch; … Name branches distinctly (`claude/<feature>-prN`). In each PR body
  say "stacked on #N — merge that first," and **never merge — leave the stack for the
  maintainer.**
- **Restacking after a review fix (this bites).** Fixing a review comment on a lower PR
  amends its branch, so every PR above must rebase onto the new tip. Use `git rebase --onto`
  with the **old** parent tip so you replay only that PR's *own* commits — a plain
  `git rebase <parent>` replays the parent's now-superseded commit too and conflicts against
  itself:
  ```bash
  # PR-1 branch moved  OLD_P1 -> NEW_P1
  git rebase --onto <NEW_P1> <OLD_P1> <pr2-branch>   # replays only PR-2's commits
  git push --force-with-lease origin <pr2-branch>    # then repeat PR-3 onto the new PR-2, …
  ```
  Resolve conflicts by keeping **both** layers' intent (the lower PR's method rewrite + the
  upper PR's added call/row). After each restack re-run the full gate on that branch
  (`npm run lint && npm run typecheck && npm test && npm run test:verify && npm run build`,
  plus `tests/e2e/perf-budget.spec.ts` for any PR touching the renderer — its ceilings are a
  regression guard; only bump one when the measured output justifies it, and say so).
- **Delegate the mechanical restacks to a subagent**; keep the main context for the feature
  work. Give the subagent the exact `--onto` SHAs and, for any semantic merge (the same
  method changed on two branches), the **exact target code** to commit — don't let it guess.
  Have it report the new tip SHA and each gate's pass/fail, and push only if all pass.
- **Review rounds (Codex).** Every PR gets an automated Codex review; subscribe to PR
  activity. For each finding: fix at the layer that **owns** the code (a bug in PR-1's logic
  is fixed on PR-1, then restack up), reply on the thread with the fixing commit + what
  changed, and resolve it. Recurring classes worth pre-empting here:
  - **Non-finite inputs poisoning a `[0..1]` field** — `clamp01(NaN)` returns `NaN`; make the
    clamp NaN-safe (`v > 0 ? min(v,1) : 0`) and route tuning options through a finite fallback.
  - **Frame-rate dependence** — anything driven per render frame must scale by `dt`, and a
    *stamped* trail must be spaced by travelled **distance** (like `SnowTrails`), not stamped
    once per frame, or it dots/gaps at speed and differs at 60/120/144 Hz.
  - **Partial GPU texture uploads** — three's `DataTexture.addUpdateRange` assumes an RGBA
    4-byte component stride, so a partial range on a single-channel `RedFormat` texture
    uploads misaligned texels; do a full `needsUpdate` re-upload from a consistent byte mirror
    (the win is windowing the CPU sync, not the upload).

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
- **Testing**: Node logic/invariant suites, browser gameplay checks, cross-browser/mobile Playwright, production-build PWA acceptance, Firestore emulator tests and separate rendering evidence. Match validation to the risk; automation is not physical-device or real-provider acceptance.
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
- **Audio is enabled** via `AUDIO_ENABLED = true` in `src/audio.ts`. The dependency-free native HTML5 `<audio>` implementation uses one track (`assets/skullbeatz_bad_cat.mp3`), mute preference, initialization and explicit playback intent; it loads on a play gesture. Howler.js and Three.js Audio were removed. Track provenance remains unresolved in [#418](https://github.com/den-run-ai/snowglider/issues/418); attribution is present, but retain/replace needs a recorded decision before using it for new promotional clips or monetized distribution.
- To disable: set `AUDIO_ENABLED = false` in `src/audio.ts` (all public methods early-exit).
- The previous Howler.js API surface is kept as no-op/Promise stubs for backward compatibility (`preloadAudio`, `playPreloadedAudio`, `resumeAudioContext`, `changeTrack`, `addAudioListener`, …), so the existing callers in `index.html` keep working without change.
- The in-page `#audioControlBtn` is created by `audio.ts` and controls music plus SFX; it is already enabled. Start/replay preserve gesture playback and mute intent. Real-device iOS Safari/Android Chrome playback, silent-switch behavior, interruptions and resume still require acceptance in [#249](https://github.com/den-run-ai/snowglider/issues/249).
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
  upgraded in place via `linkWithPopup` (same uid). A completed guest run is claimed
  only through the result's explicit sign-in-and-save action. Never import the shared
  device best into an account: automatic backfill uses UID-owned records only.
  Preserve these ownership guards when touching auth/scores.
  For guests the provider buttons are **folded behind the chip** (click `#profileChip`
  to unfold `#authUI`) so the upgrade stays reachable without cluttering the panel.
- Set `window.FIREBASE_MANUAL_INIT = true` to prevent 404 errors 
- Implement specialized handling for popup-blocked and popup-closed-by-user errors
- Provide graceful degradation to localStorage when Firebase is unavailable
- Include visual state indicators during the authentication process
- Maintain automatic detection between development and production environments
- GitHub/Apple require server-side Firebase console config (OAuth app; Apple Service ID).
  Google, GitHub and Guest buttons are exposed by the current UI; Apple is omitted.
  Mocked provider tests establish client behavior, not live console configuration or
  a successful real-provider session. Verify the latter when qualifying a release.

## Scoring and Leaderboard Implementation
- User scoring and leaderboard functionality is managed by the ScoresModule in `scores.ts`
- AuthModule delegates to ScoresModule for all score-related operations
- Both modules maintain backward compatibility with existing code
- All four difficulties (Bunny, Blue, Black, Expert) remain guest-playable, including Black. Each has its own ranked v4 board in the current source; account sign-in is for publishing/saving, not entering a difficulty.
- Device bests are stored locally; account records use UID-owned storage and version/world provenance. Never assign the shared device best to the next signed-in account. An explicit post-run save may claim that completed guest run.
- The shared start/result leaderboard displays a separate top 10 for each level. Current floors are 15 / 15 / 10 / 10 seconds (Bunny / Blue / Black / Expert), capped at 600 seconds; preserve lockstep client/fallback/Firestore validation and historical schemas.
- Time determines ranking; air points remain a separate live/run-sharing score.
- Save status is confirmed only after both the account best and board write settle;
  pending saves are durable and tied to a UID, tier, world seed and physics version.
- ScoresModule handles Firebase service availability gracefully
- Supports local development mode with localStorage fallback
- Auth and Scores modules initialize in the correct dependency order; preserve the live `__snowgliderGetRunStamp` seam used by separately copied Firebase modules in production. Practice, noncanonical, stale-version or timing-compromised finishes cannot become canonical records.
- Play again remains available while a save is pending or fails. Real-provider popup/callback, shared-device and reconnect flows require release qualification; passing mocked Firebase tests alone is insufficient.
- New profile writes/logs/report output omit provider email. Retention, historical-field purge and full account export/deletion across Auth, profiles, all board versions and applicable Analytics/local data remain open in [#419](https://github.com/den-run-ai/snowglider/issues/419); omission of new writes does not delete old data.

## Release and Acceptance Gates

- The actual publication chain is in [.github/workflows/ci.yml](.github/workflows/ci.yml): `deploy-rules` waits for `test` and production-build `pwa`; `build-pages` waits for those checks and `deploy-rules`; `deploy-pages` also waits for cross-browser `e2e`. Rules publish before the new client, and failed rules or browser gates block publication. These deploy jobs run only on `main`, not PRs.
- Firestore rules are deployed automatically through `scripts/deploy-firestore-rules.mjs` using the CI service-account secret. Treat older manual-deploy guidance as historical; maintain backward compatibility while the older client is still serving.
- Verify checks on the exact proposed head and verify the main rules/Pages deployment after merge. A source review or a green earlier head does not qualify a newer tree.
- `render-review.yml` captures exact BASE/HEAD scenes with a pinned browser. Missing/blank/incomplete captures fail; pixel diffs become an acceptance gate only with an explicitly approved baseline. Its synchronized service timings and resource counts are diagnostic, not sustained device FPS or GPU-byte measurements.
- Keep physical-phone controls/audio, sustained frame-time/thermal behavior, low-sun/horizon visual acceptance and real OAuth-provider flows explicit. Use real-player screenshots (`?eztrees=1` and an attached EZ branch check) for visuals; mobile emulation is not a physical-device sign-off. Reconcile #248/#219 around the current capture system rather than duplicating it.

## Avalanche System Implementation
- AvalancheSystem class in `avalanche.ts` manages snow boulder physics
- Uses THREE.InstancedMesh for efficient rendering of 120 snow boulders
- Triggered when player travels far enough downhill (distance threshold)
- Boulders spawn behind player (uphill) and tumble downhill following terrain
- Physics includes gravity, ground collision, bounce, friction, and slide acceleration
- Burial detection: collision between player and boulder = game over
- Methods: `trigger(playerPos)`, `update(dt)` (physics + cosmetics — the harness/test entry point), `updatePhysics(dt)` / `updateCosmetics(dt)` (the #402 split: the live loop advances boulders per FIXED 1/60 substep and powder per render frame), `checkBurial(playerPos)`, `hasPassed(playerPos)`, `reset()`
- Requires terrain height function via `setTerrainFunction(fn)` for terrain-aware physics
- Browser tests: serve with `npm start`, then `http://localhost:8080/?test=avalanche`

## Review Guidelines
- Focus on serious correctness, security, deployment, and user-visible behavior issues.
- Flag changes that can break skiing physics, terrain height consistency, tree collision detection, avalanche behavior, camera tracking, touch controls, authentication, score syncing, or GitHub Pages deployment.
- Treat missing tests as important when gameplay mechanics, shared module contracts, Firebase behavior, or CI/CD workflows change.
- Check that GitHub Actions remain least-privileged and do not publish generated folders, dependency directories, coverage reports, test artifacts, or local-only files.
- Verify the complete rules-before-client and test/PWA/cross-browser publication gates above, including exact-head checks and the successful main deployment.
- Preserve local development and `file://` fallbacks when reviewing Firebase/auth changes.
- Treat audio changes as high risk because mobile browsers require user gestures and can suspend audio contexts.
- Prefer concrete bug findings over style-only comments. Avoid broad refactor suggestions unless they directly reduce a clear risk in the changed code.

## Style Notes
- Match the existing ES-module TypeScript style — every `src/` file is `.ts` under `"strict": true` (only the two classic `src/boot/*.js` bootstrap scripts stay JS).
- Use 2-space indentation and semicolons.
- Use camelCase for variables/functions and PascalCase for classes.
- Do **not** re-introduce the removed per-module `window.*` namespace bridges (`window.Mountains`, `window.Controls`, `window.Camera`, `THREE`, …) — modules `import` each other directly now. Only `window.AuthModule`/`window.ScoresModule` and the deliberate game↔test handles remain on `window` as boot/test seams (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3).
- Use `THREE.Vector3` and existing helper functions for position and terrain calculations instead of duplicating math ad hoc.
