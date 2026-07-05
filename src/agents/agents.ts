// Living-world agent layer — public facade (issue #366, Roadmap Finding 5).
//
// PURPOSE: a thin, explicit layer for moving world entities (wildlife now; rival ghosts,
// a pursuing chaser, etc. later) — the "many independent updatable things" benefit applied
// at FEATURE scope, NOT a framework-wide ECS rewrite (which would fight the byte-identical
// baseline and seeded-PRNG invariants). It is a peer of `src/scenery/*` and is built,
// ticked and disposed through the same seams.
//
// PR 1 ships ONE purely-cosmetic, background-only layer (a small roaming herd) so the safe
// integration into scene setup / the main loop / teardown lands first and the invariants
// can be pinned. Later PRs add agents that can affect the run — those must NOT apply
// game-over themselves; they REPORT an outcome and the main loop applies it (the
// `avalanche.checkBurial` / pure `resolveBurialOutcome` pattern), input-/tier-gated so the
// no-input coasting trajectory stays byte-identical.
//
// THE INVARIANTS (mirror the scenery contract, issue #320):
//   1. render-only        — cosmetic agents use cheap fog-friendly materials, no shadows,
//                           and reuse an existing shader program (perf budget is tight).
//   2. collision-neutral  — never writes treePositions / rockPositions.
//   3. physics-neutral    — cosmetic agents never write pos / velocity / terrain / course;
//                           a lethal agent routes its outcome through a pure resolver.
//   4. Math.random-neutral— all THREE construction goes through withPrivateThreeRandom;
//                           all placement/motion randomness comes from the seeded
//                           makeAgentRng, so agents never perturb the seeded global stream.
//   5. teardown-safe      — dispose() frees the group + any off-scene caches a later PR adds.
//   6. cosmetic tick only — update() runs in the main loop's render-frame cosmetic zone,
//                           never inside the fixed physics substep (for cosmetic agents).
//
// Reading terrain height for placement is allowed (getTerrainHeight is a pure sampler);
// MUTATING terrain, or entering the collision arrays, is not.

import * as THREE from 'three';
import type { Difficulty } from '../difficulty.js';
import type { CourseLine } from '../course-line.js';
import { DEFAULT_AGENT_BUDGET, type AgentBudget } from './agents-budget.js';
import { makeAgentRng, withPrivateThreeRandom } from './agents-rng.js';
import { buildWildlife, type WildlifeSystem } from './wildlife.js';

/** Read-only context handed to agent construction. Everything here is either a pure
 *  sampler or immutable layout data — agents may READ it but must never mutate it. */
export interface AgentContext {
  /** Pure terrain-height sampler, for grounding agents on the slope. Read-only. */
  getTerrainHeight: (x: number, z: number) => number;
  /** The run's centerline (null on straight tiers), so agents can sit clear of the lane. */
  courseLine: CourseLine | null;
  /** The run's difficulty tier — agents key their deterministic seed off this. */
  difficulty: Difficulty;
  /** Deterministic seed for all placement/motion randomness (from agentsSeedFor). */
  seed: number;
  /** Optional population budget override; defaults to DEFAULT_AGENT_BUDGET. */
  budget?: AgentBudget;
}

/**
 * The live agent system. `group` holds every agent mesh (added to the scene once);
 * `update` advances cosmetic-only animation from the main loop's render-frame zone; and
 * `dispose` releases the group plus any off-scene caches a later PR adds.
 */
export interface AgentSystem {
  /** The root group holding all agents, parented under the scene. */
  group: THREE.Group;
  /**
   * Cosmetic per-frame tick. MUST stay render-only for cosmetic agents: reads `dt` and the
   * player position; never writes pos/velocity/terrain/course/collision state.
   */
  update(dt: number, playerPosition: THREE.Vector3): void;
  /** Idempotently release every resource this system owns (see teardown.ts §3). */
  dispose(): void;
}

/**
 * Build the agent system and parent it under `scene`. Called once from `setupScene()`
 * AFTER the gameplay-critical collision arrays (treePositions/rockPositions) are built,
 * so agents can never be mistaken for an obstacle source.
 */
export function createAgents(scene: THREE.Scene, ctx: AgentContext): AgentSystem {
  // Placement/motion randomness: seeded, self-contained, never touches global Math.random.
  const rng = makeAgentRng(ctx.seed);
  const budget = ctx.budget ?? DEFAULT_AGENT_BUDGET;

  // The one owned scene node. Constructed under the private-RNG guard so its UUID draw
  // can't perturb a caller's seeded global stream (invariant #4).
  const group = withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'agents';
    return g;
  });
  scene.add(group);

  // --- Layer: background wildlife (PR 1) ---
  // A small roaming herd far out on the flanks. Render-only, collision/physics/stream-
  // neutral, frozen under reduced motion. Ticked in update() below (cosmetic-only).
  const wildlife: WildlifeSystem = buildWildlife(rng, budget, ctx.getTerrainHeight);
  group.add(wildlife.group);

  let disposed = false;

  function update(dt: number, _playerPosition: THREE.Vector3): void {
    // Cosmetic-only: advances the wildlife amble from the render delta. Writes only the
    // herd's instance matrices — never pos/velocity/terrain/course/collision.
    wildlife.update(dt);
  }

  function dispose(): void {
    if (disposed) return; // idempotent, mirroring disposeGame's per-context guard
    disposed = true;
    // Free the GPU buffers of everything under the group, then detach it. teardown.ts's
    // scene sweep also catches attached meshes (double dispose() is safe), but an agent
    // system disposed on its own — or holding off-scene/cached resources a later PR adds —
    // needs this self-contained path. Geometry/material are deduped so a shared pooled
    // resource is freed at most once.
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    group.traverse((obj) => {
      const meshObj = obj as THREE.Mesh;
      if (meshObj.geometry) geoms.add(meshObj.geometry);
      const mat = meshObj.material;
      if (Array.isArray(mat)) mat.forEach((mm) => { if (mm) mats.add(mm); });
      else if (mat) mats.add(mat);
      if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    });
    for (const g of geoms) g.dispose();
    for (const mm of mats) mm.dispose();
    group.clear();
    group.removeFromParent();
  }

  return { group, update, dispose };
}
