// Seed derivation and population budget for the living-world agent layer
// (issue #366, Roadmap Finding 5).
//
// Cosmetic agents are purely decorative, so their randomness is seeded deterministically
// off the run's difficulty tier: the SAME tier always lays out the SAME herd, and a
// different tier gets a different (but equally reproducible) one. Keeping the seed a pure
// function of the tier — rather than a live `Math.random` draw — is what makes the agents
// reproducible across reloads and, crucially, independent of the seeded global stream the
// physics harnesses baseline (invariant #4). Mirrors `src/scenery/scenery-budget.ts`.

import type { Difficulty } from '../difficulty.js';

// Per-tier base seed. Arbitrary distinct 32-bit constants — the only requirement is that
// they are stable (never derived from wall-clock or the global RNG) and differ between
// tiers so each tier composes a visibly different living world. Distinct from the scenery
// tier seeds so agents and scenery never draw an identical layout stream.
const AGENTS_SEED_BY_TIER: Record<Difficulty, number> = {
  bunny: 0x3f1a5c,
  blue: 0x62b4e1,
  black: 0x1d7e93,
  expert: 0x48c2a6,
};

/**
 * The deterministic agent seed for a difficulty tier. Feed the result to
 * `makeAgentRng()` so every agent module draws its placement/motion from one
 * reproducible, tier-keyed stream.
 */
export function agentsSeedFor(difficulty: Difficulty): number {
  return AGENTS_SEED_BY_TIER[difficulty];
}

/**
 * Coarse population budget for the agent layer. A single knob the individual agent
 * modules read so the whole subsystem stays within a shared, tunable envelope instead of
 * each module hard-coding its own counts. Values are deliberately conservative — a small
 * herd keeps the layer well inside the render/perf budget (the wildlife InstancedMesh
 * reuses an existing shader program, so it adds no new programs and one geometry).
 */
export interface AgentBudget {
  /** Max cosmetic wildlife animals in the roaming flank herds (PR 1). */
  wildlife: number;
}

/** The shipped default budget. One source of truth for the agent module counts. */
export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  wildlife: 14,
};
