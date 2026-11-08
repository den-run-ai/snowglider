// course-line.ts — the descent centerline: one seeded source of truth for the line.
//
// "The line is the difficulty." The fast, safe way down a Black run is a winding
// corridor, not a straight bomb; going straight punishes you with steeper slide-out
// pitches, denser trees, and rock-gate pinches off the line. To make that coherent,
// every consumer that needs to know "where is the safe line at depth z?" reads ONE
// function here:
//   - the checkpoint gates sit on the line (src/course.ts),
//   - the skiable terrain channel banks onto it (src/mountains/terrain*.ts),
//   - the obstacle field thins on it and thickens off it (rocks/trees),
//   - and the winnability harness skis it (tests/verification/winnability_harness.js).
// Nothing duplicates the path math — they all call `laneX(z)` from a `CourseLine`
// built for the run's tier. A fixed per-tier seed (difficulty.ts) ⇒ the same Black
// course for everyone, which is what makes ranked times and shared ghosts fair.
//
// Like intro.ts and effects.ts this module is deliberately THREE-free and DOM-free:
// it is plain-number Catmull-Rom over seed-jittered control points, so the whole
// thing is headless-unit-testable (tests/course-line-tests.js) and can be imported by
// the terrain kernel without pulling in three.js.

/** Lane geometry that varies per difficulty tier (the `line` block of a tier config). */
export interface CourseLineParams {
  /** 0 ⇒ a straight fall line (`laneX ≡ 0`, the classic course). 1 ⇒ full winding. */
  curviness: number;
  /** Maximum lateral offset of the centerline from x=0, in world units (the hard `|x|` bound). */
  amplitude: number;
  /** Interior control points along the run; ~the number of turns the corridor makes. */
  controlPoints: number;
}

/** A fully-resolved line config: the tier's lane params plus its deterministic seed. */
export interface CourseLineConfig extends CourseLineParams {
  /** Per-tier seed — fixes the control-point jitter so the course is identical for everyone. */
  seed: number;
}

/** A 2D vector in the terrain x/z plane (a tangent direction). */
export interface LineVec2 {
  x: number;
  z: number;
}

/** The descent centerline for one run, sampled by world depth `z`. */
export interface CourseLine {
  /** Lateral world-x of the safe line at world depth `z` (bounded to ±`amplitude`). */
  laneX(z: number): number;
  /** Unit tangent of the line at `z`, pointing downhill (toward -z). */
  tangent(z: number): LineVec2;
  /** Heading of the line at `z` in radians: 0 down the fall line, +/- as it veers x. */
  heading(z: number): number;
  /** The resolved control-point x offsets (top→bottom), for tests / debug. */
  readonly controlsX: readonly number[];
}

// --- Lane span -----------------------------------------------------------------
// The centerline is pinned to x=0 at the top (the start gate) and the bottom (the
// finish gate) so a run begins and ends centered no matter how it weaves between.
// These mirror the shipped course geometry: LANE_Z_TOP == course.ts START_Z and
// LANE_Z_BOTTOM == collision.ts FINISH_Z. They are duplicated as plain literals
// (not imported) to keep this module free of the THREE-bearing course/collision
// graph; tests/course-line-tests.js asserts they still match the real course so the
// two can't silently drift apart.
export const LANE_Z_TOP = -15;
export const LANE_Z_BOTTOM = -195;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Deterministic per-seed PRNG (mulberry32). A fixed integer seed yields the same
 * stream on every page load and in Node, so a tier's course is reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform Catmull-Rom on a single axis (the 1D analogue of intro.ts's sampleSpline). */
function catmullRom1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (p2 - p0) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (3 * p1 - 3 * p2 + p3 - p0) * t3
  );
}

/** Sample a Catmull-Rom spline through `xs` at parameter `u ∈ [0,1]` (endpoints clamped). */
function sampleSpline1d(xs: readonly number[], u: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return xs[0]!;
  const segs = n - 1;
  const scaled = clamp01(u) * segs;
  let i = Math.floor(scaled);
  if (i >= segs) i = segs - 1; // keep the last segment for u === 1
  const localT = scaled - i;
  const p0 = xs[Math.max(i - 1, 0)]!;
  const p1 = xs[i]!;
  const p2 = xs[i + 1]!;
  const p3 = xs[Math.min(i + 2, n - 1)]!;
  return catmullRom1d(p0, p1, p2, p3, localT);
}

/** Map a world depth `z` to the spline parameter `u ∈ [0,1]` over the lane span. */
function zToU(z: number): number {
  return clamp01((LANE_Z_TOP - z) / (LANE_Z_TOP - LANE_Z_BOTTOM));
}

/**
 * Build the control-point x offsets for a tier. The two endpoints are pinned to 0
 * (centered start + finish); the interior points alternate sign for a left/right
 * serpentine, each jittered to 60–100% of the curviness-scaled amplitude. A straight
 * tier (`curviness` or `controlPoints` or `amplitude` == 0) yields all-zero controls.
 */
function buildControls(cfg: CourseLineConfig): number[] {
  const n = Math.max(0, Math.floor(cfg.controlPoints));
  const xs: number[] = [0];
  if (n > 0 && cfg.curviness > 0 && cfg.amplitude > 0) {
    const rng = mulberry32(cfg.seed);
    const flip = rng() < 0.5 ? -1 : 1; // seed picks which way the first turn breaks
    const reach = cfg.amplitude * cfg.curviness;
    for (let i = 0; i < n; i++) {
      const dir = flip * (i % 2 === 0 ? 1 : -1);
      const mag = reach * (0.6 + 0.4 * rng());
      xs.push(dir * mag);
    }
  }
  xs.push(0);
  return xs;
}

/**
 * Create the descent centerline for a run. Build it ONCE per run (the control points
 * are precomputed) and share the returned `CourseLine` with every consumer, so they
 * all read the same path. For the default straight tiers (Blue/Bunny) `laneX` returns
 * an exact 0, which keeps their terrain/gate/obstacle math byte-identical to today.
 */
export function createCourseLine(cfg: CourseLineConfig): CourseLine {
  const controlsX = buildControls(cfg);
  const bound = Math.max(0, cfg.amplitude);
  const straight = controlsX.every((x) => x === 0);

  function laneX(z: number): number {
    if (straight) return 0;
    const x = sampleSpline1d(controlsX, zToU(z));
    // Hard-clamp to ±amplitude so Catmull-Rom overshoot can never widen the corridor
    // past the advertised bound (consumers size the channel / obstacle gap from it).
    return x < -bound ? -bound : x > bound ? bound : x;
  }

  function tangent(z: number): LineVec2 {
    if (straight) return { x: 0, z: -1 };
    // Central difference of laneX wrt z. The skier travels toward -z, so the path
    // tangent is (-dLaneX/dz, -1) normalized.
    const eps = 0.5;
    const slope = (laneX(z + eps) - laneX(z - eps)) / (2 * eps); // dLaneX/dz
    const tx = -slope;
    const tz = -1;
    const len = Math.hypot(tx, tz) || 1;
    return { x: tx / len, z: tz / len };
  }

  function heading(z: number): number {
    const t = tangent(z);
    return Math.atan2(t.x, -t.z); // 0 straight down the fall line
  }

  return { laneX, tangent, heading, controlsX };
}

/** Resolve a tier config (anything carrying a `seed` + a `line` block) into a CourseLine. */
export function courseLineFor(config: { seed: number; line: CourseLineParams }): CourseLine {
  return createCourseLine({ seed: config.seed, ...config.line });
}

// --- Active-line registry (the run's one shared centerline) ----------------------
//
// "One centerline, many consumers." scene-setup registers the run's CourseLine here,
// and every consumer that needs "where is the safe line at depth z?" reads it through
// `activeLaneX(z)` — the gates (course.ts), the obstacle field (trees.ts / rocks.ts),
// and the winnability harness — so none of them duplicate the path math. Straight tiers
// (Bunny/Blue) register `null`, and `activeLaneX` then returns an exact 0, which keeps
// their gate positions and obstacle placement byte-identical to today. The terrain
// corridor (terrain.ts) is handed the SAME CourseLine instance, so all consumers agree.

let activeLine: CourseLine | null = null;

/** Register (or clear) the run's centerline. Called once per scene by scene-setup. */
export function setActiveCourseLine(line: CourseLine | null): void {
  activeLine = line;
}

/** The run's active centerline, or null for a straight tier. */
export function getActiveCourseLine(): CourseLine | null {
  return activeLine;
}

/** Lateral world-x of the run's active line at depth `z` — exactly 0 when none is set
 *  (so straight-tier consumers stay byte-identical). The one accessor gates + obstacles read. */
export function activeLaneX(z: number): number {
  return activeLine ? activeLine.laneX(z) : 0;
}
