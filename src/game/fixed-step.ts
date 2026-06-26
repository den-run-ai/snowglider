// fixed-step.ts — the fixed-timestep accumulator at the heart of the main loop's
// determinism / frame-rate-independence refactor.
//
// WHY THIS EXISTS
// ---------------
// The physics kernel (snowman/physics.ts) integrates with semi-implicit Euler and a
// per-frame drag factor re-derived to 60 Hz. At a *variable* render delta two things
// drift with frame rate (the #209 bug class diagnostics.ts watches live):
//   1. the per-frame position step `pos += velocity * dt` can exceed an obstacle's
//      collision radius (2.5u) at low FPS, so the discrete point-vs-disk check is
//      skipped entirely — the "floor it forward and tunnel through the trees" bug;
//   2. large-dt Euler diverges from small-dt in trajectory and landing timing.
//
// The fix is to advance physics ONLY ever in fixed 1/60 s steps, regardless of the
// render rate, accumulating real frame time and draining it one fixed step at a time.
// Then the per-step displacement is `velocity / 60` (well under 2.5u at any sane
// speed) and tunnel risk goes to zero by construction. 1/60 s is exactly the dt the
// physics-invariant harness pins (it drives the kernel directly at 1/60), so the live
// game advances physics at the same rate the suite tests — the thing tested becomes
// the thing that runs, and `dragFactor(60Hz)` collapses to an identity.
//
// This module is the pure, DOM-free seam: `planFrameSteps` decides how many fixed
// substeps a render frame's elapsed time should run and how much leftover to carry.
// main-loop.ts wires it to the real kernel + cosmetics; the frame-rate-equivalence
// harness drives the same function against the kernel to prove the trajectory is
// frame-rate independent.

/** The fixed physics step. Equals the dt the physics-invariant harness pins, so the
 *  live loop advances the kernel at exactly the tested rate. */
export const FIXED_DT = 1 / 60;

/** Spiral-of-death guard: the most fixed steps a single slow render frame may run
 *  (~133 ms of physics). Beyond this the game slows down rather than tunnelling —
 *  the same ceiling the old `Math.min(delta, 0.1)` clamp imposed (0.1 s ≈ 6 steps),
 *  expressed as a step count and with no tunnelling. A strictly better failure mode. */
export const MAX_SUBSTEPS = 8;

/** How a render frame's elapsed time maps onto the fixed grid. */
export interface FrameStepPlan {
  /** Number of fixed physics substeps to run this frame. */
  substeps: number;
  /** Leftover accumulator (< FIXED_DT under the maintained invariant) carried to the
   *  next frame. */
  accumulator: number;
  /** Render-interpolation factor in [0, 1): how far between the last two fixed states
   *  the render should sit (`leftover / FIXED_DT`). */
  alpha: number;
}

/**
 * Plan a render frame's fixed substeps. Adds the (ceiling-capped) frame delta to the
 * carried accumulator, then drains whole fixed steps up to MAX_SUBSTEPS.
 *
 * The frame delta is capped at `maxSubsteps * fixedDt` BEFORE accumulating, which is
 * the spiral-of-death guard: a long pause (tab backgrounded, GC hitch) can never queue
 * an unbounded number of physics steps. Because a normal frame always drains the
 * accumulator below `fixedDt`, the carried accumulator stays < fixedDt by induction, so
 * `alpha` stays in [0, 1).
 *
 * Pure and DOM-free so the loop and the frame-rate-equivalence harness share the exact
 * same stepping discipline.
 */
export function planFrameSteps(
  accumulator: number,
  frameDeltaSec: number,
  fixedDt: number = FIXED_DT,
  maxSubsteps: number = MAX_SUBSTEPS,
): FrameStepPlan {
  // Guard against a non-finite / negative frame delta (e.g. a clock anomaly) so a
  // single bad frame can never poison the accumulator.
  const safeDelta = Number.isFinite(frameDeltaSec) && frameDeltaSec > 0 ? frameDeltaSec : 0;
  const capped = Math.min(safeDelta, maxSubsteps * fixedDt);
  let acc = accumulator + capped;
  let substeps = 0;
  while (acc >= fixedDt && substeps < maxSubsteps) {
    acc -= fixedDt;
    substeps++;
  }
  const alpha = fixedDt > 0 ? Math.min(acc / fixedDt, 1) : 0;
  return { substeps, accumulator: acc, alpha };
}

/** Linear interpolation, used to render the player/camera between the last two fixed
 *  physics states (removes temporal aliasing on panels whose rate doesn't divide 60). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
