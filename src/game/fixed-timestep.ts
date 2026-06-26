// fixed-timestep.ts — the fixed-timestep accumulator math for the run loop.
//
// WHY THIS EXISTS
// ---------------
// The live game loop used to step physics with the real, variable render delta
// (`pos.x += velocity.x * delta`), which makes the steady state frame-rate
// dependent: at low FPS a single step can exceed an obstacle's collision radius
// (tunnelling through trees) and a per-frame-vs-per-second mismatch in any force
// path balloons terminal speed (the #209 bug class — see diagnostics.ts).
//
// A fixed timestep removes the cause: physics only ever advances in FIXED_DT
// (1/60 s) steps — exactly the rate the invariant harness pins
// (tests/verification/physics_invariant_harness.js drives the kernel at 1/60) —
// so the live build advances physics at the same rate the suite tests, the
// per-step displacement is `velocity / 60` (well under any collision radius at
// any sane speed), and tunnel-risk frames go to zero by construction.
//
// This module is the PURE, dependency-free core of that accumulator: it owns no
// THREE/DOM state, so it unit-tests headlessly and the frame-rate-equivalence /
// tunnel-risk harnesses can drive the SAME stepping logic the live loop runs.
// main-loop.ts imports it and supplies the actual per-substep / per-frame work.

/** The fixed physics step (60 Hz) — the rate the invariant harness pins. Physics
 *  only ever advances in steps of this size, regardless of the render rate, so
 *  `dragFactor(1/60)` is an identity and the kernel stays byte-identical to the
 *  harness's 1/60 world. */
export const FIXED_DT = 1 / 60;

/** Spiral-of-death guard: the most fixed substeps a single render frame may run
 *  (~133 ms ceiling). Mirrors the old `Math.min(delta, 0.1)` delta clamp as a
 *  step count — beyond it the game *slows down* (leftover real time is dropped)
 *  rather than tunnelling, the same ceiling, a strictly better failure mode. */
export const MAX_SUBSTEPS = 8;

/** The decision a single render frame produces from the accumulator. */
export interface SubstepPlan {
  /** Number of fixed FIXED_DT physics substeps to run this frame. */
  substeps: number;
  /** Leftover time carried into the next frame (< FIXED_DT after a normal frame). */
  accumulator: number;
  /** `accumulator / FIXED_DT` in [0, 1): the render-interpolation factor between
   *  the last two physics states (0 = exactly on a step boundary). */
  alpha: number;
}

/**
 * Advance the accumulator by one render frame's elapsed time and decide how many
 * fixed substeps to run. PURE — returns the plan, never mutates its inputs.
 *
 * `frameDelta` is the real seconds since the previous frame. It is ceiling-capped
 * at `maxSubsteps * fixedDt` first, so a long pause (GC, backgrounded tab) cannot
 * queue an unbounded burst of substeps — the excess real time is dropped, which is
 * the spiral-of-death guard expressed as the old 0.1 s clamp.
 */
export function planSubsteps(
  frameDelta: number,
  accumulator: number,
  fixedDt: number = FIXED_DT,
  maxSubsteps: number = MAX_SUBSTEPS,
): SubstepPlan {
  // Clamp to [0, ceiling]: a negative/NaN delta can't rewind, a huge one can't burst.
  const capped = Math.min(Math.max(frameDelta, 0) || 0, maxSubsteps * fixedDt);
  let acc = accumulator + capped;
  let substeps = 0;
  while (acc >= fixedDt && substeps < maxSubsteps) {
    acc -= fixedDt;
    substeps += 1;
  }
  const alpha = acc / fixedDt;
  return { substeps, accumulator: acc, alpha };
}

/** Scalar linear interpolation, for smoothing the rendered position between the
 *  two bracketing physics states when the render rate doesn't divide 60 evenly. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
