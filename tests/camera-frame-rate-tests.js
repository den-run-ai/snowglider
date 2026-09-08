// @ts-check
// Camera motion runs on render frames, so orbit clocks, manual-control holds and
// smoothing must advance by elapsed time. No renderer or physics fixture needed.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const THREE = await import('three');
  const { Camera } = await import('../src/camera.ts');
  // High above ground isolates camera response from the terrain-floor clamp.
  const player = new THREE.Vector3(0, 1000, -40);
  const rotation = new THREE.Euler(0, Math.PI, 0);
  const velocity = { x: 0, z: 0 };
  /** @param {import('../src/camera.ts').CameraMode} mode */
  function create(mode) {
    const cam = new Camera(new THREE.Scene());
    cam.setMode(mode);
    cam.initialize(player, rotation);
    cam.update(player, rotation, velocity, () => 0); // seat first-frame pose
    return cam;
  }
  function tick(cam, hz, seconds, context = true) {
    for (let i = 0; i < Math.round(hz * seconds); i++) {
      cam.update(player, rotation, velocity, () => 0, context ? { frameDt: 1 / hz } : {});
    }
  }
  function near(a, b, eps = 1e-9) { assert(Math.abs(a - b) <= eps, `${a} differs from ${b}`); }

  for (const mode of ['follow', 'orbit', 'drone', 'cameraman']) {
    const cameras = [30, 60, 144].map((hz) => {
      const cam = create(/** @type {import('../src/camera.ts').CameraMode} */ (mode));
      // Force a common displacement, then let the actual rig catch up.
      cam.camera.position.x += 20;
      tick(cam, hz, 3);
      near(cam.frameCount, 180);
      return cam;
    });
    for (const cam of [cameras[0], cameras[2]]) {
      assert(cam.smoothingVectors.targetPosition.distanceTo(cameras[1].smoothingVectors.targetPosition) < 1e-8,
        `${mode}: equal elapsed time must yield the same target/phase`);
      // A moving cinematic target is sampled at different intervals; the
      // remaining integration error is subpixel-scale at typical follow range.
      assert(cam.camera.position.distanceTo(cameras[1].camera.position) < 0.06,
        `${mode}: pose convergence varies materially with refresh rate`);
    }
  }
  console.log('PASS: follow/orbit/cinematic clocks and poses agree at 30/60/144 Hz');

  for (const mode of ['auto', 'follow']) {
    const cameras = [30, 60, 144].map((hz) => {
      const cam = create(/** @type {import('../src/camera.ts').CameraMode} */ (mode));
      cam.orbit(0.6, 0.2);
      const heldYaw = cam.orbitYaw;
      tick(cam, hz, 1);
      near(cam.manualHoldFrames, 30);
      near(cam.orbitYaw, heldYaw);
      tick(cam, hz, 1); // 0.5s held, then exactly 0.5s of recentering
      near(cam.manualHoldFrames, 0);
      return cam;
    });
    for (const cam of [cameras[0], cameras[2]]) {
      near(cam.orbitYaw, cameras[1].orbitYaw);
      near(cam.orbitPitch, cameras[1].orbitPitch);
      near(cam.autoZoom, cameras[1].autoZoom);
      near(cam.autoPitch, cameras[1].autoPitch);
    }
  }
  console.log('PASS: manual orbit holds for 1.5 seconds and Auto/Follow recenter equally at every refresh rate');

  for (const mode of ['auto', 'follow', 'orbit', 'drone', 'cameraman']) {
    const explicit = create(/** @type {import('../src/camera.ts').CameraMode} */ (mode));
    const legacy = create(/** @type {import('../src/camera.ts').CameraMode} */ (mode));
    tick(explicit, 60, 2);
    tick(legacy, 60, 2, false);
    assert.deepEqual(explicit.camera.position.toArray(), legacy.camera.position.toArray());
    assert.deepEqual(explicit.camera.quaternion.toArray(), legacy.camera.quaternion.toArray());
  }
  console.log('PASS: explicit 60 Hz deltas preserve the legacy omitted-delta camera path exactly');
  dom.window.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
