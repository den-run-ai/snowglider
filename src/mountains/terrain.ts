// mountains/terrain.ts - Analytic terrain height field (the physics seam).
//
// Pure math, no THREE/DOM: getTerrainHeight/getTerrainGradient/getDownhillDirection
// plus the shared `heightMap` cache they read/write. This is the contract the
// physics rides — `getTerrainHeight` must stay byte-identical to the mesh-vertex
// formula in terrain-mesh.ts (the "two-formula terrain contract"), and the physics
// invariant harness + terrain/regression suites pin it.
//
// `heightMap` is an ES-module singleton: terrain-mesh.ts imports THIS object and
// pre-populates it while building the mesh, and getTerrainHeight reads/fills it as a
// per-(x,z) cache. Keep it a single shared instance — splitting it would desync the
// cache from the mesh.
import { terrainRidgeField } from './noise.js';

/** A 2D vector in the terrain x/z plane: a gradient or a unit downhill direction. */
export interface TerrainVec2 {
  x: number;
  z: number;
}

// Global height map for efficient lookup - will be populated when terrain is created
export const heightMap: Record<string, number> = {};

// Calculate terrain height at (x, z)
export function getTerrainHeight(x: number, z: number): number {
  // First check if we have this position in our cached height map
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  if (heightMap[key] !== undefined) {
    return heightMap[key];
  }

  const distance = Math.sqrt(x * x + z * z);

  // Use EXACTLY the same formula as in terrain mesh creation
  // Base mountain shape
  let y = 40 * Math.exp(-distance / 40);

  // Add noise for natural backcountry terrain
  y += 1.5 * Math.sin(x * 0.05) * Math.cos(z * 0.05) * (1 - Math.exp(-distance / 60));

  // Add additional terrain features and ridges (aperiodic — see terrainRidgeField).
  // Damped toward the peak (like the low-freq term + mesh perlin) so the summit stays
  // smooth and the relief grows down the slope where it reads as backcountry terrain.
  y += terrainRidgeField(x, z) * 0.8 * (1 - Math.exp(-distance / 60));

  // Ensure downhill gradient in extended sections - create a consistent downhill slope
  // This factor increases the further (more negative) z gets, creating a gradual slope
  // Use a stronger gradient (0.12) to ensure consistent downhill even with terrain noise
  if (z < -30) {
    y += (z + 30) * 0.12; // This creates a consistent downhill gradient
  }

  // Store in height map for future lookups
  heightMap[key] = y;
  return y;
}

// Calculate terrain gradient for physics and tree placement
export function getTerrainGradient(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  return { x: (hX - h) / eps, z: (hZ - h) / eps };
}

// Compute Downhill Direction (Approximate Gradient)
export function getDownhillDirection(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  const gradient = { x: (hX - h) / eps, z: (hZ - h) / eps };
  // Downhill is opposite to the gradient
  const dir = { x: -gradient.x, z: -gradient.z };
  const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  return len ? { x: dir.x / len, z: dir.z / len } : { x: 0, z: 1 };
}

// Debug utility to verify the height map is working
export function debugHeightMap(x: number, z: number): number {
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  console.log(`Height Map Debug at (${x}, ${z}):`);
  console.log(`- Height Map Entry: ${heightMap[key]}`);
  console.log(`- Calculated Height: ${getTerrainHeight(x, z)}`);
  return heightMap[key]!;
}
