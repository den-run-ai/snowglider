# Changelog

All notable changes to SnowGlider. This is a continuously deployed static site
with no formal release versions, so entries are grouped by the pull request or
dated milestone that introduced them, most recent first.

This file consolidates two reports that previously lived under `docs/`: the
skill-&-structure implementation report (#56) and the audio implementation /
diagnostic history. For the current design see [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`PHYSICS.md`](PHYSICS.md), and [`tests/README.md`](../tests/README.md).

---

## Unreleased

### Social sharing — "Share Result" on the finish screen (#157)
- New `src/share.ts` module implements the plan in
  [`SOCIAL_SHARING_PLAN.md`](SOCIAL_SHARING_PLAN.md): lightweight sharing of a
  finished run with no sign-in, backend, or per-platform SDK.
  - `buildResultShareData(time, isNewBest, href?)` builds deterministic share
    copy ("I finished SnowGlider in 42.13s…" / "New SnowGlider personal best:…").
  - `cleanShareUrl(href)` keeps shared links stable and public: it strips
    local-only query params (`?test=…`) and the hash, and collapses
    local/dev/`file:`/unparseable URLs to the canonical `https://snowglider.ai/`.
  - `shareResult(data)` uses the native Web Share API when available (from the
    button's user gesture) and falls back to `navigator.clipboard.writeText()`
    on absence or any non-cancel failure; a user-cancelled share sheet
    (`AbortError`) is respected (no clipboard write). It never rejects.
- The course result panel (`src/course.ts`) appends one **🔗 Share Result**
  button, so it appears only on a valid successful finish and is cleaned up with
  the panel on restart. The button label reflects the outcome (Shared / Link
  copied / unavailable) and a best-effort `share_result` Analytics event is
  logged through the existing `window.firebaseModules.logEvent` seam.
- Fixed a latent touch-binding bug surfaced by the nested button: the game-over
  `MutationObserver` in `src/controls.ts` selected `#gameOverOverlay button`
  (first descendant, depth-first), which would now match the nested Share button
  and misbind restart on touch devices. Switched to the child combinator
  `#gameOverOverlay > button` so it always targets the direct-child restart
  button.
- Tests: new `tests/share-tests.js` (`npm run test:share`, 31 checks) for copy
  formatting, URL cleanup, and the share/clipboard/Analytics outcomes; the
  `dom_smoke_test` now asserts the Share button appears only in finish panels and
  copies a stable public link; the controls test guards the restart/share
  touch-binding regression.

### Visible sky — gradient sky, atmospheric sky + sun, distance fog (#2)
- Replaced the flat `scene.background = Color(0x87CEEB)` (and no fog) with a
  graduated sky and matching horizon fog, in a new `src/sky.ts` module.
- **Tier 1 — gradient sky + fog (`Sky.applyGradientSky`, kept as a fallback):**
  a large `BackSide` dome whose vertex shader pins it to the far plane
  (`gl_Position.z = gl_Position.w`), so it behaves as a skybox: it never clips
  against the camera far plane and fills every pixel not covered by scene
  geometry. The gradient is evaluated per-pixel from the view direction so it
  tracks the chase camera's pitch.
- **Tier 2 — atmospheric sky + sun (`Sky.applyAtmosphericSky`, what the game
  uses):** the Preetham daylight model ported from three.js's
  `examples/jsm/objects/Sky.js`, inlined so it imports only bare `three` (a
  `three/addons/*` specifier would 404 on the verbatim-copied dist `?test=`
  pages). The sun direction is the scene's directional-light position, so the
  visible sun disc and the cast shadows agree. Scattering params lean slightly
  clearer than three's ACES demo because the project runs the legacy colour
  pipeline (no tone mapping); an `exposure` uniform stands in for
  `renderer.toneMappingExposure`.
- `scene.fog` is a linear fog tinted to the horizon colour, tuned to keep the
  gameplay area crisp (`near = 140`) and fade only distant terrain / the far
  peak (`far = 750`) so the slope no longer hard-cuts at the far plane.
- Purely visual: no physics, collision, scoring, or lighting changes (the
  directional light and its shadows are untouched).
- The exact sky look (turbidity / rayleigh / exposure / fog tint) was set under
  the legacy pipeline and is tunable — eyeball on-device and adjust the
  constants in `src/sky.ts` if needed.

### Skiing skill — parallel turns & hop turns (completes #48)
- Added the two remaining ski techniques from #48 (P1 of [`ROADMAP.md`](ROADMAP.md)),
  on top of the carve/skid/snowplow/tuck model: **parallel turns** and **hop turns**.
- **Parallel turn** — the mastery tier above a carve. Once a committed carve locks
  the edge fully in (`carveCharge > 0.85`, the `PARALLEL_LOCK` threshold), the
  always-on turn tax fades out so a perfectly-held turn is nearly free, and the HUD
  reads `🎿 Parallel`. The snowman draws its skis together and rolls them onto edge
  (angulation), visually distinct from the beginner snowplow wedge. The pose is
  cosmetic; the only physics change (tax relief) is confined to `carveCharge > 0.85`,
  so carve/skid feel below that — and the gating carve-vs-skid check — are unchanged.
- **Hop turn** — Jump **+** Left/Right while grounded performs a quick edge-set
  pivot instead of a straight jump: it snaps the heading ~0.4 rad toward the steer
  direction, scrubs ~18% of speed, gives a small pop, and lands you on a fresh edge
  committed to the new line (`carveCharge` reset). It trades speed for a sharper
  direction change than carving can give — the steep-terrain / tight-spot move.
  Plain Jump (no steer) is unchanged.
- Determinism preserved: both mechanics are gated behind steering or jump+steer
  input, so no-input coasting stays byte-for-byte identical to the frozen baseline.
  The verification harness gains two **gating** checks — a held committed carve must
  reach the `parallel` tier, and a hop turn must pivot far harder than a plain steer
  frame *and* scrub speed. `npm test` (incl. verify + contract) and the 87-test
  browser suite stay green.

### Skiing skill — carve vs. skid speed trade-off (#48 / #54)
- Deepened the ski-technique model (P1 of [`ROADMAP.md`](ROADMAP.md)) from the
  intentionally-thin #56 first pass into a real speed-management trade-off: a
  committed carve holds speed, while panic-steering (reversing the edge or
  yanking a fresh one) scrubs it.
- Added a `carveCharge` edge-engagement state that builds while the player holds
  one steering direction (~0.66 s to lock in) and collapses on any reversal; the
  edge wash-out scales down with it, plus a small always-on turn tax so
  straight-lining stays the fastest line. The HUD `technique` now reads `carve`
  only once the edge is locked, otherwise `skid`.
- No-input coasting stays byte-for-byte identical to the frozen baseline (the
  load-bearing verification invariant). The verification harness's old
  terrain-dependent "turn vs. coast" diagnostic is replaced by a **gating**
  carve-vs-skid check: linked carves must finish meaningfully faster (>12%;
  measured ≈40%) than chatter-skidding the same fall line.

### Gameplay
- Large exposed rocks now participate in collision detection with a distinct rock
  crash reason, while small half-buried stones remain decorative terrain detail.
- Rock collision data is returned from terrain generation and threaded through the
  typed physics wrapper so the behavior lands cleanly after the TypeScript
  migration stack.
- Collidable rocks are kept off the central ski line (`|x| < 5`) and the spawn
  pocket (within 10u of the start) so the unseeded random placement can never wall
  off the run or crash the player on spawn; decorative rocks still render anywhere.

### Honest full-source coverage — Node + browser merged (#122)
- `npm run test:coverage` now runs c8 with `--all --src src`, so the Node and
  verification suites count every migrated `src/` file instead of only the ones
  Node tests `import`.
- The browser suite collects Chromium V8 coverage (`BROWSER_COVERAGE=1` →
  `tests/coverage/browser-coverage.js`) and attributes it back to `src/*.ts` via
  Vite's inline source maps. `tests/coverage/merge-lcov.js` line-merges that with
  the c8 LCOV into a single `coverage/lcov.info` (`npm run test:coverage:all` runs
  the whole pipeline; CI runs it across the existing test/browser steps).
- Line-level merge is deliberate: c8 instruments Node's type-stripped `.ts` while
  Vite instruments its esbuild output, so the two emit different statement
  structures for the same file; an Istanbul-object merge would mis-attribute hits.
- Net effect: browser-only modules (snowglider, course, effects, main, the boot
  and start-menu modules) and the auth/scores browser suites now report real
  coverage instead of `0%`; the merged report rose from ~28% (Node-only) to ~76%.
  Coverage stays informational and non-gating (`fail_ci_if_error: false`, no
  threshold); the Codecov badge is re-enabled now that the denominator is honest.

### TypeScript migration — Phase 2 (conversion) complete (#84)
- Every game module is now an ES module that imports `three` from npm (the CDN
  UMD global is gone) and imports the others directly. The final classic module
  `audio.js` was converted, and the last consumers reading it as a global — the
  boot script-loader (`src/boot/script-loader.js`) and the start menu
  (`src/ui/start-menu.js`) — became ES modules that `import { AudioModule }`.
- **All per-module `window.*` namespace bridges are retired** (`THREE`,
  `Avalanche`, `Camera`, `Controls`, `CourseModule`, `EffectsModule`,
  `Snow`/`Utils`, `Snowman`, `Mountains`, `Trees`, the `getTerrainHeight*`
  samplers, and finally `AudioModule`). Remaining `window.*` handles are
  deliberate boot/auth/test seams, not module-namespace bridges.
- Build, lint, `tsc --noEmit`, the Node suite, and the puppeteer browser suite
  stay green; the Vite bundle and `CNAME`/Pages artifact are unchanged. See
  [`TYPESCRIPT_MIGRATION.md`](TYPESCRIPT_MIGRATION.md) for the phase status.

### Onboarding / start screen
- **Self-updating build badge.** The hand-maintained `build-id` meta (stuck at
  `2025.10.06-mobile-audio-v3`) is now a `dev` placeholder that the new
  `inject-build-id` Vite plugin rewrites to the actual build timestamp at
  serve/build time — so it can never go stale again. The badge also moved off the
  primary "Start Game" CTA into an unobtrusive footer (`#buildBadge`).
- **Refreshed copy** for the description and About panel to match the shipped
  game (checkpoints, split times, ghost racing, the avalanche chase) instead of
  the old "go downhill, avoid trees" framing; removed a stale `TODO` comment.
- **Touch-controls note** added below the keyboard controls guide.
- **Global Top Times preview** on the start screen (`#startLeaderboard`),
  populated from `ScoresModule.getLeaderboard()` once scores load; hidden when no
  leaderboard is available (file:// / localhost / offline).
- **Optional sign-in** surfaced on the start screen: the existing
  `#authContainer` (login ↔ profile, managed by `auth.js`) is lifted above the
  start overlay via a `body.start-screen-active` class, plus a hint pointing to
  it. No auth wiring is duplicated — the start menu only reads auth/score state.

### Documentation
- Added [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`PHYSICS.md`](PHYSICS.md);
  folded the `docs/` implementation and audio reports into this changelog.

---

## Skill & Structure layer — gates, ski technique, avalanche drama, ghost racing (#56)

The roadmap's top recommendation: turn a pleasant Three.js snowman demo into a
game with skill, tension, and a reason to replay — shipped *before* more content.

**Files:** new `course.js` (~560 lines) and `effects.js` (~190 lines); modified
`snowman.js`, `snowglider.js`, `index.html`. No new dependencies, no build step,
no changes to the Firebase/auth/audio/scores subsystems.

### Added — a legible, timed course (`course.js`)
- **Checkpoint gates** at `z = -60, -105, -150` plus a gold **finish arch** at
  `z = -195`. Gates are **purely decorative — they never collide**, so they can't
  fight the tree-collision system.
- **Progress bar + "m to finish"** HUD (1 world unit = 1 m, ~180 m course).
- **Live split times** at each checkpoint with ±delta vs. your best split
  (green/red), and a **result screen** with total time, medal, improvement line,
  and a per-checkpoint split table.

### Added — ghost racing & progression (`course.js`)
- Your best run's trajectory is recorded (~20 Hz) and replayed as a translucent
  blue **ghost**, with an AHEAD/BEHIND-by-seconds readout at your current depth.
- **Medals** relative to your own pace (first descent / new record / silver within
  +10% / bronze within +25% / finished) — robust without a hand-tuned global par.
- Best splits (`snowgliderBestSplits`) and the ghost (`snowgliderGhost`) persist to
  `localStorage`, committed **only when a run beats the stored best**. Complements,
  and does not change, the existing `snowgliderBestTime` flow.

### Changed — skiing skill, not just steering (`snowman.js`)
- **Snowplow brake (Down):** decelerates along the actual direction of travel,
  shedding real speed while granting tighter, planted turns; skis form a wedge.
- **Carve vs. skid (Left/Right):** smooth turns hold speed; hard turns at speed
  wash the edges out and scrub speed, scaled by speed and grip.
- **Tuck (Up, no steer):** least friction, most speed, least control.
- No keys added or remapped. See [`PHYSICS.md` §3](PHYSICS.md) for the model.

### Added — avalanche telegraphing & game feel (`effects.js`)
- Red **warning banner** (escalates to "RIGHT BEHIND YOU!"), a **danger meter**
  showing metres behind you, a red **vignette**, and **camera shake** that all
  scale with proximity — driven by the avalanche system's existing
  `getClosestDistance()`/`active`, so `avalanche.js` was unchanged.
- **Speed-based FOV** (75°→88°) and landing/proximity camera shake. All motion
  respects `prefers-reduced-motion`.

### Design note — the test-safe physics seam
The ski-technique model is layered so that **with no steering/brake input the
grounded physics is byte-for-byte identical to the original**, preserving the
existing test suite. This is verified, not assumed:
`tests/verification/physics_invariant_harness.js` reports max abs trajectory
difference `0` for the coasting case and gates its exit code on it. See
[`PHYSICS.md` §6](PHYSICS.md).

### Verification
- Node regression suite **31/31** (terrain 7, physics 6, regression 5,
  tree-collision 3, avalanche 10), before and after.
- Physics-invariant harness: coasting identical; snowplow brakes to a near-stop;
  edge scrub active under steering.
- DOM smoke test **16/16** (jsdom + mocked THREE): both modules build their DOM,
  the per-frame loop runs, every checkpoint and the finish are reached, ghost and
  splits persist, and a faster second run is reported as a new record.
- Puppeteer suite **51/51** against the integrated game.

### Deliberately out of scope (follow-ups)
Ski snow-trails, a day→night skybox and weather, a "Yeti" chaser, arcade
power-ups, and the AI-coach / natural-language course ideas.

---

## Audio

Background music has a long, troubled history across three implementations. Audio
is currently the **simplified native HTML5** implementation; the `AUDIO_ENABLED`
flag in [`src/audio.js`](src/audio.js) gates it, and `CLAUDE.md` documents the
operational guidance for re-enabling/testing on mobile.

### Simplified native HTML5 audio (Jan 2026)
A deliberate rewrite to the simplest thing that works: native `<audio>`, no
library. **182 lines** (down from 734), a single track (`drum_loop`), two state
variables (`muted`, `initialized`), no pre-loading (loads on first play), no
visibility-change handling (the browser manages it). Howler.js and its CDN tag
were removed, along with the conflicting `initAudioContext()` in `index.html`.
Automated audio tests updated to the simplified API: **19/19 passing**. Remaining:
manual verification on real iOS/Android devices.

### Audio disabled on main — `ccdbad4` (Jan 26 2026)
After ~10 months and 8+ fix attempts, audio was intentionally disabled on `main`
(`AUDIO_ENABLED = false`, all public methods early-exit) while the approach was
reconsidered — which led to the simplified rewrite above.

### Howler.js migration — `88ee638` (Nov 23 2025)
Migrated from THREE.Audio to Howler.js for better mobile/iOS handling (automatic
unlock, HTML5-audio fallback, `onplayerror`/`onloaderror`). Public `AudioModule`
API kept stable; `addAudioListener()` became a no-op. **It did not solve the
problems** — see root-cause notes below.

### Initial Three.js audio — `1e3bf97` (Apr 2025)
First implementation using `THREE.AudioListener`/`AudioLoader`/`Audio`.

### Why it kept failing (root-cause notes, kept for whoever re-enables audio)
- **THREE.Audio:** thin Web-Audio wrapper with no mobile-quirk handling; required
  manual `AudioContext.resume()` at exactly the right time; no HTML5 fallback.
  Mobile contexts suspended and wouldn't reliably resume; no reliable iOS silent-
  switch detection; inconsistent autoplay-policy enforcement; flag sprawl.
- **Howler.js:** `html5: true` (needed for iOS) raised latency → audible lag;
  Howler's own `AudioContext` fought the page's temporary unlock context; pre-load
  vs. lazy-load race conditions; visibility-change resume sometimes failed silently
  with no retry. Code grew to 734 lines with overlapping flags.
- **Takeaway / current approach:** the simplest native implementation (Option 1)
  was chosen over Tone.js or raw Web Audio. When re-enabling, test thoroughly on
  iOS Safari (silent switch on/off), Android Chrome, and desktop, and verify the
  unlock happens inside a user gesture.

### References
- Howler.js: https://howlerjs.com/ · https://github.com/goldfire/howler.js
- Autoplay policy: https://developer.chrome.com/blog/autoplay/
- Web Audio API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

---

## Earlier improvements

Foundational work that predates the structured entries above, consolidated here
from the README. Audio-related items live in the [Audio](#audio) section.

### Gameplay, terrain & effects
- Avalanche system: snow boulders triggered when traveling far enough downhill,
  with physics simulation and burial detection (game over on collision).
- Converted the terrain from a groomed ski run to a natural backcountry mountain;
  distributed trees and rocks across the whole mountain; strengthened the downhill
  gradient for a consistent skiing experience.
- Fixed tree-collision detection in the extended terrain areas.
- Enhanced the snow particle effects.

### Camera
- Improved camera tracking with smooth transitions.

### Auth & leaderboard
- Added Firebase authentication and a user account system; a global leaderboard
  with the top 10 player times; and automatic score syncing between `localStorage`
  and Firebase.
- Split scoring/leaderboard into a separate `scores.js` module, with clearer
  separation of concerns and backward-compatible interfaces.
- Hardened error handling and Firebase service-availability management.
- Mobile auth: improved Chrome popup handling, popup-blocked / cancellation
  recovery with automatic retry, an optimized mobile auth flow, responsive visual
  feedback, and a debug overlay (`?debug=auth`).

### Mobile & controls
- Mobile-friendly touch controls with on-screen visual indicators; an adaptive
  layout for screen size / orientation; and automatic mobile-device detection.

### UI
- Collapsible Game Controls panel matching the Game Stats panel; consistent
  left/right swipe gestures to collapse panels; and cross-device fixes for the
  collapsible panels.

### Code structure & testing
- Renamed `utils.js` → `snow.js`; extracted tree logic into `trees.js`; separated
  the snowman into its own module.
- Added comprehensive test hooks for verifying game mechanics.
