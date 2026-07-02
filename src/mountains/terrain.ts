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
// Type-only: the corridor is built from a CourseLine the caller (scene-setup) passes
// in, so terrain.ts gains no runtime dependency on the course-line / difficulty graph
// and stays the pure physics seam.
import type { CourseLine } from '../course-line.js';

/** A 2D vector in the terrain x/z plane: a gradient or a unit downhill direction. */
export interface TerrainVec2 {
  x: number;
  z: number;
}

// Global height map for efficient lookup - will be populated when terrain is created
export const heightMap: Record<string, number> = {};

// --- Difficulty corridor (D3.2b: "the line is the difficulty") --------------------
//
// A tier can bank the terrain into a winding skiable channel that follows the descent
// centerline (course-line.ts). The channel FLOOR is byte-identical to today's terrain
// — the corridor only RAISES the flanks off the line into walls, so running straight
// when the line turns climbs a steepening slope (and the same walls funnel avalanche
// boulders down the channel). Within `channelHalfWidth` of the line the wall term is a
// flat 0 (height AND gradient unchanged), so the on-line skiing feel is exactly today's.
//
// Straight tiers (Bunny/Blue) never set a corridor, so `corridorWallHeight` returns 0
// and getTerrainHeight is untouched — the byte-identical guardrail.

/** Per-tier corridor shape (the `terrain` block of a difficulty config). */
export interface TerrainCorridorParams {
  /** Half-width of the flat skiable channel floor; the wall term is 0 within this. */
  channelHalfWidth: number;
  /** Lateral distance over which the flank ramps from the floor up to `wallHeight`. */
  wallRamp: number;
  /** Height the off-line flanks rise to — how hard the corridor funnels you back. */
  wallHeight: number;
}

/** The active corridor: a centerline to follow + the wall shape around it. */
export interface TerrainCorridor {
  line: CourseLine;
  params: TerrainCorridorParams;
}

let activeCorridor: TerrainCorridor | null = null;

// --- Designed air: kickers on the course line (jump-system completion JP-6) -------
//
// A tier can ship sculpted kickers/tabletops sitting ON its descent centerline: a
// ramp that rises smoothly (smootherstep — no gradient kink on the approach) to a
// lip and then DROPS — the drop is what the kernel's auto-jump reads as a terrain
// lip, and with `tuning.lipLaunch` the takeoff velocity derives from the ramp
// geometry the player actually rode off. Same guardrail pattern as the corridor:
// tiers without `features` never set kickers, the term is skipped entirely, and the
// terrain is byte-identical.

/** One sculpted kicker on the course line (the `features` block of a difficulty
 *  config). Skiing runs in −z: the approach enters at `z + length` (uphill) and the
 *  LIP sits at `z`; past the lip the added height drops to 0 (the tabletop face). */
export interface KickerSpec {
  z: number;          // lip position along the run (skiing −z reaches it last)
  length: number;     // along-run length of the rising approach ramp
  halfWidth: number;  // lateral half-extent (tapers smoothly to 0 at the edges)
  height: number;     // lip height above the base terrain
}

/** An active kicker with its lateral center resolved from the course line ONCE at
 *  set time (`laneX(z)` at the lip), so the sampler never re-walks the line. */
interface ActiveKicker {
  spec: KickerSpec;
  xc: number;
}

let activeKickers: ActiveKicker[] | null = null;

/**
 * Set (or clear) the run's kickers. Mirrors setTerrainCorridor: resets the heightMap
 * cache (its key has no tier dimension) and must be called BEFORE createTerrain so
 * the mesh vertices bake the same ramps — scene-setup.ts does, once per scene.
 * `line` resolves each kicker's lateral center (null/absent ⇒ centered at x = 0).
 */
export function setTerrainKickers(
  kickers: KickerSpec[] | null,
  line?: { laneX(z: number): number } | null
): void {
  activeKickers = kickers && kickers.length
    ? kickers.map((spec) => ({ spec, xc: line ? line.laneX(spec.z) : 0 }))
    : null;
  resetHeightMap();
}

/** Whether kickers are active (lets the mesh builder skip the add entirely). */
export function hasActiveKickers(): boolean {
  return activeKickers !== null;
}

/**
 * Extra terrain height from the kickers at (x, z): the ONE ramp formula — both
 * getTerrainHeight and the mesh builder add it, so the two-formula terrain contract
 * (§2.2) holds. 0 with no kickers, outside a kicker's footprint, and past the lip
 * (the drop face the auto-jump launches off).
 */
export function kickerRampHeight(x: number, z: number): number {
  if (!activeKickers) return 0;
  let add = 0;
  for (const { spec, xc } of activeKickers) {
    if (z < spec.z || z > spec.z + spec.length) continue; // past the lip / before the ramp
    const lat = 1 - Math.abs(x - xc) / spec.halfWidth;
    if (lat <= 0) continue;
    const u = (spec.z + spec.length - z) / spec.length;   // 0 at entry → 1 at the lip
    add += spec.height * smootherstep01(u) * smootherstep01(lat);
  }
  return add;
}

/**
 * Set (or clear) the terrain corridor for the run. ALWAYS resets the heightMap cache:
 * its key is `${x},${z}` with no tier dimension, so a stale entry from a different
 * corridor would otherwise be served as the wrong height. Call this BEFORE createTerrain
 * (so the mesh vertices bake in the same walls) — scene-setup.ts does, once per scene.
 */
export function setTerrainCorridor(corridor: TerrainCorridor | null): void {
  activeCorridor = corridor;
  resetHeightMap();
}

/** Empty the shared heightMap cache in place (it is an imported singleton, not reassigned). */
export function resetHeightMap(): void {
  for (const key in heightMap) delete heightMap[key];
}

/** Whether a corridor is active. Lets the mesh builder skip the wall add entirely for
 *  straight tiers (so the Blue mesh takes the literal original code path). */
export function hasActiveCorridor(): boolean {
  return activeCorridor !== null;
}

/** Smootherstep clamped to [0,1] (zero 1st AND 2nd derivative at the ends → no kink). */
function smootherstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Extra terrain height from the corridor walls at (x, z): 0 on the line (and anywhere
 * within `channelHalfWidth` of it), ramping up to `wallHeight` off the line. This is the
 * ONE wall formula — both getTerrainHeight and the mesh builder (terrain-mesh.ts) add it,
 * so the two-formula terrain contract holds. Returns 0 when no corridor is set.
 */
export function corridorWallHeight(x: number, z: number): number {
  const c = activeCorridor;
  if (!c) return 0;
  const dx = Math.abs(x - c.line.laneX(z));
  const t = (dx - c.params.channelHalfWidth) / c.params.wallRamp;
  return c.params.wallHeight * smootherstep01(t);
}

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

  // Bank the winding corridor (Black). Gated so straight tiers (no corridor) take the
  // literal original path — the byte-identical guardrail. Added as the LAST term, the
  // same way + same formula as the mesh builder, so the two stay in lockstep.
  if (activeCorridor) {
    y += corridorWallHeight(x, z);
  }

  // Sculpted kickers (JP-6). Same guardrail: tiers without `features` never set
  // kickers and take the literal original path; the mesh adds the same formula.
  if (activeKickers) {
    y += kickerRampHeight(x, z);
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
