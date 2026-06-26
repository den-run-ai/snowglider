// Fixed-timestep accumulator math for the SnowGlider run loop.
//
// WHY THIS EXISTS
// ---------------
// The physics-invariant harness (tests/verification/physics_invariant_harness.js)
// drives the kernel (`Snowman.updateSnowman`) at a fixed dt = 1/60 on every step.
// The live game, by contrast, used to step physics at the variable render delta —
// so on a slow device a single frame could advance the player by `velocity * delta`
// with `delta` up to the 0.1 s loop cap, large enough to (a) skip a discrete
// point-vs-disk collision check (tunnel through a tree) and (b) diverge from the
// 60 Hz trajectory the harness pins. diagnostics.ts watches both smells live.
//
// A fixed-timestep accumulator removes the cause: the loop banks the real frame
// delta into an accumulator and only ever advances physics in whole 1/60 s steps,
// so the per-step displacement is `velocity / 60` (well under any obstacle radius)
// regardless of render rate. The leftover (< one step) drives render interpolation.
//
// This module is intentionally pure (no Three.js / DOM) so the accumulator schedule
// is unit-testable headlessly and shared between main-loop.ts (the live loop) and the
// frame-rate-equivalence harness (which drives the REAL kernel through this same
// scheduler at 30/50/144/jittery FPS and asserts the trajectory matches 60 FPS).

/** The fixed physics step the harness pins (60 Hz). At this dt the kernel's own
 *  `dragFactor(k)` 60 Hz re-derivation is an identity (`delta*60 == 1`), so the
 *  live game advances physics byte-identically to the invariant harness. */
export const FIXED_DT = 1 / 60;

/** Spiral-of-death guard: the most physics steps one render frame may run (~133 ms
 *  of simulated time). Beyond this the game *slows down* rather than tunnelling —
 *  the same ceiling the old `Math.min(delta, 0.1)` clamp imposed (0.1 s ≈ 6 steps),
 *  expressed as a step count and with no tunneling. A strictly better failure mode. */
export const MAX_SUBSTEPS = 8;

/** The result of folding one render frame's elapsed time into the accumulator. */
export interface SubstepPlan {
  /** How many fixed physics steps to run this frame (0..maxSubsteps). */
  steps: number;
  /** The accumulator remainder to carry into the next frame (always < fixedDt). */
  accumulator: number;
  /** Leftover fraction of a step (0..1) for render interpolation between the last
   *  two physics states. */
  alpha: number;
  /** The frame delta actually consumed, after clamping to the spiral guard ceiling.
   *  Cosmetic/per-render systems advance on this (never the raw, unclamped delta). */
  frameDelta: number;
}

/**
 * Fold one render frame's raw elapsed time into the accumulator and decide how many
 * fixed physics steps to run.
 *
 * The raw delta is first clamped to `maxSubsteps * fixedDt` (the spiral-of-death
 * guard — a long frame can never schedule an unbounded number of catch-up steps).
 * The clamped delta is added to the accumulator; whole `fixedDt` chunks are drained
 * as steps (bounded by `maxSubsteps`); the sub-step remainder becomes `alpha`.
 *
 * Pure and deterministic: same (accumulator, rawDelta) → same plan, with no clock or
 * RNG access, so both the live loop and the offline harness get identical schedules.
 */
export function planSubsteps(
  accumulator: number,
  rawDelta: number,
  fixedDt: number = FIXED_DT,
  maxSubsteps: number = MAX_SUBSTEPS,
): SubstepPlan {
  // Clamp the frame delta (and treat a non-finite / negative delta as zero so a
  // bad timestamp can never inject steps or NaN into the accumulator).
  const frameDelta = Number.isFinite(rawDelta) && rawDelta > 0
    ? Math.min(rawDelta, maxSubsteps * fixedDt)
    : 0;

  let acc = accumulator + frameDelta;
  let steps = 0;
  while (acc >= fixedDt && steps < maxSubsteps) {
    acc -= fixedDt;
    steps++;
  }
  // Drop any accumulator beyond one step that survived the substep cap (the slow
  // frame already ran maxSubsteps): keeps `alpha` in [0,1) and time merely slows.
  if (acc >= fixedDt) acc = acc % fixedDt;

  return { steps, accumulator: acc, alpha: acc / fixedDt, frameDelta };
}
