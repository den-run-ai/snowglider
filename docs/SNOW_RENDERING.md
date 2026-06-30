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
down-slope). This is what lets the sun cycle's low-sun guard drop from 14° toward 8°
(the guard change + golden-hour retune is the separate NS2 follow-up).

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
## Ownership boundaries

Keeping each layer in its lane is what prevents the whiteout / grey / muddy
regressions from creeping back when one piece is retuned:

| Layer | Owns | Must not own |
|---|---|---|
| Static snow-lighting (`scene-setup.ts`, `mountains.ts`) | albedo, normal-map de-striping, smoothed render normals, static light balance, near-white slope tint | sun-cycle animation |
| Terrain (`mountains.ts` height field) | the slope geometry; replacing the periodic ridge that bands under low sun | lighting rebalance |
| Cavity / AO readability (`mountains/snow-surface.ts`, #17) | per-vertex concavity darken + cool-shift baked into the slope tint | terrain physics changes / height field |
| Obstacle contact shadows (`mountains/contact-shadows.ts`, #17) | baked AO blobs under trees/rocks (one InstancedMesh) | casting real shadows / physics |
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
