// Decorative forest belts — side-slope conifer bands (issue #320, PR 4).
//
// Instanced conifer belts that thicken the tree line along the OUTER flanks of the run,
// beyond the gameplay forest and well outside the racing lane. They add depth and enclosure
// to the descent — a forested valley wall — without ever being obstacles.
//
// PLACEMENT: the terrain mesh is 300×400 (x∈[-150,150], z∈[-200,200]); the gameplay forest
// reaches |x|≈100. The belts sit in the |x|∈[102,145] band on BOTH flanks, z∈[-190,40], so
// they stand on rendered terrain (grounded via getTerrainHeight — reading is fine here, the
// terrain exists) just outside the play area. They are NEVER added to treePositions, so they
// borrow the forest's LOOK but none of its collision semantics.
//
// INVARIANTS (issue #320): render-only (lit like the scene but casts/receives no shadow, no
// per-frame update), collision-neutral (not in treePositions/rockPositions) & physics-neutral,
// and Math.random-stream-neutral — ALL placement from the seeded `rng`, every THREE
// construction wrapped in withPrivateThreeRandom. Two InstancedMeshes (foliage + trunks) keep
// it to two draws; the scenery dispose sweep frees their instance buffers.

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';
import type { SceneryContext } from './scenery.js';

const LANE_SAFETY_X = 102;   // inner edge of the belt band — clear of the widest curved lane + margin
const BELT_SPAN_X = 43;      // belt band width per flank → outer edge ~145, inside the ±150 terrain
const Z_MIN = -190;          // along the run length, within the terrain
const Z_SPAN = 230;          // z ∈ [-190, 40]
const TRUNK_H = 1.4;
const FOLIAGE_COLOR = 0x2e5d34;
const TRUNK_COLOR = 0x6b4a2f;

/** Concatenate several indexed geometries (position+normal) into one, offsetting indices. Avoids
 *  the three/addons merge util (kept out of raw-source deployed paths, per sky.ts). */
function mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const g of geos) {
    const p = g.attributes.position!.array as ArrayLike<number>;
    const nrm = g.attributes.normal!.array as ArrayLike<number>;
    const idx = g.index!.array as ArrayLike<number>;
    const base = positions.length / 3;
    for (let i = 0; i < p.length; i++) positions.push(p[i]!);
    for (let i = 0; i < nrm.length; i++) normals.push(nrm[i]!);
    for (let i = 0; i < idx.length; i++) indices.push(idx[i]! + base);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(indices);
  return out;
}

/** A two-tier conifer canopy, origin at the ground (base sits on the trunk top). Guarded. */
function foliageGeometry(): THREE.BufferGeometry {
  const c1 = new THREE.ConeGeometry(1.4, 3.0, 7);
  c1.translate(0, TRUNK_H + 1.5, 0);
  const c2 = new THREE.ConeGeometry(1.0, 2.4, 7);
  c2.translate(0, TRUNK_H + 3.1, 0);
  return mergeIndexed([c1, c2]);
}

/** A thin trunk cylinder, base at the ground. Guarded. */
function trunkGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.16, 0.24, TRUNK_H, 6);
  g.translate(0, TRUNK_H / 2, 0);
  return g;
}

/**
 * Build the decorative forest belts: two InstancedMeshes (foliage + trunks) of conifers along
 * the outer flanks, seeded off `rng` and grounded on the terrain. Static (no per-frame update);
 * the caller (createScenery) parents the group under the scenery group.
 */
export function buildForestBelts(rng: () => number, budget: SceneryBudget, ctx: SceneryContext): THREE.Group {
  const count = Math.max(60, Math.min(400, Math.floor(budget.forestBeltTrees)));

  // Precompute per-instance transforms from the seeded rng (no THREE-uuid draws here). Terrain
  // height is READ for grounding — the belts are on the rendered terrain, so this is valid.
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scl = new THREE.Vector3();
  const transforms: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const x = side * (LANE_SAFETY_X + rng() * BELT_SPAN_X);
    const z = Z_MIN + rng() * Z_SPAN;
    const y = ctx.getTerrainHeight(x, z);
    const s = 0.8 + rng() * 0.9;
    pos.set(x, y, z);
    euler.set(0, rng() * Math.PI * 2, 0);
    quat.setFromEuler(euler);
    scl.set(s, s * (0.9 + rng() * 0.4), s);
    transforms.push(new THREE.Matrix4().compose(pos, quat, scl));
  }

  return withPrivateThreeRandom(() => {
    const group = new THREE.Group();
    group.name = 'forest-belts';

    const foliage = new THREE.InstancedMesh(
      foliageGeometry(),
      new THREE.MeshStandardMaterial({ color: FOLIAGE_COLOR, roughness: 0.85, flatShading: true, fog: true }),
      count,
    );
    foliage.name = 'forest-belt-foliage';
    const trunks = new THREE.InstancedMesh(
      trunkGeometry(),
      new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.9, flatShading: true, fog: true }),
      count,
    );
    trunks.name = 'forest-belt-trunks';

    for (const mesh of [foliage, trunks]) {
      mesh.castShadow = false;   // cosmetic belt — no shadow-map cost for hundreds of instances
      mesh.receiveShadow = false;
    }
    for (let i = 0; i < count; i++) {
      const m = transforms[i] as THREE.Matrix4;
      foliage.setMatrixAt(i, m);
      trunks.setMatrixAt(i, m);
    }
    foliage.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;

    group.add(foliage, trunks);
    return group;
  });
}
