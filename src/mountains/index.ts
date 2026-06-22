// mountains/index.ts - Terrain and mountain features for snowglider
//
// Stage R-mountains (issue #34): `src/mountains.ts` is now a thin ROOT FACADE
// (`export * from './mountains/index.js'`) and the implementation lives here, so
// every existing importer keeps resolving the sibling `./mountains.js` specifier.
// This hub is being carved into focused submodules (noise / terrain / snow-surface
// / terrain-mesh / rocks) the same way `src/snowman/*` was split; the terrain math
// stays byte-identical at every step (the terrain/regression suites + the physics
// invariant harness pin it).
//
// Phase 2.7 (issue #84): converted off the classic global model. `THREE` and the
// `Trees` module now come from real ES-module imports, and `Mountains` is
// `export`ed. mountains.js and trees.js import each other (the cross-references
// run only at call time, so the circular import resolves cleanly). The terrain
// samplers (`getTerrainHeight`/`getTerrainGradient`/`getDownhillDirection`) are
// reached via the `Mountains` import or as injected parameters — the old window
// bridges are gone.
//
// Phase 3.6 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file), the `SimplexNoise` fields and the terrain
// sampler/geometry helper signatures are now real type declarations, and the
// JSDoc `/** @type {Float32Array} */` buffer casts are now `as` casts. The terrain
// math is byte-identical — every edit is type-only/erasable, so esbuild (Vite) and
// Node's native type-stripping both run it exactly as before, preserving terrain
// height consistency (the seam camera/trees/snow/physics all depend on).
// The `./trees.js` specifier stays `.js` (Vite/tsc resolve it to `trees.ts`; the
// Node terrain/regression tests use the `.js`->`.ts` resolve hook added in PR 3.3).
import * as THREE from 'three';
import { Trees, type TreePosition } from '../trees.js';
import {
  SimplexNoise,
  terrainRidgeField,
  forestDensityField,
} from './noise.js';
import {
  type TerrainVec2,
  heightMap,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  debugHeightMap,
} from './terrain.js';
import {
  createSnowAlbedoTexture,
  createSnowNormalTexture,
  applySnowVertexColors,
  applySmoothShadingNormals,
} from './snow-surface.js';
import {
  type RockPosition,
  ROCK_COLLISION_MIN_SIZE,
  rockCollisionRadius,
  rockIsCollisionHazard,
  createRock,
  addRocks,
} from './rocks.js';

// Re-export the rock position type so the public `./mountains.js` surface keeps it
// (src/game/scene-setup.ts imports `RockPosition` from '../mountains.js').
export type { RockPosition };

// Re-export the deterministic noise fields and the terrain sampler type so the
// public `./mountains.js` named exports (`terrainRidgeField`, `forestDensityField`,
// `TerrainVec2`) and the terrain tests that import `terrainRidgeField` directly keep
// resolving them through this hub.
export { terrainRidgeField, forestDensityField };
export type { TerrainVec2 };

// --- Terrain creation functions ---

// Create Terrain (Natural Mountain)
function createTerrain(scene: THREE.Scene) {
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

// Export all mountain-related functions and classes
export const Mountains = {
  SimplexNoise,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  terrainRidgeField,
  forestDensityField,
  createTerrain,
  createRock,
  addRocks,
  ROCK_COLLISION_MIN_SIZE,
  rockCollisionRadius,
  rockIsCollisionHazard,
  debugHeightMap,
  heightMap // Expose the heightmap for debugging
};

// All window.* bridges from mountains.js are gone (issue #84). Consumers get the
// terrain samplers via imports (camera.js, trees.js, snow.js import Mountains) or
// as injected parameters (snowman.js, course.js receive them from snowglider.js).
