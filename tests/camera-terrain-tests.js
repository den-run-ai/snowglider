// @ts-check
// Actual terrain regressions plus independent geometric/budget tests for camera seating.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const THREE = await import('three');
  const { Camera, CAMERA_MODES } = await import('../src/camera.ts');
  const { seatCameraAboveTerrain, CAMERA_TERRAIN_MAX_CROSSINGS } = await import('../src/camera-terrain.ts');
  const terrain = await import('../src/mountains/terrain.ts');
  const { getDifficultyConfig } = await import('../src/difficulty.ts');
  const { courseLineFor } = await import('../src/course-line.ts');
  const height = terrain.getTerrainHeightUncached;
  let rays = 0;

  function clearRay(position, target, sample = height) {
    assert(Number.isFinite(position.x + position.y + position.z + target.y), 'finite seat/target');
    assert(position.y >= sample(position.x, position.z) + 5 - 1e-7, 'camera clears terrain by five units');
    // Dense sampling is independent of the implementation's triangle-edge traversal.
    for (let i = 0; i <= 512; i++) {
      const t = i / 512;
      const x = target.x + (position.x - target.x) * t;
      const z = target.z + (position.z - target.z) * t;
      if (x < -150 || x > 150 || z < -200 || z > 200) continue;
      const y = target.y + (position.y - target.y) * t;
      const surface = sample(Math.max(-150 + 1e-9, Math.min(150 - 1e-9, x)),
        Math.max(-200 + 1e-9, Math.min(200 - 1e-9, z)));
      assert(y >= surface - 1e-6, `sight line buried at t=${t}: ${y} < ${surface}`);
    }
    rays++;
  }

  {
    const position = { x: 10, y: 8, z: 0 };
    const target = { x: 0, y: 0, z: 0 };
    assert.equal(seatCameraAboveTerrain(position, target, () => 0), true);
    assert.deepEqual(position, { x: 10, y: 8, z: 0 });
    assert.deepEqual(target, { x: 0, y: 0, z: 0 });
  }
  {
    // Both endpoints clear; the ridge lies exactly on a cell's diagonal, NOT an
    // x/z grid crossing. Endpoint-only or x/z-only checks miss its 20-unit peak.
    const ridge = (x, z) => 10 * Math.min(x + z, 4 - x - z);
    for (const reverse of [false, true]) {
      const position = reverse ? { x: 0.2, y: 9, z: 0.2 } : { x: 1.8, y: 9, z: 1.8 };
      const target = reverse ? { x: 1.8, y: 5, z: 1.8 } : { x: 0.2, y: 5, z: 0.2 };
      assert.equal(seatCameraAboveTerrain(position, target, ridge), true);
      assert(Math.abs(position.y - 40) < 1e-8, 'minimum lift is set by the diagonal ridge');
      clearRay(position, target, ridge);
    }
  }
  {
    const position = { x: 0, y: 3, z: 12 };
    const target = { x: 0, y: -20, z: 0 };
    const ramp = (_x, z) => Math.max(0, 8 - Math.abs(z - 6) * 2);
    seatCameraAboveTerrain(position, target, ramp);
    assert.equal(target.y, 0, 'a buried target must be repaired before the ray can clear');
    clearRay(position, target, ramp);
  }
  {
    let calls = 0;
    const position = { x: 149, y: 8, z: 199 };
    const target = { x: -149, y: 0, z: -199 };
    assert.equal(seatCameraAboveTerrain(position, target, () => { calls++; return 0; }), false);
    assert(calls <= CAMERA_TERRAIN_MAX_CROSSINGS + 2, `bounded sampler calls: ${calls}`);
    assert.deepEqual(position, { x: -149, y: 5, z: -199 }, 'exhaustion uses a verified vertical fallback');
    clearRay(position, target, () => 0);
  }
  {
    const position = { x: 8, y: 8, z: 0 };
    const target = { x: 0, y: 0, z: 0 };
    assert.equal(seatCameraAboveTerrain(position, target, (x) => x === 2 ? NaN : 0), false);
    assert.deepEqual(position, { x: 0, y: 5, z: 0 }, 'invalid segment sample discards the partial search');
    const saved = { ...position };
    assert.throws(() => seatCameraAboveTerrain(position, target, () => NaN), /finite target height/);
    assert.deepEqual(position, saved, 'invalid target terrain is rejected without mutation');
  }
  console.log('PASS: unchanged clear pose, diagonal/axis ridges, buried target, bounded fallback and invalid sampler');

  // Blue at z=-80, heading PI and retained 180-degree orbit/2.5 zoom rendered
  // 5.100 units underground on main. Entry, first update and steady update must agree.
  terrain.setTerrainCorridor(null);
  terrain.setTerrainKickers(null);
  for (const z of [-200, -201, -210]) {
    const target = { x: 0.7, y: -100, z };
    const position = { x: 15.3, y: -100, z: -180 };
    seatCameraAboveTerrain(position, target);
    clearRay(position, target);
  }
  console.log('PASS: sight-line target on/outside the mesh boundary uses rendered edge heights');
  const player = new THREE.Vector3(0, height(0, -80), -80);
  const rotation = new THREE.Euler(0, Math.PI, 0);
  const velocity = { x: 0, z: 0 };
  const cam = new Camera(new THREE.Scene());
  cam.setMode('orbit');
  cam.setOrbitYaw(Math.PI);
  cam.adjustZoom(2.5);
  const originalPlayer = player.toArray();
  for (const previous of ['orbit', 'firstPerson']) {
    cam.setMode(/** @type {import('../src/camera.ts').CameraMode} */ (previous));
    cam.initialize(player, rotation, velocity);
    cam.setMode('orbit');
    cam.initialize(player, rotation, velocity);
    const entered = cam.camera.position.clone();
    clearRay(cam.camera.position, cam.smoothingVectors.lookAtPosition);
    assert(cam.smoothingVectors.lastPosition.distanceTo(entered) < 1e-9);
    assert(cam.smoothingVectors.targetPosition.distanceTo(entered) < 1e-9);
    for (const hz of [30, 60, 144]) {
      cam.update(player, rotation, velocity, () => { throw new Error('legacy injected sampler must stay unused'); }, { frameDt: 1 / hz });
      clearRay(cam.camera.position, cam.smoothingVectors.lookAtPosition);
      assert(cam.camera.position.distanceTo(entered) < 1e-8, 'no underground first frame or next-frame upward jump');
    }
  }
  assert.deepEqual(player.toArray(), originalPlayer, 'camera must not mutate the physics position');
  assert.deepEqual(velocity, { x: 0, z: 0 }, 'camera must not mutate velocity');
  assert.equal(cam.zoom, 2.5);
  assert(Math.abs(Math.abs(cam.orbitYaw) - Math.PI) < 1e-9);
  console.log('PASS: actual Blue terrain stays safe/stable through Orbit reentry and FP→Orbit at 30/60/144 Hz');

  // Actual per-tier corridor/kicker recipes, all modes and both entry/render paths.
  // Camera construction precedes the RNG guard (THREE constructors generate UUIDs).
  const cameras = CAMERA_MODES.map((mode) => {
    const camera = new Camera(new THREE.Scene());
    camera.setMode(mode);
    camera.orbitYaw = Math.PI;
    camera.zoom = 2.5;
    return camera;
  });
  const globalRandom = Math.random;
  Math.random = () => { throw new Error('camera terrain correction consumed gameplay RNG'); };
  try {
    for (const tier of /** @type {const} */ (['bunny', 'blue', 'black', 'expert'])) {
      const config = getDifficultyConfig(tier);
      const line = config.line.curviness > 0 ? courseLineFor(config) : null;
      terrain.setTerrainCorridor(line && config.terrain ? { line, params: config.terrain } : null);
      terrain.setTerrainKickers(config.features ?? null, line);
      for (const camera of cameras) {
        for (const z of [-30, -80, -133, -185, -195]) {
          player.set(line?.laneX(z) ?? 0, 0, z);
          player.y = height(player.x, z);
          camera.initialize(player, rotation, velocity);
          clearRay(camera.camera.position, camera.smoothingVectors.lookAtPosition);
          for (let frame = 0; frame < 4; frame++) {
            camera.update(player, rotation, { x: 4, z: 20 }, height, { frameDt: 1 / 144 });
            clearRay(camera.camera.position, camera.smoothingVectors.lookAtPosition);
          }
        }
      }
    }
  } finally {
    Math.random = globalRandom;
    terrain.setTerrainCorridor(null);
    terrain.setTerrainKickers(null);
    dom.window.close();
  }
  console.log(`PASS: ${rays} dense sight-line checks; all six modes/four tiers, pure terrain reads, no RNG writes`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
