# SnowGlider — Feature Gap Analysis & Roadmap

*A synthesis of multiple review passes on the Three.js skiing game at [snowglider.ai](https://snowglider.ai) ([repo](https://github.com/den-run-ai/snowglider)).*

---

## Status

This roadmap began as a feature-gap analysis. Its **top recommendation — the "skill & structure" layer — shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56)**: checkpoint gates + finish line, live split timing and a result screen, ghost racing, an avalanche warning UI, and a first snowplow/carve/tuck ski-technique pass. See [`IMPLEMENTATION_REPORT.md`](IMPLEMENTATION_REPORT.md) for that work in detail.

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
- Background music with selectable tracks
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

Audio appears **partially integrated**: the README lists music and selectable tracks, but the main game file contains no-op audio calls when audio is disabled, and the mobile music toggle is broken.

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
