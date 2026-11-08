// Cliff / cornice extensions — flank rock outcrops (issue #320, PR 5).
//
// Tall, craggy, snow-capped rock outcrops that rise from the OUTER flanks of the run,
// interspersed with the forest belts (PR 4), adding vertical drama and enclosure — a rocky
// valley wall. This EXTENDS the existing flank-cliff/rock drama; it is NOT a second collision
// rock system. The outcrops are decorative silhouettes only.
//
// PLACEMENT: on the outer flanks, |x|∈[122,148] (inside the ±150 terrain, outside the racing
// lane and the corridor walls), z∈[-190,30]. Grounded on the terrain via a read-only
// getTerrainHeight sample, with the base sunk slightly so each outcrop emerges from the slope
// instead of floating.
//
// INVARIANTS (issue #320): render-only (lit like the scene but casts/receives no shadow, no
// per-frame update), collision-neutral — NEVER added to rockPositions/treePositions, so it
// adds rock drama without being an obstacle — physics-neutral, and Math.random-stream-neutral
// (all placement + the crag perturbation from the seeded rng; every THREE construction wrapped
// in withPrivateThreeRandom). One InstancedMesh; the scenery dispose sweep frees its buffer.

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';
import type { SceneryContext } from './scenery.js';

const FLANK_MIN_X = 122;   // inner edge — outside the lane, corridor walls, and most belt trees
const FLANK_SPAN_X = 26;   // → outer edge ~148, inside the ±150 terrain
const Z_MIN = -190;
const Z_SPAN = 220;
const ROCK: [number, number, number] = hexRgb(0x8a9099); // grey stone
const SNOW: [number, number, number] = hexRgb(0xeef4fb); // snow cap / cornice

function hexRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * One craggy, snow-capped rock geometry (shared by every instance). Built from a subdivided
 * icosahedron whose radius is perturbed by a smooth function of each vertex's DIRECTION — so
 * the duplicated non-indexed vertices at a shared corner get the SAME offset and the mesh never
 * tears — then stretched tall. Per-vertex colours give a grey rock base fading to a white snow
 * cap / cornice near the top. All randomness from the seeded rng; constructed under the guard.
 */
function craggyRockGeometry(rng: () => number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // Perturbation coefficients (seeded) — a couple of low-frequency lobes for big crags.
  const f1 = 2 + Math.floor(rng() * 3), p1 = rng() * Math.PI * 2;
  const f2 = 2 + Math.floor(rng() * 3), p2 = rng() * Math.PI * 2;
  const f3 = 3 + Math.floor(rng() * 4), p3 = rng() * Math.PI * 2;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const az = Math.atan2(z, x);          // direction only → shared corners perturb identically
    const el = Math.asin(Math.max(-1, Math.min(1, y / len)));
    const bump = 1
      + 0.28 * Math.sin(f1 * az + p1) * Math.cos(f2 * el + p2)
      + 0.14 * Math.sin(f3 * (az + el) + p3);
    const nx = x * bump, ny = y * bump * 1.5 /* stretch tall */, nz = z * bump;
    pos.setXYZ(i, nx, ny, nz);
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // Snow-cap colours by normalized local height: grey rock below, white snow/cornice above.
  const colors = new Float32Array(pos.count * 3);
  const span = maxY - minY || 1;
  for (let i = 0; i < pos.count; i++) {
    const yn = (pos.getY(i) - minY) / span;
    const shade = 0.8 + 0.2 * yn;                 // faces lighten a touch upward
    const rock: [number, number, number] = [ROCK[0] * shade, ROCK[1] * shade, ROCK[2] * shade];
    const snow = smoothstep(0.6, 0.9, yn);
    colors[i * 3] = rock[0] + (SNOW[0] - rock[0]) * snow;
    colors[i * 3 + 1] = rock[1] + (SNOW[1] - rock[1]) * snow;
    colors[i * 3 + 2] = rock[2] + (SNOW[2] - rock[2]) * snow;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** How many outcrops to build for a given budget. */
function cliffCount(budget: SceneryBudget): number {
  return Math.max(10, Math.min(28, Math.floor(budget.props)));
}

/**
 * Build the flank cliff outcrops: one InstancedMesh of a craggy snow-capped rock, scattered on
 * the outer flanks and grounded on the terrain. Static (no per-frame update); the caller
 * (createScenery) parents the group under the scenery group.
 */
export function buildCliffBands(rng: () => number, budget: SceneryBudget, ctx: SceneryContext): THREE.Group {
  const count = cliffCount(budget);

  // Per-instance transforms from the seeded rng; terrain height READ for grounding.
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scl = new THREE.Vector3();
  const transforms: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const x = side * (FLANK_MIN_X + rng() * FLANK_SPAN_X);
    const z = Z_MIN + rng() * Z_SPAN;
    const sx = 3 + rng() * 4;
    const sy = 8 + rng() * 12;      // tall rock face
    const sz = 3 + rng() * 4;
    const ground = ctx.getTerrainHeight(x, z);
    pos.set(x, ground - sy * 0.15, z); // sink the base so it emerges from the slope, not floats
    euler.set(0, rng() * Math.PI * 2, 0);
    quat.setFromEuler(euler);
    scl.set(sx, sy, sz);
    transforms.push(new THREE.Matrix4().compose(pos, quat, scl));
  }

  return withPrivateThreeRandom(() => {
    const group = new THREE.Group();
    group.name = 'cliff-bands';
    const geo = craggyRockGeometry(rng);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, fog: true });
    const cliffs = new THREE.InstancedMesh(geo, mat, count);
    cliffs.name = 'cliff-outcrops';
    cliffs.castShadow = false;   // decorative — no shadow-map cost
    cliffs.receiveShadow = false;
    for (let i = 0; i < count; i++) cliffs.setMatrixAt(i, transforms[i] as THREE.Matrix4);
    cliffs.instanceMatrix.needsUpdate = true;
    group.add(cliffs);
    return group;
  });
}
