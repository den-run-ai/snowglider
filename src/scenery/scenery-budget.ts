// Seed derivation and layout budget for the background scenery system (issue #320).
//
// Scenery is purely cosmetic, so its randomness is seeded deterministically off the
// run's difficulty tier: the SAME tier always lays out the SAME distant world, and a
// different tier gets a different (but equally reproducible) one. Keeping the seed a
// pure function of the tier — rather than a live `Math.random` draw — is what makes the
// scenery reproducible across reloads and, crucially, independent of the seeded global
// stream the physics harnesses baseline (invariant #4 of the scenery plan).

import type { Difficulty } from '../difficulty.js';

// Per-tier base seed. Arbitrary distinct 32-bit constants — the only requirement is
// that they are stable (never derived from wall-clock or the global RNG) and differ
// between tiers so each tier composes a visibly different backdrop.
const SCENERY_SEED_BY_TIER: Record<Difficulty, number> = {
  bunny: 0x2b17a3,
  blue: 0x51e9c4,
  black: 0x0c4d7f,
  expert: 0x7ae1b2,
};

/**
 * The deterministic scenery seed for a difficulty tier. Feed the result to
 * `makeSceneryRng()` so every scenery module draws its placement from one
 * reproducible, tier-keyed stream.
 */
export function scenerySeedFor(difficulty: Difficulty): number {
  return SCENERY_SEED_BY_TIER[difficulty];
}

/**
 * Coarse layout budget for the scenery composition. A single knob set the individual
 * scenery modules (ridges, forest belts, props, ambient life) read so the whole
 * subsystem stays within a shared, tunable envelope instead of each module hard-coding
 * its own counts. Values are deliberately conservative for PR 1 (the foundation ships
 * with ~no visuals); later visual PRs raise them as their perf budgets allow.
 */
export interface SceneryBudget {
  /** Max distant ridge silhouette layers (PR 2). */
  ridgeLayers: number;
  /** Max decorative (non-colliding) instanced trees in the side-slope belts (PR 4). */
  forestBeltTrees: number;
  /** Max imported GLTF props scattered in the scenic zones (PR 6). */
  props: number;
  /** Max ambient birds/clouds/spindrift emitters (PR 7). */
  ambientEmitters: number;
}

/** The shipped default budget. One source of truth for the scenery module counts. */
export const DEFAULT_SCENERY_BUDGET: SceneryBudget = {
  ridgeLayers: 5,
  forestBeltTrees: 240,
  props: 24,
  ambientEmitters: 12,
};
