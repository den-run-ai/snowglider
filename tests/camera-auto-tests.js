// @ts-check
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const THREE = await import('three');
  const { Camera } = await import('../src/camera.ts');
  const { chooseAutoView, previewAutoTerrain } = await import('../src/camera-auto.ts');
  const player = new THREE.Vector3(0, 1000, -50);
  const velocity = { x: 0, z: -15 };
  const rot = new THREE.Euler();
  function create(yaw = 0) {
    const cam = new Camera(new THREE.Scene());
    const rotation = new THREE.Euler(0, yaw, 0);
    cam.initialize(player, rotation, velocity);
    cam.update(player, rotation, velocity, () => 0);
    return cam;
  }
  function tick(cam, hz = 60, context = {}, yaw = 0, seconds = 2) {
    for (let i = 0; i < hz * seconds; i++) {
      cam.update(player, new THREE.Euler(0, yaw, 0), velocity, () => 0, { ...context, frameDt: 1 / hz });
    }
  }

  // A trick/pose yaw can disagree completely with travel. Auto must remain
  // behind travel at initialize, first frame, and throughout the descent.
  const facing = create(0), flipped = create(Math.PI);
  assert(facing.camera.position.distanceTo(flipped.camera.position) < 1e-8);
  tick(facing); tick(flipped, 60, {}, Math.PI);
  assert(facing.smoothingVectors.targetPosition.distanceTo(flipped.smoothingVectors.targetPosition) < 1e-8);
  assert(facing.camera.position.z > player.z, 'negative-z skiing must be viewed from behind (+z)');
  const waiting = new Camera(new THREE.Scene());
  const opposite = new THREE.Euler(0, Math.PI, 0);
  waiting.initialize(player, opposite); // velocity is not known at spawn yet
  const initialSeat = waiting.camera.position.clone();
  waiting.update(player, opposite, velocity, () => 0);
  assert(waiting.camera.position.distanceTo(initialSeat) < 1e-8,
    'first velocity observation must not reverse the entry seat in one frame');
  waiting.update(player, opposite, velocity, () => 0);
  assert(waiting.camera.position.distanceTo(initialSeat) < 8, 'heading correction must ease into actual travel');
  console.log('PASS: Auto entry and tracking follow real travel despite a 180-degree pose yaw flip');

  // Same local ground, different upcoming grade: discover the dip/kicker before
  // reaching it, instead of reacting only to the slope beneath the skis.
  const origin = { x: 0, y: 0, z: 0 };
  const flat = previewAutoTerrain(origin, velocity, () => 0);
  const dip = previewAutoTerrain(origin, velocity, (_x, z) => z < -6 ? (z + 6) * 1.2 : 0);
  const ramp = previewAutoTerrain(origin, velocity, (_x, z) => z < -6 && z > -14 ? (-z - 6) * 0.8 : 0);
  assert(flat.slope === 0 && flat.relief === 0);
  assert(dip.slope > 1 && dip.relief > 0.7 && dip.lookHeight < -10);
  assert(ramp.relief > 0.7, 'upcoming kicker must trigger a grade-change preview');
  assert(previewAutoTerrain(origin, { x: 0, z: 0 }, () => 30).lookAhead === 0);
  let probes = 0;
  previewAutoTerrain(origin, velocity, () => { probes++; return 0; });
  assert(probes === 5, 'terrain forecast has a fixed five-sample budget');
  const calm = facing.autoFrameTargets(15, 0, 0, 1.6, false, Infinity);
  const forecast = facing.autoFrameTargets(15, dip.slope, 0, 1.6, false, Infinity, dip.relief);
  assert(forecast.zoom > calm.zoom + 0.3 && forecast.pitch > calm.pitch + 0.3);
  console.log('PASS: bounded terrain preview reveals approaching dips and kickers and widens/lifts framing');

  const blocker = { x: 0, y: 0, z: 12, scale: 1.5 };
  const clear = chooseAutoView(origin, 0, 25, 12, 0, [], [], () => 0);
  const blocked = chooseAutoView(origin, 0, 25, 12, 0, [blocker], [], () => 0);
  assert(clear.yaw === 0);
  assert(Math.abs(blocked.yaw) >= 0.35 && Math.abs(blocked.yaw) <= 0.7);
  const side = chooseAutoView(origin, 0, 25, 12, blocked.yaw, [blocker], [], () => 0);
  assert(side.yaw === blocked.yaw, 'symmetric blockers must not alternate view sides');
  assert(chooseAutoView(origin, 0, 25, 12, blocked.yaw, [], [], () => 0).yaw === 0,
    'an unobstructed center view must win again after the blocker clears');
  const rock = chooseAutoView(origin, 0, 25, 12, 0, [], [{ x: 0, y: 0, z: 12, size: 4, topY: 18 }], () => 0);
  assert(Math.abs(rock.yaw) >= 0.35);
  const upcoming = chooseAutoView(origin, 0, 25, 12, 0, [{ ...blocker, z: -12 }], [], () => 0);
  assert(upcoming.pressure > 0.5, 'obstacles in the travel corridor must widen the view before contact');
  const far = chooseAutoView(origin, 0, 25, 12, 0, [{ ...blocker, x: 100 }], [], () => 0);
  assert.deepEqual(far, clear);
  console.log('PASS: trees/rocks choose a bounded stable shoulder view, with upcoming-obstacle framing');

  // Exercise the real update path; compare equal elapsed times rather than the
  // same number of refreshes. A high blocker intersects the camera ray even as
  // the terrain/jump profile eases, avoiding a test that only mirrors the helper.
  const obstacleContext = { treePositions: [{ x: 0, y: 1000, z: -35, scale: 3 }] };
  const cameras = [30, 60, 144].map((hz) => {
    const cam = create();
    tick(cam, hz, obstacleContext);
    assert(Math.abs(cam.autoYaw) > 0.3 && Math.abs(cam.autoYaw) <= 0.7);
    return cam;
  });
  for (const cam of [cameras[0], cameras[2]]) {
    assert(Math.abs(cam.autoYaw - cameras[1].autoYaw) < 0.025);
    assert(Math.abs(cam.autoZoom - cameras[1].autoZoom) < 0.025);
    assert(Math.abs(cam.autoPitch - cameras[1].autoPitch) < 0.025);
  }
  const cam = cameras[1];
  cam.orbit(0.5, 0.1);
  const held = { yaw: cam.autoYaw, zoom: cam.autoZoom, pitch: cam.autoPitch };
  tick(cam, 60, {}, 0, 1);
  assert.deepEqual({ yaw: cam.autoYaw, zoom: cam.autoZoom, pitch: cam.autoPitch }, held);
  assert(cam.orbitYaw === 0.5);
  cam.setMode('orbit');
  assert(cam.autoYaw === 0 && cam.autoHeading === null && cam.autoZoom === 1 && cam.autoPitch === 0);
  cam.setMode('auto');
  tick(cam, 60, obstacleContext);
  cam.initialize(player, rot);
  assert(cam.autoYaw === 0 && cam.autoZoom === 1 && cam.autoPitch === 0);
  assert(Math.abs(cam.camera.position.z - player.z - 15 * Math.cos(cam.orbitYaw) * Math.cos(cam.orbitPitch)) < 1e-8);
  console.log('PASS: Auto reframing agrees at 30/60/144 Hz, honors manual hold, and resets across modes/runs');

  const { getTerrainHeightUncached } = await import('../src/mountains/terrain.ts');
  // Exercise the actual mode-entry order with a moving subject: initialize,
  // first render frame, then regular frames. Auto must not seat at 15 units and
  // lurch to its 25-unit speed rig through the initial high-smoothing window.
  for (const hz of [30, 60, 144]) {
    for (const aspect of [390 / 844, 16 / 9]) {
      const moving = new THREE.Vector3(0, getTerrainHeightUncached(0, -30), -30);
      const view = new Camera(new THREE.Scene());
      view.camera.aspect = aspect;
      view.camera.updateProjectionMatrix();
      view.initialize(moving, rot, { x: 0, z: -20 });
      assert(Math.abs(view.camera.position.z - moving.z - 25) < 1e-8,
        'moving Auto initialization must use its live-speed distance');
      const previous = view.camera.position.clone();
      let maxStep = 0;
      for (let frame = 0; frame < Math.ceil(hz / 4); frame++) {
        moving.z -= 20 / hz;
        moving.y = getTerrainHeightUncached(moving.x, moving.z);
        view.update(moving, rot, { x: 0, z: -20 }, getTerrainHeightUncached, { frameDt: 1 / hz });
        if (frame === 0) assert(Math.abs(view.camera.position.z - moving.z - 25) < 1e-8,
          'first update must retain the same speed-based entry distance');
        maxStep = Math.max(maxStep, view.camera.position.distanceTo(previous));
        previous.copy(view.camera.position);
      }
      assert(maxStep < 3, `Auto entry lunges ${maxStep} units in one frame at ${hz} Hz`);
    }
  }
  console.log('PASS: moving Auto initialize/first/regular frames share the live-speed seat without an entry lurch');
  for (const aspect of [390 / 844, 16 / 9]) {
    for (const speed of [3, 10, 20]) {
      for (const z of [-40, -80, -145, -200, -250]) {
        for (const airborne of [false, true]) {
          const subject = new THREE.Vector3(0, getTerrainHeightUncached(0, z) + (airborne ? 15 : 0), z);
          const view = new Camera(new THREE.Scene());
          view.camera.aspect = aspect;
          view.camera.updateProjectionMatrix();
          view.initialize(subject, rot, { x: 0, z: -speed });
          for (let i = 0; i < 180; i++) view.update(subject, rot, { x: 0, z: -speed }, () => 0,
            { frameDt: 1 / 60, isInAir: airborne });
          view.camera.updateMatrixWorld();
          const body = subject.clone().add(new THREE.Vector3(0, 4, 0)).project(view.camera);
          assert(Math.abs(body.x) < 0.85 && Math.abs(body.y) < 0.85 && body.z < 1 && body.z > -1,
            `rider leaves Auto frame: aspect=${aspect} speed=${speed} z=${z} air=${airborne}: ${body.toArray()}`);
        }
      }
    }
  }
  console.log('PASS: actual-terrain rider stays framed at 3/10/20 speed on portrait/landscape dip and jump poses');

  // Camera observation must neither mutate the collision inputs nor consume the
  // gameplay RNG. Construct Three objects first because their UUIDs use randomness.
  const deterministic = create();
  const originalRandom = Math.random;
  let draws = 0;
  Math.random = () => { draws++; return 0.5; };
  const frozenTree = Object.freeze({ x: 0, y: 1000, z: -35, scale: 3 });
  try { tick(deterministic, 60, { treePositions: Object.freeze([frozenTree]) }); }
  finally { Math.random = originalRandom; }
  assert(draws === 0);
  assert.deepEqual(velocity, { x: 0, z: -15 });
  assert.deepEqual(player.toArray(), [0, 1000, -50]);
  console.log('PASS: Auto probes are read-only and consume no gameplay randomness');
  dom.window.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
