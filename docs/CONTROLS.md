# SnowGlider — Controls & Techniques

*The single map of SnowGlider's control surface: every input, what it does, and
where the authoritative detail lives.*

This page is an **index, not a re-statement** of the physics. The number behind
each behavior is governed by [`PHYSICS.md`](PHYSICS.md); the input plumbing is in
[`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-input); and the player-facing copy is the
in-game guide (`#controlsGuide` on the start screen and the Game Controls widget in
[`index.html`](../index.html)). When a behavior changes, change it there and update
this table's pointer — don't duplicate the math here.

Three sources, three audiences:

| Source | Audience | What it owns |
|--------|----------|--------------|
| In-game guide (`index.html`) | Players | Short "what the button does" copy, shown on the start screen + in-game |
| [`PHYSICS.md`](PHYSICS.md) §3–§4 | Developers | The technique model: forces, `carveCharge`, scrub, jump/landing math |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) §6 | Developers | How keyboard/touch write the shared `controls` state object |

---

## 1. Inputs

All inputs write a single shared `controls` state (`left/right/up/down/jump`) in
[`controls.ts`](../src/controls.ts); the physics reads only that state, so keyboard
and touch are fully interchangeable ([`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-input)).

| Input (keyboard) | Touch | Effect | Authoritative detail |
|---|---|---|---|
| **← / →** or **A / D** | Tap left / right of screen | **Steer.** Default is a *parallel (skidded)* turn; holding a smooth line locks it into a *carve* — see Techniques below | [`PHYSICS.md` §3.3](PHYSICS.md#33-ski-technique-the-skill-layer), §3.6 |
| **↑ / W** | Tap top of screen | **Speed up.** With no steering this is the *tuck* (least friction, most speed, least control); the snowman folds forward into a low aero crouch as the visible cue | [`PHYSICS.md` §3.3](PHYSICS.md#33-ski-technique-the-skill-layer) |
| **↓ / S** | Tap bottom of screen | **Brake — snowplow / "pizza".** A hold ramp: a tap only trims speed, a sustained hold deepens the wedge to a full stop — but only on green/blue pitches; a black-diamond slope is too steep to stop (only slows). Clamped so it never reverses uphill | [`PHYSICS.md` §3.4](PHYSICS.md#34-snowplow-brake-stop-slow-down-and-steep-slope-failure) |
| **Space** | Tap center of screen | **Jump.** A straight pop when not steering; a *player-initiated* jump is graded on landing and can earn a capped speed boost. **Not available on ● Bunny** — see the per-tier table below | [`PHYSICS.md` §4](PHYSICS.md#4-jumps--air), [`MEANINGFUL_JUMPS.md`](MEANINGFUL_JUMPS.md) |
| **Space + ← / →** | (center + side) | **Hop turn.** A quick grounded edge-set pivot for tight, steep terrain: snaps the heading and scrubs speed with a small pop. Rides the jump verb, so also **not available on ● Bunny** | [`PHYSICS.md` §4](PHYSICS.md#4-jumps--air) (hop turn) |
| **V** | — | **Toggle camera view** (follow ↔ alternate) | [`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-input) |
| *(no input)* | — | **Idle wander** — a gentle auto-turn biased back toward center keeps an unattended snowman alive. No-input coasting is the **deterministic baseline** and must stay byte-identical | [`PHYSICS.md` §3.5](PHYSICS.md#35-automatic-turning-idle-wander), §6 |

> The on-screen Reset and Restart buttons (and their touch handlers) call the
> `window.resetSnowman` / `window.restartGame` seams — see
> [`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-input) and §3.

### Per-tier control availability

Every tier shares the steering / speed / brake verbs. The **jump verb** is per-tier
(jump-system completion, workstream A), gated by `ski.manualJump` / `ski.autoJump`
in [`difficulty.ts`](../src/difficulty.ts) — the physics kernel is the single source
of truth; the touch surface follows via `Controls.setJumpEnabled(...)` at run start
(center region excluded from hit-testing, indicator hidden) and the start screen
hides the jump copy for a no-jump tier.

| Verb | ● Bunny | ■ Blue | ◆ Black | ◆◆ Expert |
|---|---|---|---|---|
| Steer / Carve, Speed/Tuck, Brake/Snowplow | ✅ | ✅ | ✅ | ✅ |
| Jump (Space / center tap) | — | ✅ | ✅ | ✅ |
| Hop turn (Space + steer) | — | ✅ | ✅ | ✅ |
| Terrain auto-jump (lips loft you) | — | ✅ | ✅ | ✅ |
| Freestyle tricks in the air (#32) | — | — | — | ✅ |

On Bunny, holding Space is provably ≡ no input (pinned by the invariant harness's
Bunny-suppression check) and lips never loft — the gentlest way down.

---

## 2. Ski techniques

The techniques are **not separate keys** — they emerge from how you use Steer /
Brake / Speed / Jump. The two steered turns are the ends of one `carveCharge`
edge-engagement axis: how committed the edge is sets the turn's radius, its speed
scrub, *and* its pose. Full model and constants in
[`PHYSICS.md` §3.3](PHYSICS.md#33-ski-technique-the-skill-layer).

| Technique | How to do it | Feel / trade-off |
|---|---|---|
| **Parallel turn** (skidded) | Steer ← / → uncommitted (fresh, reversed, or abrupt) | Skis brush sideways and **scrub speed**; **tighter** arc, body upright. The entry turn |
| **Carve** | Steer ← / → and *hold a smooth line* until the edge locks (`carveCharge > 0.6`) | The locked edge **holds speed**; **wider** arc with a deep body lean. The mastery turn above a parallel |
| **Snowplow / pizza** | Brake (↓ / S) — tap to slow, hold to stop | Wedge the ski tips together: a tap trims speed, a held wedge deepens to a **stop**; sharp, planted turns. Too steep (black diamond ◆) and even a full wedge only slows — match the Slope HUD tier |
| **Tuck** | Speed up (↑ / W) with **no steering** | Straight-line for **maximum speed** — least friction, least control. The body folds forward into a low aero crouch (the visible speed cue) |
| **Hop turn** | **Jump + Steer** (Space + ← / →, grounded) | A quick pivot that snaps the heading and scrubs ~18% speed; for tight, steep terrain |

**Why it's a skill:** an always-on turn tax (faded out by a committed carve) keeps
straight-lining the fastest line, so anticipating and holding a clean carve beats
chatter-skidding. The classification (`parallel` → `carve`) is what the HUD shows
and what drives the ski/body pose — purely cosmetic, it never feeds back into the
physics. Details and the edge-engagement equations:
[`PHYSICS.md` §3.3](PHYSICS.md#33-ski-technique-the-skill-layer).

### Freestyle tricks (◆◆ Expert)

On the **Expert** tier, the *same* steering keys become trick controls **while you're
in the air** — off a deliberate jump **and** off any terrain **kicker** (the sculpted
lips loft you). This is the air a touch player actually reaches: launch off a kicker,
then touch a direction to rotate. Land the rotation clean and it scores + boosts you;
land mid-rotation and it spoils the landing (head-first crashes).

| Trick | Keyboard | Touch | Notes |
|---|---|---|---|
| **Spin** (yaw) | Hold ← / → in the air | Touch left / right region | 360°/s; the body banks into a fast spin |
| **Flip** (somersault) | Hold ↑ (front) / ↓ (back) in the air | Touch top / bottom region | 300°/s; orbits the body's center of mass |
| **Grab** | Release then re-hold Space mid-air | Lift then re-tap center | Tucks into a grab; scores per second held |

Combine them (spin **and** flip together = a "corked" rotation). Full model, rates,
and the landing grade: [`PHYSICS.md` §4.1](PHYSICS.md#41-freestyle-tricks-32--expert-tier-only).

---

## 3. Notes for contributors

- **The no-input path is load-bearing.** Coasting (no steer, no brake, no jump)
  must stay byte-identical to the pre-technique physics — every technique above is
  gated behind an explicit input. Any change to that path is deliberate and must be
  reflected in [`PHYSICS.md`](PHYSICS.md) *and* the
  `tests/verification/snowman_baseline.js` snapshot, or the physics-invariant
  harness fails. See [`PHYSICS.md` §6](PHYSICS.md#6-determinism--the-test-safe-seam).
- **Keyboard and touch are one contract.** Both only write the shared `controls`
  state; never branch physics on input source. Add a binding in
  [`controls.ts`](../src/controls.ts), not in the game loop.
- **Click-bound buttons just work on touch now.** The document-level touch handlers
  in [`controls.ts`](../src/controls.ts) `preventDefault()` steering touches, which
  used to swallow the synthesized `click` on any on-screen button (hence the long
  trail of per-button workarounds: #173, the auth `touchend`, the mute-button
  `touchstart`, the share defuses). The handlers now **bail on touches that land on an
  interactive control** (`button, a, input, select, textarea, label, [role="button"]`),
  so a plain `click` listener is enough — no per-button touch wiring required.
  Buttons that need to act on `touchstart`/`touchend` for other reasons (audio unlock,
  popup user-activation) still may, but it's no longer mandatory.
- **Reduced motion / automation.** Cosmetic layers (intro fly-over, snowman flex)
  are disabled under `reduced-motion` / test / automation so the deterministic path
  is unchanged — see [`ARCHITECTURE.md` §8](ARCHITECTURE.md#8-testing--deployment-seams).
