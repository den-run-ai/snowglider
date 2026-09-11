// Cosmetic-only camera seating against the same triangles used by the terrain mesh.
import {
  getTerrainHeightUncached, GRID_X0, GRID_Z0, GRID_STEP, GRID_NX, GRID_NZ,
} from './mountains/terrain.js';

interface CameraPoint { x: number; y: number; z: number; }
type HeightSampler = (x: number, z: number) => number;

export const CAMERA_TERRAIN_CLEARANCE = 5;
export const CAMERA_TERRAIN_MAX_CROSSINGS = 256;
const GRID_X1 = GRID_X0 + (GRID_NX - 1) * GRID_STEP;
const GRID_Z1 = GRID_Z0 + (GRID_NZ - 1) * GRID_STEP;
const EDGE_EPSILON = 1e-9;

/** First strictly positive crossing of regularly spaced parallel grid edges. */
function firstCrossing(start: number, delta: number, origin: number): number {
  if (delta === 0) return Infinity;
  const cell = (start - origin) / GRID_STEP;
  const next = delta > 0 ? Math.floor(cell) + 1 : Math.ceil(cell) - 1;
  return (origin + next * GRID_STEP - start) / delta;
}

function seatAboveTarget(position: CameraPoint, lookTarget: CameraPoint): false {
  position.x = lookTarget.x;
  position.y = lookTarget.y + CAMERA_TERRAIN_CLEARANCE;
  position.z = lookTarget.z;
  return false;
}

/**
 * Raise the seat just enough to keep the actual sight line above the rendered terrain.
 * The height field is linear between x, z, and x+z grid-edge crossings, so checking
 * those vertices is sufficient; fixed-distance ray samples can miss a narrow ridge.
 * Clearance tapers from zero at the look target to five units at the camera.
 *
 * Only camera vectors are mutated. No allocation, RNG, raycaster, scene traversal,
 * or temporal state: the same requested pose has the same correction at every Hz.
 * Abnormally long segments or invalid terrain samples fall back to a vertical view
 * above the valid look target, never to an unchecked partially searched segment.
 * Returns false when that bounded fallback was needed.
 * An invalid target/target height is rejected before mutation: without a valid
 * terrain anchor there is no verifiable seat, so it must not render as success.
 */
export function seatCameraAboveTerrain(
  position: CameraPoint,
  lookTarget: CameraPoint,
  sampleHeight: HeightSampler = getTerrainHeightUncached,
): boolean {
  if (!Number.isFinite(lookTarget.x) || !Number.isFinite(lookTarget.y) || !Number.isFinite(lookTarget.z)) {
    throw new RangeError('Camera terrain seating requires a finite look target');
  }
  // Exactly on the outer boundary the sampler switches to the analytic field;
  // use the rendered boundary edge instead (as for segment crossings below).
  const targetOnGrid = lookTarget.x >= GRID_X0 && lookTarget.x <= GRID_X1 &&
    lookTarget.z >= GRID_Z0 && lookTarget.z <= GRID_Z1;
  const targetHeight = targetOnGrid
    ? sampleHeight(
      Math.max(GRID_X0 + EDGE_EPSILON, Math.min(GRID_X1 - EDGE_EPSILON, lookTarget.x)),
      Math.max(GRID_Z0 + EDGE_EPSILON, Math.min(GRID_Z1 - EDGE_EPSILON, lookTarget.z)),
    )
    : sampleHeight(lookTarget.x, lookTarget.z);
  if (!Number.isFinite(targetHeight)) throw new RangeError('Camera terrain seating requires a finite target height');
  // Look-ahead and Cameraman smoothing may place the intended target under a crest.
  // Lifting only the camera cannot clear a segment whose target is buried.
  lookTarget.y = Math.max(lookTarget.y, targetHeight);
  const dx = position.x - lookTarget.x;
  const dz = position.z - lookTarget.z;
  const seatHeight = sampleHeight(position.x, position.z);
  if (!Number.isFinite(dx + dz + position.y + seatHeight)) return seatAboveTarget(position, lookTarget);
  let safeY = Math.max(position.y, seatHeight + CAMERA_TERRAIN_CLEARANCE);

  // Clip to the rendered grid: the analytic continuation outside it has no mesh.
  let enter = 0;
  let leave = 1;
  for (let axis = 0; axis < 2; axis++) {
    const start = axis === 0 ? lookTarget.x : lookTarget.z;
    const delta = axis === 0 ? dx : dz;
    const min = axis === 0 ? GRID_X0 : GRID_Z0;
    const max = axis === 0 ? GRID_X1 : GRID_Z1;
    if (delta === 0) {
      if (start < min || start > max) {
        position.y = safeY;
        return true;
      }
    } else {
      const a = (min - start) / delta;
      const b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
  }
  if (leave < enter) {
    position.y = safeY;
    return true;
  }

  let tx = firstCrossing(lookTarget.x, dx, GRID_X0);
  let tz = firstCrossing(lookTarget.z, dz, GRID_Z0);
  let td = firstCrossing(lookTarget.x + lookTarget.z, dx + dz, GRID_X0 + GRID_Z0);
  const stepX = GRID_STEP / Math.abs(dx);
  const stepZ = GRID_STEP / Math.abs(dz);
  const stepD = GRID_STEP / Math.abs(dx + dz);
  // Skip the unrendered part without iterating through distant grid cells.
  if (tx < enter) tx += Math.ceil((enter - tx) / stepX) * stepX;
  if (tz < enter) tz += Math.ceil((enter - tz) / stepZ) * stepZ;
  if (td < enter) td += Math.ceil((enter - td) / stepD) * stepD;
  let t = enter;
  for (let count = 0; count < CAMERA_TERRAIN_MAX_CROSSINGS; count++) {
    if (t > 0) {
      // At the outer edge the terrain API uses its analytic continuation. Sample
      // infinitesimally inside instead to retain the actual boundary triangle.
      const x = Math.max(GRID_X0 + EDGE_EPSILON, Math.min(GRID_X1 - EDGE_EPSILON, lookTarget.x + dx * t));
      const z = Math.max(GRID_Z0 + EDGE_EPSILON, Math.min(GRID_Z1 - EDGE_EPSILON, lookTarget.z + dz * t));
      const height = sampleHeight(x, z);
      if (!Number.isFinite(height)) return seatAboveTarget(position, lookTarget);
      safeY = Math.max(safeY, lookTarget.y + (height - lookTarget.y) / t + CAMERA_TERRAIN_CLEARANCE);
      if (!Number.isFinite(safeY)) return seatAboveTarget(position, lookTarget);
    }
    if (t >= leave) {
      position.y = safeY;
      return true;
    }
    if (tx <= t + 1e-12) tx += stepX;
    if (tz <= t + 1e-12) tz += stepZ;
    if (td <= t + 1e-12) td += stepD;
    t = Math.min(tx, tz, td, leave);
  }
  return seatAboveTarget(position, lookTarget);
}
