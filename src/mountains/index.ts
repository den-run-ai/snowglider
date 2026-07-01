// mountains/index.ts - Assembly hub for the Mountains module.
//
// Stage R-mountains (issue #34): `src/mountains.ts` is a thin ROOT FACADE
// (`export * from './mountains/index.js'`); this hub wires the focused submodules
// into the `Mountains` object and re-exports the named/type surface so every
// existing importer keeps resolving the sibling `./mountains.js` specifier. The
// implementation lives in:
//   - noise.ts        SimplexNoise + the deterministic fBm ridge/forest fields
//   - terrain.ts      analytic height field + shared heightMap (the physics seam)
//   - snow-surface.ts snow albedo/normal CanvasTextures + vertex-colour passes
//   - terrain-mesh.ts createTerrain (rasterizes the height field, scatters rocks/trees)
//   - rocks.ts        rock meshes/colours/placement + the collision-hazard subset
//
// The terrain math is byte-identical to the pre-split module — the terrain math
// formula in terrain-mesh.ts MUST match getTerrainHeight in terrain.ts (the
// "two-formula terrain contract"); the terrain/regression suites and the physics
// invariant harness pin it. The old per-module `window.*` bridges are gone (#84):
// consumers read the terrain samplers via the `Mountains` import (camera.js,
// trees.js, snow.js) or as injected parameters (snowman.js, course.js).
import {
  SimplexNoise,
  terrainRidgeField,
  forestDensityField,
} from './noise.js';
import {
  type TerrainVec2,
  type TerrainCorridorParams,
  type TerrainCorridor,
  heightMap,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  debugHeightMap,
  setTerrainCorridor,
} from './terrain.js';
import { createTerrain } from './terrain-mesh.js';
import {
  type RockPosition,
  ROCK_COLLISION_MIN_SIZE,
  rockCollisionRadius,
  rockIsCollisionHazard,
  createRock,
  addRocks,
} from './rocks.js';

// Re-export the named samplers/helpers and the contract types so the public
// `./mountains.js` surface is unchanged: terrain-tests.js imports terrainRidgeField
// directly, and scene-setup.ts imports the RockPosition type from '../mountains.js'.
// rockCollisionRadius was a named export of the pre-split mountains.ts too — keep it
// on the facade so `import { rockCollisionRadius } from './mountains.js'` still works.
export { terrainRidgeField, forestDensityField, rockCollisionRadius, ROCK_COLLISION_MIN_SIZE };
export { setTerrainCorridor };
export type { TerrainVec2, TerrainCorridorParams, TerrainCorridor, RockPosition };

// Export all mountain-related functions and classes
export const Mountains = {
  SimplexNoise,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  terrainRidgeField,
  forestDensityField,
  createTerrain,
  setTerrainCorridor,
  createRock,
  addRocks,
  ROCK_COLLISION_MIN_SIZE,
  rockCollisionRadius,
  rockIsCollisionHazard,
  debugHeightMap,
  heightMap // Expose the heightmap for debugging
};
