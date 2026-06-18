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
