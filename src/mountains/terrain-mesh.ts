// mountains/terrain-mesh.ts - Build the natural-mountain terrain mesh.
//
// THREE-heavy (browser-only): createTerrain rasterizes the analytic height field
// into a PlaneGeometry, pre-populates the shared heightMap singleton, applies the
// snow look, and scatters rocks + trees. Since #401 the mesh has NO formula of
// its own: every vertex samples getTerrainHeightUncached (terrain.ts), the same
// pure function physics/collision/placement read — the old duplicated
// "MUST MATCH" vertex formula had drifted materially and rendered a different
// mountain than the one the kernel simulated.
//
// trees.ts is now a sibling submodule (./trees.js) that reads the terrain samplers
// from the leaf modules directly, so there is no longer a mountains<->trees circular
// import — this is a plain one-way dependency (terrain-mesh -> trees -> terrain/noise).
import * as THREE from 'three';
import { Trees, type TreePosition } from './trees.js';
import { heightMap, getTerrainHeightUncached } from './terrain.js';
import {
  createSnowAlbedoTexture,
  createSnowNormalTexture,
  applySnowVertexColors,
  applySmoothShadingNormals,
} from './snow-surface.js';
import { addRocks, type RockPosition } from './rocks.js';
import { addContactShadows } from './contact-shadows.js';
import { SNOW_ROUGHNESS_SURFACE } from './snow-palette.js';
import { getTerrainHeight as sampleTerrainHeight } from './terrain.js';
import { withGameplayStream } from '../run-context.js';

// Create Terrain (Natural Mountain).
//
// The whole world build — addRocks and the ONE
// Trees.addTrees forest (#397) — runs inside the 'hazards' gameplay stream
// (#400): a pure no-op while unseeded (today's production and every harness
// that assigns `Math.random = makeRng(seed)` stay byte-identical), and a
// seed-deterministic world once setRunSeed is active — same seed => same
// obstacle field, without touching the ~120 legacy draw sites individually.
export function createTerrain(scene: THREE.Scene) {
  return withGameplayStream('hazards', () => createTerrainUnstreamed(scene));
}

function createTerrainUnstreamed(scene: THREE.Scene) {
  // Create a large natural mountain terrain
  const geometry = new THREE.PlaneGeometry(300, 400, 150, 200);
  geometry.rotateX(-Math.PI / 2);

  // Store the original terrain geometry for raycasting
  scene.userData = scene.userData || {};
  scene.userData.terrainGeometry = geometry;

  // BufferAttribute.array is typed ArrayLike<number> (read-only); the concrete
  // buffer is a writable Float32Array, which we mutate in place below.
  const vertices = geometry.attributes.position!.array as Float32Array;

  // ONE height field (#401): every mesh vertex samples getTerrainHeightUncached —
  // the SAME pure analytic function physics, collision grounding, and tree/rock
  // placement read. The old vertex loop kept a hand-copied variant behind "MUST
  // MATCH" comments and it had materially drifted (Simplex noise x2.0 + ridge x1.5
  // + per-vertex Math.random bumps vs the sampler's sin*cos x1.5 + ridge x0.8), so
  // the surface players SAW was not the surface the kernel and the headless
  // harnesses simulated — and the mesh differed run to run (unseeded Simplex +
  // random bumps). Sampling the one function ends the drift class: the corridor
  // and kicker terms ride along automatically (the sampler already gates them),
  // and the mesh is exactly as deterministic as the sampler.
  //
  // The shared heightMap cache is pre-populated with the SAME values the sampler's
  // cache-miss path would compute, so it is now a pure memoization (it can no
  // longer serve mesh-formula heights to physics that the analytic path would
  // disagree with).
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i]!, z = vertices[i + 2]!;
    const y = getTerrainHeightUncached(x, z);
    vertices[i + 1] = y;
    heightMap[`${Math.round(x * 10)},${Math.round(z * 10)}`] = y;
  }
  geometry.computeVertexNormals();
  // Smooth the *shading* normals (positions/physics untouched) so the directional
  // light stops raking every terrain bump into a grey band (PR #181 review). Must
  // run before applySnowVertexColors (which derives the slope tint from these
  // normals) and must NOT be followed by another computeVertexNormals (it would
  // overwrite them). PlaneGeometry(150,200 segments) => 151x201 grid vertices.
  applySmoothShadingNormals(geometry, 151, 201, 7);

  // Snow surface material (issue #17): a bright, isotropically mottled near-white
  // albedo plus a soft *isotropic* micro-relief normal map (powder granulation, no
  // directional ripples) so the slope reads as deep snow that catches the light,
  // instead of the old flat grey grid / diagonal striping. Slope shading (bright
  // snow -> faint cool powder shadow on pitches) is baked into the geometry's
  // vertex colours and multiplied in via `vertexColors`. A high roughness keeps it
  // matte like real powder; the gentle normalScale avoids harsh corrugation.
  const albedo = createSnowAlbedoTexture();
  const normalMap = createSnowNormalTexture();
  // Pass the 151x201 grid so the slope tint also bakes the cavity/AO term (hollows
  // read as shaded depressions, not flat white). Same grid as applySmoothShadingNormals.
  applySnowVertexColors(geometry, 151, 201);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: SNOW_ROUGHNESS_SURFACE,
    map: albedo,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.12, 0.12),
    vertexColors: true
  });

  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  terrain.name = 'terrain'; // Add a name for easy identification
  scene.add(terrain);

  // Store terrain mesh in scene userData and global window for precise object placement
  scene.userData.terrainMesh = terrain;
  if (typeof window !== 'undefined') {
    window.terrainMesh = terrain;
  }

  // NOTE: do not recompute vertex normals here — applySmoothShadingNormals() above
  // installed the smoothed snow-shading normals and a plain computeVertexNormals
  // would overwrite them with the raw faceted ones (reintroducing the grey banding).

  // Debug log to verify our height map is working
  console.log(`Height map contains ${Object.keys(heightMap).length} terrain points`);

  // Add rocks to make the mountain more realistic. The returned subset is the
  // collision source of truth for rocks large enough to read as hazards; `allRocks`
  // captures EVERY rendered rock so the contact shadows below ground decorative + safety-
  // filtered rocks too (Codex review #243), not just the collision subset.
  const allRocks: RockPosition[] = [];
  const rockPositions = addRocks(scene, allRocks);

  // Add trees to make the slope more visible using the separate Trees module
  let treePositions: TreePosition[] = [];
  if (Trees && typeof Trees.addTrees === 'function') {
    treePositions = Trees.addTrees(scene);
  } else {
    console.warn("Trees module not found, skipping tree creation");
  }

  // Baked contact-AO blobs under each tree + large rock (issue #17) so obstacles read
  // as grounded against the bright snow instead of floating. One InstancedMesh (one draw
  // call) — reuses the positions trees/rocks already produced; render-only, no physics.
  addContactShadows(scene, treePositions, allRocks, sampleTerrainHeight);

  return { terrain, treePositions, rockPositions };
}
