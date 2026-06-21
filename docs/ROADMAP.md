# SnowGlider — Feature Gap Analysis & Roadmap

*A synthesis of multiple review passes on the Three.js skiing game at [snowglider.ai](https://snowglider.ai) ([repo](https://github.com/den-run-ai/snowglider)).*

---

## Status

This roadmap began as a feature-gap analysis. Its **top recommendation — the "skill & structure" layer — shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56)**: checkpoint gates + finish line, live split timing and a result screen, ghost racing, an avalanche warning UI, and a first snowplow/carve/tuck ski-technique pass. See [`CHANGELOG.md`](CHANGELOG.md) for that work in detail.

**Since this roadmap was written (snapshot 2026-06-18):** a large *infrastructure* wave landed — the TypeScript/ES-module migration completed (issues [#35](https://github.com/den-run-ai/snowglider/issues/35), [#84](https://github.com/den-run-ai/snowglider/issues/84), [#98](https://github.com/den-run-ai/snowglider/issues/98), now closed; all of `src/` is `.ts` under `strict: true`, bundled by Vite), plus CI hardening (production-build validation, raw-TS Pages guard, honest merged Node+browser coverage) and new test layers (Playwright cross-browser/mobile E2E, Firestore-rules harness, c8 coverage harnesses). **None of this changed gameplay**, so the Priority Findings below are unchanged — but it did invalidate the premises of the [Refactoring Roadmap](#refactoring-roadmap), which has been updated accordingly. *(Update: post-snapshot gameplay PRs have since deepened Finding 2 / P1 — [#136](https://github.com/den-run-ai/snowglider/pull/136) landed the carve-vs-skid speed-management trade-off, and #146 added parallel turns and hop turns, substantially completing the ski-techniques issue #48.)*

Status legend used below: **✅ shipped** · **◐ partial** (started, more to do) · **○ open**.

> The [**GitHub issue tracker**](https://github.com/den-run-ai/snowglider/issues) is the living source of truth for the backlog. This document is a higher-level synthesis and will drift as issues open and close — treat the issue references here as pointers, not a status board.

---

## TL;DR

SnowGlider has a solid, playable **foundation** — a snowman skis down a procedurally generated mountain, dodges trees, jumps, and races the clock against an avalanche. The original gap was **game depth and a replay loop**: the moment-to-moment experience was "go downhill, avoid trees, maybe jump, beat your time," which is enough for a demo but not enough for repeat play.

The missing layer can be summarized as one chain:

> **course → visible goal → skill choices → risk / reward → finish & result → reason to play again**

**Single strongest move (✅ shipped in #56):** **gates/checkpoints + carving/snowplow technique + an avalanche warning UI**, with **split-time ghost racing** as the replay hook. That turned a pleasant Three.js snowman demo into a game with skill, tension, and replayability. The skiing-technique model landed deliberately thin (see Finding 2); its key open thread — the carve-vs-skid speed trade-off — was then deepened in **#136**.

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
- **Ski technique (first pass):** snowplow brake, carve/skid, tuck, and terrain-dependent grip — *intentionally thin* at first; the carve-vs-skid speed trade-off was later deepened in #136 (see Finding 2)

**The core gap was "game feel + replay loop," not core tech.**

---

## Priority Findings

Ordered roughly by impact. Each notes *why it matters*, *what to add*, and *related GitHub issues* where applicable.

### 1. A clearer course and objective feedback *(highest impact)* — ✅ shipped (#56)

The objective is "reach the bottom fast," but the player got little guidance, so the mountain read like a sandbox slope rather than a race.

- **Shipped:** finish-line arch, checkpoint gates, distance-to-finish + progress bar, a result screen with split times and an "improved by ±X seconds" payoff.
- **Remaining (○):** mini-map, on-slope route hints/arrows.

### 2. Skiing skill, not just steering — ◐ partial (#56, #136, #146)

The biggest design gap: the game *slid with steering* rather than feeling like skiing.

- **Shipped (#56):** snowplow/"pizza" braking (clamped so it stops rather than reversing uphill), carve vs. skid, straight-line tuck, and terrain-dependent grip — layered on a test-safe seam so no-input physics is unchanged.
- **Shipped (#136):** the carve-vs-skid **speed-management trade-off** that #56 was thin on — a `carveCharge` edge-engagement model where a committed carve holds speed and panic-steering (reversing the edge / yanking a fresh one) scrubs it, plus an always-on turn tax so straight-lining stays the fastest line. A gating carve-vs-skid check (carve ≈40% faster than chatter-skidding) protects it; no-input coasting stays byte-identical.
- **Shipped (#146):** the two remaining ski techniques from #48 — **parallel turns** (the mastery tier above a carve: a fully-locked edge, `carveCharge > 0.85`, relieves the turn tax so a perfect turn is nearly free, with a distinct skis-together/angulation pose) and **hop turns** (Jump+steer = a quick edge-set pivot that snaps the heading and scrubs speed for tight, steep terrain). Both are input-gated, so the no-input invariant holds; two new gating harness checks protect them. **This substantially completes #48.**
- **Remaining (○):** ski poles/planting (#52); meaningful jumps (#47).
- **Open issues:** ski poles and planting (**#52**); freestyle/jump mechanics (**#47**/**#32**). Speed control (**#54**) and core ski techniques (**#48**) are now addressed end-to-end (straight-line/tuck, snowplow/pizza, carve/skid + the speed trade-off, **parallel and hop turns**); the named techniques in #48 are all in — only poles (#52) and meaningful jumps (#47) remain of the broader skill layer.

### 3. Telegraphing and drama around the avalanche — ✅ shipped (#56)

The avalanche existed but wasn't well communicated, especially when it came from behind.

- **Shipped:** a warning banner ("⚠ AVALANCHE — GO!" escalating when close), a "distance behind you" danger meter, a red vignette, and proximity-scaled camera shake.
- **Remaining (○):** audio rumble/cue, an approaching snow cloud/shadow rendered in the scene.
- **Open issues:** avalanche trigger notification + visibility from behind (**#49**), avalanche effects and controls (**#44**).

### 4. Jump usefulness and trick/reward mechanics — ○ open

Jump is a listed control but currently does little for the player.

- **Add:** airtime scoring, landing-quality grading, obstacle clears, shortcuts, avalanche-dodge windows, speed boost on clean landings, and style/combo bonuses.
- **Open issues:** jumping should help avoid obstacles and maybe avalanches (**#47**), freestyle ski tricks (**#32**).

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

- **Shipped:** speed-based FOV (widens at speed), camera shake on hard landings / avalanche proximity, a **visible sky** — a Preetham atmospheric sky with a sun aligned to the directional light, plus horizon distance fog so terrain reads with depth instead of hard-cutting at the far plane (**#2**, `src/sky.ts`) — a **cinematic intro fly-over** of the mountain at game start (**#51**, `src/intro.ts`): a wide establishing shot that sweeps down the course and settles into the gameplay pose, skippable and disabled under test/automation/reduced-motion — a **de-striped, smooth-shaded snow surface** (diagonal texture stripes removed + render-only *smoothed shading normals* so the bumpy terrain stops reading as grey bands + softer light + snow-capped rocks; physics height field untouched; **#17**, `src/mountains.ts`), and **temporary ski tracks** that fade behind the skis (**#17**, `src/snowtracks.ts`).
- **Remaining (○):** a real **snow-accumulation model** (persistent `SnowDepthField`: snowfall raises depth, skis compact tracks, tracks refill over time — visual-only first, fed into the terrain material; the current ski tracks are transient feedback, not accumulation); replacing the periodic `sin(x*0.2)*cos(z*0.3)` terrain ridge with layered fBm/domain-warp so the geometry itself stops banding (a separate terrain PR — touches the height contract + physics tests); weather variation and a day→sunset→night skybox; stronger slope contrast and obstacle silhouettes; and depth cues.
- **Open issues:** lighting/shadows and snow/tree/rock/snowman textures (**#17** snow surface + dynamic trails now ◐ partial). Intro fly-over (**#51**) ✅ shipped (`src/intro.ts`). Visible sky (**#2**) is ◐ partial — static sky + a bounded golden-hour↔midday sun cycle (#163) shipped; clouds / full night path remain.

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
- **Open issues:** gyro/tilt controls (**#24**), more visible touchscreen controls (**#25**), make all buttons (about-game, music selection) mobile-friendly (**#37**).

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
| **P1 — Make skiing skillful** | Reward technique | Carving / snowplow / straight-line modes, speed loss on turns, terrain-dependent friction, meaningful jumps | ◐ mostly shipped (#56, #136, #146) — carve/snowplow/tuck + the carve-vs-skid speed trade-off + parallel/hop turns (#48) all land; meaningful jumps (#47) and ski poles (#52) still open |
| **P2 — Make it memorable** | Atmosphere & drama | Better mountain visuals, avalanche warning, expressive snowman, scarf/poles, intro fly-over, ghost racer | ◐ avalanche warning + ghost racer (#56), visible sky (#2), and the intro fly-over (#51) shipped; expressive snowman/scarf/poles open |
| **P3 — Make it social / AI** | Retention | Daily challenge, ghost leaderboard, AI coach, shareable replay | ○ open |

---

## Refactoring Roadmap

> **Premises updated (2026-06-18).** This section originally assumed a
> "classic browser-script" / `file://` architecture with a load-bearing script
> order. That is no longer the project: the TypeScript migration (**#84**,
> **#98**) converted every `src/*` module to a `.ts` ES module bundled by Vite,
> removed the per-module `window.*` namespace bridges, single-sourced three.js
> from npm, and retired the explicit script order (`src/main.ts` is the bundle
> entry and modules now resolve each other through real ES imports — see
> `src/main.ts`: *"the import order below is no longer load-bearing"*). `file://`
> is no longer a supported run path for the game graph; only the boot scripts
> (`src/boot/local-auth.js`, `src/boot/firebase-bootstrap.js`) stay as classic
> non-module scripts so the Local Mode auth/score fallback still loads. The
> staged plan below survives the migration, but **Stage R1 has effectively
> shipped** and the remaining stages should be read as ES-module extractions,
> not classic-script ones.

The feature roadmap above is increasingly constrained by three large files:
`index.html` owns markup, CSS, bootstrapping, local-mode mocks, script loading,
and start-menu behavior; `src/snowglider.ts` owns scene setup, shared game state,
the render loop, lifecycle, HUD updates, scoring, overlays, and test globals; and
`src/snowman.ts` owns model construction, skiing physics, pose animation,
collision checks, finish/crash reason selection, and browser test hooks.

The best structural move is a staged, behavior-preserving extraction. Do **not**
turn this into a *framework* rewrite (React Three Fiber **#36** and alternative
engines like rapier **#38** / Needle **#41** remain exploratory "consider" issues,
not committed direction). Preserve the Vite/GitHub Pages deployment path, the
Local Mode boot fallback, and the remaining test/runtime `window.*` hooks
(`window.resetSnowman`, `window.restartGame`, …) until tests and callers have been
migrated. **Tracking issues:** refactor `index.html` into CSS + main (**#33**),
refactor `snowglider` into a thinner UI/game module (**#34**).

> **Update — Stages R2 and R3 have shipped.** `snowglider.ts` is now a ~380-line
> coordinator (`src/game/*` for scene / loop / lifecycle, `src/ui/*` for HUD and
> overlays) and `snowman.ts` is a thin facade over `src/snowman/*`. The stage
> descriptions below are kept for context; `ARCHITECTURE.md` §5 has the current
> module map.

### Stage R1 — Split the page shell first — ✅ shipped

Lowest-risk extraction from `index.html`; this stage has landed (file names
reflect what exists today):

- ✅ Page styles moved to `styles/main.css` (no inline `<style>` left in `index.html`).
- ✅ `file://`/Local Mode auth/score mocks in `src/boot/local-auth.js`.
- ✅ Firebase defaults/init-json handling in `src/boot/firebase-bootstrap.js`.
- ✅ Script loading replaced — the nested `onload` pyramid is gone; the bundle
  entry `src/main.ts` (Vite) eagerly imports the game modules. `src/boot/script-loader.ts`
  remains the **startup driver**: its `DOMContentLoaded` handler still sequences auth,
  the `window.__loadSnowGliderOrchestrator` import, readiness, and audio preload (see
  `ARCHITECTURE.md` §2.2). Its `GAME_SCRIPT_ORDER` is now empty and it only *additionally*
  appends the browser-test suite when `?test=` is present — it is **not** a test-only shim.
- ✅ Start/about menu behavior moved to `src/ui/start-menu.ts`.

The old fixed script order is **obsolete** — modules resolve each other through
ES imports, so this chain is no longer load-bearing:

```text
mountains -> trees -> snow -> camera -> snowman -> audio -> controls
          -> avalanche -> effects -> course -> snowglider -> tests
```

### Stage R2 — Thin the game orchestrator — ✅ shipped

`src/snowglider.ts` should become a small coordinator instead of the owner of
every runtime concern. The TS migration already did the *state* slice of this:
the mutable run/lifecycle state was folded into a typed `GameState`
(**#118**/**#119**/**#121**) and the player physics state was extracted into
`src/player-state.ts` (**#120**). The *scene / loop / UI* extractions below have since
shipped — `src/game/` exists and `src/ui/` now holds four modules:

- ✅ `game-state` — typed `GameState` (`pos`, `velocity`, air state, timers,
  avalanche trigger state, technique) + `src/player-state.ts` player-state layer.
- ✅ `src/game/scene-setup.ts` for scene, renderer, lights, terrain, trees, snowman,
  snow particles, avalanche construction, and course/effects init.
- ✅ `src/game/main-loop.ts` for the current `animate()` ordering.
- ✅ `src/game/lifecycle.ts` for start, reset, restart, and game-active transitions.
- ✅ `src/ui/hud.ts` for stats, timer, speed color, position, and technique display.
- ✅ `src/ui/result-overlay.ts` for game-over/finish overlay, local best display,
  login prompt, leaderboard insertion, and `CourseModule.onFinish(...)`.
- ✅ `src/ui/collapsible-panel.ts` for shared Game Stats / Game Controls
  collapse, resize, and swipe behavior.

Keep these globals stable during the first pass because controls and browser
tests still use them: `window.resetSnowman`, `window.restartGame`,
`window.showGameOver`, `window.toggleCameraView`, and
`window.initializeGameWithAudio`.

### Stage R3 — Split snowman only after R1/R2 — ✅ shipped

`src/snowman.ts` is the highest-risk file because it contains the physics model
and the deterministic verification seam. Note the typed `src/player-state.ts`
extracted in R2 is only the per-frame *state* container — the physics *math*
(`Snowman.updateSnowman` / `Snowman.resetSnowman`) is reached through the stable
`./snowman.js` facade so the physics-invariant harness stays byte-identical. The
split landed after the boot and orchestrator work:

- `src/snowman/model.ts` for geometry, materials, arms, hat, skis, and scene add.
- `src/snowman/physics.ts` for gravity, friction, jumping, air control, ski
  technique, snowplow braking, skid/carve classification, and idle turning.
- `src/snowman/pose.ts` for heading, terrain tilt, jump tilt, turn lean, and ski
  wedge animation.
- `src/snowman/collision.ts` for tree collision, boundary checks, finish
  detection, and crash/finish reason strings.
- `src/snowman/test-hooks.ts` for browser collision hooks.

Keep the **ESM `Snowman` named export from `./snowman.js`**
(`Snowman.createSnowman` / `resetSnowman` / `updateSnowman` / `addTestHooks`) as the
stable surface, internally delegating to the smaller modules without changing the
public signatures. There is **no** `window.Snowman` global to preserve — the ESM app
exposes none (it exists only in the frozen `tests/verification/snowman_baseline.js`
snapshot), and re-adding one would violate the no-per-module-`window`-bridge rule.
`ARCHITECTURE.md` §5 documents the resulting facade and module map.

### Guardrails

- Keep refactoring mechanical: no physics constant changes, no timing changes,
  no scoring changes, and no UI behavior changes unless explicitly scoped.
- Preserve the finish reason string `"You reached the end of the slope!"`; the
  result screen, best-time recording, score syncing, and course finish flow key
  off it.
- Re-run `npm test` and `npm run test:verify` after each stage. Any change to the
  no-input physics path must be deliberate and reflected in
  `docs/PHYSICS.md` plus the verification baseline.
- Update `docs/ARCHITECTURE.md` in the same PR as each extraction so the module
  graph, globals, and ownership boundaries stay accurate.

---

## Top Recommendation (✅ delivered in #56)

The first thing to ship was **gates/checkpoints + carving/snowplow mechanics + avalanche warning UI**, plus **split-time ghost racing** — building the *skill and structure* layer before adding more content, because that converts a cute Three.js skiing demo into a game with skill, tension, and replayability. This shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56).

**Next strongest move:** ~~deepen the ski-technique model into a real speed-management trade-off (carving holds speed; panic-steering scrubs it) — issues **#48** / **#54**~~ — **shipped in [#136](https://github.com/den-run-ai/snowglider/pull/136)**; ~~the remaining P1 thread is parallel/hop turns (#48)~~ — **parallel and hop turns shipped in #146, substantially completing #48**. The remaining P1 thread is now **meaningful jumps (#47)** (airtime scoring, obstacle/avalanche clears); after that, layer P2 atmosphere on top.

---

## Appendix — Mapping to GitHub Issues

Many recommendations align with the maintainer's backlog, which is a good sign the direction is shared. **The issue tracker is authoritative; the statuses below are this document's best-effort snapshot.**

| Theme | Issue(s) | Status |
|-------|----------|--------|
| Realistic speed control (turns, terrain, avalanche escape) | #54 | ◐ first pass in #56; carve-vs-skid speed trade-off shipped in #136 (turns now cost speed; clean carves hold it) |
| Ski techniques (snowplow/pizza, parallel, carving, hop, straight-line) | #48 | ✅ all named techniques in: snowplow/carve/tuck (#56), carve-vs-skid trade-off (#136), parallel + hop turns (#146) — candidate to close |
| Avalanche trigger notification + visibility from behind | #49 | ◐ warning UI + danger meter in #56; in-scene cloud/shadow open |
| Avalanche effects and controls | #44 | ◐ effects in #56; controls open |
| Expressive snowman (scarf, flexible, breaks on impact) | #53 | ✅ all three shipped — flexible/"wiggly" snowman (`src/snowman-flex.ts`), crash-shatter wipeout (`src/debris.ts`: balls break into snow chunks + puff on any crash), and a red scarf (wrap + wind-trailing tail). Candidate to close |
| Ski poles and planting | #52 | ○ open |
| Intro fly-over of the mountain | #51 | ✅ shipped — cinematic camera fly-over at game start (`src/intro.ts`) |
| Mobile music-disable button broken *(bug)* | #50 | ○ open |
| Jumping should help avoid obstacles/avalanches | #47 | ○ open |
| Freestyle ski tricks | #32 | ○ open |
| Pause/save game state | #39 | ○ open |
| Social media sharing | #31 | ○ open |
| Gameplay tuning (steeper slope, fewer bumps, drop the "forward" button) | #27 | ○ open |
| More visible touchscreen controls; mobile-friendly buttons | #25, #37 | ○ open |
| Gyro/tilt controls | #24 | ○ open |
| Lighting and shadows | #18 | ○ open |
| Textures (snow, trees, rocks, snowman) | #17 | ◐ partial — snow-surface texture (grid-line fix → isotropic powder), snow-capped rocks, tree bark/foliage, and dynamic ski trails shipped (`src/mountains.ts`, `src/trees.ts`, `src/snowtracks.ts`); snowman texture open |
| Visible sky | #2 | ◐ partial — atmospheric sky + sun + horizon fog + a bounded golden-hour↔midday **sun cycle** shipped (`src/sky.ts`, #163); clouds / full night path open |

### Infrastructure, tooling & exploratory

These don't map to a Priority Finding above but are part of the live backlog (and
several landed after this roadmap was first written):

| Theme | Issue(s) | Status |
|-------|----------|--------|
| TypeScript / ES-module migration | #35, #84, #98 | ✅ shipped — closed (all `src/` is `.ts`, `strict: true`, Vite bundle) |
| Refactor `index.html` into CSS + main | #33 | ✅ Stage R1 shipped (`styles/main.css` + `src/boot/*` + `src/ui/start-menu.ts`) |
| Refactor `snowglider` into a thinner UI/game module | #34 | ◐ partial — typed `GameState` + `src/player-state.ts`; scene/loop/UI extraction still open |
| Improve test coverage for RED files (scores, auth, controls, start-menu) | #126 | ◐ in progress (#128–#131) |
| Update three.js + validate testing/audio | #29 | ✅ likely addressed by the r160 upgrade (#75/#76) + native-audio rewrite — candidate to close |
| Leaderboard unavailable / sign-in dropout + testing | #28 | ◐ scores/auth hardening + tests (#67, #73, #128/#129); the specific dropout report not separately re-verified |
| Performance monitoring via Firebase | #30 | ○ open |
| Engine/framework explorations (not committed direction) | #40 (3D map), #36 (React Three Fiber), #38 (rapier physics), #41 (Needle tools) | ○ exploratory |

*The higher-level structural gaps — a finish line and objective feedback, scoring depth, progression/replay hooks, and the AI features — were the items the tracker was quieter on; #56 delivered the first of these (course + result + ghost), and the rest (daily/per-course leaderboards, AI coach) remain the biggest open wins.*
