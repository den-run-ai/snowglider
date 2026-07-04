# Snow Rendering & Lighting Guide

This is the design rationale for how SnowGlider lights and shades snow. It is the
reference the snow/lighting PRs (issues #17, #18, and the #2 sky work) converged on,
and the contract any later atmospheric layer — notably the #163 sun cycle — must
preserve. For the module wiring see [`ARCHITECTURE.md`](ARCHITECTURE.md); for the
simulation model see [`PHYSICS.md`](PHYSICS.md). The lighting lives in
[`src/game/scene-setup.ts`](../src/game/scene-setup.ts), the sky/fog in
[`src/sky.ts`](../src/sky.ts), and the snow material/normals in
[`src/mountains.ts`](../src/mountains.ts).

## Core visual principle

Snow form should come from **warm sun, cool skylight, and occluded concavities** —
not from grey paint or broad intensity changes.

![Snow lighting model: a warm directional key light lights the slope, cool blue
skylight fills the shadows, and ambient occlusion darkens concavities. The bottom
row contrasts flat-white whiteout, muddy grey shading, and the target warm-plus-cool
snow form.](snow-lighting-model.svg)

- **Sunlit snow** is warm and near-white.
- **Shaded snow** is cool blue, not grey.
- **Troughs, lee sides, and track grooves** get their form from
  ambient-occlusion / concavity, not from a grey vertex tint.
- **Distant snow** fades cool and hazy, so far-field banding is less visible.

## Failure modes to avoid

| Failure | Cause | Fix |
|---|---|---|
| **Whiteout** | Too much flat/soft light or ambient — terrain form disappears | Keep ambient low; let the hemisphere fill shade *by orientation*, not a uniform wash |
| **Grey corduroy** | Hard low sun raking periodic terrain ridges into repeated grey bands | Soften the key light, smooth the *shading* normals, and remove the periodic ridge as a banding source (the ridge is now aperiodic — see below) |
| **Muddy snow** | Neutral grey shadows instead of cool blue ones | Shadows are filled by a cool-blue hemisphere sky color, never neutral grey |
| **Striped snow** | Directional drift bands turned up until they read as painted stripes | The sastrugi wind-drift streaks (`sastrugiDriftAmount`, `mountains/snow-surface.ts`) are hard-capped at a **0.10 lerp toward `SNOW_SHADE`** — a tint, never dirt — and gated off forest stands and steep pitches. Raise the cap and powder stops reading bright; add directionality to the *albedo texture* instead and it tiles into visible banding (that's why the mottle is isotropic and the directional cue lives in the per-vertex pass) |

The "grey lines" that survived the snow *texture* fix (#17) were terrain **shadows**,
not a texture: every mogul lit on one side and greyed on the other, made periodic by
the regular `sin(x * 0.2) * cos(z * 0.3)` terrain ridge. They were first addressed by
(a) smoothing the *shading* normals while leaving the skiable height field untouched,
and (b) the light rebalance below.

The banding *source* itself — that periodic ridge — has now been removed (issue #188
step 3): `mountains.ts` replaces `sin(x * 0.2) * cos(z * 0.3)` with a **deterministic
domain-warped fBm** (`terrainRidgeField`), so the ridges meander instead of forming a
regular lattice and a low sun has no periodicity left to rake into corduroy. The field
is fixed-seed (an integer hash, not the `Math.random`-seeded SimplexNoise) so terrain
is stable across loads and the Node terrain/regression tests pin its shape, and it is
damped toward the peak like the existing perlin layer (smooth summit, relief growing
down-slope). This is what let the sun cycle's low-sun guard drop from 14° to **8°**
(NS2, completion-plan PR-V2 — the guard change + golden-hour retune shipped, with a
fresh `test:sky` capture).

The remaining cost of the lower sun is **shadow quality, not banding**: the ±60 ortho
shadow frustum's ground footprint stretches by ~1/sin(elevation) along the sun axis —
≈4.1× at 14°, ≈**7.2× at 8°** — so effective shadow-texel density on the slope drops
exactly when shadows are longest. `game/sun-shadow.ts` compensates the shadow
**normal bias** on an elevation-aware curve (`shadowNormalBiasForElevation`:
`SHADOW_NORMAL_BIAS × clamp(sin(elevMidday)/sin(elev), 1, 3)`), driven per-frame from
the live sun elevation. **This is a stability compensation only** — it mitigates
acne / peter-panning; it does **not** restore texel density. If low-sun blockiness
ever fails the visual gate, the density lever is fitting the ortho box
anisotropically along the sun's ground-projected axis, *not* raising the bias or the
2048² map size. If 8° still artefacts on low-end mobile GPUs, fall back to 10° and
note the residual here rather than growing the map.

## The merged static lighting (source of truth: `scene-setup.ts`)

Intensities are pre-multiplied by `Math.PI` to preserve the original r134 brightness
under three.js physically-correct lighting (see the renderer note in
`scene-setup.ts`). The snow-readability rebalance (#17 follow-up) dialed the hard sun
*down* and the orientation-aware fill *up*, so deep powder reads low-contrast — bright
almost everywhere with soft shading — the way real snow does under an open sky.

| Element | Merged value | Role |
|---|---|---|
| `AmbientLight` | `0xffffff` at `0.26 * Math.PI` | Low floor so nothing goes pure black |
| `HemisphereLight` | sky `0xdcebfb` / ground `0xbcc7d4` at `0.62 * Math.PI` | Cool-blue skylight fill that shades **by orientation** — the source of cool shadow color and snow form |
| `DirectionalLight` | `0xffffff` at `0.5 * Math.PI`, position `(50, 100, 50)` | The warm-ish key light; casts the shadows |
| Sky (`src/sky.ts`) | Preetham atmospheric sky, `exposure 0.45` | Bright azure sky + visible sun aligned to the directional light |
| Fog / distance | horizon-tinted `Fog`, near `140` / far `750` | Distant snow fades cool and hazy |

The design-intent palette these values serve (near-white `#EDF0F6` base albedo, warm
`#FFF6E6` sunlit snow, cool `#B6C9E6` shaded snow, `#93A9CC` occluded pockets) is the
target the snow material and tints aim at; the code in `mountains.ts` /
`scene-setup.ts` is the authoritative value.

## Contact shadows follow the player (#18)

A grounding shadow is the strongest "this object is on the snow" cue on an all-white
slope. Every shadow-caster was already configured (`castShadow` on the snowman,
trees, rocks, boulders, gates; `receiveShadow` on the terrain), but the directional
(sun) light's shadow **camera** was left at three.js's default ±5-unit orthographic
box centred on the world origin. The snowman spawns at `z = -15` — already outside
that box — and skis far downhill, so it cast **no** contact shadow for essentially
the whole run while the 2048² shadow map was spent on a patch nobody skis through.

`src/game/sun-shadow.ts` fixes this in two pure pieces:

- **`configureSunShadow(light, renderer)`** (called once in `scene-setup.ts`) widens
  the frustum to `±SHADOW_HALF_EXTENT` (60) around the player, sets near/far to
  bracket the sun distance, raises the map to 2048², enables `PCFSoftShadowMap`, and
  applies `bias`/`normalBias` to kill acne and peter-panning on the low-relief snow.
- **`aimSunLight(light, sunDir, distance, x, y, z)`** (called each frame in
  `main-loop.ts`, on the **interpolated render position**, before `renderer.render`)
  moves the light *and* its target so the frustum tracks the snowman:
  `position = player + sunDir·distance`, `target = player`. The light→target vector
  stays exactly `sunDir·distance`, so the shadow **direction** is unchanged — only the
  frustum slides over to the player.

The sun **direction** still comes from the sun cycle. Because the follow offsets the
light's world position every frame, the cycle's direction is read via
`Sky.getSunDirection()` / `Sky.getSunDistance()` (from the live Preetham `sunPosition`
uniform + the captured midday distance), **not** from the light's position. This is a
pure rendering change: it never touches `pos`/`velocity` or the physics height field,
so the no-input invariant is unaffected, and it adds no new per-frame shadow cost (the
sun cycle already re-rendered the shadow map every frame).

## Cavity / ambient-occlusion shading (#17)

The "Core visual principle" above asks for troughs and lee sides to get their form
from **occluded concavity**, not a grey tint. The shipped slope tint
(`applySnowVertexColors`) only keyed off slope *magnitude* (normal tilt), so it
darkened steep faces but left concave hollows — the rolls and gullies between moguls —
as flat white, exactly where snow self-shadows. `applySnowVertexColors` now also bakes a
**cavity/AO term** when handed the terrain grid (`cols`/`rows`):

- For each vertex it compares the height to its 4 grid neighbours' mean. A vertex that
  sits *below* the local mean is concave (a hollow) and takes a subtle darken + cool
  blue-shift toward an occluded-pocket tint; convex peaks go negative and stay bright.
- The term is a little stronger on steeper ground, gated by the **shared** `SLOPE_STEEP`
  boundary from `src/slope-tiers.ts` — the same constant the HUD's difficulty mark uses,
  so the on-snow shading and the on-screen tier never drift.
- It reads vertex *heights* but never writes them, so the physics height field and the
  authoritative terrain geometry are untouched (same render-only contract as the slope
  tint and smoothed shading normals). It is build-time and deterministic — zero per-frame
  cost. Covered by `tests/snow-surface-tests.js` (`npm run test:snow-surface`).

## Obstacle contact shadows (#17)

Trees and rocks sat ON the bright snow with no grounding cue, so on an all-white slope
a tree could read as floating / pasted-on. The slope tint and lighting shade the terrain
itself, but nothing darkened the snow right where an obstacle meets it.
`mountains/contact-shadows.ts` adds a soft baked **contact shadow** (ambient-occlusion
blob) under each tree and large rock:

- One `InstancedMesh` of a single shared horizontal quad + one shared radial-alpha
  texture — so the whole forest's grounding cue is **one extra draw call, one geometry,
  one texture** (the same perf discipline as the instanced forest; it stays well inside
  the `perf-budget.spec.ts` ceilings). The blobs never cast or receive shadows — they ARE
  the (fake) shadow — so they add no shadow-pass cost.
- It reuses the tree/rock positions the placement code already computed (no duplicated
  placement logic) and only READS the terrain height to sit each blob on the surface;
  it never touches the height field or any physics path. Headless-safe (the radial
  texture is `document`-guarded). Covered by `tests/contact-shadows-tests.js`
  (`npm run test:contact-shadows`).

This complements, rather than duplicates, the player-following directional shadow: the
contact blob is a tight AO darkening right at the base, independent of sun direction.
## Persistent snow-depth field (#246, visual-only v1)

The transient ski grooves in `src/snowtracks.ts` are *temporary feedback, not
accumulation* (their own header says so) — they fade in a few seconds and the slope
forgets you. The persistent snow-depth field is the larger follow-up that gives the
mountain memory. It is landing as a **staged PR stack** so the risky renderer work is
isolated:

| PR | Scope | Status |
|---|---|---|
| **PR 1** | `src/mountains/snow-depth.ts` — the pure `SnowDepthField` grid logic + Node tests. **No renderer integration.** | ✅ landed |
| **PR 2** | Drive the field's `compactAt` from the grounded ski-track cadence (`SnowDepthField.update`, wired in `game/scene-setup.ts` / `game/main-loop.ts` / `game/lifecycle.ts` / `game/teardown.ts`); no visible change, transient trails stay, field carries no GPU texture yet. | ✅ landed |
| **PR 3** | One `DataTexture` sampled by the terrain material (`applySnowDepthModulation` → `onBeforeCompile`): packed → darker/icier (`vec3(0.86,0.90,0.98)` tint + roughness `0.58`), powder → brighter/softer. No displacement, no geometry / height-map mutation; full-powder start renders identically. | this stack |
| PR 4 | Perf: capped resolution, dirty-only upload (`texture.addUpdateRange`), near-player window, mobile scaling; verify against `tests/e2e/perf-budget.spec.ts`. | follow-up |
| PR 5 | Integrate / supersede the transient `SnowTrails` overlay once the texture path is visually proven. | follow-up |

**The field logic (`SnowDepthField`).** A bounded 2D grid (`Float32Array depth`, one cell
per ~2 world units over the terrain footprint) storing snow depth in `[0..1]` — `1` is
undisturbed powder, `0` is fully packed / skied-out.

- `compactAt(x, z, radius?, strength?)` — a ski pass removes depth in cells near `(x,z)`,
  most at the centre and tapering to `0` at the rim (clamped `>= 0`).
- `refill(dt)` — fresh snow settles: every packed cell recovers toward `1` at a constant
  `refillRate` per second (a linear recovery, not a proportional lerp; clamped `<= 1`).
- `update(dt, player, isInAir, speed)` — the main-loop driver: refill, then, while grounded
  and moving, lay compaction stamps along the travelled path — one every `stampSpacing`
  world units of distance (matching `SnowTrails`), so the packed line is continuous and
  frame-rate independent — then `flush()` the change to the texture.
- `sample(x, z)` / `reset()` / `dispose()` (frees the DataTexture as of PR 3).

**The GPU seam (PR 3).** `flush()` mirrors changed cells into a single-channel
`THREE.DataTexture` (guarded by a private random stream so its UUID draw can't perturb the
seeded placement RNG). `applySnowDepthModulation(terrainMaterial, field)` samples it in the
terrain material's `onBeforeCompile` — the mesh sits at the origin with its rotation baked
into the geometry, so vertex `position.xz` indexes the field directly — and scales
`diffuseColor` (toward a cool icy grey-blue) and `roughnessFactor` (down, for a sharper
icy glint) by how packed each texel is. It moves **no vertex**, so the two-formula terrain
height contract is untouched, and a stable `customProgramCacheKey` keeps the modulated
terrain program distinct. Live shader compile + per-frame program/texture budget are
verified by `tests/e2e/perf-budget.spec.ts` (the terrain program adds exactly one; standard
peak 25, EZ peak 42).

**Hard guardrail — "persistent visual snow memory, zero physics meaning."** v1 carries
**no** physics: the field never reads or writes `pos`/`velocity`, the authoritative
`heightMap`, terrain vertex positions, friction, grip, or scoring. The physics-invariant
harness (`npm run test:verify`) therefore stays byte-identical. The logic is
dependency-free (no THREE / DOM), so it consumes zero `Math.random` (stream-neutral by
construction) and is exhaustively Node-tested (`npm run test:snow-depth`): compaction
lowers depth, refill raises it, values stay bounded in `[0..1]`, and a fixed input
sequence is deterministic.

## Ownership boundaries

Keeping each layer in its lane is what prevents the whiteout / grey / muddy
regressions from creeping back when one piece is retuned:

| Layer | Owns | Must not own |
|---|---|---|
| Static snow-lighting (`scene-setup.ts`, `mountains.ts`) | albedo, normal-map de-striping, smoothed render normals, static light balance, near-white slope tint | sun-cycle animation |
| Terrain (`mountains.ts` height field) | the slope geometry; replacing the periodic ridge that bands under low sun | lighting rebalance |
| Cavity / AO readability (`mountains/snow-surface.ts`, #17) | per-vertex concavity darken + cool-shift baked into the slope tint; the capped sastrugi wind-drift streaks (aligned with the shared `wind.ts` prevailing direction) | terrain physics changes / height field |
| Snow palette (`mountains/snow-palette.ts`) | the ONE set of shared snow colour/roughness constants (`SNOW_WHITE` caps/shelves, `SNOW_SHADE`, `CAVITY_COLOR`, surface/cap roughness) consumed by the terrain surface, rock caps, tree caps/shelves, and the snowman body | any behaviour — it is constants only, so it can be imported from anywhere (including headless tests) without cycles |
| Obstacle contact shadows (`mountains/contact-shadows.ts`, #17) | baked AO blobs under trees/rocks (one InstancedMesh) | casting real shadows / physics |
| Tree snow load + shedding (`mountains/trees.ts` registry, `src/tree-shed.ts`, #253) | per-tree load attributes (foliage droop/damping, snow-shelf scale), gust-shed puffs, slow re-laden | terrain snow depth, collision positions, physics |
| Persistent snow-depth field (`mountains/snow-depth.ts`, #246) | the `[0..1]` per-cell snow-depth grid + its compaction/refill math (later: a DataTexture the terrain material samples for packed-vs-powder albedo/roughness) | pos/velocity, `heightMap`, terrain vertices, friction, grip, scoring — **visual memory only, zero physics meaning** |
| Sun cycle (`src/sky.ts`, #163) | directional sun position/color/intensity, Preetham `sunPosition`/`exposure`, bounded fog/background tint | snow albedo, vertex tint, smoothed normals, terrain, **hemisphere fill** |

## The sun cycle is an atmospheric layer, not a readability fix

When the #163 sunrise ↔ midday cycle lands, it animates **on top of** this settled
static look. It captures the merged static lighting as its midday snapshot and lerps
toward warmer, dimmer golden-hour values and back — it does **not** rebalance snow
readability. Specifically the cycle must:

- preserve the warm-sun / cool-shadow relationship described above;
- leave the `HemisphereLight` (the cool-shadow source) completely untouched;
- keep `AmbientLight` static — never animate it toward the old `0.5 * Math.PI`
  whiteout value;
- reproduce the captured static snapshot **exactly** at midday and when frozen
  (reduced-motion / disabled).

See the `#163 implementation contract` in issue #188 for the full set of invariants
and the `test:sky` coverage that enforces them.

### Fog ↔ horizon coupling + warm midday key (completion-plan PR-V3)

Two colour-truth fixes on top of the cycle:

- **Fog is the sky.** The distance fog / background is no longer a hand-tuned constant
  (`ATMOSPHERE_FOG_COLOR`) lerping to a warm golden constant. It is now the Preetham
  dome's *own* colour at the **view-forward horizon** (−z, y≈0 — the run heads downhill,
  so the player mostly faces the anti-solar horizon), evaluated per cycle phase by a
  pure port of the dome fragment math (`src/sky-preetham-eval.ts`,
  `evalPreethamColor`). Terrain therefore fades into exactly the colour the sky paints
  where they meet, at every phase — killing the golden-hour seam where warm terrain fog
  used to meet the cool anti-solar sky band. The midday fog endpoint is still *captured*
  (from the eval), not hardcoded, so the frozen/reduced-motion state reproduces it
  exactly. `sky-preetham-eval.ts` and the dome `SKY_SHADER` share the same scattering
  constants and must stay in lockstep.
- **Warm midday key.** The palette core is *warm sun, cool skylight* (sunlit snow
  `#FFF6E6`), but the directional key was pure white `0xffffff` — with near-white snow
  albedo, sunlit warmth can only come from the light. The midday key is now
  `#FFF4E6` (slightly desaturated). Peak white on flats is unaffected: the
  hemisphere+ambient fill already saturates an up-facing white surface to `(255,255,255)`,
  so the warm key only tints midtones/shadowed pitches — the warm-sun / cool-shadow
  relationship now holds at *every* phase, not only golden hour. The cool fill
  (hemisphere/ambient) is untouched. `test:sky-preetham` pins the fog↔eval identity, the
  anti-solar-cooler-than-solar seam guard, and the peak-white-within-2/255 bound; the
  re-pinned `test:sky` midday `dirColor` records the warm key.
