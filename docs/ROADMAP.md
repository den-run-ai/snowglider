# SnowGlider — Feature Gap Analysis & Roadmap

*A synthesis of multiple review passes on the Three.js skiing game at [snowglider.ai](https://snowglider.ai) ([repo](https://github.com/den-run-ai/snowglider)).*

---

## Status

This roadmap began as a feature-gap analysis. Its **top recommendation — the "skill & structure" layer — shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56)**: checkpoint gates + finish line, live split timing and a result screen, ghost racing, an avalanche warning UI, and a first snowplow/carve/tuck ski-technique pass. See [`CHANGELOG.md`](CHANGELOG.md) for that work in detail.

Status legend used below: **✅ shipped** · **◐ partial** (started, more to do) · **○ open**.

> The [**GitHub issue tracker**](https://github.com/den-run-ai/snowglider/issues) is the living source of truth for the backlog. This document is a higher-level synthesis and will drift as issues open and close — treat the issue references here as pointers, not a status board.

---

## TL;DR

SnowGlider has a solid, playable **foundation** — a snowman skis down a procedurally generated mountain, dodges trees, jumps, and races the clock against an avalanche. The original gap was **game depth and a replay loop**: the moment-to-moment experience was "go downhill, avoid trees, maybe jump, beat your time," which is enough for a demo but not enough for repeat play.

The missing layer can be summarized as one chain:

> **course → visible goal → skill choices → risk / reward → finish & result → reason to play again**

**Single strongest move (✅ shipped in #56):** **gates/checkpoints + carving/snowplow technique + an avalanche warning UI**, with **split-time ghost racing** as the replay hook. That turned a pleasant Three.js snowman demo into a game with skill, tension, and replayability. The skiing-technique model landed deliberately thin (see Finding 2) — deepening it is the main open thread from this slice.

---

## What's Already Built (baseline)

These exist today and generally don't need re-inventing — the gaps below build on top of them:

- Snowman skiing with physics and terrain interaction
- Procedurally generated backcountry mountain terrain
- Tree/rock obstacles with collision detection
- Avalanche system (triggers after distance traveled, checks burial, resets if it passes the player)
- Snow particle effects responsive to speed/turning
- Tracking camera with toggleable views
- Background music (simplified native HTML5 audio, single track)
- Timer with best-time tracking
- Firebase auth + global leaderboard (finishes can record scores when logged in)
- Mobile touch controls
- A comprehensive test suite

### Shipped in the skill & structure layer (#56)

- **Course structure:** checkpoint gates down the fall line + a gold finish arch; progress bar and "m to finish" HUD
- **Split timing + result screen:** per-checkpoint splits with ±delta vs. your best, a finish result panel with a medal and an improvement line
- **Ghost racing:** your best run recorded and replayed as a translucent ghost, with an AHEAD/BEHIND readout
- **Avalanche telegraphing:** warning banner, "distance behind you" danger meter, red vignette, proximity camera shake
- **Game feel:** speed-based FOV, camera shake on hard landings
- **Ski technique (first pass):** snowplow brake, carve/skid, tuck, and terrain-dependent grip — *intentionally thin* for now (see Finding 2)

**The core gap was "game feel + replay loop," not core tech.**

---

## Priority Findings

Ordered roughly by impact. Each notes *why it matters*, *what to add*, and *related GitHub issues* where applicable.

### 1. A clearer course and objective feedback *(highest impact)* — ✅ shipped (#56)

The objective is "reach the bottom fast," but the player got little guidance, so the mountain read like a sandbox slope rather than a race.

- **Shipped:** finish-line arch, checkpoint gates, distance-to-finish + progress bar, a result screen with split times and an "improved by ±X seconds" payoff.
- **Remaining (○):** mini-map, on-slope route hints/arrows.

### 2. Skiing skill, not just steering — ◐ partial (#56)

The biggest design gap: the game *slid with steering* rather than feeling like skiing.

- **Shipped:** snowplow/"pizza" braking (clamped so it stops rather than reversing uphill), carve vs. skid, straight-line tuck, and terrain-dependent grip — layered on a test-safe seam so no-input physics is unchanged.
- **Remaining (○):** the model is *intentionally thin* — turning doesn't yet cost speed at normal velocity, so carving isn't yet a genuine speed-management trade-off. Also: parallel turns, hop turns, ski poles/planting.
- **Open issues:** more realistic speed control for turns/terrain/avalanche escape (**#54**), ski techniques (**#48**), ski poles and planting (**#52**).

### 3. Telegraphing and drama around the avalanche — ✅ shipped (#56)

The avalanche existed but wasn't well communicated, especially when it came from behind.

- **Shipped:** a warning banner ("⚠ AVALANCHE — GO!" escalating when close), a "distance behind you" danger meter, a red vignette, and proximity-scaled camera shake.
- **Remaining (○):** audio rumble/cue, an approaching snow cloud/shadow rendered in the scene.
- **Open issues:** avalanche trigger notification + visibility from behind (**#49**), avalanche effects and controls (**#44**).

### 4. Jump usefulness and trick/reward mechanics — ○ open

Jump is a listed control but currently does little for the player.

- **Add:** airtime scoring, landing-quality grading, obstacle clears, shortcuts, avalanche-dodge windows, speed boost on clean landings, and style/combo bonuses.
- **Open issue:** jumping should help avoid obstacles and maybe avalanches (**#47**).

### 5. Dynamic hazards and a living world — ○ open

Hazards are static (trees, rocks) plus the single avalanche, so the descent feels static after the first minute.

- **Add:** moving wildlife (penguins, deer), falling snowballs, breaking ice patches that change friction, rival skiers, and ramps.
- **The "Yeti factor":** a pursuing antagonist/snow monster (à la SkiFree) that forces the player to speed up adds memorable pressure — the avalanche is a start, but a recurring chaser is stickier.
- **Power-ups (more arcade-leaning):** invincibility shield (burst through trees), coin magnet, "rocket skis" speed boost with exhaust trails.

### 6. Progression and replay hooks — ◐ partial (#56)

Timer/best-time and leaderboard existed, but there was no reason to play 20 runs.

- **Shipped:** ghost replay ("beat your ghost") and medals/tiers on the result screen.
- **Remaining (○):** a daily seeded course, unlockable cosmetics (scarves/skis/hats), achievements, difficulty tiers (kids/bunny vs. expert), missions ("near-miss 5 trees in one run," "travel 1000 m without jumping"), and per-course / per-day leaderboards instead of a single global list.

### 7. Game feel ("juice") and visual readability — ◐ partial (#56)

A skiing game lives on speed readability and mountain atmosphere.

- **Shipped:** speed-based FOV (widens at speed) and camera shake on hard landings / avalanche proximity.
- **Remaining (○):** snow trails carved from the back of the skis, weather variation and a day→sunset→night skybox, stronger slope contrast and obstacle silhouettes, depth cues, a readable horizon, and an intro fly-over of the mountain.
- **Open issues:** intro fly-over (**#51**), plus open issues on lighting/shadows, snow/tree/rock/snowman textures, and a visible sky.

### 8. Audio consistency and completion — ○ open

Audio has since been rewritten to a simplified, dependency-free native HTML5 implementation (single background-music track) and re-enabled (`AUDIO_ENABLED = true`); the full history is in [`CHANGELOG.md`](CHANGELOG.md). It remains **partially integrated**: the in-page audio control button is still disabled in `index.html` and mobile playback (iOS Safari silent switch, Android Chrome) is not yet verified on real devices.

- **Add / finish:** sound effects beyond music — wind that scales with speed, satisfying carving sounds on sharp turns, a crash/thud on wipeout — and complete the mobile integration.
- **Open issue:** mobile music-disable button not working (**#50**).

### 9. Pause/save and quality-of-life controls — ○ open

Basic product completeness is missing, which is especially felt on mobile.

- **Add:** pause/resume/save state, restart confirmation, remappable controls, controller support, sensitivity settings, camera FOV control, and mobile calibration.
- **Open issue:** implement game state for pause/save (**#39**).

### 10. Mobile-first control polish — ○ open

Touch controls exist, but this game is a natural fit for richer mobile input.

- **Add:** gyro/tilt steering, haptics, swipe-to-jump, a simpler mobile HUD, and **performance scaling** (toggle shadows / reduce particle counts when framerate drops below ~30 FPS).
- **UI:** keep the game-over screen, score counter, and menus as responsive HTML/CSS overlaying the `<canvas>` for crisp mobile readability, rather than baked into the 3D scene.
- **Open issue:** gyro/tilt controls (open).

### 11. Personality and fail-state fun — ○ open

Crashes and finishes are where a casual game becomes memorable and shareable.

- **Add:** snowman parts flying off on impact, scarf physics, funny crash animations, snowballing after a wipeout, and celebratory finish animations.
- **Open issue:** a more realistic snowman with scarf/flexibility that breaks down on impact (**#53**).

---

## The "AI" Angle (snowglider.ai)

Given the `.ai` domain, at least one AI-flavored feature is a natural fit and a differentiator. (Ghost racing shipped in #56 lays the trajectory-recording groundwork an AI ghost could reuse.)

- **AI ghost skier** that races your best time.
- **AI coach** after each run: *"You lost time braking too late before the trees."*
- **Procedural course generator** with named difficulties: "powder forest," "avalanche chute," "bunny slope."
- **Auto-generated replay highlights:** crashes, big jumps, near misses.
- **Natural-language course prompt:** *"make a fast open powder run with few trees."*

---

## Recommended Roadmap

A phased plan that several of the review passes converge on:

| Phase | Goal | Ship | Status |
|-------|------|------|--------|
| **P0 — Make it feel like a game** | Give runs a shape | Finish line, checkpoints, split times, result screen, medals, restart/replay flow | ✅ shipped (#56) |
| **P1 — Make skiing skillful** | Reward technique | Carving / snowplow / straight-line modes, speed loss on turns, terrain-dependent friction, meaningful jumps | ◐ started (#56) — technique seam landed but thin; turns don't yet cost speed; jumps still open (#48/#54) |
| **P2 — Make it memorable** | Atmosphere & drama | Better mountain visuals, avalanche warning, expressive snowman, scarf/poles, intro fly-over, ghost racer | ◐ avalanche warning + ghost racer shipped (#56); visuals/snowman/poles/fly-over open |
| **P3 — Make it social / AI** | Retention | Daily challenge, ghost leaderboard, AI coach, shareable replay | ○ open |

---

## Refactoring Roadmap

The feature roadmap above is increasingly constrained by three large files:
`index.html` owns markup, CSS, bootstrapping, local-mode mocks, script loading,
and start-menu behavior; `src/snowglider.js` owns scene setup, shared game state,
the render loop, lifecycle, HUD updates, scoring, overlays, and test globals; and
`src/snowman.js` owns model construction, skiing physics, pose animation,
collision checks, finish/crash reason selection, and browser test hooks.

The best structural move is a staged, behavior-preserving extraction that keeps
the current no-build/static-site architecture intact. Do **not** use this as a
bundler/framework rewrite. Preserve the `file://` fallback, GitHub Pages
deployment, explicit script order, and existing `window.*` compatibility exports
until tests and callers have been migrated.

### Stage R1 — Split the page shell first

Lowest-risk extraction from `index.html`:

- Move page styles to `styles/main.css`.
- Move `file://` auth/score mocks to `src/boot/local-auth.js`.
- Move Firebase defaults/init-json handling to `src/boot/firebase-bootstrap.js`.
- Replace the nested script `onload` pyramid with `src/boot/script-loader.js`
  using a small `loadScriptsInOrder([...])` helper.
- Move start/about menu behavior to `src/ui/start-menu.js`.

The script order must remain:

```text
mountains -> trees -> snow -> camera -> snowman -> audio -> controls
          -> avalanche -> effects -> course -> snowglider -> tests
```

### Stage R2 — Thin the game orchestrator

`src/snowglider.js` should become a small coordinator instead of the owner of
every runtime concern. Extract:

- `src/game/scene-setup.js` for scene, renderer, lights, terrain, trees, snowman,
  snow particles, avalanche construction, and course/effects init.
- `src/game/game-state.js` for mutable run state (`pos`, `velocity`, air state,
  timers, avalanche trigger state, technique).
- `src/game/main-loop.js` for the current `animate()` ordering.
- `src/game/lifecycle.js` for start, reset, restart, and game-active transitions.
- `src/ui/hud.js` for stats, timer, speed color, position, and technique display.
- `src/ui/result-overlay.js` for game-over/finish overlay, local best display,
  login prompt, leaderboard insertion, and `CourseModule.onFinish(...)`.
- `src/ui/collapsible-panel.js` for shared Game Stats / Game Controls
  collapse, resize, and swipe behavior.

Keep these globals stable during the first pass because controls and browser
tests still use them: `window.resetSnowman`, `window.restartGame`,
`window.showGameOver`, `window.toggleCameraView`, and
`window.initializeGameWithAudio`.

### Stage R3 — Split snowman only after R1/R2

`src/snowman.js` is the highest-risk file because it contains the physics model
and the deterministic verification seam. Split it only after the boot and
orchestrator work has landed:

- `src/snowman/model.js` for geometry, materials, arms, hat, skis, and scene add.
- `src/snowman/physics.js` for gravity, friction, jumping, air control, ski
  technique, snowplow braking, skid/carve classification, and idle turning.
- `src/snowman/pose.js` for heading, terrain tilt, jump tilt, turn lean, and ski
  wedge animation.
- `src/snowman/collision.js` for tree collision, boundary checks, finish
  detection, and crash/finish reason strings.
- `src/snowman/test-hooks.js` for browser collision hooks.

Keep `window.Snowman.updateSnowman(...)`, `window.Snowman.resetSnowman(...)`,
and `window.Snowman.addTestHooks(...)` as compatibility wrappers at first.
Internally delegate to smaller modules without changing the public signatures.

### Guardrails

- Keep refactoring mechanical: no physics constant changes, no timing changes,
  no scoring changes, and no UI behavior changes unless explicitly scoped.
- Preserve the finish reason string `"You reached the end of the slope!"`; the
  result screen, best-time recording, score syncing, and course finish flow key
  off it.
- Re-run `npm test` and `npm run test:verify` after each stage. Any change to the
  no-input physics path must be deliberate and reflected in
  `docs/PHYSICS.md` plus the verification baseline.
- Update `docs/ARCHITECTURE.md` in the same PR as each extraction so the script
  order, globals, and ownership boundaries stay accurate.

---

## Top Recommendation (✅ delivered in #56)

The first thing to ship was **gates/checkpoints + carving/snowplow mechanics + avalanche warning UI**, plus **split-time ghost racing** — building the *skill and structure* layer before adding more content, because that converts a cute Three.js skiing demo into a game with skill, tension, and replayability. This shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56).

**Next strongest move:** deepen the ski-technique model into a real speed-management trade-off (carving holds speed; panic-steering scrubs it) — issues **#48** / **#54** — then layer P2 atmosphere on top.

---

## Appendix — Mapping to GitHub Issues

Many recommendations align with the maintainer's backlog, which is a good sign the direction is shared. **The issue tracker is authoritative; the statuses below are this document's best-effort snapshot.**

| Theme | Issue(s) | Status |
|-------|----------|--------|
| Realistic speed control (turns, terrain, avalanche escape) | #54 | ◐ first pass in #56; turns don't yet cost speed |
| Ski techniques (snowplow/pizza, parallel, carving, hop, straight-line) | #48 | ◐ snowplow/carve/tuck in #56; parallel/hop open |
| Avalanche trigger notification + visibility from behind | #49 | ◐ warning UI + danger meter in #56; in-scene cloud/shadow open |
| Avalanche effects and controls | #44 | ◐ effects in #56; controls open |
| Expressive snowman (scarf, flexible, breaks on impact) | #53 | ○ open |
| Ski poles and planting | #52 | ○ open |
| Intro fly-over of the mountain | #51 | ○ open |
| Mobile music-disable button broken *(bug)* | #50 | ○ open |
| Jumping should help avoid obstacles/avalanches | #47 | ○ open |
| Integrate a realistic 3D map | #40 | ○ open |
| Pause/save game state | #39 | ○ open |
| Gyro/tilt controls; lighting/shadows; textures; visible sky | (open) | ○ open |

*The higher-level structural gaps — a finish line and objective feedback, scoring depth, progression/replay hooks, and the AI features — were the items the tracker was quieter on; #56 delivered the first of these (course + result + ghost), and the rest (daily/per-course leaderboards, AI coach) remain the biggest open wins.*
