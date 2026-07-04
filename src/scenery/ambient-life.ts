// Ambient life — drifting clouds, circling birds, blowing spindrift (issue #320, PR 7).
//
// The final scenery layer and the FIRST with per-frame motion: soft clouds drift across the
// sky, a small flock of birds circles high overhead, and wind-blown snow spindrift streams over
// the upper slope. Together they bring the static world to life.
//
// MOTION SAFETY:
//   * prefers-reduced-motion — under the OS "reduce motion" setting the whole layer FREEZES at
//     its deterministic initial layout (mirrors the sun cycle in sky.ts). No animation at all.
//   * cosmetic-only — update() reads dt + the wind strength and writes ONLY its own instance
//     matrices; it never touches pos/velocity/terrain/course/collision. It advances off its OWN
//     accumulated time (not wall-clock), so it can't perturb the deterministic sim, and the
//     physics-invariant harness never runs this render-frame code anyway.
//
// INVARIANTS (issue #320): render-only (no shadows), collision/physics-neutral, and
// Math.random-stream-neutral (initial layout from the seeded `rng`; per-frame updates use only
// Matrix4/Vector math — no Math.random; every THREE construction wrapped in
// withPrivateThreeRandom). Three InstancedMeshes (clouds/birds/spindrift) — one geometry each,
// so the layer adds a fixed, tiny geometry count. Teardown falls out of the scenery group sweep.

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The live ambient-life layer: its group plus a cosmetic per-frame tick. */
export interface AmbientLifeSystem {
  group: THREE.Group;
  update(dt: number, playerPosition: THREE.Vector3, windStrength: number): void;
}

// Prevailing drift direction for clouds + spindrift (unit-ish), scaled by wind strength.
const DRIFT_X = 0.92, DRIFT_Z = -0.39;

/** A shallow double-wing "bird" silhouette, made DOUBLE-FACED in the geometry (front + reversed
 *  winding) so it reads from any angle WITHOUT `side: DoubleSide` — which would set the
 *  DOUBLE_SIDED shader define and compile a distinct program (perf-budget: keep all ambient
 *  materials FrontSide so they share ONE instanced-basic-fog program). Origin at its body. */
function birdGeometry(): THREE.BufferGeometry {
  const positions = [
    0, 0, 0.10,   // 0 front body
    0, 0, -0.20,  // 1 back body
    -1, 0.30, 0,  // 2 left tip
    1, 0.30, 0,   // 3 right tip
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Front faces + the same triangles wound the other way => visible from both sides.
  geo.setIndex([0, 1, 2, 0, 3, 1, /* back */ 0, 2, 1, 0, 1, 3]);
  geo.computeVertexNormals();
  return geo;
}

/** A double-faced flat quad (two triangles + their reverse) for spindrift wisps, so they read
 *  from both sides on a FrontSide material (again avoiding the DOUBLE_SIDED program). Unit width,
 *  0.28 tall, centred at the origin in the XY plane. */
function wispGeometry(): THREE.BufferGeometry {
  const hw = 0.5, hh = 0.14;
  const positions = [-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, /* back */ 0, 2, 1, 0, 3, 2]);
  geo.computeVertexNormals();
  return geo;
}

export function buildAmbientLife(rng: () => number, budget: SceneryBudget): AmbientLifeSystem {
  const ae = Math.floor(budget.ambientEmitters);
  const cloudCount = Math.max(4, Math.min(10, Math.round(ae * 0.7)));
  const birdCount = Math.max(6, Math.min(16, ae));
  const driftCount = Math.max(24, Math.min(60, ae * 4));

  // --- Deterministic initial layout data (from the seeded rng; no THREE, no Math.random) ---
  // Clouds: high, spread wide, drifting along the prevailing wind.
  const cloud = {
    x: new Array<number>(cloudCount), y: new Array<number>(cloudCount), z: new Array<number>(cloudCount),
    sx: new Array<number>(cloudCount), sy: new Array<number>(cloudCount), sz: new Array<number>(cloudCount),
    phase: new Array<number>(cloudCount),
  };
  for (let i = 0; i < cloudCount; i++) {
    cloud.x[i] = -420 + rng() * 840;
    cloud.y[i] = 95 + rng() * 55;
    cloud.z[i] = -420 + rng() * 700;
    cloud.sx[i] = 22 + rng() * 26;
    cloud.sy[i] = 7 + rng() * 5;
    cloud.sz[i] = 22 + rng() * 26;
    cloud.phase[i] = rng() * 1000;
  }
  // Birds: circle a high centre, each on its own radius/speed/height/phase.
  const bird = {
    cx: new Array<number>(birdCount), cz: new Array<number>(birdCount), cy: new Array<number>(birdCount),
    r: new Array<number>(birdCount), spd: new Array<number>(birdCount), ang: new Array<number>(birdCount), scl: new Array<number>(birdCount),
  };
  for (let i = 0; i < birdCount; i++) {
    bird.cx[i] = -120 + rng() * 240;
    bird.cz[i] = -260 + rng() * 240;
    bird.cy[i] = 55 + rng() * 45;
    bird.r[i] = 14 + rng() * 26;
    bird.spd[i] = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.4);
    bird.ang[i] = rng() * Math.PI * 2;
    bird.scl[i] = 2.4 + rng() * 1.8;
  }
  // Spindrift: wisps of blown snow over the upper slope, streaming with the wind and recycling.
  const drift = {
    x: new Array<number>(driftCount), y: new Array<number>(driftCount), z: new Array<number>(driftCount),
    spd: new Array<number>(driftCount), scl: new Array<number>(driftCount), rot: new Array<number>(driftCount),
  };
  for (let i = 0; i < driftCount; i++) {
    drift.x[i] = -170 + rng() * 340;
    drift.y[i] = 26 + rng() * 60;
    drift.z[i] = -200 + rng() * 220;
    drift.spd[i] = 14 + rng() * 22;
    drift.scl[i] = 2.5 + rng() * 4;
    drift.rot[i] = rng() * Math.PI * 2;
  }

  const reduced = prefersReducedMotion();
  let time = 0;
  // Accumulated wind-drift offset (Codex review on #332): clouds + spindrift translate by this,
  // advanced by `dt * wind` each frame. Integrating the drift (rather than multiplying the
  // CURRENT wind sample by total elapsed time) means a gust only affects FUTURE motion — with
  // `wind * time` a strength change re-evaluated all prior history and teleported the instances.
  let windDrift = 0;

  // Scratch (reused each frame; no per-frame allocation).
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();

  const built = withPrivateThreeRandom(() => {
    const group = new THREE.Group();
    group.name = 'ambient-life';
    // All three materials are unlit MeshBasicMaterial + fog + FrontSide, so they share ONE
    // instanced-basic-fog shader program (the same one the valley forest patches already use).
    // Colour is a uniform and `transparent`/`depthWrite` are render state — NONE add a program;
    // only `side: DoubleSide` would (DOUBLE_SIDED define), which is why the flat bird/wisp
    // geometries are double-faced instead. Keeps the layer within the tight perf-budget.
    const clouds = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xf4f8fd, fog: true }),
      cloudCount,
    );
    clouds.name = 'ambient-clouds';

    const birds = new THREE.InstancedMesh(
      birdGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x3a3f47, fog: true }),
      birdCount,
    );
    birds.name = 'ambient-birds';

    // Opaque, pale wisps: keeping spindrift opaque (rather than transparent) means all three
    // ambient materials are the SAME program config (unlit basic + fog + FrontSide, colour is a
    // uniform), so they share ONE program — the very one the valley forest patches already use —
    // and the layer adds ~0 shader programs, staying well within the tight perf-budget ceiling.
    const spindrift = new THREE.InstancedMesh(
      wispGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xeaf2fb, fog: true }),
      driftCount,
    );
    spindrift.name = 'ambient-spindrift';

    for (const mesh of [clouds, birds, spindrift]) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // wide-ranging instances; keep them from popping at cull edges
    }
    group.add(clouds, birds, spindrift);
    return { group, clouds, birds, spindrift };
  });

  const { group, clouds, birds, spindrift } = built;

  // Wrap a value into [-half, half] (deterministic recycle for clouds/spindrift).
  const wrap = (v: number, half: number): number => {
    const span = half * 2;
    return ((((v + half) % span) + span) % span) - half;
  };

  function writeFrame(): void {
    // Clouds — drift along the prevailing wind, wrapped over a wide span. Offset is the
    // ACCUMULATED wind-drift (integrated in update), so a gust never re-evaluates past motion.
    for (let i = 0; i < cloudCount; i++) {
      const cx = wrap((cloud.x[i] as number) + DRIFT_X * 2.2 * windDrift, 460);
      const cz = wrap((cloud.z[i] as number) + DRIFT_Z * 2.2 * windDrift, 460);
      p.set(cx, cloud.y[i] as number, cz);
      q.identity();
      s.set(cloud.sx[i] as number, cloud.sy[i] as number, cloud.sz[i] as number);
      m.compose(p, q, s);
      clouds.setMatrixAt(i, m);
    }
    clouds.instanceMatrix.needsUpdate = true;
    // Birds — circle their centre; yaw faces the tangent of travel.
    for (let i = 0; i < birdCount; i++) {
      const a = (bird.ang[i] as number) + (bird.spd[i] as number) * time;
      const r = bird.r[i] as number;
      const bx = (bird.cx[i] as number) + Math.cos(a) * r;
      const bz = (bird.cz[i] as number) + Math.sin(a) * r;
      const by = (bird.cy[i] as number) + Math.sin(a * 2) * 2.5;
      p.set(bx, by, bz);
      e.set(0, -a + (bird.spd[i]! < 0 ? Math.PI : 0), 0);
      q.setFromEuler(e);
      const sc = bird.scl[i] as number;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      birds.setMatrixAt(i, m);
    }
    birds.instanceMatrix.needsUpdate = true;
    // Spindrift — stream with the wind over the slope, recycling across the span. Per-wisp
    // speed scales the shared accumulated wind-drift (so gusts only push future motion).
    for (let i = 0; i < driftCount; i++) {
      const spd = drift.spd[i] as number;
      const dx = wrap((drift.x[i] as number) + DRIFT_X * spd * windDrift, 190);
      const dz = wrap((drift.z[i] as number) + DRIFT_Z * spd * windDrift, 190);
      const dy = (drift.y[i] as number) + Math.sin(time * 0.6 + i) * 1.5;
      p.set(dx, dy, dz);
      e.set(0, (drift.rot[i] as number), 0);
      q.setFromEuler(e);
      const sc = drift.scl[i] as number;
      s.set(sc, sc * 0.6, sc);
      m.compose(p, q, s);
      spindrift.setMatrixAt(i, m);
    }
    spindrift.instanceMatrix.needsUpdate = true;
  }

  // Seed the static initial frame (also the frozen frame under reduced motion).
  writeFrame();

  function update(dt: number, _playerPosition: THREE.Vector3, windStrength: number): void {
    if (reduced) return;            // frozen under prefers-reduced-motion
    if (!(dt > 0)) return;          // no-op on a zero/negative delta
    time += dt;
    // Integrate wind drift: gentle even in calm, faster in gusts. Only future motion is affected.
    windDrift += dt * (0.4 + windStrength * 1.6);
    writeFrame();
  }

  return { group, update };
}
