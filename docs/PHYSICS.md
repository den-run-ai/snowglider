# SnowGlider — Physics Reference

This document describes the simulation model behind SnowGlider: terrain, skiing,
jumps, collisions, and the avalanche. It is a reference for anyone changing
gameplay feel or debugging a physics regression. All numbers below are the actual
constants in the source as of writing — when you change a constant, update this
file and the verification baseline (see [Determinism & the test seam](#determinism--the-test-safe-seam)).

Companion docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the modules fit together),
[`tests/README.md`](../tests/README.md) (how the physics is tested).

---

## 1. Conventions

- **Units.** 1 world unit = 1 metre for HUD purposes. Time is in seconds; `delta`
  is the physics timestep. The live loop runs a **fixed-timestep accumulator**
  (`src/game/main-loop.ts`): physics advances only in `FIXED_DT = 1/60` s steps,
  with `MAX_SUBSTEPS = 8` capping how many steps a single slow render frame may run
  (~133 ms — the same ceiling the old `min(delta, 0.1)` clamp imposed) so a stalled
  tab cannot teleport the snowman, and the game slows down rather than tunnelling
  below ≈8 FPS. The fixed grid makes the live build frame-rate independent and is the
  exact `dt` the invariant/stress harnesses drive the kernel at. The kernel itself
  accepts any `delta` (the headless harnesses sweep it); only the live loop pins 1/60.
- **Axes.** `+y` is up. The fall line runs along `-z`: the player starts near
  `z = -15` and skis toward `z = -195`. `x` is the cross-slope (left/right) axis.
- **Downhill velocity is negative `z`.** Spawning, the avalanche, and the finish
  trigger all rely on this sign convention.
- **State.** The snowman's motion is integrated explicitly (semi-implicit Euler):
  forces adjust `velocity`, then `pos += velocity * delta`.

---

## 2. Terrain

Terrain is the foundation of every other system: skiing forces, tree/rock
placement, gates, and the avalanche all sample terrain height. Implemented in
[`src/mountains.ts`](src/mountains.ts).

### 2.1 Height field

The base mountain is a radial exponential peak with layered noise:

```
distance = sqrt(x² + z²)
y  = 40 * exp(-distance / 40)                                   // base peak
y += 1.5 * sin(x*0.05) * cos(z*0.05) * (1 - exp(-distance/60))  // low-freq roll
y += sin(x*0.2) * cos(z*0.3) * 0.8                              // fine ridges
if (z < -30) y += (z + 30) * 0.12                               // downhill bias
```

The last term is critical: below `z = -30` it adds a **consistent downhill
gradient (0.12 per unit)** so the run never flattens out or turns uphill, even
where noise would otherwise create a basin.

### 2.2 The two-formula contract (read before editing terrain)

There are **two** code paths that produce height, and they must agree:

1. `createTerrain()` builds the visible mesh. It uses `SimplexNoise.noise()` for
   roughness, plus occasional random bumps, and writes every vertex's **final**
   height into a global `heightMap` keyed by `round(x*10),round(z*10)`.
2. `getTerrainHeight(x, z)` is the analytic function the **physics** calls every
   frame. It first checks `heightMap`; on a hit it returns the exact mesh height,
   so the snowman rides precisely on the rendered surface at grid points. On a
   miss it recomputes the analytic formula in §2.1 as an approximation.

The **base peak term and the downhill term must stay byte-identical between the
two** (they are commented `MUST MATCH` in the source). The high-frequency noise
intentionally differs (analytic `sin/cos` vs. Simplex), and the `heightMap`
reconciles them at vertex positions. If you change the base shape or the downhill
factor in one place and not the other, the snowman will float above or sink into
the terrain between vertices — the single most common terrain regression, and the
reason `tests/terrain-tests.js` asserts consistency.

### 2.3 Gradient & downhill direction

```
getTerrainGradient(x,z): forward difference, eps = 0.1
    grad = { (h(x+eps,z) - h)/eps , (h(x,z+eps) - h)/eps }
getDownhillDirection(x,z): normalize(-grad), fallback {x:0, z:1} when flat
steepness = |grad|   // magnitude, drives gravity along the slope
```

The physics uses `getDownhillDirection` for the direction of the gravity pull and
`steepness` for its magnitude. Tilt rendering uses a wider central-difference
sample (`sampleDist = 0.4`) for stability.

---

## 3. Skiing model

Implemented in [`src/snowman.ts`](src/snowman.ts) `updateSnowman()`. Each frame,
grounded, the order is: detect landing → compute slope forces → apply ski
technique → friction → integrate → orient/tilt → collision & bounds.

> For the player-facing input → technique map (which keys/touches trigger each
> technique below), see [`CONTROLS.md`](CONTROLS.md).

### 3.1 Gravity along the slope

```
gravity = 9.8
velocity.x += dir.x * steepness * gravity * delta
velocity.z += dir.z * steepness * gravity * delta
```

Acceleration scales with `steepness`, so steeper pitches accelerate harder, just
like a real slope.

### 3.2 Friction (coasting)

Dynamic friction that is gentle at low speed (smooth starts) and firmer at speed:

```
speedFactor = min(1, currentSpeed / 8)
baseFriction = 0.012
friction = baseFriction + 0.020 * speedFactor        // 0.012 .. 0.032
velocity *= (1 - (friction + skidScrub))             // skidScrub == 0 when coasting
```

### 3.3 Ski technique (the skill layer)

Layered on top of the arcade handling. **When the player gives no steering and no
brake input, `turnForce`/accel are unchanged and `skidScrub == 0`, so coasting is
identical to the pre-technique physics** — see §6.

There are **two** steered turns — a skidded parallel turn and a carve — plus the
snowplow wedge. They are the two ends of one axis (`carveCharge`, below): how
committed the edge is sets the turn's radius, its speed scrub, *and* its pose, so
they read clearly differently to drive and to watch.

| Technique | Trigger | Effect |
|-----------|---------|--------|
| **Parallel (skidded)** | Left/Right, uncommitted (fresh, *reversed*, or abrupt) | Skis brush sideways and **scrub speed** (`skidScrub` near full); **tighter** turn (`turnForce → 19`); skis stay flatter, body upright |
| **Carve** | Left/Right, *committed* (held smoothly, `carveCharge > 0.6`) | **Holds speed** — the locked edge sheds ~92% of the wash-out; **wider** arc (`turnForce → 10`); skis roll onto edge + draw together with a deep body lean. The mastery turn above a parallel |
| **Snowplow** | Down (hold ramp) | Sheds real speed, sharper planted turns (`turnForce = 24`, grip = 1.0); skis form a wedge that **deepens the longer you hold** (`plowCharge`): a tap only trims speed, a full wedge stops you — but only where the slope isn't too steep (§3.4) |
| **Tuck**  | Up, no steer | Least friction, most speed, least control (`accel = 10` on `-z`) |
| **Hop turn** | Jump **+** Left/Right (grounded) | A quick edge-set pivot: snaps heading ~0.4 rad toward the steer, scrubs ~18% speed, small pop; lands on a fresh edge (see §4) |

**Edge engagement — carve vs. skidded parallel (issues #48 / #54).** A turn is only a
skill if a clean, committed turn costs less speed than a panicked one. `carveCharge`
∈ [0,1] tracks how locked-in the current edge is: it builds while the player holds
*one* steering direction and collapses to 0 the instant they reverse it or first set
an edge out of a straight line. Past `CARVE_LOCK = 0.6` the turn is a **carve** (wide
arc, holds speed); below it the turn is a **skidded parallel** turn (tighter, scrubs
speed). So anticipating and holding a smooth line carves and keeps speed, while
abrupt or flip-flopping steering skids and bleeds it. The state lives on
`snowman.userData` (like the pose state), persists across frames, and is cleared by
`resetSnowman`.

Key terms:

```
terrainGrip = 0.6 + min(0.4, steepness * 0.5)        // more bite on pitches

// Edge engagement (per-frame, on snowman.userData):
if steering != 0:
    carveCharge = (steering == lastSteerDir)          // same way as last frame?
                ? min(1, carveCharge + delta * 1.5)   // ~0.4 s of a held turn locks the carve in
                : 0                                    // reversal / fresh edge breaks it
else:
    carveCharge = max(0, carveCharge - delta * 3.0)   // releases ~2x faster than it engages

// Turn RADIUS is the inverse of commitment (a carve can't be whipped tight):
turnForce   = 24.0                                    if snowplow   // tightest, planted wedge
            = 19.0 + (10.0 - 19.0) * carveCharge      otherwise     // 19 skid (tight) -> 10 carve (wide)
            *= 0.85                                    if currentSpeed > 18 (no snowplow)
left/right:  velocity.x ∓= turnForce * delta

skidScrub = 0  unless (steering && currentSpeed > 4):
    speedFactor2 = min(1, currentSpeed / 22)
    grip = snowplow ? 1.0 : terrainGrip
    edgeScrub = 0.10 * speedFactor2 * (1 - grip*0.85) * (1 - 0.92 * carveCharge)  // carve sheds ~92%
    skidScrub = edgeScrub + 0.008 * speedFactor2 * (1 - carveCharge)              // turn tax, faded by a carve
```

`technique` is classified each frame and returned for the HUD and ski pose: a steered
turn reads as **`parallel`** (skidded) until the edge locks in, then **`carve`** once
`carveCharge > CARVE_LOCK` (0.6). The snowplow forms a ski wedge whose depth tracks the
brake commitment (`wedge = 0.18 + 0.32 * plowCharge` rad — a light check that opens
into a deep "pizza") with the **tips converging and the tails splayed out**; a **carve**
rolls the skis hard onto their edges, draws them together, and inclines the whole body
into the turn (lean clamp raised to ~0.42 rad); a **skidded parallel** turn keeps the
skis flatter and the body upright; a **tuck** (Up, no steer) folds the body forward
into the fall line and crouches low over skis drawn parallel and narrow — an
aerodynamic egg, the visible "go fast" cue (pitch clamp raised to ~0.5 rad, `scale.y`
compressed about the foot-level origin); and a hard snowplow adds a knees-bent squat
that deepens with `plowCharge` (a dig-in, not a lean back). The pose is purely
cosmetic — it never touches the physics. The always-on turn tax (faded out by a carve) keeps turning from ever being
entirely free, so straight-lining stays the fastest line and a clean carve still
finishes far faster than chatter-skidding (≈30%+ in the verification harness, §6).

### 3.4 Snowplow brake: stop, slow-down, and steep-slope failure

Snowplow decelerates **along the actual direction of travel**, so it bleeds
genuine speed rather than only downhill velocity. The wedge is a **hold ramp**, not an
on/off brake: `plowCharge ∈ [0,1]` builds while Down is held and decays when released
(mirroring `carveCharge`), and the deceleration scales with it. A tap gives a shallow
wedge that only trims speed; a sustained hold deepens it into a full "pizza" that can
bring you to a stop.

```
// wedge depth (per-frame, on snowman.userData; cleared by resetSnowman):
plowCharge = snowplow ? min(1, plowCharge + delta * 1.6)   // ~0.6 s of holding => full wedge
                      : max(0, plowCharge - delta * 4.0)   // relaxes quickly on release

brakeSpeed = |velocity|                                    // AFTER this frame's gravity
if (snowplow && brakeSpeed > 0.001):
    brakeDecel   = 3.14 + (5.68 - 3.14) * plowCharge        // light -> full wedge
    brakeImpulse = min(brakeDecel * delta, brakeSpeed)      // clamp: never reverse velocity
    velocity    -= (velocity / brakeSpeed) * brakeImpulse
```

The `min(..., brakeSpeed)` clamp is load-bearing: without it, at low speed the
subtraction overshoots zero and drives the snowman **uphill from a standstill**,
letting players stall or climb the timed course by braking. `brakeSpeed` is recomputed
here from the **post-gravity** velocity (not the stale start-of-frame speed): scaling
by the smaller pre-gravity speed over-removed velocity as it dropped, which pinned the
snowman to a stop well past the cap (~36° rather than 30°), so a pitch the HUD calls
black could still be fully stopped. Recomputing keeps the removed impulse exactly
`brakeDecel · delta`, so the stop/fail boundary lands on the tier edge. (The earlier fixed
`+3 m/s²` uphill nudge that rode alongside the brake was removed — as a *constant* it
applied even to a feather-light wedge, which both stopped you on terrain too steep to
wedge and pushed the stop threshold past anything the run actually skis; it is folded
into `PLOW_MAX_DECEL`, and the clamp alone is what prevents reversal.)

**Steep-slope failure.** Because the full wedge's deceleration is *capped*
(`PLOW_MAX_DECEL`), it cannot stop you where the slope's gravity component
`steepness × g` exceeds it — there it only holds a slow **terminal speed**. The two
thresholds are pinned to the Slope-HUD colour tiers (PR #201, `src/ui/hud.ts`:
`SLOPE_MODERATE = 0.32 ≈ 18°`, `SLOPE_STEEP = 0.58 ≈ 30°`) by setting each decel to the
slope gravity at the tier edge (`0.32 × 9.8 = 3.14`, `0.58 × 9.8 = 5.68`), so the live
readout doubles as a "can I stop here?" cue:

| Slope HUD | Pitch | Light wedge (tap) | Full wedge (hold) |
|-----------|-------|-------------------|-------------------|
| 🟢 green  | < 18° | stops you | stops you |
| 🟡 yellow | 18–30° | only slows | stops you |
| 🔴 red    | > 30° | only slows | **only slows** (can't stop) |

This graceful degradation is what makes the steep upper mountain — and outrunning an
avalanche — actually demand carving/hopping instead of a free "pizza" anywhere (#54).

### 3.5 Automatic turning (idle wander)

When neither Left nor Right is pressed, a gentle sinusoidal wander keeps an
unattended snowman looking alive and biased back toward center:

```
turnPhase += delta * 0.5
// every 3–5 s pick a turn direction, biased toward center when |x| is large
turnIntensity = min(currentSpeed, 10) / 10
velocity.x += sin(turnPhase*0.3) * (turnAmplitude*0.7) * delta * turnIntensity * dir
```

### 3.6 Orientation & tilt

- **Heading** (`rotation.y`) eases toward `atan2(velocity.x, velocity.z)` only
  when `currentSpeed > 0.5`, capped at `delta*3` rad/frame (~180°/s) to prevent
  spinning, with shortest-arc wrapping at 2π.
- **Tilt** (`rotation.x/z`) blends a slope component (`grad*0.3` from a
  `sampleDist = 0.4` central difference) with a turn lean (`velocity.x *
  min(0.3, speed/25)`) and a jump lean, lerped (`0.08` grounded / `0.05` airborne)
  and clamped to `±0.25 rad` (~14°).

---

## 4. Jumps & air

**Per-tier availability (jump-system completion, workstream A).** The jump verbs are
gated by two boolean fields on `SnowmanPhysicsTuning` (`src/difficulty.ts`):
`manualJump` (Space/touch straight jump **and** hop turn) and `autoJump` (terrain-lip
auto-pop). Both are `true` on the Blue default — so the frozen baseline, every
existing caller, and the invariant harness (which passes no tuning) are
byte-identical — and both are `false` on **● Bunny**, whose grounded path's
`pos.y = terrain` keeps the snowman glued over lips (a calm, groomed learning run;
held-Space is provably ≡ no-input, pinned by the harness's Bunny-suppression check).
⚠️ `manualJump: false` + `autoJump: true` is **unsupported**: the auto-jump gate keeps
its `!jump` takeoff-precedence term, so holding Jump on such a tier would suppress
auto-pops and diverge from the no-input trajectory. No shipped tier uses it.

```
// Auto-jump over terrain lips / moguls. Skipped while Jump is held so a deliberate
// jump input wins on a combined lip+jump frame (meaningful jumps #47, §3.1); the
// `!jump` term is a no-op on every no-input/coasting frame, so the baseline is
// unchanged. A terrain auto-jump is never player-initiated: playerJump := false.
// `tuning.autoJump` (true on Blue == default) gates the whole branch per tier.
if (!isInAir && tuning.autoJump && !jump && heightDifference < -0.8 && currentSpeed > 12 && jumpCooldown <= 0):
    verticalVelocity = 6 + currentSpeed * 0.3 ; isInAir = true ; playerJump = false

// Manual jump (Space / touch) — straight pop when NOT steering. Marks this air
// phase player-initiated so the landing can grade it and award a boost (#47, §3.1).
// `tuning.manualJump` (true on Blue == default) gates the jump VERB per tier — this
// branch AND the hop turn below (a hop is bound to the jump input).
if (tuning.manualJump && jump && !isInAir && jumpCooldown <= 0 && steering == 0):
    verticalVelocity = 10 + currentSpeed * 0.5 ; isInAir = true ; jumpCooldown = 0.5
    playerJump = true

// Hop turn — Jump WHILE steering Left/Right (issue #48). A quick edge-set pivot:
// rotate the horizontal velocity toward the steer direction and scrub speed, with
// a small pop; land on a fresh edge committed to the new direction. Gated entirely
// behind jump+steer input, so it touches no coasting/plain-steer path.
if (tuning.manualJump && jump && !isInAir && jumpCooldown <= 0 && steering != 0):
    theta = steering * 0.4                          // HOP_PIVOT_ANGLE (~23°), right => +x
    (velocity.x, velocity.z) = rotate(velocity, theta) * 0.82   // HOP_SPEED_KEEP (scrub ~18%)
    verticalVelocity = 5.0                          // HOP_POP (small, < a full jump)
    isInAir = true ; jumpCooldown = 0.45            // HOP_COOLDOWN
    carveCharge = 0 ; lastSteerDir = steering       // re-set the edge for the new line
    playerJump = false                              // a hop is a steering move, not a graded jump

// While airborne:
airTime += delta
verticalVelocity -= 16 * delta                 // stronger gravity than ground "pull"
pos.y += verticalVelocity * delta
left/right: velocity.x ∓= 5.0 * delta          // limited air control
velocity *= (1 - 0.01)                          // low air friction

// Landing (pos.y <= terrain). The landing reads + clears playerJump (consume the
// provenance) and branches on it (meaningful jumps #47, §3.2/§3.3):
landingImpact = min(0.5, airTime * 0.15)
landingForce = airTime                          // fed to camera shake (EffectsModule)

if (playerJump):                                // a graded *manual*-jump landing
    alignment = dot(velocityHeading, downhill)  // cosine vs the fall line at touchdown
    vImpact   = |v³ · n|                        // impact into the surface — see §4.2 (JP-4)
    if   wipeout (§4.2, tuning.wipeouts only):  quality = WIPEOUT; run ends (crash path)
    elif alignment > 0.85 and vImpact < 24: quality = CLEAN  ; velocity *= (1 + min(0.06, airTime*0.04))  // boost
    elif alignment > 0.55 and vImpact <= 30: quality = OK    ;                                            // neutral
    else:                  quality = SKETCHY; velocity *= (1 - scrub)   // deeper scrub if vImpact > 30
    airScoreDelta = quality==WIPEOUT ? 0 : round(airTime*100 + (quality==CLEAN ? 50 : 0))
else:                                           // auto-jump / hop — UNCHANGED from before
    velocity *= (1 - landingImpact)             // bleed speed on impact
jumpCooldown = 0.3
```

`landingForce` (seconds aloft) and `justLanded` are returned so the main loop can
trigger a proportional camera shake on touchdown. `landingQuality` (CLEAN/OK/SKETCHY,
null off a manual landing) and `airScoreDelta` are also returned: the loop toasts
`✈ AIR <t>s · <grade>` via `CourseModule.flashAir(...)` and banks `airScoreDelta` into a
per-run **air score** shown on the result screen. The score is banked from *inside* the
kernel step (`Snowman.updateSnowman`, via an injected `bankAirScore` callback) **before**
its synchronous finish/collision check, so a jump that lands on the same frame the player
crosses the finish line is still counted on the result screen. **All of this is gated on
the `playerJump` provenance flag** (set true only at a deliberate straight-jump takeoff,
false at auto-jump/hop takeoffs, cleared on landing and in `resetSnowman`), so the
auto-jump / hop / coasting landing path is byte-identical to before — see §6 and the
new gating checks in the invariant harness.

**Scored obstacle clears (JP-2, #245 item 1).** The collision layer (§5) already
*suppresses* tree/rock hits while airborne-clear (`isJumpingHighAboveTrees` /
`isJumpingOverRock`); those silent saves are now surfaced and rewarded. Detection
lives in `collision.ts` (`ObstacleClear`: "the horizontal-overlap test would have
collided, but the suppression branch fired"), reported through an
`onObstaclesCleared` callback that runs **before** the finish check so a clear on
the finish frame still banks (#186 rationale). The policy is applied in
`snowman/index.ts`:

- **Provenance:** only a *manual* jump's air scores (`playerJump` still true while
  airborne) — an auto-jump / hop clear banks nothing, and its bytes are unchanged.
- **Dedup:** one pass over an obstacle spans many overlap frames; the per-air-phase
  `clearedObstacles` set (fresh at every manual takeoff) counts it once.
- **Cap:** at most `CLEAR_MAX_PER_AIR = 3` scored clears per air phase.
- **Banking:** `CLEAR_SCORE = 75` per clear, via the same `bankAirScore` path as the
  landing score. `UpdateResult.obstacleCleared` (`'tree' | 'rock' | null`) surfaces
  the cue; the loop toasts `✦ CLEARED!` (`CourseModule.flashClear`).

Clears never touch `pos`/`velocity` — pinned by the harness's clear-provenance
check (identical trajectories with and without provenance; exactly one scored clear
per obstacle; cap honoured).

**Avalanche-dodge window (JP-3 — the #47 headline).** A *deliberate* jump carrying
the player over the slide front survives it. Implemented **at the loop's
`checkBurial()` site in `game/main-loop.ts`, never in the kernel** (#245): the pure
`resolveBurialOutcome(overlapping, isInAir, playerJump, dodgeAwarded)`
(`src/avalanche.ts`, pinned headlessly in `tests/avalanche-tests.js`) maps each
frame's burial overlap to `safe` / `buried` / `dodgedFirst` / `dodged`:

- immune while the `playerJump` air phase lasts; the **first** dodging frame of a
  slide banks `DODGE_SCORE = 250` (same air-score channel), toasts
  `🏔 DODGED THE AVALANCHE!`, and applies a one-shot `×1.10` horizontal escape
  impulse (adopted decision §10.2: immunity + impulse) so a stomped landing can
  outrun the front;
- **exploit guards:** auto-jump / hop air (`playerJump` false) is buried like
  grounded (provenance); `dodgeAwarded` (GameState, re-armed when the slide resets
  or a new run starts) caps it at one award per slide; without overlap the outcome
  is `safe` regardless of input, so holding Jump early does nothing — the award
  needs airborne overlap.
- **frame-perfect leap (deliberate):** burial resolves after the frame's physics
  substeps, so a jump pressed on the very frame the overlap begins is already
  airborne when it's resolved and counts as a dodge — the heroic last-instant
  escape is the #47 fantasy. It can't be farmed: if the overlap began on any
  *earlier* grounded frame that frame's check already buried the player, and a
  bunny-hop spends ≥0.3 s grounded (the landing cooldown) inside the front between
  hops.

### 4.1 Freestyle tricks (#32 — Expert tier only)

On the ◆◆ **Expert** tier (`ski.freestyleTricks` in `src/difficulty.ts` — the only
tier that sets it), **every** jump's air phase accepts trick input — a deliberate
manual pop *and* a sculpted terrain **kicker** (auto-jump). Kicker air is the main
way you get big air on Expert, and on **touch** it is the *only* air a player reaches
(a manual pop needs a steer-free tap in the CENTER region), so a kicker sets a
`freestyleAir` flag — gated on `tuning.freestyleTricks`, so every other tier's kicker
stays non-freestyle and byte-identical (#32 mobile fix). `freestyleAir` is a *superset*
of `playerJump`: it opts the phase into trick input + a graded landing **without**
marking it a deliberate jump, so a passive kicker never triggers the deliberate-jump-only
**avalanche-dodge** or **obstacle-clear** rewards (those stay strictly on `playerJump` —
a natural lip is not an avalanche-immunity farm). The tricks re-use the existing controls
while airborne:

```
// Double gate: tuning.freestyleTricks (Expert only) AND the freestyleAir flag —
// set at a deliberate manual pop AND at an Expert kicker, so kicker air is a full
// freestyle phase (manual pops and kickers both count). playerJump (dodge/clear) is
// left FALSE on a kicker, so a passive lip launch is never dodge-worthy.
// Pure userData accumulator writes — pos/velocity are NEVER touched here (the
// existing ±5 m/s² airControl drift above is unchanged and still applies):
Left/Right : trickSpin ∓= 360 * delta      // SPIN_RATE_DEG (deg/s of yaw, right = +)
Up/Down    : trickFlip ±= 300 * delta      // FLIP_RATE_DEG (+ = frontflip, − = backflip)
Jump       : re-press → grab               // released after takeoff first (arms), then held:
             trickGrabTime += delta        // the takeoff press itself can never grab

// At touchdown, the landing branch settles the tricks (gradeFreestyleTrick):
spinHalves = floor((|trickSpin| + 60) / 180)   // completed 180s within SPIN_LAND_TOL_DEG
flips      = floor((|trickFlip| + 75) / 360)   // completed 360s within FLIP_LAND_TOL_DEG
underRotated = residual(trickSpin, 180) > 60 || residual(trickFlip, 360) > 75
trickScore = spinHalves*40 + flips*120 + (grab >= 0.25s ? grabTime*60 : 0)
if underRotated: trickScore *= 0.5 ; quality := SKETCHY   // spoils even a perfect aim
airScoreDelta = round(airTime*100 + cleanBonus + trickScore)
trickName = "540 + BACKFLIP + GRAB"-style label (null when nothing completed)
```

The rotation itself is **cosmetic** — applied in `pose.ts` from the `userData`
accumulators (`trickSpin` drives `rotation.y` directly while spinning, pausing the
velocity-facing smoothing; `trickFlip` rotates the model's **COM pivot** —
`userData.flipPivot`, a child group at the mass-weighted center y ≈ 3.1 (JP-5,
radii 2/1.5/1 ⇒ masses ∝ 8/3.375/1) — so a somersault orbits the body's center of
mass instead of the feet while the root keeps position/yaw/tilt and the follow
camera stays steady; a held grab tucks `scale.y`; and a **spin-lean flair** banks the
body off-vertical into a spin — a roll on the COM pivot scaled by the live spin rate
and eased in/out — so a big spin reads as athletic rather than a stiff turntable, all
cosmetic and leaving the root/camera heading untouched) — so the trajectory of a trick
flight is identical to the same flight without the trick system (pinned pose-only
by the freestyle suite's pivot trajectory-identity check). The **only** physics consequence is at touchdown:
landing mid-rotation (under-rotated) forces the SKETCHY scrub, which is the
freestyle risk/reward. Trick points ride inside `airScoreDelta` (same banking path),
and `trickName` is returned for the toast (`✈ AIR <t>s · <trick> · <grade>`).
Trick state (and the `freestyleAir` flag) lives on `snowman.userData` with the same
lifecycle as `playerJump`: set/reset at every freestyle takeoff (a manual pop or an
Expert kicker), consumed at landing, cleared in `resetSnowman`.
Because spins can't yet alter the *velocity* heading (that needs heading-relative
velocity, #244), a spun landing is still graded by velocity-vs-fall-line alignment.
Tunables + grading live in `src/snowman/physics.ts` (exported constants +
`gradeFreestyleTrick`), pinned by `tests/freestyle-tests.js`.

**Style/combo chain (JP-7 — loop-side, no kernel state).** Consecutive rewarded air
events — CLEAN landings, scored clears (JP-2), avalanche dodges (JP-3) — build a
multiplier on every point banked into the air score: ×1.25 per step, capped ×3
(`src/game/combo.ts`, the pure decision core). An OK landing holds the chain;
SKETCHY/wipeout breaks it; a run reset clears it. Order contract: an event's own
points ride the multiplier built by the events *before* it (the loop's
`bankAirScore` callback multiplies at the current step, then `aggregateEvents`
advances the chain from the substep result). The air toast carries the live label
(`✈ AIR 1.2s · 360 · CLEAN ×1.56`), and the result screen's air score total
reflects the multiplied points. **Physical spins (#244) — reserved seam:** once
heading is real kernel state, a landed 180 rides switch and the grade reads
heading-vs-velocity; combo.ts's event stream is where a switch-landing event slots
in without touching the multiplier math.

### 4.2 Impact-consistent grading & wipeouts (JP-4 — MEANINGFUL_JUMPS §8.3)

Landing harshness is **physical, not just aim**: the grade also reads the velocity
component *into* the landing surface —

```
n       = normalize(-∇x, 1, -∇z)                       // surface normal at the landing point
vImpact = |(vx, verticalVelocity, vz) · n|             // computed before verticalVelocity is zeroed
```

Touching down where the surface falls away along travel (a downslope transition)
absorbs the fall — `vImpact` drops — while flatting out from big air reads harsh
even perfectly aligned. Grade gates (in the `playerJump` branch only):

- **CLEAN** additionally requires `vImpact < LAND_SOFT_NORMAL (24)`;
- `vImpact > LAND_HARSH_NORMAL (30)` forces **SKETCHY** with a deeper scrub
  (`min(0.5, landingImpact × 1.5)`) and a heavier touchdown shake;
- **WIPEOUT** (`tuning.wipeouts` tiers — Expert only): `vImpact >
  LAND_WIPEOUT_NORMAL (34)` **or** landing more than 120° into a somersault
  (`WIPEOUT_FLIP_RESIDUAL_DEG`; the flip is the only rotation whose residual can
  exceed 120° — a spin's residual to the nearest 180° maxes at 90°). A wipeout
  banks **zero** air score and `updateSnowman` routes it to the crash path
  (`showGameOver` → the #171 shatter): freestyle risk with real consequences.

Thresholds are calibrated to **measured** touchdown impacts (probe over speeds
8–25 on the harness hill + constant 9°/18°/30° slopes: a plain full-power straight
jump lands at `vImpact ≈ 15–28`), so ordinary stomps keep the #186 CLEAN boost and
harsh/wipeout live past what a plain downhill jump reaches (flat-outs and
kicker-scale air get there). Pinned by the harness's **landing-monotonicity** check
(equal touchdown velocity: a downslope landing never grades worse than flat) and
the **wipeout-gate** check (`'wipeout'` unreachable when `tuning.wipeouts` is
false); the freestyle suite pins the wipeout residual/impact tables.

### 4.3 Designed air: kickers + lip-consistent launch (JP-6 — Expert)

**Kickers** (`DifficultyConfig.features?: KickerSpec[]` — Expert ships three;
absent ⇒ byte-identical terrain, the `terrain`-corridor guardrail pattern): sculpted
ramps sitting ON the course line, each `{ z, length, halfWidth, height }` — the
approach rises by a **quadratic ease (u²)** to the lip at `z` and then **drops**
(the tabletop face the auto-jump launches off), tapering smoothly (smootherstep) to
0 at `±halfWidth` around `laneX(z)`. u² is deliberate: flat at the entry (no kink
riding on) and **steepest at the lip** — how a real kicker is shaped, and what the
launch below converts to air; a smoothstep profile would flatten at the lip and
launch nothing on a steep base slope. The ramp term is added in the **one canonical height source**
(`mountains/terrain.ts` `kickerRampHeight`), consumed by both the mesh builder and
the physics sampler — the §2.2 two-formula contract — and `setTerrainKickers`
resets the height cache like the corridor. Pinned by `tests/kicker-tests.js`.

**Lip-consistent launch** (`tuning.lipLaunch` — Expert only; every other tier keeps
the frozen constant):

```
// In the auto-jump branch, when tuning.lipLaunch. NOTE: by the time the auto-jump
// condition (heightDifference < -0.8) has fired, pos is already PAST the drop, so
// the approach pitch is measured entirely from samples BEHIND pos — never against
// the dropped current height (which would read the ramp as negative slope and
// collapse every kicker to the LIP_MIN floor — Codex on #292).
u          = velocity / |velocity|                       // travel direction
slopeBehind = (h(pos − u·2) − h(pos − u·4)) / 2          // approach-ramp pitch (behind-only)
slopeAhead  = (h(pos + u·2) − h(pos)) / 2                // − = keeps dropping away ahead
Δslope      = max(0, slopeBehind − slopeAhead)           // convexity along travel
v_y         = clamp(speed · Δslope · LIP_K(1), LIP_MIN(4), LIP_MAX(16))
```

Bigger ramps at higher speed give proportionally bigger, physically plausible arcs
— which is what makes the kickers *work*. The manual-jump pop stays a constant
"ollie" on all tiers (it's an input, not terrain). Pinned by the harness's
**lipLaunch gate**: flag off ⇒ the legacy `6 + 0.3·speed` bytes; flag on ⇒ exactly
the exported formula (cap + speed-scaling asserted); off-lip descents are
byte-identical under either flag. The follow-the-line **winnability** gate now runs
Expert too — the line rider goes straight off all three kickers and must still
finish, stay in the corridor, and out-ski the slide, every seed.

---

## 5. Collisions, bounds & game over

### 5.1 Trees

2D (x,z) distance check against `treePositions`; default
`treeCollisionRadius = 2.5`. A collision ends the run **unless** the snowman is
genuinely clearing the tree: `isInAir && verticalVelocity > 0 && pos.y > treeY + 5`
allows jumping over. (Test modes widen the epsilon and add force-collision hooks —
see [`src/snowman.ts`](src/snowman.ts) `addTestHooks`.)

### 5.2 Rocks

Rocks are generated by `mountains.ts` as terrain scenery, but only large exposed
rocks (`size >= 1.25`) are returned as collision hazards through `rockPositions`.
Small half-buried stones remain decorative so the slope does not become unfairly
dense with low-visibility crashes.

Because rock placement is unseeded `Math.random()`, `mountains.ts` also keeps the
central ski line and the spawn pocket free of *collidable* rocks
(`rockIsCollisionHazard`): a rock only becomes a hazard when `|x| >= 5` (mirroring
the tree clear-corridor in `trees.ts`, and wide enough to cover the max rock
radius) and it is at least `10` units from the snowman start `(0, -15)`. This
guarantees the run is always navigable and the player never spawns on a rock.
Decorative rocks are still rendered across the whole mountain — only their hazard
status is suppressed.

Rock collision uses the same simple 2D (x,z) distance style as trees, with a
size-scaled radius clamped to `1.25 .. 3.0`. A rock hit ends the run unless the
snowman is actively clearing it: `isInAir && verticalVelocity > 0` and the
snowman origin is above the exposed rock top plus a small margin. Rocks are low
obstacles, so their jump clearance is intentionally much lower than the tree
clearance rule.

### 5.3 Boundaries & reset reasons

`updateSnowman` ends the run (`showGameOver(reason)`) when any of:

| Condition | Reason string |
|-----------|---------------|
| `pos.z < -195` | "You reached the end of the slope!" (a **finish**, not a crash) |
| `abs(pos.x) > 120` | "You went off the mountain!" |
| `!isInAir && pos.y < terrain - 0.5` (`fallThreshold`) | "You fell off the terrain!" |
| tree collision | "BANG!!! You hit a tree!" |
| exposed-rock collision | "BANG!!! You hit a rock!" |
| avalanche burial (main loop) | "Buried by avalanche!" |

The finish string is load-bearing — `showGameOver` keys the result screen,
best-time recording, and `CourseModule.onFinish` off it.

---

## 6. Determinism & the test-safe seam

Several browser tests drive the **real** `updateSnowman`, and a headless harness
compares trajectories against a frozen baseline. Two properties make this work:

1. **No-input identity.** With no steering/brake input the grounded physics is
   byte-for-byte identical to the pre-technique model: `skidScrub == 0`, the
   snowplow branch is gated on `controls.down`, `turnForce` is only *applied*
   under Left/Right (and preserves sign: left → `-x`, right → `+x`), and the
   terrain-grip term only affects carve/skid, never base coast friction. This is
   asserted, not assumed — `tests/verification/physics_invariant_harness.js`
   reports max abs trajectory difference `0` for the coasting case and gates its
   exit code on it. The same harness also gates the **carve-vs-skid trade-off**:
   linked, committed carves must finish meaningfully faster (gate: >12%; measured
   ≈40%) than chatter-skidding the same fall line, alongside the snowplow-brake,
   `scrub ≥ baseline`, high-speed edge-scrub, **parallel-turn-reachable** (a held,
   committed carve must lock into the `parallel` tier), and **hop-turn** (Jump+steer
   must snap the heading far harder than a plain steer frame *and* scrub speed)
   checks. The parallel/hop additions are all gated behind steering or jump+steer
   input, so none of them perturb the no-input identity above. The **meaningful
   jumps** layer (#47, §4) adds three more: **takeoff precedence** (pressing Jump on
   a terrain-lip frame yields the stronger *manual* takeoff stamped `playerJump`,
   while an *unpressed* lip stays a byte-identical auto-jump), **landing grade** (a
   CLEAN manual landing finishes faster and scores higher than a SKETCHY one from the
   same speed + airtime), and the **provenance gate** (a non-player landing earns no
   boost or air score). All three are gated on the `playerJump` flag, so the
   auto-jump / coasting landing path stays byte-identical — no baseline regen needed.
2. **Sources of randomness.** `Math.random()` appears in the idle auto-turn
   (§3.5), in terrain mesh noise/bumps, and in avalanche spawn/velocity. The
   verification harness injects a seeded RNG and a deterministic terrain so runs
   are reproducible. If you add randomness to the grounded path, keep it behind an
   input gate or the invariant harness will (correctly) fail.

The harnesses drive the kernel at a fixed `dt = 1/60`, and so does the **live loop**
(the fixed-timestep accumulator, §1) — the thing that runs is the thing that's tested.
`tests/verification/fixed_timestep_harness.js` proves it: stepping the kernel through
the accumulator at 30/50/144 FPS and a jittery rate traces a **byte-identical** path to
the 60 FPS run, and every fixed step stays under the tree collision radius (no tunneling
by construction). The accumulator changes only *when* steps run, never their content, so
the no-input identity above is untouched and the invariant harness is unaffected.

Regenerate the baseline only on a **deliberate** physics change — and note it is
**not** a verbatim copy of `src/snowman.ts`. The harness loads the baseline as a
*classic script* through `vm.runInContext` and reads `window.Snowman.updateSnowman`,
whereas `src/snowman.ts` is an ES module (`import * as THREE from 'three'`,
`export const Snowman`). A raw `git show <ref>:src/snowman.ts > …snowman_baseline.js`
would therefore write ESM `import`/`export` with no `window.Snowman`, and the next
`npm run test:verify` would fail. Instead, port the changed `updateSnowman` (plus the
helpers it calls) into the existing classic-wrapper shape: drop the
`import * as THREE from 'three'` line (the harness supplies a global `THREE` stub) and
the `export`s, and keep the trailing
`const Snowman = { … }; if (typeof window !== 'undefined') window.Snowman = Snowman;`
block. Re-add the header, then re-run `npm run test:verify`. (`tests/README.md` carries
the same note.)

---

## 7. Avalanche

Implemented in [`src/avalanche.ts`](src/avalanche.ts) (`AvalancheSystem`), driven
from the main loop in [`src/snowglider.ts`](src/snowglider.ts).

### 7.1 Trigger

The trigger distance is **per difficulty tier** (D3.2d): once the player has descended
`avalanche.triggerDistance` units past the last trigger point
(`lastAvalancheZ - pos.z > triggerDistance`) and `avalanche.enabled`, `trigger(playerPos)`
fires. **Blue** (default) uses `80` — its shipped `BLUE_AVALANCHE`; **Black** arms sooner at
`60` (more slides over the run); **Bunny** is `enabled: false`, so the slide never arms. The
tier's `avalanche` block lives in [`src/difficulty.ts`](src/difficulty.ts) and is passed to
the `AvalancheSystem` by `scene-setup.ts`; `main-loop.ts` reads `avalanche.triggerDistance`.
`AVALANCHE_TRIGGER_DISTANCE`/`AVALANCHE_BOULDER_COUNT` are re-exported from `BLUE_AVALANCHE`
as the single source of truth for Blue.

### 7.2 Spawn (per-tier boulder count; 120 on Blue)

```
angle = (rand - 0.5) * π * 0.6         // arc behind the player
dist  = 25 + rand*15
pos   = playerPos + ( sin(angle)*dist , 8 + rand*6 , dist*cos(angle) )  // +z = uphill/behind
vel.z = -(slideSpeedBase + rand*slideSpeedJitter)   // toward player (downhill); Blue 7/3, Black 9/3
vel.x = (rand - 0.5) * 2
size  = 0.4 + rand*1.2
```

The boulder count and `slideSpeedBase`/`slideSpeedJitter` are the tier's `avalanche` block:
Blue is `120` boulders at `-(7 + rand*3)` m/s (today's exact slide); Black is `150` at
`-(9 + rand*3)` — faster and heavier against its faster physics. Because the speed is one
`Math.random()` call in the same position, Blue's spawn stream is byte-identical.

### 7.3 Per-frame physics

```
gravity = 18 ; friction = 0.98 ; bounce = 0.25
frictionFactor = friction ** (dt * 60)         // per-second decay (see note below)
vel.y -= gravity * dt ; pos += vel * dt
floorY = getTerrainHeight(pos.x, pos.z)        // requires setTerrainFunction()
if (pos.y < floorY + radius):                  // ground contact
    pos.y = floorY + radius
    vel.y *= -bounce
    vel.x *= frictionFactor ; vel.z *= frictionFactor
    vel.z -= 2 * dt                            // downhill slide acceleration
```

`setTerrainFunction(fn)` must be called before `update()` or boulders fall to
`y = 0` instead of following the slope.

**Frame-rate-independent friction.** Ground friction is a continuous per-second
decay, so — like the snowman's coast drag (§3.4, `dragFactor`) — it is raised to
`dt * 60` rather than applied once per frame. Applying the raw `0.98` each frame
made boulders decay ~4× less at the capped 10 FPS delta than at 60 FPS, so the
grounded-slide terminal speed `2·dt / (1 − friction)` scaled ~6× with frame time —
the avalanche reached farther and faster on slow devices, skewing burial (game-over)
fairness by frame rate. This is the same bug class as the snowman drag fix (PR #209).
`frictionFactor` is byte-identical at the 60 Hz baseline (`dt·60 == 1` exactly when
`dt == 1/60`, and `x ** 1 === x`), so existing avalanche tests are unchanged; only
off-60 Hz frames are corrected. Gated by
[`tests/verification/avalanche_framerate_harness.js`](tests/verification/avalanche_framerate_harness.js)
(`npm run test:stress`), which fails hard on the per-frame-friction regression.

### 7.4 Queries (used by gameplay & UI)

| Method | Purpose | Metric |
|--------|---------|--------|
| `checkBurial(playerPos, hitRadius=2)` | game over on contact | **3D** dist < `hitRadius + size` |
| `getClosestDistance(playerPos)` | drives the warning UI | **2D** (x,z) nearest boulder |
| `hasPassed(playerPos)` | "you survived" → reset | ≥ 80% of boulders at `z < playerZ - 10` |

### 7.5 Powder cloud (purely cosmetic — issue #49)

So an approaching slide reads as a rolling cloud of snow and not just a cluster of
spheres, the tumbling boulders trail a **billowing powder plume**. It is a pool of
`POWDER_COUNT = 260` additive-free (alpha-blended, `depthWrite: false`) sprites —
the same sprite approach as the ski snow-splash in `snow.ts`, not the boulders'
`InstancedMesh`, because each puff fades, expands and rotates independently.

- **Lifecycle.** Built once in the constructor (`_initPowder`), but **only when a
  `document` exists** — the headless Node avalanche tests construct the system with
  no DOM, so the pool stays empty and every powder call is a no-op there. Driven
  from inside `update(dt)` (so it only runs while the slide is `active`), cleared by
  `reset()` (`_hidePowder`), and freed by `dispose()`. Inactive puffs are kept
  `visible = false` so three skips them in the render traversal / transparent sort on
  the idle menu/gameplay path; emission flips a puff visible only while it is live.
- **Emission.** Each frame `_updatePowder` spawns ~3–7 puffs at random boulders,
  near each boulder's base, inheriting a fraction of its velocity plus an upward
  loft and lateral spread. Round-robin over the pool; emission stops early once all
  puffs are in use, so the cloud reaches a steady density rather than growing
  unbounded.
- **Per-puff motion.** Light gravity (`4.5`) and strong air drag (`1.4/s`) so it
  lofts then billows and settles; the sprite **expands** (up to ~3×) and fades over
  a `1.1–2.5 s` life (quick fade-in, then fade-out below 55% life remaining).
- **Determinism.** The powder is entirely cosmetic — it never reads or writes the
  snowman's `pos`/`velocity` or the boulder physics, so the physics-invariant
  harness and the burial/`getClosestDistance`/`hasPassed` contracts are unchanged.
  It honors the snow-effects convention (like falling snow / ski splash) of running
  regardless of `prefers-reduced-motion`, which gates only camera motion (§9).

---

## 8. Course timing & ghost

Implemented in [`src/course.ts`](src/course.ts). Physics-adjacent: it reads the
snowman's position but applies no forces (gates are decorative and never collide).

- Geometry: `START_Z = -15`, `FINISH_Z = -195`, checkpoints at `-60, -105, -150`,
  `COURSE_LENGTH = 180` (1 unit = 1 m).
- Trajectory recorded at `SAMPLE_INTERVAL = 0.05 s` (~20 Hz) and replayed as a
  translucent "ghost" via linear interpolation (`ghostPositionAt(t)`), with an
  AHEAD/BEHIND readout from `ghostTimeAtZ(z)` (time-at-depth).
- Medals are relative to the player's own best: new record (`< best`), silver
  (`≤ best*1.10`), bronze (`≤ best*1.25`), else finished. Best splits and the ghost
  persist to `localStorage` (`snowgliderBestSplits`, `snowgliderGhost`) and commit
  only on a personal best.

---

## 9. Camera "juice"

Implemented in [`src/effects.ts`](src/effects.ts); applied in the render step and
then reverted so the camera manager's smoothing never re-ingests its own shake.

- **Speed FOV.** `BASE_FOV = 75` widens toward `MAX_FOV = 88` as speed approaches
  `FOV_SPEED_REF = 28`, smoothed at `dt*3`.
- **Shake.** Transient impulses (`addShake`, capped 2.5, decay `dt*4`) plus a
  sustained avalanche-proximity shake `danger² * 0.6`, where
  `danger = clamp((WARN_FAR - dist)/(WARN_FAR - WARN_NEAR))`, `WARN_NEAR = 9`,
  `WARN_FAR = 70`.
- All of the above is disabled under `prefers-reduced-motion`.

---

## 10. Constants quick reference

| Constant | Value | Where |
|----------|-------|-------|
| Frame `delta` cap | 0.1 s | `snowglider.js` |
| Start position / velocity | `z=-15`, `vz=-3.0` | `snowman.js` |
| Ground gravity (slope pull) | 9.8 | `snowman.js` |
| Air gravity | 16 | `snowman.js` |
| Base / max coast friction | 0.012 / 0.032 | `snowman.js` |
| Turn force (parallel/snowplow/carve) | 19 / 24 / 10 (×0.85 over 18 u/s) | `snowman.js` |
| Accel (tuck) | 10 | `snowman.js` |
| Brake decel (light → full wedge) | 3.14 → 5.68 (lerp by `plowCharge`) | `snowman.js` |
| Plow build / release rate | 1.6 / 4.0 per s | `snowman.js` |
| Max skid scrub (uncommitted) | 0.10 + 0.008 tax | `snowman.js` |
| Carve scrub relief | 0.92 | `snowman.js` |
| Carve build / release rate | 1.5 / 3.0 per s | `snowman.js` |
| Carve lock threshold | `carveCharge > 0.6` | `snowman.js` |
| Carve body-lean clamp | 0.42 rad (~24°) | `snowman.js` |
| Hop turn pivot / speed-keep / pop / cooldown | 0.4 rad / 0.82 / 5.0 / 0.45 s | `snowman.js` |
| Manual / auto jump impulse | `10 + v*0.5` / `6 + v*0.3` | `snowman.js` |
| Landing scrub | `min(0.5, airTime*0.15)` | `snowman.js` |
| Jump landing grade (CLEAN / OK align) | `> 0.85` / `> 0.55` | `snowman/physics.ts` |
| Landing impact bands (soft / harsh / wipeout, JP-4) | `vImpact` 24 / 30 / 34 m/s | `snowman/physics.ts` |
| Wipeout flip residual / harsh scrub factor (JP-4) | 120° / ×1.5 | `snowman/physics.ts` |
| Clean-landing boost (per s / cap) | `airTime*0.04` / `0.06` | `snowman/physics.ts` |
| Air score (per s / clean bonus) | `airTime*100` / `+50` | `snowman/physics.ts` |
| Obstacle clear score / cap per air (JP-2) | 75 / 3 | `snowman/physics.ts` |
| Avalanche dodge score / escape impulse (JP-3) | 250 / ×1.10 (once per slide) | `game/main-loop.ts` |
| Lip launch (JP-6): K / min / max / sample dist | 1.0 / 4 / 16 m/s / 2 u | `snowman/physics.ts` |
| Combo chain (JP-7): step factor / cap | ×1.25 / ×3 | `game/combo.ts` |
| Expert kickers (JP-6) | 3 × `{length 7, halfWidth 7, height 3.0}` (u² ramp) | `difficulty.ts` `features` |
| Freestyle spin / flip rate (Expert, #32) | 360 / 300 deg/s | `snowman/physics.ts` |
| Freestyle score (per 180° spin / 360° flip / grab s) | 40 / 120 / 60 | `snowman/physics.ts` |
| Freestyle landing tolerance (spin / flip residual) | 60° / 75° | `snowman/physics.ts` |
| Freestyle grab min hold / under-rotation penalty | 0.25 s / ×0.5 + SKETCHY | `snowman/physics.ts` |
| Max tilt | 0.25 rad (~14°) | `snowman.js` |
| Tree collision radius | 2.5 | `snowman.js` |
| Rock hazard min size / radius clamp | 1.25 / `1.25 .. 3.0` | `mountains.ts`, `snowman.ts` |
| Rock hazard clear-zone (path half-width / start radius) | `|x|>=5` / `10` from `(0,-15)` | `mountains.ts` |
| Off-mountain / fall bounds | `|x|>120` / `terrain−0.5` | `snowman.js` |
| Downhill terrain bias | `(z+30)*0.12` for `z<-30` | `mountains.js` |
| Avalanche trigger distance (per tier) | Blue 80 / Black 60 / Bunny off | `difficulty.ts` |
| Avalanche count / initial speed (per tier) | Blue 120 / `-(7+r*3)` · Black 150 / `-(9+r*3)` | `difficulty.ts` |
| Avalanche gravity / bounce / friction | 18 / 0.25 / 0.98 | `avalanche.js` |
| Course length / checkpoints | 180 / `-60,-105,-150` | `course.js` |
| FOV range / ref speed | 75–88 / 28 | `effects.js` |
| Wind base / gust range / prevailing angle / gust rate | 2.4 / 4.8 / 0.35 rad / 0.7 rad/s | `wind.js` |

---

## 11. Wind (cosmetic)

Implemented in [`src/wind.ts`](src/wind.ts) (`Wind`), advanced once per render frame from
the main loop. **Wind is cosmetic — it never touches `pos`/`velocity`.** It exists so the
snowfall, the scarf, the trees, and the audio bed all read *one* agreed-upon wind instead
of each faking its own (issue #253).

- **The field.** A single global horizontal vector `W(t)`: a prevailing direction that
  wanders slowly around `prevailingAngle`, times a magnitude `base + gustRange·gust(t)`.
  `gust(t) ∈ [0,1]` is a deterministic layered sum of sines (three octaves whose
  amplitudes sum to 1). Defaults in the constants table above (magnitude ≈ 2.4–7.2).
- **Deterministic.** `W` is a pure function of an internal clock (`Wind.update(dt)`
  advances it; `Wind.reset()` rewinds to `t = 0` each run) — **no `Math.random()` / no
  `Date.now()`** — so screenshots are reproducible and, if a wind *force* is ever added to
  the player, the invariant harness can inject a fixed wind. `configure({...})` swaps the
  profile (e.g. a calmer vs. gustier difficulty tier).
- **Consumers.** Snow drift (`snow.ts`: flakes blow downwind scaled by a per-flake
  `windFactor` — lighter flakes further — and the ski splash is advected by `SPLASH_WIND`).
  Scarf streaming (`snowman-flex.ts`: the scarf tail trails the **apparent** wind
  `(wind − velocity)` resolved into the snowman's local frame — sideways in a crosswind,
  lifted fore/aft in a head/tail wind — plus a light brace-into-the-wind body lean; the
  main loop computes the local-frame apparent wind and passes it in as `windSway`/
  `windStream`, both defaulting to 0 so the no-wind pose is byte-identical).
  Tree sway (`mountains/trees.ts`: the instanced forest leans downwind via a GPU vertex
  sway — an `onBeforeCompile` injection on the instanced tree materials, driven by a shared
  uniform set the main loop refreshes once per frame from `Wind.dir()`/`strength()`. The
  trunk material is "rooted" so the bend is planted at the base while the canopy above it
  sways as a unit; a spatial phase from each vertex's world x/z desyncs neighbouring trees.
  The amplitude band (`TREE_SWAY_MIN_AMP`..`TREE_SWAY_MAX_AMP` = 0.06..0.9 world units at
  full canopy weight) and the 0.6-static / 0.4-oscillating split are tuned so a gust visibly
  whips the ~8-14u trees (~5° treetop swing) and a lull relaxes them — the first cut capped
  at 0.35u (~1.5°), imperceptible at chase distance. No position/collision change, so it is
  invariant-safe; the load-carrying families draw a per-forest geometry clone for their
  per-instance attributes — see snow load below — while the trunk still draws the shared
  pooled geometry).
  Audio bed (`sfx.ts`: the procedural ambient wind noise adds `Wind.strength() ×
  WIND_FIELD_GAIN` on top of its speed-scaled whoosh via the pure `windGainForField`, so a
  gusty slope hisses at a standstill and swells with gusts; the main loop passes
  `Wind.strength()` into `Sfx.updateSkiing`. Keyed on `strength` (not the raw gust, which
  stays non-zero in a calm profile) so a dead-calm field reduces exactly to the old
  speed-only gain). The audio bed reads the field even under `prefers-reduced-motion` — it
  is the one consumer that stays audible when *visible* motion is damped (the reduced-motion
  gate lives in each visual consumer, not in `Wind` itself).
- **Wind "howl" (audio, `sfx.ts`).** A second, distinct wind sound: a narrow high-Q
  bandpass "whistle" layered on the ambient bed, driven each frame by
  `Sfx.updateWindHowl(Wind.strength(), Wind.gust())` (called from the render loop after
  `Wind.update()`). Its gain comes from `howlGainForWind(strength)` — silent below a knee so
  a light breeze does not whistle, then swelling as the wind builds — and its pitch from
  `howlFreqForGust(gust)`, sweeping up on a gust and back in the lull so the tone wavers.
  Keyed on `strength`, which is 0 in a dead-calm field, so the howl is exactly silent with
  no wind (a windless run is unchanged). Reads the field only — no `pos`/`velocity` — so it
  is invariant-safe like the visual consumers.
- **Snow load & shedding (Phase B, cosmetic).** Every placed tree carries a CURRENT snow
  load (0..1) in a registry inside `mountains/trees.ts`, exposed as two live-updatable
  per-instance attributes: `aSnowLoad` (absolute — a laden part sways at
  `1 − TREE_LOAD_DAMP·load` of the free amplitude and bows `TREE_LOAD_DROOP·load` world
  units, matched in the shadow-depth materials) and `aSnowRatio` (current/base — the snow
  caps/shelves scale toward `TREE_SNOW_SHRINK_MIN` as the load sheds). Base loads reuse
  **existing** randomness only: the stylized path threads `collectTree`'s pre-existing
  per-tree `snowLoad` draw (the seeded placement `Math.random()` sequence the harnesses
  baseline is untouched — the new geometry clones mint their uuids under the same private
  RNG swap as the depth materials), and the EZ path derives load from the placement hash
  that already sizes its shelves. `src/tree-shed.ts` makes the load DYNAMIC: a gust front
  (rising edge of `Wind.gust()`, cooldown-limited) picks the most laden trees within a
  radius of the player, dumps them fast (`keep` fraction survives; puff sprites burst off
  the crown, document-guarded like the avalanche powder), then re-ladens them slowly.
  `TreeShed.update()` returns the frame's shed events; the main loop voices each via
  `Sfx.treeShed(distance)` (a soft low "whump", `shedGainForDistance`), and feeds
  `Sfx.updateForest(strength, gust, proximity)` — a bright needle-rustle noise bed gated on
  wind × `forestProximityAt(treePositions, x, z)`, so an open bowl at any wind and a calm
  glade are both exactly silent. Ground snow collars sit outside every tree's attribute
  ranges (load 0 / ratio 1), so they never droop, shrink, or shed. Reduced motion keeps the
  whole shed system inert (static base loads); `TreeShed.reset()` re-ladens the forest on
  every run reset so the deterministic gust cycle replays identically.
- **Why this is invariant-safe.** Because no consumer writes `pos`/`velocity`, the
  no-input coasting path stays byte-identical to the frozen baseline (§6) — adding wind
  needed **no** baseline regeneration. A wind *force* on the skier would be the opposite: a
  deliberate §6 physics change requiring a baseline regen + a new harness gate, which is
  why it is deferred to a separate, opt-in (tier-gated) follow-up.
