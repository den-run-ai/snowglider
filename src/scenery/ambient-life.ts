// Ambient life — drifting clouds, circling birds, blowing spindrift (issue #320, PR 7).
//
// The final scenery layer and the FIRST with per-frame motion: soft clouds drift across the
// sky, a small flock of birds circles high overhead, and wind-blown snow spindrift streams over
// the upper slope. Together they bring the static world to life.
//
// MOTION SAFETY:
//   * prefers-reduced-motion — under the OS "reduce motion" setting the whole layer FREEZES at
//     its deterministic initial layout (mirrors the sun cycle in sky.ts). No animation at all.
//   * cosmetic-only — update() reads dt + the shared wind vector and writes ONLY its own
//     instance matrices and powder opacity; it never touches pos/velocity/terrain/course/collision. It advances off its OWN
//     accumulated time (not wall-clock), so it can't perturb the deterministic sim, and the
//     physics-invariant harness never runs this render-frame code anyway.
//
// INVARIANTS (issue #320): render-only (no shadows), collision/physics-neutral, and
// Math.random-stream-neutral (initial layout from the seeded `rng`; per-frame updates use only
// Matrix4/Vector math — no Math.random; every THREE construction wrapped in
// withPrivateThreeRandom). Three InstancedMeshes (clouds/birds/spindrift) — one geometry each,
// so the layer adds a fixed, tiny geometry count. Teardown falls out of the scenery group sweep.

import * as THREE from 'three';
import { DEFAULT_WIND_CONFIG, WIND_REFERENCE_SPEED } from '../wind.js';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The live ambient-life layer: its group plus a cosmetic per-frame tick. */
export interface AmbientLifeSystem {
  group: THREE.Group;
  update(dt: number, playerPosition: THREE.Vector3, windStrength: number, windX?: number, windZ?: number): void;
  reset(): void;
}

const DRIFT_HALF_X = 140;
const DRIFT_HALF_Z = 188;
const WIND_REFERENCE = WIND_REFERENCE_SPEED;

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

/** Tapered, overlapping powder ribbons. Three faint nested silhouettes soften the edge
 *  through ordinary alpha blending, without a texture or another shader variant. The two
 *  crossed ribbons keep a wisp visible from both low chase and overhead camera views;
 *  reverse-wound faces retain the shared FrontSide program. */
function wispGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const contour: ReadonlyArray<readonly [number, number]> = [[-0.5, 0], [-0.26, -0.07], [0.2, -0.05], [0.5, 0], [0.24, 0.045], [-0.2, 0.06]];
  for (const angle of [-0.55, 0.55]) {
    for (const scale of [1, 0.76, 0.5]) {
      const start = positions.length / 3;
      for (const [x, y] of contour) positions.push(x * scale, y * scale * Math.cos(angle), y * scale * Math.sin(angle));
      for (let j = 1; j < contour.length - 1; j++) {
        indices.push(start, start + j, start + j + 1, start, start + j + 1, start + j);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function buildAmbientLife(
  rng: () => number, budget: SceneryBudget,
  getTerrainHeight: (x: number, z: number) => number = () => 0,
): AmbientLifeSystem {
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
  // Spindrift stays on the rendered slope. y is a small ground clearance, not world altitude.
  const drift = {
    x: new Array<number>(driftCount), y: new Array<number>(driftCount), z: new Array<number>(driftCount),
    spd: new Array<number>(driftCount), scl: new Array<number>(driftCount), phase: new Array<number>(driftCount),
  };
  for (let i = 0; i < driftCount; i++) {
    drift.x[i] = -130 + rng() * 260;
    drift.y[i] = 0.28 + rng() * 0.34;
    drift.z[i] = -178 + rng() * 356;
    drift.spd[i] = 0.5 + rng() * 0.5;
    drift.scl[i] = 2.4 + rng() * 2.4;
    drift.phase[i] = rng() * Math.PI * 2;
  }

  const reduced = prefersReducedMotion();
  let time = 0;
  // Accumulated wind-drift offset (Codex review on #332): clouds + spindrift translate by this,
  // advanced by `dt * wind` each frame. Integrating the drift (rather than multiplying the
  // CURRENT wind sample by total elapsed time) means a gust only affects FUTURE motion — with
  // `wind * time` a strength change re-evaluated all prior history and teleported the instances.
  let windDriftX = 0;
  let windDriftZ = 0;
  let driftYaw = -DEFAULT_WIND_CONFIG.prevailingAngle;

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
      // Soft, translucent puffs. transparent + depthWrite:false so the low-poly icosahedra
      // read as hazy cloud volume rather than hard opaque pale discs floating in the sky
      // (which is how the fully-opaque version looked when the camera zoomed far out). This
      // is RENDER STATE only — not a shader-program define — so it stays program-neutral.
      new THREE.MeshBasicMaterial({ color: 0xf4f8fd, fog: true, transparent: true, opacity: 0.6, depthWrite: false }),
      cloudCount,
    );
    clouds.name = 'ambient-clouds';

    const birds = new THREE.InstancedMesh(
      birdGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x3a3f47, fog: true }),
      birdCount,
    );
    birds.name = 'ambient-birds';

    // Faint cool powder, faded in by actual wind speed. Layered tapered geometry softens
    // the silhouette without a new map/alpha/shader variant or opaque floating plates.
    const spindrift = new THREE.InstancedMesh(
      wispGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xe5edf6, fog: true, transparent: true, opacity: 0, depthWrite: false }),
      driftCount,
    );
    spindrift.name = 'ambient-spindrift';
    spindrift.visible = false;

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

  function writeFrame(forcePowder = false): void {
    // Clouds — drift along the prevailing wind, wrapped over a wide span. Offset is the
    // ACCUMULATED wind-drift (integrated in update), so a gust never re-evaluates past motion.
    for (let i = 0; i < cloudCount; i++) {
      const cx = wrap((cloud.x[i] as number) + 0.42 * windDriftX, 460);
      const cz = wrap((cloud.z[i] as number) + 0.42 * windDriftZ, 460);
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
    // Calm/reduced-motion powder is invisible: skip all terrain samples and GPU writes.
    if (!forcePowder && !spindrift.visible) return;
    // Ribbons follow the local terrain tangent and hover less than a metre above it.
    // All samples are read-only, and every scratch object is reused. Taper at the field
    // boundary before recycling so a wrap cannot flash a large streak across the view.
    const alongX = Math.cos(driftYaw);
    const alongZ = -Math.sin(driftYaw);
    for (let i = 0; i < driftCount; i++) {
      const spd = drift.spd[i] as number;
      const dx = wrap((drift.x[i] as number) + spd * windDriftX, DRIFT_HALF_X);
      const dz = wrap((drift.z[i] as number) + spd * windDriftZ, DRIFT_HALF_Z);
      const ground = getTerrainHeight(dx, dz);
      const dy = (Number.isFinite(ground) ? ground : 0) + (drift.y[i] as number)
        + 0.06 * Math.sin(time * 1.2 + (drift.phase[i] as number));
      const sc = drift.scl[i] as number;
      const halfLength = sc * 0.5;
      const h0 = getTerrainHeight(dx - alongX * halfLength, dz - alongZ * halfLength);
      const h1 = getTerrainHeight(dx + alongX * halfLength, dz + alongZ * halfLength);
      const pitch = Number.isFinite(h0) && Number.isFinite(h1) ? Math.atan2(h1 - h0, sc) : 0;
      p.set(dx, dy, dz);
      e.set(0, driftYaw, pitch, 'YXZ');
      q.setFromEuler(e);
      const edge = Math.min(1, (DRIFT_HALF_X - Math.abs(dx)) / 8, (DRIFT_HALF_Z - Math.abs(dz)) / 8);
      s.set(sc * edge, sc * 0.55 * edge, sc * 0.55 * edge);
      m.compose(p, q, s);
      spindrift.setMatrixAt(i, m);
    }
    spindrift.instanceMatrix.needsUpdate = true;
  }

  // Seed the static initial frame (also the frozen frame under reduced motion).
  writeFrame(true);

  function update(dt: number, _playerPosition: THREE.Vector3, windStrength: number, windX?: number, windZ?: number): void {
    if (reduced) return;            // frozen under prefers-reduced-motion
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const delta = Math.min(dt, 0.25); // bound resume gaps without ever integrating Infinity
    time += delta;
    // Older callers only supplied strength: use the field's prevailing direction for
    // that compatibility path. A supplied vector is authoritative, including exact calm.
    const strength = Number.isFinite(windStrength) ? Math.max(0, Math.min(1, windStrength)) : 0;
    const wx = windX === undefined ? Math.cos(DEFAULT_WIND_CONFIG.prevailingAngle) * strength * WIND_REFERENCE :
      (Number.isFinite(windX) ? Math.max(-30, Math.min(30, windX)) : 0);
    const wz = windZ === undefined ? Math.sin(DEFAULT_WIND_CONFIG.prevailingAngle) * strength * WIND_REFERENCE :
      (Number.isFinite(windZ) ? Math.max(-30, Math.min(30, windZ)) : 0);
    windDriftX += delta * wx;
    windDriftZ += delta * wz;
    const speed = Math.hypot(wx, wz);
    if (speed > 0.01) {
      const targetYaw = -Math.atan2(wz, wx);
      const angle = Math.atan2(Math.sin(targetYaw - driftYaw), Math.cos(targetYaw - driftYaw));
      driftYaw += angle * (1 - Math.exp(-4 * delta));
    }
    const opacity = 0.045 * Math.max(0, Math.min(1, (speed - 0.6) / 5.4));
    spindrift.material.opacity += (opacity - spindrift.material.opacity) * (1 - Math.exp(-5 * delta));
    spindrift.visible = spindrift.material.opacity > 0.001;
    writeFrame();
  }

  function reset(): void {
    time = 0;
    windDriftX = windDriftZ = 0;
    driftYaw = -DEFAULT_WIND_CONFIG.prevailingAngle;
    spindrift.material.opacity = 0;
    spindrift.visible = false;
    writeFrame(true);
  }

  return { group, update, reset };
}
