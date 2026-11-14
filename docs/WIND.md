# Wind, snow and sound

SnowGlider uses one deterministic horizontal airflow for its existing trees,
falling snow, snowman scarf, terrain powder and procedural sound. This improves
the sense of exposure and speed while keeping the skier's controls, collision
geometry and ranked trajectories unchanged. Gameplay wind forces remain the
separate, deliberately versioned follow-up in [#253](https://github.com/den-run-ai/snowglider/issues/253).

## Shared field and frame order

`windFieldAt(time, config)` is a pure layered gust field. It uses no DOM, Three.js,
wall clock or global random stream. The default vector has magnitude 2.4–7.2 world
units/second and a slowly wandering cross-slope direction. `strength` is magnitude
divided by the fixed `WIND_REFERENCE_SPEED = 7.2`, clamped to 0–1. It is not divided
by each profile's own maximum: that incorrectly made a 0.1-unit steady breeze as
strong as a gale. A zero gust range now reports zero gust. All tuning fields are
finite and bounded before reaching shaders, particle integration or audio.

The render loop advances `Wind` once, before scarf/snow/tree observers. The same
sample drives every consumer; continuous audio updates after camera framing.
Reset rewinds the field, tree sway, loads and scenery. Hidden-tab handling pauses
the owning render loop. Wind stays outside the fixed-step gameplay solver.

## Trees and shading

The instanced forest keeps its existing EZ-Tree archetypes, placement, LOD and
static collision arrays. Slow whole-tree bending and restrained needle flutter
remain separate. Roots stay planted, motion uses normalized height and each tree
has one phase derived from its root. This preserves the fix for the
[#394 crumpled-pine regression](https://github.com/den-run-ai/snowglider/pull/394).

Deformation now changes the shared vertex position before Three.js projects it
or computes world-space shadow coordinates. An analytic deformation Jacobian
rotates lighting normals and tangents; the same displacement also runs in custom
depth materials. Lighting, received shadows and cast silhouettes therefore follow
the bent tree. The existing cool snow/warm sunlight palette and color pipeline are
preserved. Geometry colors need no compensating brightness increase.

EZ branches and needles read the same snow load. Separately instanced snow shelves
carry their host root's phase, so snow follows its branch instead of drifting to
a different oscillation. Load shedding still changes only visual attributes and
pooled powder, never colliders. Instancing, conservative wind bounds and shared
materials remain in place; no new material families are required.

## Snow, geometry and camera views

Falling flakes relax toward the air velocity with exponential drag. Both velocity
and displacement are integrated analytically for the current wind sample. Smaller
flakes follow air more closely than larger clumps. Flutter is a small bounded
offset, replacing the old oscillating velocity that could overwhelm the shared
wind. This preserves motion across 30/60/144 Hz and makes gust direction legible.

The existing shared billboard batch projects fall/drift into the active camera
plane and stretches crystals by at most 40%. Follow, Orbit, first-person and Drone
views therefore see the correct direction without camera-specific physics or
shared-material rotation. Frustum bounds include that stretch. Normal blending,
depth testing and the cool-white palette preserve snow readability against sky,
terrain and dark trees. Reduced motion removes flutter, lateral drift and streaks.

Clouds and spindrift now integrate the actual vector rather than a hard-coded
direction. Small overlapping tapered powder ribbons follow the terrain tangent,
fade at recycling boundaries and disappear in calm air. Their positions accumulate
wind displacement, so a direction change cannot rewrite past motion or teleport
them. They reuse the existing instanced unlit/fog material family without textures
or a new weather/physics subsystem.

The snowman's scarf uses apparent airflow `(wind - skier velocity)` in its local
frame, with exact exponential relaxation. Its brace and cloth pose stay bounded.
The camera continues following the established trajectory; wind adds no shake or
orbit motion that could obscure the route.

## Sound

The production Web Audio graph distinguishes three wind cues:

| Layer | Driver | Presentation |
|---|---|---|
| Air rushing past the skier | Magnitude of `wind - velocity` | More rush/brightness into a headwind; quieter in a following wind; subtle stereo width |
| Environmental gust | Shared wind strength and gust envelope | Broad low-band turbulence instead of a narrow repeating whistle; sound arrives from upwind |
| Forest rustle | Wind multiplied by nearby tree density | Needle hiss around the skier; silent in calm air or an open bowl |

Environmental pan projects incoming wind onto the camera's right vector, limited
to ±0.45. Skier rush is limited to ±0.16. Camera rotation changes the audible side
without moving the wind in world space. Gain, filter and pan targets ease over
220 ms; older browsers without `StereoPannerNode` retain the mono path.

A six-second private seeded noise buffer replaces the shared two-second global
random buffer. Different bed offsets decorrelate the layers without more buffers.
No new audio files or music dependencies ship. Start/replay gestures still own
context activation, one mute control owns all sound, and disposal stops and
disconnects loops and releases the buffer. A muted running graph tracks current
conditions so unmuting cannot restore a stale gust.

## Verification and scope

Headless suites cover absolute strength, malformed inputs, frame-rate agreement,
calm/reduced-motion behavior, projected snow geometry, root/load correspondence,
camera-relative audio, private RNG, lifecycle and disposal. Real WebGL captures
must opt into `?eztrees=1`, verify attached EZ branch meshes and exercise visible
and depth shader variants. Before/after artifacts use the same world and camera;
they are rendering fixtures, not a claim that an autonomous skier finished a run.

An offline audio preview renders the actual SFX graph through calm, gust, headwind,
tailwind, forest, camera turn and mute segments, with peak/RMS/stereo checks. It
contains no music or microphone input. Browser emulation and offline audio cannot
establish physical iPhone/Android loudspeaker quality, silent-switch behavior,
interruptions or sustained thermal performance; [#249](https://github.com/den-run-ai/snowglider/issues/249)
retains that acceptance work.

## Design references

- [GPU Gems 3: vegetation animation and shading](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis): per-instance world wind, main bending and leaf detail.
- [Three.js Object3D](https://threejs.org/docs/pages/Object3D.html): matching custom depth deformation for correct shadows.
- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html): shared geometry/materials and explicit bounds.
- [Three.js color management](https://threejs.org/manual/en/color-management.html): linear lighting and correctly tagged color/data textures; a global color migration remains separately reviewed.
- [EZ-Tree](https://github.com/dgreenheck/ez-tree): retain the existing procedural asset/instancing integration.
- [Web Audio target smoothing](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/setTargetAtTime), [stereo panning](https://developer.mozilla.org/en-US/docs/Web/API/StereoPannerNode), and [offline rendering](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext).
- [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/) and [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/): adding a second rigid-body solver solely for cosmetic wind would duplicate SnowGlider's existing fixed-step solver; retain its physics/version contracts.
