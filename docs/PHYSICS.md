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
  is the per-frame timestep, **capped at 0.1 s** in the animation loop so a stalled
  tab cannot teleport the snowman.
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
skis flatter and the body upright. The pose is purely cosmetic — it never touches the
physics. The always-on turn tax (faded out by a carve) keeps turning from ever being
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

```
// Auto-jump over terrain lips / moguls. Skipped while Jump is held so a deliberate
// jump input wins on a combined lip+jump frame (meaningful jumps #47, §3.1); the
// `!jump` term is a no-op on every no-input/coasting frame, so the baseline is
// unchanged. A terrain auto-jump is never player-initiated: playerJump := false.
if (!isInAir && !jump && heightDifference < -0.8 && currentSpeed > 12 && jumpCooldown <= 0):
    verticalVelocity = 6 + currentSpeed * 0.3 ; isInAir = true ; playerJump = false

// Manual jump (Space / touch) — straight pop when NOT steering. Marks this air
// phase player-initiated so the landing can grade it and award a boost (#47, §3.1).
if (jump && !isInAir && jumpCooldown <= 0 && steering == 0):
    verticalVelocity = 10 + currentSpeed * 0.5 ; isInAir = true ; jumpCooldown = 0.5
    playerJump = true

// Hop turn — Jump WHILE steering Left/Right (issue #48). A quick edge-set pivot:
// rotate the horizontal velocity toward the steer direction and scrub speed, with
// a small pop; land on a fresh edge committed to the new direction. Gated entirely
// behind jump+steer input, so it touches no coasting/plain-steer path.
if (jump && !isInAir && jumpCooldown <= 0 && steering != 0):
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
    if   alignment > 0.85: quality = CLEAN  ; velocity *= (1 + min(0.06, airTime*0.04))  // boost
    elif alignment > 0.55: quality = OK     ;                                            // neutral
    else:                  quality = SKETCHY; velocity *= (1 - landingImpact)            // scrub
    airScoreDelta = round(airTime*100 + (quality==CLEAN ? 50 : 0))
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

`AVALANCHE_TRIGGER_DISTANCE = 80`. Once the player has descended 80 units past the
last trigger point (`lastAvalancheZ - pos.z > 80`), `trigger(playerPos)` fires.

### 7.2 Spawn (120 instanced boulders)

```
angle = (rand - 0.5) * π * 0.6         // arc behind the player
dist  = 25 + rand*15
pos   = playerPos + ( sin(angle)*dist , 8 + rand*6 , dist*cos(angle) )  // +z = uphill/behind
vel.z = -(8 + rand*4)                   // toward player (downhill)
vel.x = (rand - 0.5) * 2
size  = 0.4 + rand*1.2
```

### 7.3 Per-frame physics

```
gravity = 18 ; friction = 0.98 ; bounce = 0.25
vel.y -= gravity * dt ; pos += vel * dt
floorY = getTerrainHeight(pos.x, pos.z)        // requires setTerrainFunction()
if (pos.y < floorY + radius):                  // ground contact
    pos.y = floorY + radius
    vel.y *= -bounce
    vel.x *= friction ; vel.z *= friction
    vel.z -= 2 * dt                            // downhill slide acceleration
```

`setTerrainFunction(fn)` must be called before `update()` or boulders fall to
`y = 0` instead of following the slope.

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
| Clean-landing boost (per s / cap) | `airTime*0.04` / `0.06` | `snowman/physics.ts` |
| Air score (per s / clean bonus) | `airTime*100` / `+50` | `snowman/physics.ts` |
| Max tilt | 0.25 rad (~14°) | `snowman.js` |
| Tree collision radius | 2.5 | `snowman.js` |
| Rock hazard min size / radius clamp | 1.25 / `1.25 .. 3.0` | `mountains.ts`, `snowman.ts` |
| Rock hazard clear-zone (path half-width / start radius) | `|x|>=5` / `10` from `(0,-15)` | `mountains.ts` |
| Off-mountain / fall bounds | `|x|>120` / `terrain−0.5` | `snowman.js` |
| Downhill terrain bias | `(z+30)*0.12` for `z<-30` | `mountains.js` |
| Avalanche trigger distance | 80 | `snowglider.js` |
| Avalanche count / gravity / bounce / friction | 120 / 18 / 0.25 / 0.98 | `avalanche.js` |
| Course length / checkpoints | 180 / `-60,-105,-150` | `course.js` |
| FOV range / ref speed | 75–88 / 28 | `effects.js` |
