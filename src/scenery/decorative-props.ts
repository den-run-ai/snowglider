// Decorative props placement — scatters the prop catalog on the flanks (issue #320, PR 6).
//
// Grounds small procedural props (from prop-catalog.ts) on the near-to-mid flanks of the run,
// between the clear racing lane and the gameplay forest, so they read as backcountry detail the
// player skis PAST — never through the lane. Purely decorative.
//
// PLACEMENT: |x|∈[48,95] on both flanks (outside the lane + its drift margin, inside the
// gameplay forest zone edge), z∈[-180,25]. Grounded on the terrain via a read-only
// getTerrainHeight sample.
//
// INVARIANTS (issue #320): render-only (no per-frame update), collision-neutral (props are
// NEVER added to treePositions/rockPositions — decorative only), physics-neutral, and
// Math.random-stream-neutral (all placement + archetype selection from the seeded `rng`; the
// whole build runs inside withPrivateThreeRandom so THREE UUID draws can't perturb the seeded
// global stream). Teardown falls out of the scenery group dispose sweep.

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';
import type { SceneryContext } from './scenery.js';
import { PROP_CATALOG, createPropPool } from './prop-catalog.js';

const FLANK_MIN_X = 48;
const FLANK_SPAN_X = 47; // → outer edge ~95
const Z_MIN = -180;
const Z_SPAN = 205;      // z ∈ [-180, 25]

/**
 * Build the decorative props group: procedural props from the catalog, scattered on the flanks
 * and grounded on the terrain. Static (no per-frame update); the caller (createScenery) parents
 * the group under the scenery group. The ENTIRE build runs under one private-RNG guard.
 */
export function buildDecorativeProps(rng: () => number, budget: SceneryBudget, ctx: SceneryContext): THREE.Group {
  const count = Math.max(8, Math.min(40, Math.floor(budget.props)));
  return withPrivateThreeRandom(() => {
    const group = new THREE.Group();
    group.name = 'decorative-props';
    // ONE shared geometry/material pool for the whole scatter (Codex review on #327): every
    // prop references it, so N props add a fixed handful of geometries, not N×(2..5).
    const pool = createPropPool();
    for (let i = 0; i < count; i++) {
      const arch = PROP_CATALOG[Math.floor(rng() * PROP_CATALOG.length)] ?? PROP_CATALOG[0]!;
      const prop = arch.build(rng, pool);
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (FLANK_MIN_X + rng() * FLANK_SPAN_X);
      const z = Z_MIN + rng() * Z_SPAN;
      const y = ctx.getTerrainHeight(x, z);
      prop.position.set(x, y, z);
      prop.rotation.y = rng() * Math.PI * 2;
      const s = 0.85 + rng() * 0.5;
      prop.scale.setScalar(s);
      group.add(prop);
    }
    return group;
  });
}
