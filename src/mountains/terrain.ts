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

/** The active kickers + the course line their lateral centers follow. The line is
 *  kept (not baked at set time) because it is evaluated PER SAMPLE z: over a 7 u
 *  approach the winding Expert line can drift almost a full halfWidth (Codex on
 *  #292 — laneX(-150) ≈ 3.2 vs laneX(-143) ≈ 11.0), so a lip-frozen center would
 *  park much of the ramp on the corridor shoulder and off the skier's actual line.
 *  laneX-per-sample is exactly what corridorWallHeight already does. */
interface ActiveKickers {
  specs: KickerSpec[];
  line: { laneX(z: number): number } | null;
}

let activeKickers: ActiveKickers | null = null;

/**
 * Set (or clear) the run's kickers. Mirrors setTerrainCorridor: resets the heightMap
 * cache (its key has no tier dimension) and must be called BEFORE createTerrain so
 * the mesh vertices bake the same ramps — scene-setup.ts does, once per scene.
 * `line` centers the ramp laterally at laneX(z) for every sample, so the kicker
 * follows the course line through its whole approach (null/absent ⇒ centered x = 0).
 */
export function setTerrainKickers(
  kickers: KickerSpec[] | null,
  line?: { laneX(z: number): number } | null
): void {
  activeKickers = kickers && kickers.length
    ? { specs: kickers, line: line ?? null }
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
 *
 * Along-run profile: QUADRATIC ease (u²) — flat at the entry (C1, no kink riding
 * on) and STEEPEST at the lip, which is how a real kicker is shaped and what the
 * lip-consistent launch (physics.ts, tuning.lipLaunch) derives its arc from. A
 * smoothstep-style profile would flatten at the lip and launch nothing on a steep
 * base slope. Lateral taper stays smootherstep (soft shoulders both sides).
 */
export function kickerRampHeight(x: number, z: number): number {
  if (!activeKickers) return 0;
  const { specs, line } = activeKickers;
  let add = 0;
  for (const spec of specs) {
    if (z < spec.z || z > spec.z + spec.length) continue; // past the lip / before the ramp
    // Lateral center follows the course line AT THIS z (not frozen at the lip), so
    // the whole approach sits under a line-following skier on a winding course.
    const xc = line ? line.laneX(z) : 0;
    const lat = 1 - Math.abs(x - xc) / spec.halfWidth;
    if (lat <= 0) continue;
    const u = (spec.z + spec.length - z) / spec.length;   // 0 at entry → 1 at the lip
    add += spec.height * u * u * smootherstep01(lat);
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
  resetGridCorners(); // the render-grid corner cache keys off the same surface recipe
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
  const y = getTerrainHeightUncached(x, z);
  // Store in height map for future lookups
  heightMap[key] = y;
  return y;
}

/**
 * The pure terrain-height evaluation behind getTerrainHeight — identical formula
 * (it IS getTerrainHeight's cache-miss path), but it neither reads nor writes the
 * shared heightMap. For RENDER-ONLY consumers that sample many ad-hoc coordinates
 * (the rock grounding collars/chips, #385 PR 4): getTerrainHeight memoizes every
 * query into 0.1-unit cells that later tree placement and live physics read, so a
 * cosmetic layer sampling through the cached path would change what those
 * downstream callers see (Codex review on #390). Gameplay/physics callers should
 * keep using getTerrainHeight — the cache is their shared source of truth.
 */
/** The pure ANALYTIC height field: the function the render grid is built from.
 *  Everything else — physics, collision, placement — reads the TRIANGLE-
 *  INTERPOLATED form below (getTerrainHeightUncached), which samples this only
 *  at render-grid corners, so the simulated surface IS the rendered surface
 *  even across discontinuities like the kicker lip (#403 review: the analytic
 *  lip drop diverged from the 2-unit mesh interpolation by up to ~3 units).
 *  Exported for the parity tests. */
export function analyticTerrainHeight(x: number, z: number): number {
  const distance = Math.sqrt(x * x + z * z);

  // THE height formula (#401): the mesh builder rasterizes this per vertex,
  // and the interpolated sampler below reads the same grid — one source of
  // truth for the mountain, rendered, simulated, and placed against.
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

  return y;
}

// --- Render-grid sampling (#403 review): physics samples the rendered triangles.
// The terrain mesh is a PlaneGeometry(300, 400, 150, 200) rotated -90° about X:
// vertices at x = -150 + 2i (i in 0..150) and z = -200 + 2j (j in 0..200), each
// 2x2 cell split into the triangles (a,b,d) and (b,c,d) with a=(i,j), b=(i,j+1),
// c=(i+1,j+1), d=(i+1,j) — i.e. the diagonal from (x0, z0+2) to (x0+2, z0).
// getTerrainHeightUncached evaluates the SAME piecewise-linear surface the GPU
// rasterizes, so rendered and simulated heights agree everywhere — including
// off-vertex points across the kicker-lip discontinuity, where the analytic
// formula and the interpolated mesh used to diverge by up to ~3 units.
const GRID_X0 = -150, GRID_Z0 = -200, GRID_STEP = 2;
const GRID_NX = 151, GRID_NZ = 201; // vertices per axis
// Lazy corner cache for analytic evaluations at grid vertices (NaN = unfilled).
// Cleared whenever the surface recipe changes (resetHeightMap: corridor/kickers).
let gridCorner = new Float64Array(GRID_NX * GRID_NZ).fill(NaN);

function cornerHeight(i: number, j: number): number {
  const idx = i + j * GRID_NX;
  let h = gridCorner[idx]!;
  if (Number.isNaN(h)) {
    h = analyticTerrainHeight(GRID_X0 + i * GRID_STEP, GRID_Z0 + j * GRID_STEP);
    gridCorner[idx] = h;
  }
  return h;
}

/** Reset the lazy render-grid corner cache (called with the heightMap reset). */
function resetGridCorners(): void {
  gridCorner = new Float64Array(GRID_NX * GRID_NZ).fill(NaN);
}

export function getTerrainHeightUncached(x: number, z: number): number {
  // Off the rendered grid (nothing is rasterized there; gameplay is bounded at
  // |x| <= 120 and z in [-195, ...]) fall back to the analytic field.
  if (x <= GRID_X0 || x >= GRID_X0 + (GRID_NX - 1) * GRID_STEP ||
      z <= GRID_Z0 || z >= GRID_Z0 + (GRID_NZ - 1) * GRID_STEP) {
    return analyticTerrainHeight(x, z);
  }
  const fx = (x - GRID_X0) / GRID_STEP;
  const fz = (z - GRID_Z0) / GRID_STEP;
  const i = Math.min(GRID_NX - 2, Math.floor(fx));
  const j = Math.min(GRID_NZ - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const ha = cornerHeight(i, j);        // (x0,     z0)
  const hb = cornerHeight(i, j + 1);    // (x0,     z0 + 2)
  const hc = cornerHeight(i + 1, j + 1);// (x0 + 2, z0 + 2)
  const hd = cornerHeight(i + 1, j);    // (x0 + 2, z0)
  // Triangle (a,b,d) below the b->d diagonal (u + v <= 1), (b,c,d) above — the
  // exact PlaneGeometry split. Linear (barycentric) interpolation per triangle.
  if (u + v <= 1) {
    return ha + u * (hd - ha) + v * (hb - ha);
  }
  return hc + (1 - u) * (hb - hc) + (1 - v) * (hd - hc);
}

// Calculate terrain gradient for physics and tree placement
export function getTerrainGradient(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  return { x: (hX - h) / eps, z: (hZ - h) / eps };
}

/** Cache-neutral twin of getTerrainGradient (same eps/differencing) for render-only
 *  consumers — see getTerrainHeightUncached for why. */
export function getTerrainGradientUncached(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeightUncached(x, z);
  const hX = getTerrainHeightUncached(x + eps, z);
  const hZ = getTerrainHeightUncached(x, z + eps);
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
