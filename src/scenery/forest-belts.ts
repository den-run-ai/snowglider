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
const TRUNK_COLOR = 0x6b4a2f;
// Per-vertex foliage palette: deep shadowed green at the base → lit green up the crown →
// frosted snow dusting on the upper tiers, so the belt conifers read as natural snow-laden firs
// instead of flat cartoon cones (blends with the EZ gameplay forest). Owner feedback, PR 4b.
const GREEN_LOW: [number, number, number] = hexRgb(0x24401f);
const GREEN_HIGH: [number, number, number] = hexRgb(0x40703a);
const SNOW: [number, number, number] = hexRgb(0xecf2f8);

function hexRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

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

/** A tapered multi-tier conifer canopy with a per-vertex green→snow gradient, origin at the
 *  ground (base sits on the trunk top). Four overlapping cones of decreasing radius/height give
 *  a natural fir silhouette; the upper tiers frost toward snow. Guarded. */
function foliageGeometry(): THREE.BufferGeometry {
  const tiers = [
    { r: 1.75, h: 2.3, y: TRUNK_H + 1.0 },
    { r: 1.35, h: 2.1, y: TRUNK_H + 2.2 },
    { r: 0.98, h: 1.9, y: TRUNK_H + 3.35 },
    { r: 0.6, h: 1.7, y: TRUNK_H + 4.45 },
  ];
  const geo = mergeIndexed(tiers.map((t) => {
    const c = new THREE.ConeGeometry(t.r, t.h, 8);
    c.translate(0, t.y, 0);
    return c;
  }));

  // Colour by normalized height: deep green base → lit green crown, with a snow dusting frosting
  // the upper tiers (blended, not pure white, so it reads as snow-laden rather than a snowman).
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < posAttr.count; i++) { const y = posAttr.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = maxY - minY || 1;
  const colors = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    const yn = (posAttr.getY(i) - minY) / span;
    const g = Math.min(1, yn * 1.15); // green shade lightens up the crown
    const snow = smoothstep(0.5, 1.0, yn) * 0.55; // frost the upper half, partial blend
    for (let k = 0; k < 3; k++) {
      const green = lerp(GREEN_LOW[k]!, GREEN_HIGH[k]!, g);
      colors[i * 3 + k] = lerp(green, SNOW[k]!, snow);
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
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
      // vertexColors carries the green→snow gradient; flatShading+fog+vertexColors shares the
      // SAME shader program the cliff outcrops already compile, so this adds no new program.
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true, fog: true }),
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
