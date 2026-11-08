// Pure, render-only Auto-camera probes. These read the uncached terrain sampler
// and existing collision positions; they never query scene meshes or touch physics.
import { getTerrainHeightUncached } from './mountains/terrain.js';

interface Point { x: number; y: number; z: number; }
interface Velocity { x: number; z: number; }
export interface CameraTree extends Point { scale: number; }
export interface CameraRock extends Point { size: number; topY?: number; }
type HeightSampler = (x: number, z: number) => number;

/** Read the upcoming slope and changes in grade before the skier reaches them. */
export function previewAutoTerrain(
  position: Point, velocity: Velocity, sampleHeight: HeightSampler = getTerrainHeightUncached,
): { slope: number; relief: number; lookAhead: number; lookHeight: number } {
  const speed = Math.hypot(velocity.x, velocity.z);
  const lookAhead = Math.min(22, 8 + speed * 0.65);
  const start = sampleHeight(position.x, position.z);
  if (!(speed > 1) || !Number.isFinite(start)) {
    return { slope: 0, relief: 0, lookAhead: 0, lookHeight: position.y };
  }
  const dx = velocity.x / speed, dz = velocity.z / speed;
  let previous = start, previousGrade = 0, slope = 0, relief = 0;
  const step = lookAhead / 4;
  for (let i = 1; i <= 4; i++) {
    const height = sampleHeight(position.x + dx * step * i, position.z + dz * step * i);
    if (!Number.isFinite(height)) break;
    const grade = (height - previous) / step;
    slope = Math.max(slope, Math.abs(grade));
    if (i > 1) relief = Math.max(relief, Math.abs(grade - previousGrade));
    previous = height;
    previousGrade = grade;
  }
  return { slope, relief: Math.min(1, relief), lookAhead, lookHeight: previous };
}

// Symmetric side seats stay behind the skier. Hysteresis favors the current side
// until another view is materially clearer, preventing left/right oscillation.
const VIEW_ANGLES = [0, -0.35, 0.35, -0.7, 0.7] as const;

/** Approximate a canopy/rock by a bounded vertical cylinder for view selection. */
function obstruction(
  seat: Point, subject: Point, obstacle: Point, radius: number, top: number,
): number {
  const dx = seat.x - subject.x, dz = seat.z - subject.z;
  const lengthSq = dx * dx + dz * dz;
  if (!(lengthSq > 0) || !(radius > 0) || !Number.isFinite(top + obstacle.x + obstacle.y + obstacle.z)) return 0;
  const t = Math.max(0, Math.min(1,
    ((obstacle.x - subject.x) * dx + (obstacle.z - subject.z) * dz) / lengthSq));
  const x = subject.x + dx * t, z = subject.z + dz * t;
  const y = subject.y + (seat.y - subject.y) * t;
  if (y > top + 1 || y < obstacle.y - 1) return 0;
  const distance = Math.hypot(obstacle.x - x, obstacle.z - z);
  return Math.max(0, 1 - distance / (radius + 1));
}

/** Pick a nearby clear shoulder view and report hazards in the skier's path. */
export function chooseAutoView(
  position: Point, behindHeading: number, distance: number, height: number, currentYaw: number,
  trees: readonly CameraTree[] = [], rocks: readonly CameraRock[] = [],
  sampleHeight: HeightSampler = getTerrainHeightUncached,
): { yaw: number; pressure: number } {
  const subject = { x: position.x, y: position.y + 4, z: position.z };
  let bestYaw = 0, bestScore = Infinity, pressure = 0;
  for (const yaw of VIEW_ANGLES) {
    const angle = behindHeading + yaw;
    const seat = {
      x: position.x + Math.sin(angle) * distance,
      y: position.y + height,
      z: position.z + Math.cos(angle) * distance,
    };
    const ground = sampleHeight(seat.x, seat.z);
    if (!Number.isFinite(ground)) continue;
    const lift = Math.max(0, ground + 5 - seat.y);
    seat.y += lift;
    let score = Math.abs(yaw) * 0.18 + (yaw * currentYaw < 0 ? 0.25 : 0) + lift * 0.015;
    // Preview terrain occlusion here; exact triangle-crossing clearance is still
    // applied to the final smoothed camera ray by camera-terrain.ts.
    for (let i = 1; i < 5; i++) {
      const t = i / 5;
      const terrain = sampleHeight(subject.x + (seat.x - subject.x) * t, subject.z + (seat.z - subject.z) * t);
      if (Number.isFinite(terrain)) score += Math.max(0, terrain + t * 5 - (subject.y + (seat.y - subject.y) * t)) * 0.12;
    }
    for (const tree of trees) {
      const dx = tree.x - position.x, dz = tree.z - position.z;
      if (dx * dx + dz * dz > 4900) continue;
      score += obstruction(seat, subject, tree, 2.8 * tree.scale, tree.y + 12 * tree.scale) * 3;
      if (yaw === 0) {
        const ahead = -dx * Math.sin(behindHeading) - dz * Math.cos(behindHeading);
        const side = Math.abs(dx * Math.cos(behindHeading) - dz * Math.sin(behindHeading));
        if (ahead > 0 && ahead < 28 && side < 5 + tree.scale * 3) pressure = Math.max(pressure, 1 - ahead / 35);
      }
    }
    for (const rock of rocks) {
      const dx = rock.x - position.x, dz = rock.z - position.z;
      if (dx * dx + dz * dz > 4900) continue;
      score += obstruction(seat, subject, rock, rock.size, rock.topY ?? rock.y + rock.size) * 3;
      if (yaw === 0) {
        const ahead = -dx * Math.sin(behindHeading) - dz * Math.cos(behindHeading);
        const side = Math.abs(dx * Math.cos(behindHeading) - dz * Math.sin(behindHeading));
        if (ahead > 0 && ahead < 28 && side < 5 + rock.size) pressure = Math.max(pressure, 1 - ahead / 35);
      }
    }
    if (score < bestScore) { bestScore = score; bestYaw = yaw; }
  }
  return { yaw: bestYaw, pressure };
}
