// Valley backdrop — frozen lake, far lodges, forest patches (issue #320, PR 3).
//
// The mid-distance scenery band that sits BETWEEN the play area and the distant ridge
// panorama (PR 2, radius ~520): a frozen lake in a side valley, a small cluster of far
// lodge silhouettes on its shore, and scattered low forest/meadow patches. Together they
// give the descent somewhere to look out over — a populated valley rather than empty snow
// between the course and the horizon.
//
// Placed off the course to the downhill-left and set into a basin (a low, flat floor Y),
// at ~250–450 from the play corridor so the scene's distance fog (FOG_NEAR=140) hazes it
// gently — present but clearly "over there", never competing with gameplay.
//
// INVARIANTS (issue #320): render-only (unlit MeshBasicMaterial, NO reflective/mirror
// shader on the lake, no shadows, no per-frame update), collision-neutral & physics-neutral
// (pure geometry in the scenery group; never touches treePositions/rockPositions/pos/
// velocity), and Math.random-stream-neutral (placement from the seeded `rng`; every THREE
// construction wrapped in withPrivateThreeRandom). `getTerrainHeight` is READ ONLY and only
// used to keep the lakeside props from floating; terrain is never mutated.

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';
import type { SceneryContext } from './scenery.js';

// Valley center (world units). Placed DOWN the fall line, just past the terrain's far edge
// (the mesh spans z∈[-200,200]), so it sits in the open below the descending slope where
// the player looks as they ski — not tucked behind a terrain shoulder. Slightly left of the
// course centerline, set into a low basin, and inside the fog band (~285–400 from the run).
const VALLEY_CX = -90;
const VALLEY_CZ = -470;
const FLOOR_Y = -70;          // basin floor: well below the play surface, so it reads as a deep valley
const LAKE_RADIUS = 135;      // frozen lake extent
const LAKE_COLOR = 0xcfe3f2;  // pale, flat ice (no reflection — render-only)
const LODGE_WALL = 0x5b4636;  // dark timber silhouette
const LODGE_ROOF = 0xe8eef5;  // snow-capped roof
const PATCH_COLOR = 0x33502f; // muted valley forest green

/** Flat, irregular frozen lake disc (a triangle fan with rng-jittered rim). Unlit and
 *  fog-hazed — deliberately NOT reflective (render-only invariant). */
function buildLake(rng: () => number): THREE.Mesh {
  const rim = 48;
  const positions: number[] = [VALLEY_CX, FLOOR_Y, VALLEY_CZ]; // center vertex
  const radii: number[] = [];
  for (let i = 0; i < rim; i++) radii.push(LAKE_RADIUS * (0.78 + rng() * 0.3));
  for (let i = 0; i <= rim; i++) {
    const k = i % rim;
    const theta = (i / rim) * Math.PI * 2;
    // Slight elliptical squash so it reads as a lake, not a perfect circle.
    positions.push(
      VALLEY_CX + Math.cos(theta) * (radii[k] ?? LAKE_RADIUS) * 1.15,
      FLOOR_Y,
      VALLEY_CZ + Math.sin(theta) * (radii[k] ?? LAKE_RADIUS) * 0.8,
    );
  }
  const indices: number[] = [];
  for (let i = 0; i < rim; i++) indices.push(0, i + 1, i + 2);
  return withPrivateThreeRandom(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({ color: LAKE_COLOR, side: THREE.DoubleSide, fog: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'frozen-lake';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  });
}

/** A single far lodge silhouette: a dark timber box under a snow-capped pyramid roof. */
function buildLodge(rng: () => number, x: number, z: number, groundY: number): THREE.Group {
  const w = 8 + rng() * 6;
  const h = 6 + rng() * 4;
  const d = 6 + rng() * 5;
  const roofH = 4 + rng() * 3;
  const rot = rng() * Math.PI * 2;
  return withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'lodge';
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color: LODGE_WALL, fog: true }),
    );
    wall.position.set(x, groundY + h / 2, z);
    wall.castShadow = false; wall.receiveShadow = false;
    // 4-sided pyramid roof (ConeGeometry with 4 radial segments), aligned to the box.
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(w, d) * 0.78, roofH, 4),
      new THREE.MeshBasicMaterial({ color: LODGE_ROOF, fog: true }),
    );
    roof.position.set(x, groundY + h + roofH / 2, z);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = false; roof.receiveShadow = false;
    g.add(wall, roof);
    g.rotation.y = rot;
    return g;
  });
}

/** A cluster of far lodges along the lake's near shore. Count is budget-bounded. */
function buildLodges(rng: () => number, budget: SceneryBudget, ctx: SceneryContext): THREE.Group {
  const count = Math.max(3, Math.min(6, Math.floor(budget.props / 4)));
  const group = withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'lodges';
    return g;
  });
  for (let i = 0; i < count; i++) {
    // Along an arc on the near (toward-course) shore of the lake.
    const a = -Math.PI * 0.15 + (i / Math.max(1, count - 1)) * Math.PI * 0.5;
    const r = LAKE_RADIUS * (1.05 + rng() * 0.25);
    const x = VALLEY_CX + Math.cos(a) * r * 1.15;
    const z = VALLEY_CZ + Math.sin(a) * r * 0.8;
    // Read-only terrain sample keeps a lodge from floating if the basin edge rises; clamp
    // to the basin floor so it never sinks below the lake.
    const groundY = Math.max(FLOOR_Y, ctx.getTerrainHeight(x, z));
    group.add(buildLodge(rng, x, z, groundY));
  }
  return group;
}

/** Scattered low forest/meadow patches (one InstancedMesh, no collision). Distinct from the
 *  gameplay forest — purely a valley texture. */
function buildForestPatches(rng: () => number, budget: SceneryBudget): THREE.InstancedMesh {
  const count = Math.max(24, Math.min(budget.forestBeltTrees, 80));
  const dummy = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  // Precompute transforms from the seeded rng (no THREE-uuid draws here).
  const transforms: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = LAKE_RADIUS * (1.2 + rng() * 1.4);
    const x = VALLEY_CX + Math.cos(a) * r * 1.2;
    const z = VALLEY_CZ + Math.sin(a) * r * 0.85;
    const s = 4 + rng() * 6;
    pos.set(x, FLOOR_Y + s * 0.5, z);
    quat.set(0, 0, 0, 1);
    scl.set(s * (0.7 + rng() * 0.6), s, s * (0.7 + rng() * 0.6));
    transforms.push(dummy.clone().compose(pos, quat, scl));
  }
  return withPrivateThreeRandom(() => {
    // Low-poly squashed cone reads as a distant conifer clump.
    const geo = new THREE.ConeGeometry(0.7, 1.6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: PATCH_COLOR, fog: true });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.name = 'valley-forest-patches';
    inst.castShadow = false;
    inst.receiveShadow = false;
    for (let i = 0; i < count; i++) inst.setMatrixAt(i, transforms[i] as THREE.Matrix4);
    inst.instanceMatrix.needsUpdate = true;
    return inst;
  });
}

/**
 * Build the valley backdrop group: frozen lake + far lodges + forest patches, all seeded off
 * `rng` so the same tier composes the same valley. Static (no per-frame update); the caller
 * (createScenery) parents it under the scenery group.
 */
export function buildValleyBackdrop(rng: () => number, budget: SceneryBudget, ctx: SceneryContext): THREE.Group {
  const group = withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'valley-backdrop';
    return g;
  });
  group.add(buildLake(rng));
  group.add(buildForestPatches(rng, budget));
  group.add(buildLodges(rng, budget, ctx));
  return group;
}
