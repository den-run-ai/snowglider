# SnowGlider — Feature Gap Analysis & Roadmap

*A synthesis of multiple review passes on the Three.js skiing game at [snowglider.ai](https://snowglider.ai) ([repo](https://github.com/den-run-ai/snowglider)).*

---

## Status

This roadmap began as a feature-gap analysis. Its **top recommendation — the "skill & structure" layer — shipped in [#56](https://github.com/den-run-ai/snowglider/pull/56)**: checkpoint gates + finish line, live split timing and a result screen, ghost racing, an avalanche warning UI, and a first snowplow/carve/tuck ski-technique pass. See [`CHANGELOG.md`](CHANGELOG.md) for that work in detail.

**Since this roadmap was written (snapshot 2026-06-18):** a large *infrastructure* wave landed — the TypeScript/ES-module migration completed (issues [#35](https://github.com/den-run-ai/snowglider/issues/35), [#84](https://github.com/den-run-ai/snowglider/issues/84), [#98](https://github.com/den-run-ai/snowglider/issues/98), now closed; all of `src/` is `.ts` under `strict: true`, bundled by Vite), plus CI hardening (production-build validation, raw-TS Pages guard, honest merged Node+browser coverage) and new test layers (Playwright cross-browser/mobile E2E, Firestore-rules harness, c8 coverage harnesses). **None of this changed gameplay**, so the Priority Findings below are unchanged — but it did invalidate the premises of the [Refactoring Roadmap](#refactoring-roadmap), which has been updated accordingly. *(Update: post-snapshot gameplay PRs have since deepened Finding 2 / P1 — [#136](https://github.com/den-run-ai/snowglider/pull/136) landed the carve-vs-skid speed-management trade-off, and #146 added parallel turns and hop turns, substantially completing the ski-techniques issue #48.)*

**Update (2026-06-21) — a gameplay & visual-polish wave then landed**, closing or advancing several Priority Findings (details in each finding and the appendix). Highlights: an **expressive snowman** for **#53** — a flexible squash-and-settle body ([#170](https://github.com/den-run-ai/snowglider/pull/170)/[#182](https://github.com/den-run-ai/snowglider/pull/182)), crash-shatter debris ([#171](https://github.com/den-run-ai/snowglider/pull/171)), and a wind-trailing scarf ([#172](https://github.com/den-run-ai/snowglider/pull/172)); a first **meaningful-jumps** pass for **#47** — player jumps are graded on landing (CLEAN/OK/SKETCHY) with a capped speed boost and an air-score readout ([#186](https://github.com/den-run-ai/snowglider/pull/186)); an in-scene **avalanche powder cloud** for **#49** ([#187](https://github.com/den-run-ai/snowglider/pull/187)); a domain-warped **fBm terrain ridge** that removes the last geometric banding for **#17** ([#197](https://github.com/den-run-ai/snowglider/pull/197)) plus a realistic **rock-colour palette + cliff outcrops + terrain↔tree biome tinting** ([#203](https://github.com/den-run-ai/snowglider/pull/203)); **carve vs. parallel** turns made visibly distinct ([#191](https://github.com/den-run-ai/snowglider/pull/191)); a **shaped-ski redesign** ([#198](https://github.com/den-run-ai/snowglider/pull/198)); a bounded golden-hour↔midday **sun cycle** ([#163](https://github.com/den-run-ai/snowglider/pull/163)); the first **dynamic ski trails** + de-striped snow surface ([#181](https://github.com/den-run-ai/snowglider/pull/181)); and a **procedural sound-effects** engine (#158). The **mobile mute-button bug #50** was fixed ([#173](https://github.com/den-run-ai/snowglider/pull/173)) and **desktop social sharing** shipped for **#31** ([#177](https://github.com/den-run-ai/snowglider/pull/177)). **Issues #48, #49, #51, #53, and #189 have since been closed on the tracker; #31 and #50 remain candidates to close; #17 / #47 advanced.** The new [`CONTROLS.md`](CONTROLS.md) consolidates the full control/technique surface in one place.

**Update (2026-07-01) — a progression, correctness, and atmosphere wave landed.** The headline is the **difficulty-tier system** (● Bunny / ■ Blue / ◆ Black), a multi-PR stack tracked by [#247](https://github.com/den-run-ai/snowglider/issues/247) that is the first concrete progression hook (Finding 6): the config spine + kernel tuning API ([#236](https://github.com/den-run-ai/snowglider/pull/236)), a start-screen tier picker + result label ([#237](https://github.com/den-run-ai/snowglider/pull/237)), per-tier local ghost/splits ([#238](https://github.com/den-run-ai/snowglider/pull/238)), per-tier Firestore leaderboards + best times ([#239](https://github.com/den-run-ai/snowglider/pull/239)), a first *felt* per-tier ski feel with Bunny/Black shipping **unranked** ([#240](https://github.com/den-run-ai/snowglider/pull/240)), and a finish-screen tier switch + shared colored picker widget ([#255](https://github.com/den-run-ai/snowglider/pull/255)) — with Blue held **byte-for-byte identical** at every stage. The **"the line is the difficulty" (D3.2) sub-stack** — a seeded winding course-line spine, terrain corridor, gates/obstacles on the line, and a per-tier avalanche + follow-the-line winnability harness — is **in flight as open PRs [#254](https://github.com/den-run-ai/snowglider/pull/254)/[#257](https://github.com/den-run-ai/snowglider/pull/257)/[#261](https://github.com/den-run-ai/snowglider/pull/261)/[#263](https://github.com/den-run-ai/snowglider/pull/263)**; a Level-during-play HUD ([#266](https://github.com/den-run-ai/snowglider/pull/266)) shipped alongside, and the ranked flip (D3.3) is the tracked follow-up. Separately, a **correctness milestone** landed — a **fixed-timestep accumulator** made the live physics frame-rate-independent and eliminated the tree-tunneling bug class ([#209](https://github.com/den-run-ai/snowglider/issues/209)), backed by a new read-only runtime **diagnostics** layer (`src/diagnostics.ts`, [`DIAGNOSTICS.md`](DIAGNOSTICS.md)) and a stress harness. The **wind system (#253, Phase A)** grew from a shared field into snow drift, a scarf that streams in the apparent wind ([#259](https://github.com/den-run-ai/snowglider/pull/259)), tree sway ([#265](https://github.com/den-run-ai/snowglider/pull/265)), and an ambient audio bed + gust "howl" tied to the field ([#271](https://github.com/den-run-ai/snowglider/pull/271)/[#272](https://github.com/den-run-ai/snowglider/pull/272)); the **snow/light rendering stack (#17/#18)** added a player-following **sun shadow** + frustum fix, **cavity/AO snow shading**, and **obstacle contact shadows** (see [`SNOW_RENDERING.md`](SNOW_RENDERING.md)); a systemic **mobile dead-button** class was root-caused and fixed; and an **in-game feedback / feature-request form** shipped ([#258](https://github.com/den-run-ai/snowglider/issues/258) (PR #260), `src/ui/feedback.ts`). **Issues #2 (visible sky), #44 (avalanche effects/controls), and #34 (thin the game orchestrator) have since been closed**; #29, #50, #31, and #126 are also closed. New tracking issues frame the next wave: heading-relative velocity ([#244](https://github.com/den-run-ai/snowglider/issues/244)), meaningful jumps round 2 ([#245](https://github.com/den-run-ai/snowglider/issues/245)), a persistent snow-depth field ([#246](https://github.com/den-run-ai/snowglider/issues/246)), rendering test tiers ([#248](https://github.com/den-run-ai/snowglider/issues/248)), and real-device mobile-audio verification ([#249](https://github.com/den-run-ai/snowglider/issues/249)).

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
- Procedural sound effects (`src/sfx.ts`: wind, carving swish, jump/land, avalanche rumble, crash/finish)
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

### 2. Skiing skill, not just steering — ◐ partial (#56, #136, #146, #191)

The biggest design gap: the game *slid with steering* rather than feeling like skiing.

- **Shipped (#56):** snowplow/"pizza" braking (clamped so it stops rather than reversing uphill), carve vs. skid, straight-line tuck, and terrain-dependent grip — layered on a test-safe seam so no-input physics is unchanged.
- **Shipped (#136):** the carve-vs-skid **speed-management trade-off** that #56 was thin on — a `carveCharge` edge-engagement model where a committed carve holds speed and panic-steering (reversing the edge / yanking a fresh one) scrubs it, plus an always-on turn tax so straight-lining stays the fastest line. A gating carve-vs-skid check (carve ≈40% faster than chatter-skidding) protects it; no-input coasting stays byte-identical.
- **Shipped (#146, #191):** the two remaining ski techniques from #48 — a **parallel turn** and a **hop turn** — and then ([#191](https://github.com/den-run-ai/snowglider/pull/191)) the parallel/carve pair was made *visibly distinct* (the two had been near-identical). The two steered turns are now the ends of one `carveCharge` edge-engagement axis: a **parallel (skidded)** turn — uncommitted steering — brushes the skis sideways to **scrub speed** for a tighter arc, while a **carve** — steering held smoothly past the lock (`carveCharge > 0.6`) — rolls onto the edge to **hold speed** through a wider arc with a deep body lean (the mastery turn above a parallel). **Hop turns** (Jump+steer) add a quick grounded edge-set pivot that snaps the heading and scrubs speed for tight, steep terrain. All are input-gated, so the no-input invariant holds; gating harness checks protect them. **This completed #48, which is now closed** (see [`PHYSICS.md`](PHYSICS.md) §3.3 and the new [`CONTROLS.md`](CONTROLS.md)).
- **Remaining (○):** ski poles/planting (#52); meaningful jumps (#47).
- **Open issues:** ski poles and planting (**#52**); freestyle/jump mechanics (**#47**/**#32**). Core ski techniques (**#48**) are now addressed end-to-end (straight-line/tuck, snowplow/pizza, carve/skid + the speed trade-off, **parallel and hop turns**) and **#48 is closed**; speed control (**#54**) is still open but substantially advanced — only poles (#52) and meaningful jumps (#47) remain of the broader skill layer.

### 3. Telegraphing and drama around the avalanche — ✅ shipped (#56, #187)

The avalanche existed but wasn't well communicated, especially when it came from behind.

- **Shipped:** a warning banner ("⚠ AVALANCHE — GO!" escalating when close), a "distance behind you" danger meter, a red vignette, proximity-scaled camera shake, and a proximity-scaled audio rumble (#158, `src/sfx.ts`).
- **Shipped (#187):** an in-scene **powder cloud** — a billowing plume of snow sprites kicked up by the tumbling boulders, so an approaching slide reads as a rolling wall of powder rather than a cluster of spheres (`src/avalanche.ts`).
- **Remaining (○):** a cast shadow / darkening ahead of the slide. The in-flight D3.2d PR ([#263](https://github.com/den-run-ai/snowglider/pull/263)) also makes the avalanche **per-difficulty-tier** (Black fires earlier/faster/heavier, Bunny off), funneled down the winding corridor.
- **Open issues:** avalanche trigger notification + visibility from behind (**#49** — **closed**; warning UI + powder cloud shipped), avalanche effects and controls (**#44** — **closed**; effects shipped in #56/#187, per-tier slide in flight).

### 4. Jump usefulness and trick/reward mechanics — ◐ partial (#186)

Jump was a listed control that did little for the player; a first reward pass has landed.

- **Shipped (#186):** a first **meaningful-jumps** pass — a *player-initiated* jump (Space, no steer) is now graded on landing as **CLEAN / OK / SKETCHY** from air time and landing alignment, awards a **capped speed boost** on a clean landing, and flashes an **air-score** readout via `CourseModule` (`src/snowman/physics.ts`, `src/course.ts`). Terrain auto-jumps and hop turns are excluded so no-input coasting stays byte-identical; see [`MEANINGFUL_JUMPS.md`](MEANINGFUL_JUMPS.md).
- **Shipped (freestyle first pass, #32):** the **◆◆ Expert tier** (after Black) unlocks in-air **freestyle tricks** re-using the existing controls during a manual jump — Left/Right spins, Up/Down front/backflips, a re-pressed Jump grabs. Completed tricks are named in the air toast (`✈ AIR 1.2s · 360 + GRAB · CLEAN`) and scored into the air score; landing mid-rotation forces a SKETCHY scrub (the freestyle risk/reward). Rotation is cosmetic (pose-only) and everything is double-gated on `ski.freestyleTricks` + `playerJump`, so all other tiers and the no-input baseline are byte-identical ([`PHYSICS.md` §4.1](PHYSICS.md)).
- **Remaining (○):** obstacle/tree clears and avalanche-dodge windows, shortcuts, combo multipliers, and *physical* spins (heading-relative velocity, #244).
- **Open issues:** jumping should help avoid obstacles and maybe avalanches (**#47** — first pass shipped in #186), freestyle ski tricks (**#32** — first pass shipped, Expert tier), round 2 combos/clears (**#245**).

### 5. Dynamic hazards and a living world — ○ open

Hazards are static (trees, rocks) plus the single avalanche, so the descent feels static after the first minute.

- **Add:** moving wildlife (penguins, deer), falling snowballs, breaking ice patches that change friction, rival skiers, and ramps.
- **The "Yeti factor":** a pursuing antagonist/snow monster (à la SkiFree) that forces the player to speed up adds memorable pressure — the avalanche is a start, but a recurring chaser is stickier.
- **Power-ups (more arcade-leaning):** invincibility shield (burst through trees), coin magnet, "rocket skis" speed boost with exhaust trails.

### 6. Progression and replay hooks — ◐ partial (#56, difficulty tiers #247)

Timer/best-time and leaderboard existed, but there was no reason to play 20 runs.

- **Shipped (#56):** ghost replay ("beat your ghost") and medals/tiers on the result screen.
- **Shipped (difficulty tiers, #247):** the first real progression axis — **● Bunny / ■ Blue / ◆ Black** tiers with a start-screen and finish-screen picker ([#237](https://github.com/den-run-ai/snowglider/pull/237)/[#255](https://github.com/den-run-ai/snowglider/pull/255)), **per-tier local ghosts + best splits** ([#238](https://github.com/den-run-ai/snowglider/pull/238)), **per-tier Firestore leaderboards + best times** (sibling `leaderboard_bunny`/`leaderboard_black` boards, [#239](https://github.com/den-run-ai/snowglider/pull/239)), and a first *felt* per-tier ski feel ([#240](https://github.com/den-run-ai/snowglider/pull/240)) — Blue is the frozen default (byte-identical), Bunny/Black ship **unranked** until per-tier plausibility floors + a winnability gate pass. The config spine + kernel tuning API ([#236](https://github.com/den-run-ai/snowglider/pull/236)) keeps the physics kernel pure (only `config.ski` enters it). This directly delivers the "difficulty tiers (kids/bunny vs. expert)" item below.
- **In flight (○):** the **"the line is the difficulty"** D3.2 stack (open PRs [#254](https://github.com/den-run-ai/snowglider/pull/254)/[#257](https://github.com/den-run-ai/snowglider/pull/257)/[#261](https://github.com/den-run-ai/snowglider/pull/261)/[#263](https://github.com/den-run-ai/snowglider/pull/263)) — a seeded winding course line drives terrain/gates/obstacles/avalanche so Black is *shaped* harder, not just steeper — and the **ranked flip** (D3.3: re-measured floors + `ranked:true`). A live **Level** HUD row ([#266](https://github.com/den-run-ai/snowglider/pull/266)) now shows the selected tier during play. Per-tier ranked boards also depend on the leaderboard-floor work (**#235**).
- **Remaining (○):** a daily seeded course, unlockable cosmetics (scarves/skis/hats), achievements, missions ("near-miss 5 trees in one run," "travel 1000 m without jumping"), and per-course / per-day leaderboards instead of a single global list.

### 7. Game feel ("juice") and visual readability — ◐ partial (#56)

A skiing game lives on speed readability and mountain atmosphere.

- **Shipped:** speed-based FOV (widens at speed), camera shake on hard landings / avalanche proximity, a **visible sky** — a Preetham atmospheric sky with a sun aligned to the directional light, plus horizon distance fog so terrain reads with depth instead of hard-cutting at the far plane (**#2**, `src/sky.ts`) — a **cinematic intro fly-over** of the mountain at game start (**#51**, `src/intro.ts`): a wide establishing shot that sweeps down the course and settles into the gameplay pose, skippable and disabled under test/automation/reduced-motion — a **de-striped, smooth-shaded snow surface** (diagonal texture stripes removed + render-only *smoothed shading normals* so the bumpy terrain stops reading as grey bands + softer light + snow-capped rocks; physics height field untouched; **#17**, `src/mountains.ts`), and **temporary ski tracks** that fade behind the skis (**#17**, `src/snowtracks.ts`).
- **Shipped (#197):** the periodic `sin(x*0.2)*cos(z*0.3)` terrain ridge was replaced with a **deterministic domain-warped fBm** ridge field (`terrainRidgeField`, `src/mountains.ts`) so the geometry itself stops banding — the last source of the grey "corduroy" striping. *(The physics height contract is preserved; the invariant harness uses its own noise-free terrain, so no baseline regen.)*
- **Shipped (#203):** a realistic **rock-colour palette + cliff outcrops** (`makeRockColor`, `createRock` cliff option, an `addRocks` outcrop pass) plus **terrain↔tree biome alignment** — a shared deterministic `Mountains.forestDensityField` now drives both the terrain tint and tree-stand bias so rock, ground colour, and forest read as one coherent biome (cosmetic; physics invariant identical).
- **Shipped (#201):** a live **Slope/incline HUD** readout (degrees + %) replacing the static Best-Time stats row, color-tiered to the measured run so the player can read terrain steepness at a glance (`src/ui/hud.ts`; best-time persistence and the result screen are untouched).
- **Shipped (#18, #17 — shadows & snow readability):** a **player-following sun shadow** (`src/game/sun-shadow.ts`) — the directional light's shadow camera was on three.js's default ±5-unit box centred on the world origin, so the snowman (which spawns at `z=-15` and skis far downhill) cast **no shadow for essentially the whole run**; the frustum now tracks the player so the contact shadow is present end-to-end; a **cavity / ambient-occlusion snow shading** term darkens concave hollows/gullies so the terrain stops reading as flat white; and **obstacle contact shadows** (a single instanced AO decal under each tree/large rock) ground the trees so they no longer read as pasted-on. All build-time / render-only — the physics height field is untouched (see [`SNOW_RENDERING.md`](SNOW_RENDERING.md)).
- **Shipped (#253, Phase A):** the first **weather variation** — a shared deterministic **wind field** (`src/wind.ts`) that blows the snowfall sideways and the ski splash downwind. It has since grown consumers across the scene: the red **scarf streams in the apparent wind** ([#259](https://github.com/den-run-ai/snowglider/pull/259)), the **forest sways** in the same field (a GPU vertex sway, [#265](https://github.com/den-run-ai/snowglider/pull/265)), and the **ambient audio bed** is tied to the wind with a resonant gust **"howl"** ([#271](https://github.com/den-run-ai/snowglider/pull/271)/[#272](https://github.com/den-run-ai/snowglider/pull/272)). All cosmetic-only (no `pos`/`velocity`), so the physics invariant is byte-identical; an optional gameplay wind *force* (tier-gated) is the deferred follow-up.
- **Remaining (○):** a real **snow-accumulation model** (now tracked as **#246** — persistent `SnowDepthField`: snowfall raises depth, skis compact tracks, tracks refill over time — visual-only first, fed into the terrain material; the current ski tracks are transient feedback, not accumulation); deeper weather variation and a day→sunset→night skybox; and depth cues. *(Stronger slope contrast + obstacle silhouettes shipped via the cavity/AO shading + contact shadows above.)*
- **Open issues:** lighting/shadows and snow/tree/rock/snowman textures (**#17** snow surface + de-banded fBm terrain (#197) + dynamic trails + cavity/AO shading + contact shadows now ◐ partial; only the snowman material is left). Lighting/shadows (**#18**) ✅ addressed (hemisphere fill + player-following sun shadow). Intro fly-over (**#51**) ✅ shipped (`src/intro.ts`). Visible sky (**#2**) ✅ **closed** — atmospheric sky + sun + horizon fog + a bounded golden-hour↔midday sun cycle (#163); clouds / a full night path remain possible future polish.

### 8. Audio consistency and completion — ◐ partial

Audio has since been rewritten to a simplified, dependency-free native HTML5 implementation (single background-music track) and re-enabled (`AUDIO_ENABLED = true`); the full history is in [`CHANGELOG.md`](CHANGELOG.md). **Sound effects beyond music shipped (#158):** `src/sfx.ts`, a procedural Web Audio engine (no binary assets) covering speed-scaled wind, a technique-keyed carving swish, an avalanche rumble, and jump/land/crash/finish one-shots. It remains **partially integrated**: the in-page audio control button is still disabled in `index.html`, and mobile playback for both music and effects (iOS Safari silent switch, Android Chrome) is not yet verified on real devices.

- **Done:** sound effects beyond music — wind that scales with speed, carving swish on turns, a crash/thud on wipeout, plus jump/land and an avalanche rumble (**#158**, `src/sfx.ts`).
- **Add / finish:** complete the mobile integration (real-device verification of music + SFX, now tracked as **#249**) and the in-page audio control button.
- **Open issue:** mobile music-disable button (**#50**) ✅ **fixed in [#173](https://github.com/den-run-ai/snowglider/pull/173)** and **closed** — the mute toggle fires on `touchstart`; it was later subsumed by the systemic mobile dead-button fix (Finding 10) that stops the gameplay touch handler swallowing taps on *any* interactive control. Remaining audio gaps are the in-page control button and real-device mobile verification (**#249**).

### 9. Pause/save and quality-of-life controls — ○ open

Basic product completeness is missing, which is especially felt on mobile.

- **Add:** pause/resume/save state, restart confirmation, remappable controls, controller support, sensitivity settings, camera FOV control, and mobile calibration.
- **Shipped (adjacent):** an **in-game feedback / feature-request form** ([#258](https://github.com/den-run-ai/snowglider/issues/258) (PR #260), `src/ui/feedback.ts`) — a start-screen "💬 Feedback" button that opens a GitHub *prefilled* new-issue URL (keyless; the player submits under their own account) with optional diagnostics, and fires a `feedback_submitted` Analytics event. Structured issue templates live under `.github/ISSUE_TEMPLATE/`.
- **Open issue:** implement game state for pause/save (**#39**).

### 10. Mobile-first control polish — ○ open

Touch controls exist, but this game is a natural fit for richer mobile input.

- **Add:** gyro/tilt steering, haptics, swipe-to-jump, a simpler mobile HUD, and **performance scaling** (toggle shadows / reduce particle counts when framerate drops below ~30 FPS).
- **UI:** keep the game-over screen, score counter, and menus as responsive HTML/CSS overlaying the `<canvas>` for crisp mobile readability, rather than baked into the 3D scene.
- **Shipped (bug class):** a **systemic mobile dead-button fix** — the gameplay touch handlers (`controls.ts`) `preventDefault()` every touch for ski steering, which suppressed the synthesized `click` and left *any* click-bound button drawn over the canvas dead on mobile. Rather than the ~6 accumulated one-off rescues (restart, share, audio, auth, …), the handlers now bail on touches that land on an interactive control (`button, a, input, …, [role="button"]`), covering current and future buttons; the finish-screen share buttons and Start-menu About/Close/logout were the last casualties. This clears much of the substance behind **#37** (about-game / music buttons mobile-friendly).
- **Open issues:** gyro/tilt controls (**#24**), more visible touchscreen controls (**#25**), make all buttons (about-game, music selection) mobile-friendly (**#37** — the dead-button class is now fixed; richer/visible controls remain).

### 11. Personality and fail-state fun — ✅ shipped (#53)

Crashes and finishes are where a casual game becomes memorable and shareable.

- **Shipped (#53):** an **expressive snowman** — a flexible "wiggly" body that squashes on landing and settles ([#170](https://github.com/den-run-ai/snowglider/pull/170)/[#182](https://github.com/den-run-ai/snowglider/pull/182), `src/snowman-flex.ts`), a **crash-shatter** wipeout where the snowballs break into snow chunks with a puff on any crash ([#171](https://github.com/den-run-ai/snowglider/pull/171), `src/debris.ts`), and a wind-trailing **red scarf** ([#172](https://github.com/den-run-ai/snowglider/pull/172), `src/snowman/model.ts`) — all layered without touching the deterministic `updateSnowman` kernel.
- **Remaining (○):** snowballing after a wipeout and a dedicated celebratory finish animation (the result screen carries the finish payoff for now).
- **Open issue:** expressive snowman with scarf/flexibility that breaks on impact (**#53**) ✅ shipped — **closed**.

---

## The "AI" Angle (snowglider.ai)

Given the `.ai` domain, at least one AI-flavored feature is a natural fit and a differentiator. (Ghost racing shipped in #56 lays the trajectory-recording groundwork an AI ghost could reuse.)

- **AI ghost skier** that races your best time.
- **AI coach** after each run: *"You lost time braking too late before the trees."*
- **Procedural course generator** with named difficulties: "powder forest," "avalanche chute," "bunny slope." *(The difficulty tiers (#247) lay the groundwork — a seeded `laneX(z)` course line + per-tier terrain/gate/obstacle/avalanche generation, already named ● Bunny / ■ Blue / ◆ Black.)*
- **Auto-generated replay highlights:** crashes, big jumps, near misses.
- **Natural-language course prompt:** *"make a fast open powder run with few trees."*

---

## Recommended Roadmap

A phased plan that several of the review passes converge on:

| Phase | Goal | Ship | Status |
|-------|------|------|--------|
| **P0 — Make it feel like a game** | Give runs a shape | Finish line, checkpoints, split times, result screen, medals, restart/replay flow | ✅ shipped (#56) |
| **P1 — Make skiing skillful** | Reward technique | Carving / snowplow / straight-line modes, speed loss on turns, terrain-dependent friction, meaningful jumps | ◐ mostly shipped (#56, #136, #146, #191) — carve/snowplow/tuck + the carve-vs-skid speed trade-off + parallel/hop turns + distinct carve-vs-parallel (#48) all land; **meaningful jumps (#47) first pass shipped in #186**; per-tier ski feel via difficulty tiers (#240); heading-relative velocity (#244) + jumps round 2 (#245) queued; ski poles (#52) still open |
| **P2 — Make it memorable** | Atmosphere & drama | Better mountain visuals, avalanche warning, expressive snowman, scarf/poles, intro fly-over, ghost racer | ◐ avalanche warning + ghost racer (#56), visible sky (**#2 closed**), intro fly-over (#51), mountain visuals/textures (#17) + sun shadow/AO/contact shadows (#18/#17), the avalanche powder cloud (#187), wind (#253), and the **expressive snowman + scarf (#53)** shipped; ski poles (#52) still open |
| **P3 — Make it social / AI** | Retention | Daily challenge, ghost leaderboard, AI coach, shareable replay | ◐ started — **difficulty tiers (#247)** add per-tier leaderboards + ghosts and a seeded procedural course line (the "named difficulties" AI-angle item); desktop/mobile share (#177/#31) ships. Daily challenge, cross-player ghost leaderboard (#235), and the AI coach remain open |

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

**Next strongest move:** ~~deepen the ski-technique model into a real speed-management trade-off (carving holds speed; panic-steering scrubs it) — issues **#48** / **#54**~~ — **shipped in [#136](https://github.com/den-run-ai/snowglider/pull/136)**; ~~the remaining P1 thread is parallel/hop turns (#48)~~ — **parallel and hop turns shipped in #146** (made visibly distinct in #191), substantially completing #48. ~~The remaining P1 thread is now **meaningful jumps (#47)**~~ — a **first meaningful-jumps pass shipped in [#186](https://github.com/den-run-ai/snowglider/pull/186)** (landing grade + capped boost + air score); the remaining jump work is obstacle/avalanche clears and trick/combo scoring. After that, the only untouched P1 thread is ski poles (#52), then layer P2 atmosphere on top.

---

## Appendix — Mapping to GitHub Issues

Many recommendations align with the maintainer's backlog, which is a good sign the direction is shared. **The issue tracker is authoritative; the statuses below are this document's best-effort snapshot.**

| Theme | Issue(s) | Status |
|-------|----------|--------|
| Realistic speed control (turns, terrain, avalanche escape) | #54 | ◐ first pass in #56; carve-vs-skid speed trade-off shipped in #136 (turns now cost speed; clean carves hold it); snowplow now *stops* vs. slows + fails on steep pitches aligned to the Slope HUD; per-tier ski feel (#240). Heading-relative velocity for true carving is queued (#244) |
| Ski techniques (snowplow/pizza, parallel, carving, hop, straight-line) | #48 | ✅ **closed** — all named techniques in: snowplow/carve/tuck (#56), carve-vs-skid trade-off (#136), parallel + hop turns (#146), distinct carve-vs-parallel (#191). See [`CONTROLS.md`](CONTROLS.md) |
| Avalanche trigger notification + visibility from behind | #49 | ✅ **closed** — warning UI + danger meter (#56) + in-scene powder cloud (#187) (a cast shadow ahead of the slide remains a possible future polish) |
| Avalanche effects and controls | #44 | ✅ **closed** — warning UI + shake + rumble (#56/#158) + powder cloud (#187); per-tier avalanche (Black earlier/faster/heavier, Bunny off) in flight (#263) |
| Expressive snowman (scarf, flexible, breaks on impact) | #53 | ✅ **closed** — all three shipped: flexible/"wiggly" snowman (`src/snowman-flex.ts`), crash-shatter wipeout (`src/debris.ts`: balls break into snow chunks + puff on any crash), and a red scarf (wrap + wind-trailing tail) |
| Ski poles and planting | #52 | ○ open |
| Intro fly-over of the mountain | #51 | ✅ **closed** — cinematic camera fly-over at game start (`src/intro.ts`) |
| Mobile music-disable button broken *(bug)* | #50 | ✅ **closed** — fixed in #173, then subsumed by the systemic mobile dead-button fix (gameplay touch handler now bails on interactive controls) |
| Jumping should help avoid obstacles/avalanches | #47 | ◐ first pass in #186 (player-jump landing grade + capped boost + air score); obstacle/avalanche clears open |
| Freestyle ski tricks | #32 | ◐ first pass shipped — Expert-tier spins/flips/grabs; combos + physical spins (#244/#245) remain |
| Pause/save game state | #39 | ○ open |
| Social media sharing | #31 | ✅ **closed** — desktop platform menu + Instagram screenshot card (#177), OG-image fix (#193); native share on mobile |
| Difficulty tiers (● Bunny / ■ Blue / ◆ Black) | #247 | ◐ in progress — config spine + kernel tuning (#236), pickers (#237/#255), per-tier ghosts/splits (#238), per-tier leaderboards (#239), felt per-tier ski feel unranked (#240) all merged; "the line is the difficulty" D3.2 stack (#254/#257/#261/#263) in flight, Level-during-play HUD (#266) merged; ranked flip (D3.3) pending |
| Gameplay tuning (steeper slope, fewer bumps, drop the "forward" button) | #27 | ○ open (partly served by per-tier feel #240) |
| More visible touchscreen controls; mobile-friendly buttons | #25, #37 | ◐ mobile dead-button class fixed systemically (finish/share/About/logout now tap-through); richer/more-visible controls open |
| Gyro/tilt controls | #24 | ○ open |
| Lighting and shadows | #18 | ✅ **closed** — hemisphere fill light (#168) + player-following sun shadow with a frustum fix (`src/game/sun-shadow.ts`) so the snowman casts a contact shadow for the whole run |
| Textures (snow, trees, rocks, snowman) | #17 | ◐ partial — snow-surface texture (grid-line fix → isotropic powder), de-banded domain-warped **fBm terrain** (#197), snow-capped rocks, tree bark/foliage, dynamic ski trails, a realistic **rock-colour palette + cliff outcrops + terrain↔tree biome tinting** (#203), plus **cavity/AO snow shading** + **obstacle contact shadows** ([`SNOW_RENDERING.md`](SNOW_RENDERING.md)) shipped; snowman texture open |
| Ski shape redesign (sidecut / camber / shovel) | #189 | ✅ **closed** — shaped lofted-geometry skis with sidecut/camber/shovel/tail/binding/steel edge + cosmetic flex (#198) |
| Visible sky | #2 | ✅ **closed** — atmospheric sky + sun + horizon fog + a bounded golden-hour↔midday **sun cycle** shipped (`src/sky.ts`, #163); clouds / full night path remain optional polish |
| Persistent snow-depth field (visual-only v1) | #246 | ○ open — tracks the real snow-accumulation model (Finding 7) |
| Meaningful jumps, round 2 (scored clears + avalanche dodge + combos) | #245 | ○ open — rebases on per-tier scoring (#239); follows the #186 first pass |
| Heading-relative velocity (real carving) | #244 | ○ open — extends the kernel tuning API (#236), lands before Black turn-tuning |

### Infrastructure, tooling & exploratory

These don't map to a Priority Finding above but are part of the live backlog (and
several landed after this roadmap was first written):

| Theme | Issue(s) | Status |
|-------|----------|--------|
| TypeScript / ES-module migration | #35, #84, #98 | ✅ shipped — closed (all `src/` is `.ts`, `strict: true`, Vite bundle) |
| Refactor `index.html` into CSS + main | #33 | ✅ Stage R1 shipped (`styles/main.css` + `src/boot/*` + `src/ui/start-menu.ts`) |
| Refactor `snowglider` into a thinner UI/game module | #34 | ✅ **closed** — typed `GameState` + `src/player-state.ts` **plus the scene/loop/UI extraction (Stages R2/R3)**: `src/game/{scene-setup,main-loop,lifecycle}.ts` + `src/ui/{hud,result-overlay,collapsible-panel}.ts`, leaving `snowglider.ts` a ~380-line coordinator |
| Improve test coverage for RED files (scores, auth, controls, start-menu) | #126 | ✅ **closed** — coverage layers landed (#128–#131) |
| Update three.js + validate testing/audio | #29 | ✅ **closed** — r160 upgrade (#75/#76) + native-audio rewrite |
| Frame-rate-independent physics (fixed-timestep, no tunneling) + runtime diagnostics | #209 | ✅ shipped — fixed-timestep accumulator in `main-loop.ts` (physics on a 1/60 grid, render interpolation), avalanche friction made FPS-independent, and a read-only telemetry layer (`src/diagnostics.ts`, [`DIAGNOSTICS.md`](DIAGNOSTICS.md)) that watches the tunneling/runaway-speed bug class live |
| Rendering test tiers (perf/draw-call budget + visual regression) | #248 | ◐ perf-budget spec landed (#220); Playwright visual-regression tier is an opt-in draft (#219) |
| Leaderboard floor: production deploy + purge + deferred global-ghost | #235 | ○ open — prerequisite for flipping Bunny/Black to ranked (per-tier floors) |
| Leaderboard unavailable / sign-in dropout + testing | #28 | ◐ scores/auth hardening + tests (#67, #73, #128/#129); Firestore-rules deploy now automated via the Rules REST API (#250/#264) |
| Performance monitoring via Firebase | #30 | ○ open |
| CI: per-PR preview deployments for branches/forks (Cloudflare Pages) | #190 | ○ open |
| Simplify physics-invariant baseline regeneration (ESM/automated) | #137 | ○ open |
| Engine/framework explorations (not committed direction) | #40 (3D map), #36 (React Three Fiber), #38 (rapier physics), #41 (Needle tools) | ○ exploratory |

*The higher-level structural gaps — a finish line and objective feedback, scoring depth, progression/replay hooks, and the AI features — were the items the tracker was quieter on; #56 delivered the first of these (course + result + ghost), and the **difficulty-tier stack (#247)** is now delivering per-tier leaderboards/ghosts and a seeded procedural course line. The remaining biggest open wins are a daily/seeded challenge, a cross-player ghost leaderboard (#235), and the AI coach.*
