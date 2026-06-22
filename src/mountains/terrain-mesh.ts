// mountains/terrain-mesh.ts - Build the natural-mountain terrain mesh.
//
// THREE-heavy (browser-only): createTerrain rasterizes the analytic height field
// into a PlaneGeometry, pre-populates the shared heightMap singleton (so the
// per-vertex mesh height and getTerrainHeight agree — the "two-formula terrain
// contract"), applies the snow look, and scatters rocks + trees. The mesh-vertex
// formula here MUST stay byte-identical to getTerrainHeight in terrain.ts; the
// terrain/regression suites and the physics-invariant harness pin it.
//
// trees.ts imports Mountains from the facade, so the ../trees.js import here is part
// of the mountains<->trees cycle; it resolves cleanly because the cross-calls
// (Trees.addTrees here, Mountains.* in trees) only run at call time.
import * as THREE from 'three';
import { Trees, type TreePosition } from '../trees.js';
import { SimplexNoise, terrainRidgeField } from './noise.js';
import { heightMap } from './terrain.js';
import {
  createSnowAlbedoTexture,
  createSnowNormalTexture,
  applySnowVertexColors,
  applySmoothShadingNormals,
} from './snow-surface.js';
import { addRocks } from './rocks.js';

// Create Terrain (Natural Mountain)
export function createTerrain(scene: THREE.Scene) {
  // Create a large natural mountain terrain
  const geometry = new THREE.PlaneGeometry(300, 400, 150, 200);
  geometry.rotateX(-Math.PI / 2);

  // Store the original terrain geometry for raycasting
  scene.userData = scene.userData || {};
  scene.userData.terrainGeometry = geometry;

  // BufferAttribute.array is typed ArrayLike<number> (read-only); the concrete
  // buffer is a writable Float32Array, which we mutate in place below.
  const vertices = geometry.attributes.position.array as Float32Array;

  // Create Perlin noise for natural terrain variation
  const perlin = new SimplexNoise();

  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], z = vertices[i + 2];
    const distance = Math.sqrt(x * x + z * z);

    // Base mountain shape - MUST MATCH getTerrainHeight function exactly!
    let y = 40 * Math.exp(-distance / 40);

    // Add perlin noise for natural terrain roughness
    // Less noise near the peak, more at the sides
    const noiseScale = 0.05;
    const noiseStrength = 2.0 * (1 - Math.exp(-distance / 60));
    y += perlin.noise(x * noiseScale, z * noiseScale) * noiseStrength;

    // Store this vertex position in our heightmap for precise object placement
    const key = `${Math.round(x*10)},${Math.round(z*10)}`;
    heightMap[key] = y;

    // Add natural terrain features and ridges (aperiodic — see terrainRidgeField).
    // Damped toward the peak like the perlin roughness above (same distance falloff).
    y += terrainRidgeField(x, z) * 1.5 * (1 - Math.exp(-distance / 60));

    // Ensure downhill gradient in extended sections - create a consistent downhill slope
    // Must match getTerrainHeight implementation exactly!
    // Use a stronger gradient (0.12) to ensure consistent downhill even with terrain noise
    if (z < -30) {
      y += (z + 30) * 0.12;
    }

    // Add some random smaller bumps for natural backcountry terrain
    if (Math.random() > 0.6) {
      y += perlin.noise(x * 0.1 + 100, z * 0.1 + 100) * 2.0;
    }

    vertices[i + 1] = y;

    // IMPORTANT: Update the heightmap with the FINAL height after all modifications
    heightMap[`${Math.round(x*10)},${Math.round(z*10)}`] = y;
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
  applySnowVertexColors(geometry);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
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
  // collision source of truth for rocks large enough to read as hazards.
  const rockPositions = addRocks(scene);

  // Add trees to make the slope more visible using the separate Trees module
  let treePositions: TreePosition[] = [];
  if (Trees && typeof Trees.addTrees === 'function') {
    treePositions = Trees.addTrees(scene);
  } else {
    console.warn("Trees module not found, skipping tree creation");
  }

  return { terrain, treePositions, rockPositions };
}
