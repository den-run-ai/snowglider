// Wildlife — a small herd of alpine animals drifting in the far background
// (issue #366, Roadmap Finding 5, PR 1).
//
// Deliberately SIMPLE and purely BACKGROUND, exactly like the ambient birds already in
// scenery: a handful of low-poly animal silhouettes far out on the flanks that wander on
// slow, gentle loops. It never interacts with the game — no collision, no physics, no
// player reaction. It is the first content of the agent layer and proves the seam; richer,
// interactive agents (chasers, rival ghosts) come in later PRs behind the pure
// outcome-resolver pattern.
//
// MOTION SAFETY (mirrors scenery/ambient-life.ts):
//   * prefers-reduced-motion — the whole layer FREEZES at its deterministic initial layout.
//   * cosmetic-only — update() reads dt and writes ONLY its own instance matrices; it never
//     touches pos/velocity/terrain/course/collision. It advances off its OWN accumulated
//     time (not wall-clock), so it can't perturb the deterministic sim, and the
//     physics-invariant harness never runs this render-frame code anyway.
//
// INVARIANTS (issue #366): render-only (no shadows), collision/physics-neutral, and
// Math.random-stream-neutral (initial layout from the seeded `rng`; per-frame updates use
// only Matrix4/Vector math — no Math.random; every THREE construction wrapped in
// withPrivateThreeRandom). ONE InstancedMesh over ONE merged geometry with a
// MeshBasicMaterial+fog material — the SAME program the ambient birds already compiled, so
// the layer adds no shader program and a single geometry (perf budget has ~1 spare program).

import * as THREE from 'three';
import { withPrivateThreeRandom } from './agents-rng.js';
import type { AgentBudget } from './agents-budget.js';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The live wildlife layer: its group plus a cosmetic per-frame tick. */
export interface WildlifeSystem {
  group: THREE.Group;
  update(dt: number): void;
}

/** Append an axis-aligned box (centre + half-extents) into a shared position/index buffer,
 *  so the whole animal is ONE merged BufferGeometry. Normals are omitted on purpose —
 *  MeshBasicMaterial is unlit and ignores them, which keeps the geometry small. */
function appendBox(
  pos: number[], idx: number[],
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
): void {
  const base = pos.length / 3;
  // 8 corners of the box.
  for (let sx = -1; sx <= 1; sx += 2)
    for (let sy = -1; sy <= 1; sy += 2)
      for (let sz = -1; sz <= 1; sz += 2)
        pos.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
  // Corner order above is (sx,sy,sz): index = ((sx>0)<<2)|((sy>0)<<1)|(sz>0).
  const c = (x: number, y: number, z: number) => base + (x << 2) + (y << 1) + z;
  const quad = (a: number, b: number, d: number, e: number) => { idx.push(a, b, d, a, d, e); };
  // Six faces (winding not important — the animal reads as a solid silhouette at distance).
  quad(c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)); // -x
  quad(c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)); // +x
  quad(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)); // -y
  quad(c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)); // +y
  quad(c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)); // -z
  quad(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)); // +z
}

/** A minimal low-poly quadruped: body + head + four short legs, origin between the feet,
 *  facing +Z. Simple on purpose — it only ever reads as a background silhouette. */
function animalGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  appendBox(pos, idx, 0, 1.05, 0, 0.30, 0.34, 0.75);       // body
  appendBox(pos, idx, 0, 1.55, 0.72, 0.20, 0.22, 0.24);    // head (raised, forward)
  const lx = 0.24, lz = 0.55, lh = 0.5;                     // legs
  appendBox(pos, idx, lx, lh, lz, 0.09, lh, 0.09);
  appendBox(pos, idx, -lx, lh, lz, 0.09, lh, 0.09);
  appendBox(pos, idx, lx, lh, -lz, 0.09, lh, 0.09);
  appendBox(pos, idx, -lx, lh, -lz, 0.09, lh, 0.09);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // Compute normals so the geometry's attribute layout MATCHES the ambient-life bird/wisp
  // geometries exactly. MeshBasicMaterial is unlit and ignores normals, but sharing the
  // attribute layout keeps this InstancedMesh on the SAME compiled shader program as the
  // ambient birds (instanced-basic-fog) instead of forking a new one (perf budget).
  geo.computeVertexNormals();
  return geo;
}

export function buildWildlife(
  rng: () => number,
  budget: AgentBudget,
  getTerrainHeight: (x: number, z: number) => number,
): WildlifeSystem {
  const count = Math.max(0, Math.min(24, Math.floor(budget.wildlife)));

  // --- Deterministic initial layout (from the seeded rng; no THREE, no Math.random) ---
  // Each animal wanders a slow, gentle loop around a home point far out on ONE flank, well
  // outside the play corridor so it stays clearly a background creature, never an obstacle.
  const home = {
    x: new Array<number>(count), z: new Array<number>(count),
    r: new Array<number>(count), spd: new Array<number>(count),
    ang: new Array<number>(count), scl: new Array<number>(count),
  };
  for (let i = 0; i < count; i++) {
    const side = rng() < 0.5 ? -1 : 1;              // left or right flank
    home.x[i] = side * (70 + rng() * 60);           // |x| ∈ [70,130] — far background flank
    home.z[i] = -260 + rng() * 300;                 // spread along the descent
    home.r[i] = 5 + rng() * 9;                       // small wander radius
    home.spd[i] = (rng() < 0.5 ? -1 : 1) * (0.12 + rng() * 0.16); // slow amble
    home.ang[i] = rng() * Math.PI * 2;
    home.scl[i] = 1.1 + rng() * 0.6;
  }

  const reduced = prefersReducedMotion();
  let time = 0;

  // Scratch (reused each frame; no per-frame allocation).
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();

  const built = withPrivateThreeRandom(() => {
    const group = new THREE.Group();
    group.name = 'wildlife';
    // Unlit MeshBasicMaterial + fog + FrontSide — the SAME program the ambient birds
    // compiled, so this adds no shader program. A warm brown reads as an animal on snow.
    const mesh = new THREE.InstancedMesh(
      animalGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x6b5334, fog: true }),
      Math.max(1, count), // InstancedMesh needs a positive capacity even when the herd is empty
    );
    mesh.name = 'wildlife-herd';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // wide-spread instances; keep them from popping at cull edges
    mesh.count = count;         // draw only the real animals (capacity may be padded to 1)
    group.add(mesh);
    return { group, mesh };
  });

  const { group, mesh } = built;

  function writeFrame(): void {
    for (let i = 0; i < count; i++) {
      const a = (home.ang[i] as number) + (home.spd[i] as number) * time;
      const r = home.r[i] as number;
      const x = (home.x[i] as number) + Math.cos(a) * r;
      const z = (home.z[i] as number) + Math.sin(a) * r;
      // Ground the animal on the terrain (read-only sampler) plus a gentle amble bob.
      const y = getTerrainHeight(x, z) + Math.sin(time * 1.4 + i) * 0.06;
      p.set(x, y, z);
      // Face the tangent of travel (heading), flipped when ambling the other way.
      e.set(0, -a + (home.spd[i]! < 0 ? Math.PI : 0), 0);
      q.setFromEuler(e);
      const sc = home.scl[i] as number;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // Seed the static initial frame (also the frozen frame under reduced motion).
  writeFrame();

  function update(dt: number): void {
    if (reduced) return;   // frozen under prefers-reduced-motion
    if (!(dt > 0)) return; // no-op on a zero/negative delta
    if (count === 0) return;
    time += dt;
    writeFrame();
  }

  return { group, update };
}
