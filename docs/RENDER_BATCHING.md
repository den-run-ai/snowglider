# Spatial render batches

The interactive forest uses 80-unit world x/z cells. Each geometry/material family
retains its shared material and static vertex/index buffers; a cell owns its instance
matrices, tints and snow-load attributes. Both the normal camera and shadow cameras
can reject whole cells with Three.js's standard frustum culling. There is no per-frame
rebucketing or change to the static near/far EZ detail split.

The placement builders still run in their original order before the render-only
split. Extra Three.js UUID construction uses `withPrivateThreeRandom`, so collision
positions, downstream random draws, tree scale/rotation/colour and snow loads stay
unchanged. Tree-load ranges are remapped into each cell, including a tree whose parts
cross a cell boundary. Classic trees, EZ trees, failed-load fallback and late upgrades
use the same split.

Bounds include full-size geometry and snow's shrink origin. A 1.2-unit expansion on
each axis covers the current shader's maximum 1.008-unit lean, 0.144-unit crosswind
flutter and 0.6-unit load droop. If `TREE_SWAY_PROJECT_VERTEX` changes these limits,
update `TREE_CHUNK_MOTION_PADDING` and the motion-envelope regression test together.
Every chunk stays at the identity model transform: the shader's instance phase and
world-space wind direction therefore remain unchanged.

Chunk geometries are lightweight wrappers around shared static attributes rather
than full archetype copies. Static BufferAttribute identities are unique per forest
family, while immutable CPU arrays remain shared with the pools. This matters because
Three.js deletes every attribute's GPU buffer when a geometry is disposed; it does
not reference-count shared attributes or invalidate surviving sibling VAOs. Each
family therefore defers geometry disposal until all its chunks release ownership,
then dispatches disposal on every wrapper (including any that rendered before the
last, possibly never-rendered chunk). Rebuilding one scene cannot delete a different
scene's buffers. Instance buffers are independently released by InstancedMesh.dispose;
global pool teardown releases cached archetypes/materials.

Validation lives in `tests/forest-chunks-tests.js` (matrix/colour/load pairing, cold
seeded collider/RNG snapshot, motion bounds, real Three.js frustum rejection, shedding
and disposal), plus the classic, EZ fallback/upgrade and tree-shed integration suites.
The browser tree-count check sums all trunk/branch chunks. Renderer budgets remain the
authority for the tradeoff: chunking adds draw calls in exchange for rejecting
invisible geometry, so changes to cell size must be measured with real EZ trees and
shadow rendering enabled.

Chromium CI for PR #444 measured classic warm-frame peaks of 186 draw calls,
219,898 triangles and 212 resident geometries (retry: 207 / 222,480 / 228), and EZ
peaks of 230 / 382,868 / 265. Before rock batching, the geometry ceilings are 230
classic and 280 EZ. These counts include chunk wrappers; they do not measure
unique vertex/index buffers or GPU bytes. Draw, triangle, texture and program
ceilings remain unchanged. The 12-frame sample runs in one browser evaluation so
runner round-trip delays cannot introduce arbitrary extra simulation frames.

Static rocks use 40-unit cells grouped by their shared material. The builder first
computes every original rock's collider top and contact-shadow position, then bakes
its placed geometry into cell-relative coordinates and merges that cell. UVs, vertex
colours and lighting normals are preserved; the original per-rock geometries and
intermediate clones are released. A lone rock can keep its original mesh. The merged
mesh carries `userData.isRock`, `rockCount` and `rockChunk`, so cleanup, gallery hiding
and rendered-rock accounting work for both representations. Batches have finite
geometry bounds and use ordinary camera/shadow frustum culling.

`addRocks(..., { batching: false })` retains the original mesh representation as an
equivalence-test seam. `tests/rock-batches-tests.js` compares world-space vertices,
normals, colours and UVs, verifies independent distant-cell rejection, and proves
byte-identical collider tops, contact-shadow inputs and downstream RNG on every tier.
Its seeded scene goes from 147 to 50 draws for Bunny/Blue, 176 to 62 for Black, and 174
to 58 for Expert before camera/shadow culling. Actual frame-level renderer metrics
must still be measured because a merged cell can submit some off-screen rocks.

With both batches enabled, Chromium CI for PR #445 measured classic peaks of
135 draw calls / 221,026 triangles / 141 geometries and EZ peaks of
179 / 384,010 / 193. Geometry ceilings therefore return to 185 classic / 210 EZ;
the temporary forest-only 230 / 280 caps are no longer needed. Both variants
retained 17 textures and 26 classic / 43 EZ programs. Chromium and WebKit teardown
returned the measured 141 geometries to zero.
