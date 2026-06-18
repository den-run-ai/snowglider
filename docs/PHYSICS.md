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
[`src/mountains.js`](src/mountains.js).

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

Implemented in [`src/snowman.js`](src/snowman.js) `updateSnowman()`. Each frame,
grounded, the order is: detect landing → compute slope forces → apply ski
technique → friction → integrate → orient/tilt → collision & bounds.

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
baseFriction = 0.015
friction = baseFriction + 0.025 * speedFactor        // 0.015 .. 0.040
velocity *= (1 - (friction + skidScrub))             // skidScrub == 0 when coasting
```

### 3.3 Ski technique (the skill layer)

Layered on top of the arcade handling. **When the player gives no steering and no
brake input, `turnForce`/accel are unchanged and `skidScrub == 0`, so coasting is
identical to the pre-technique physics** — see §6.

| Technique | Trigger | Effect |
|-----------|---------|--------|
| **Carve** | Left/Right, smooth/slow | Holds speed; `turnForce = 16` |
| **Skid**  | Left/Right, hard at speed | Washes edges out, scrubs speed (`skidScrub`) |
| **Snowplow** | Down | Sheds real speed, but sharper, planted turns (`turnForce = 24`, grip = 1.0); skis form a wedge |
| **Tuck**  | Up, no steer | Least friction, most speed, least control (`accel = 10` on `-z`) |

Key terms:

```
terrainGrip = 0.6 + min(0.4, steepness * 0.5)        // more bite on pitches

turnForce   = 16.0
            = 24.0  if snowplow                       // planted wedge steers harder
            = 14.0  if currentSpeed > 18 (no snowplow)// hard to wrench skis at speed
left/right:  velocity.x ∓= turnForce * delta

skidScrub = 0  unless (steering && currentSpeed > 4):
    speedFactor2 = min(1, currentSpeed / 22)
    grip = snowplow ? 1.0 : terrainGrip
    skidScrub = 0.06 * speedFactor2 * (1 - grip*0.85) // ~0 .. 0.06, added to friction
```

`technique` is classified each frame (`carve` vs `skid` switches at
`skidScrub > 0.025`) and returned for the HUD and ski-wedge pose
(`wedge = 0.35 rad` lerped onto the ski meshes).

### 3.4 Snowplow brake (and why it is clamped)

Snowplow decelerates **along the actual direction of travel**, so it bleeds
genuine speed rather than only downhill velocity:

```
if (snowplow && currentSpeed > 0.001):
    brakeImpulse = min(14.0 * delta, currentSpeed)   // clamp: never reverse velocity
    velocity -= (velocity / currentSpeed) * brakeImpulse
    if (brakeImpulse < currentSpeed):                // only while still moving
        velocity.z += 10.0 * delta * 0.3             // slight uphill control bias
```

The `min(..., currentSpeed)` clamp and the `brakeImpulse < currentSpeed` guard are
load-bearing: without them, at low speed the subtraction overshoots zero and the
control bias drives the snowman **uphill from a standstill**, letting players stall
or climb the timed course by braking.

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
// Auto-jump over terrain lips / moguls:
if (!isInAir && heightDifference < -0.8 && currentSpeed > 12 && jumpCooldown <= 0):
    verticalVelocity = 6 + currentSpeed * 0.3 ; isInAir = true

// Manual jump (Space / touch):
if (jump && !isInAir && jumpCooldown <= 0):
    verticalVelocity = 10 + currentSpeed * 0.5 ; isInAir = true ; jumpCooldown = 0.5

// While airborne:
airTime += delta
verticalVelocity -= 16 * delta                 // stronger gravity than ground "pull"
pos.y += verticalVelocity * delta
left/right: velocity.x ∓= 5.0 * delta          // limited air control
velocity *= (1 - 0.01)                          // low air friction

// Landing (pos.y <= terrain):
landingImpact = min(0.5, airTime * 0.15)
velocity *= (1 - landingImpact)                 // bleed speed on impact
landingForce = airTime                          // fed to camera shake (EffectsModule)
jumpCooldown = 0.3
```

`landingForce` (seconds aloft) and `justLanded` are returned so the main loop can
trigger a proportional camera shake on touchdown.

---

## 5. Collisions, bounds & game over

### 5.1 Trees

2D (x,z) distance check against `treePositions`; default
`treeCollisionRadius = 2.5`. A collision ends the run **unless** the snowman is
genuinely clearing the tree: `isInAir && verticalVelocity > 0 && pos.y > treeY + 5`
allows jumping over. (Test modes widen the epsilon and add force-collision hooks —
see [`src/snowman.js`](src/snowman.js) `addTestHooks`.)

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
   exit code on it.
2. **Sources of randomness.** `Math.random()` appears in the idle auto-turn
   (§3.5), in terrain mesh noise/bumps, and in avalanche spawn/velocity. The
   verification harness injects a seeded RNG and a deterministic terrain so runs
   are reproducible. If you add randomness to the grounded path, keep it behind an
   input gate or the invariant harness will (correctly) fail.

Regenerate the baseline only on a **deliberate** physics change:
`git show <ref>:src/snowman.js > tests/verification/snowman_baseline.js`
(re-add the header), then re-run `npm run test:verify`.

---

## 7. Avalanche

Implemented in [`src/avalanche.js`](src/avalanche.js) (`AvalancheSystem`), driven
from the main loop in [`src/snowglider.js`](src/snowglider.js).

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

---

## 8. Course timing & ghost

Implemented in [`src/course.js`](src/course.js). Physics-adjacent: it reads the
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

Implemented in [`src/effects.js`](src/effects.js); applied in the render step and
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
| Base / max coast friction | 0.015 / 0.040 | `snowman.js` |
| Turn force (normal/snowplow/fast) | 16 / 24 / 14 | `snowman.js` |
| Accel (tuck) | 10 | `snowman.js` |
| Brake decel | 14 | `snowman.js` |
| Max skid scrub | 0.06 | `snowman.js` |
| Manual / auto jump impulse | `10 + v*0.5` / `6 + v*0.3` | `snowman.js` |
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
