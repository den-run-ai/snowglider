// Background scenery system — public facade (issue #320).
//
// PURPOSE: compose the distant, non-interactive alpine world (ridge silhouettes, a
// valley / frozen lake, decorative forest belts, cliff bands, imported props, ambient
// birds/clouds/spindrift) that makes the mountain read as a real backcountry bowl —
// WITHOUT ever touching gameplay. This module is the stable seam every later visual PR
// hangs its layer off; PR 1 ships it essentially empty (one owned `THREE.Group`, a
// no-op cosmetic tick, and a real disposal path) so the safe integration into scene
// setup / the main loop / teardown lands first and the invariants can be pinned.
//
// THE SIX INVARIANTS (enforced by tests/scenery-*-tests.js; see issue #320):
//   1. render-only        — cheap, fog-friendly materials; no shadow-caster requirement
//   2. collision-neutral  — never writes treePositions / rockPositions
//   3. physics-neutral    — never writes pos / velocity / terrain samplers / course state
//   4. Math.random-neutral— all THREE construction goes through withPrivateThreeRandom;
//                           all placement randomness comes from the seeded makeSceneryRng,
//                           so scenery never perturbs the seeded global stream
//   5. teardown-safe      — dispose() frees the group + any off-scene caches/loaders
//   6. cosmetic tick only — update() runs in the main loop's render-frame cosmetic zone,
//                           never inside the fixed physics substep
//
// Reading terrain height for placement is allowed (getTerrainHeight is a pure sampler);
// MUTATING terrain, or entering the collision arrays, is not.

import * as THREE from 'three';
import type { Difficulty } from '../difficulty.js';
import type { CourseLine } from '../course-line.js';
import { makeSceneryRng, withPrivateThreeRandom } from './scenery-rng.js';
import { DEFAULT_SCENERY_BUDGET, type SceneryBudget } from './scenery-budget.js';
import { buildDistantRidges } from './distant-ridges.js';
import { buildValleyBackdrop } from './valley-backdrop.js';
import { buildForestBelts } from './forest-belts.js';

/** Read-only context handed to scenery construction. Everything here is either a pure
 *  sampler or immutable layout data — scenery may READ it but must never mutate it. */
export interface SceneryContext {
  /** The terrain mesh, for bounds/placement reference only (never mutated). */
  terrain: THREE.Object3D | null;
  /** Pure terrain-height sampler, for placing scenery on/near the ground. Read-only. */
  getTerrainHeight: (x: number, z: number) => number;
  /** The run's centerline (null on straight tiers), so scenery can sit clear of the lane. */
  courseLine: CourseLine | null;
  /** The run's difficulty tier — scenery keys its deterministic seed off this. */
  difficulty: Difficulty;
  /** Deterministic seed for all placement randomness (from scenerySeedFor(difficulty)). */
  seed: number;
  /** Optional layout budget override; defaults to DEFAULT_SCENERY_BUDGET. */
  budget?: SceneryBudget;
}

/** Cosmetic per-frame signals scenery may lean on (all read-only, all optional). */
export interface SceneryUpdateContext {
  /** Normalized wind strength 0..1 (Wind.strength()). */
  windStrength?: number;
  /** Instantaneous gust factor 0..1 (Wind.gust()). */
  windGust?: number;
}

/**
 * The live scenery system. `group` holds every scenery mesh (added to the scene once);
 * `update` advances cosmetic-only animation from the main loop's render-frame zone; and
 * `dispose` releases the group plus any off-scene caches, loaders, or listeners a later
 * PR adds (beyond what the scene-sweep in teardown.ts catches for attached meshes).
 */
export interface ScenerySystem {
  /** The root group holding all scenery, parented under the scene. */
  group: THREE.Group;
  /**
   * Cosmetic per-frame tick. MUST stay render-only: reads `dt`, the player position, and
   * the optional wind signals; never writes pos/velocity/terrain/course/collision state.
   */
  update(dt: number, playerPosition: THREE.Vector3, ctx?: SceneryUpdateContext): void;
  /** Idempotently release every resource this system owns (see teardown.ts §3). */
  dispose(): void;
}

/**
 * Build the scenery system and parent it under `scene`. Called once from `setupScene()`
 * AFTER the gameplay-critical collision arrays (treePositions/rockPositions) are built,
 * so scenery can never be mistaken for an obstacle source.
 *
 * PR 1 constructs only the (empty) root group — the integration seam. Later PRs push
 * their layers into `group` here, each drawing placement from the seeded `rng` and
 * wrapping THREE construction in `withPrivateThreeRandom`.
 */
export function createScenery(scene: THREE.Scene, ctx: SceneryContext): ScenerySystem {
  // Placement randomness: seeded, self-contained, never touches global Math.random.
  // Every scenery layer draws its placement from this one tier-keyed stream.
  const rng = makeSceneryRng(ctx.seed);
  const budget = ctx.budget ?? DEFAULT_SCENERY_BUDGET;

  // The one owned scene node. Constructed under the private-RNG guard so its UUID draw
  // can't perturb a caller's seeded global stream (invariant #4).
  const group = withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'scenery';
    return g;
  });
  scene.add(group);

  // --- Layer: distant alpine panorama (PR 2) ---
  // Static jagged ridge silhouettes fog-hazed into the horizon. Render-only and
  // collision/physics/stream-neutral (all THREE construction guarded, placement seeded).
  group.add(buildDistantRidges(rng, budget));

  // --- Layer: valley backdrop (PR 3) ---
  // Mid-distance frozen lake + far lodges + forest patches on their own rendered snowfield
  // floor, in a side valley between the play area and the ridges. Render-only (no reflective
  // shader); self-grounded (the valley is past the rendered terrain, so it samples no terrain).
  group.add(buildValleyBackdrop(rng, budget));

  // --- Layer: decorative forest belts (PR 4) ---
  // Instanced conifer belts on the outer flanks (|x|∈[102,145]), grounded on the terrain and
  // OUTSIDE the lane. Collision-neutral — never added to treePositions, so they thicken the
  // tree line without being obstacles.
  group.add(buildForestBelts(rng, budget, ctx));

  let disposed = false;

  function update(_dt: number, _playerPosition: THREE.Vector3, _ctx?: SceneryUpdateContext): void {
    // No cosmetic layers yet (PR 1 is the seam). Intentionally a no-op — and it must
    // stay physics/collision-neutral when layers are added: read-only signals only.
  }

  function dispose(): void {
    if (disposed) return; // idempotent, mirroring disposeGame's per-context guard
    disposed = true;
    // Free the GPU buffers of everything under the group, then detach it. teardown.ts's
    // scene sweep also catches attached meshes (double dispose() is safe), but a scenery
    // system disposed on its own — or holding off-scene/cached resources a later PR adds
    // — needs this self-contained path. Geometry/material are deduped so a shared pooled
    // resource is freed at most once.
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geoms.add(mesh.geometry);
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => { if (m) mats.add(m); });
      else if (mat) mats.add(mat);
      if ((obj as THREE.InstancedMesh).isInstancedMesh) (obj as THREE.InstancedMesh).dispose();
    });
    for (const g of geoms) g.dispose();
    for (const m of mats) m.dispose();
    group.clear();
    group.removeFromParent();
  }

  return { group, update, dispose };
}
