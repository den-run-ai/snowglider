// camera-node-tests.js
// Headless, c8-instrumented coverage for src/camera.ts (the follow-camera).
//
// Until now src/camera.ts was exercised ONLY by the browser suite (?test=camera),
// which needs the live WebGL game and so never counts toward Node coverage — camera
// was one of the weakest-covered modules. camera.ts uses three.js math objects
// (PerspectiveCamera/Vector3/Euler) and reads terrain through the imported
// `Mountains.getTerrainHeight`; none of that needs a GPU, so the whole class runs
// under jsdom. This harness drives the camera modes (auto/follow/orbit/firstPerson),
// the 360° orbit + zoom view controls, the auto-frame easing, the speed-based follow
// distance, and the terrain floor clamp.
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://snowglider.ai/' });
global.window = dom.window;
global.document = dom.window.document;

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) {
    pass++;
  } else {
    fail++;
  }
}
// Position-based tests use the project's ±0.001 float tolerance (CLAUDE.md).
function approx(a, b, tol = 0.001) {
  return Math.abs(a - b) <= tol;
}

async function main() {
  const THREE = await import('three');
  const { Camera, CAMERA_MODES, isThirdPerson } = await import('../src/camera.ts');
  const { Mountains } = await import('../src/mountains.js');

  const newCamera = () => new Camera(new THREE.Scene());

  console.log('--- construction defaults ---');
  {
    const cam = newCamera();
    check('starts in auto mode', cam.mode === 'auto');
    check('getCamera() returns the underlying PerspectiveCamera',
      cam.getCamera() === cam.camera && cam.camera instanceof THREE.PerspectiveCamera);
    check('isFirstFrame starts true, frameCount starts 0',
      cam.isFirstFrame === true && cam.frameCount === 0);
    check('follow-distance parameters are min 15 / max 25 / threshold 20',
      cam.minDistance === 15 && cam.maxDistance === 25 && cam.speedThreshold === 20);
    check('view controls start neutral (orbit 0, pitch 0, zoom 1)',
      cam.orbitYaw === 0 && cam.orbitPitch === 0 && cam.zoom === 1);
    check('CAMERA_MODES lists the four modes in cycle order',
      CAMERA_MODES.join(',') === 'auto,follow,orbit,firstPerson');
    check('isThirdPerson() is true for auto/follow/orbit, false for firstPerson',
      isThirdPerson('auto') && isThirdPerson('follow') && isThirdPerson('orbit') &&
      !isThirdPerson('firstPerson'));
  }

  console.log('\n--- toggleCameraMode cycles all four modes ---');
  {
    const cam = newCamera();
    check('auto -> follow', cam.toggleCameraMode() === 'follow' && cam.mode === 'follow');
    check('follow -> orbit', cam.toggleCameraMode() === 'orbit' && cam.mode === 'orbit');
    check('orbit -> firstPerson', cam.toggleCameraMode() === 'firstPerson' && cam.mode === 'firstPerson');
    check('firstPerson -> auto (wraps)', cam.toggleCameraMode() === 'auto' && cam.mode === 'auto');
  }

  console.log('\n--- setMode jumps directly ---');
  {
    const cam = newCamera();
    check('setMode("orbit") returns and sets orbit', cam.setMode('orbit') === 'orbit' && cam.mode === 'orbit');
    check('setMode("firstPerson") switches to head cam', cam.setMode('firstPerson') === 'firstPerson');
  }

  console.log('\n--- initialize: third-person ---');
  {
    const cam = newCamera();
    const player = new THREE.Vector3(10, 50, -15);
    cam.initialize(player, new THREE.Euler(0, 0, 0));
    // rotation.y = 0 -> offset (sin0*15, 8, cos0*15) = (0, 8, 15)
    const p = cam.camera.position;
    check('places camera at player + (0,8,15) when facing forward',
      approx(p.x, 10) && approx(p.y, 58) && approx(p.z, 0));
    check('seeds smoothing targetPosition to the camera position',
      cam.smoothingVectors.targetPosition.distanceTo(p) < 0.001);
    check('seeds lookAtPosition to the player position',
      approx(cam.smoothingVectors.lookAtPosition.x, 10) &&
      approx(cam.smoothingVectors.lookAtPosition.z, -15));
    check('resets isFirstFrame / frameCount after initialize',
      cam.isFirstFrame === true && cam.frameCount === 0);
  }

  console.log('\n--- initialize: third-person with yaw ---');
  {
    const cam = newCamera();
    // rotation.y = PI/2 -> offset (sin*15, 8, cos*15) = (15, 8, ~0)
    cam.initialize(new THREE.Vector3(0, 0, 0), new THREE.Euler(0, Math.PI / 2, 0));
    const p = cam.camera.position;
    check('rotates the follow offset around the player by yaw',
      approx(p.x, 15) && approx(p.y, 8) && approx(p.z, 0));
  }

  console.log('\n--- initialize: first-person ---');
  {
    const cam = newCamera();
    cam.setMode('firstPerson');
    cam.initialize(new THREE.Vector3(0, 20, 0), new THREE.Euler(0, 0, 0));
    // offset (-sin0*2.5+0.2, 10, -cos0*2.5) = (0.2, 10, -2.5)
    const p = cam.camera.position;
    check('seats the camera just above/behind the head',
      approx(p.x, 0.2) && approx(p.y, 30) && approx(p.z, -2.5));
  }

  console.log('\n--- orbit: 360° scroller places the camera around the player ---');
  {
    // Orbit mode holds the yaw exactly as set (no auto recenter). 90° -> side view,
    // 180° -> front/look-back view. Test via initialize (uses minDistance = 15).
    const side = newCamera();
    side.setMode('orbit');
    side.setOrbitYaw(Math.PI / 2); // 90°
    side.initialize(new THREE.Vector3(0, 50, 0), new THREE.Euler(0, 0, 0));
    check('orbit yaw 90° swings the camera to the side (+x, z~0)',
      approx(side.camera.position.x, 15) && approx(side.camera.position.z, 0) &&
      approx(side.camera.position.y, 58));

    const front = newCamera();
    front.setMode('orbit');
    front.setOrbitYaw(Math.PI); // 180°
    front.initialize(new THREE.Vector3(0, 50, 0), new THREE.Euler(0, 0, 0));
    check('orbit yaw 180° puts the camera in front (z flips to ~-15)',
      approx(front.camera.position.x, 0) && approx(front.camera.position.z, -15));

    // orbit(delta) accumulates and wraps into (-π, π].
    const acc = newCamera();
    acc.orbit(Math.PI); acc.orbit(Math.PI / 2);
    check('orbit() wraps the accumulated yaw into (-π, π]',
      approx(acc.orbitYaw, -Math.PI / 2));
    check('orbit() sets the manual-hold window', acc.manualHoldFrames > 0);
  }

  console.log('\n--- zoom: clamps and changes follow distance, not physics ---');
  {
    const cam = newCamera();
    cam.setMode('orbit');
    cam.adjustZoom(2); // 1 * 2 = 2 (<= maxZoom 2.5)
    check('adjustZoom pulls the camera back (zoom 2)', approx(cam.zoom, 2));
    cam.adjustZoom(10); // clamps at maxZoom
    check('zoom clamps to maxZoom (2.5)', approx(cam.zoom, cam.maxZoom));
    cam.adjustZoom(0.0001); // clamps at minZoom
    check('zoom clamps to minZoom (0.5)', approx(cam.zoom, cam.minZoom));

    // zoom = 2 -> follow distance doubles (15 -> 30) at init.
    const zc = newCamera();
    zc.setMode('orbit');
    zc.adjustZoom(2);
    zc.initialize(new THREE.Vector3(0, 50, 0), new THREE.Euler(0, 0, 0));
    check('zoom 2 doubles the initial follow distance (z ~30)',
      approx(zc.camera.position.z, 30));
  }

  console.log('\n--- recenter / resetView ---');
  {
    const cam = newCamera();
    cam.setMode('orbit');
    cam.orbit(1.2, 0.5);
    cam.adjustZoom(2);
    cam.recenter();
    check('recenter zeroes orbit yaw/pitch but keeps zoom',
      cam.orbitYaw === 0 && cam.orbitPitch === 0 && approx(cam.zoom, 2));
    cam.orbit(1.0, 0.3);
    cam.resetView();
    check('resetView zeroes orbit AND zoom',
      cam.orbitYaw === 0 && cam.orbitPitch === 0 && cam.zoom === 1);
  }

  console.log('\n--- update: first frame snaps (third-person) ---');
  {
    const cam = newCamera();
    const player = new THREE.Vector3(0, 50, 0);
    cam.initialize(player, new THREE.Euler(0, 0, 0));
    cam.update(player, new THREE.Euler(0, 0, 0), { x: 0, z: 0 }, () => 0);
    check('first update clears isFirstFrame', cam.isFirstFrame === false);
    const p = cam.camera.position;
    check('first update snaps directly to player + (0,8,15)',
      approx(p.x, 0) && approx(p.y, 58) && approx(p.z, 15));
  }

  console.log('\n--- update: follow distance grows with speed (orbit mode = no easing) ---');
  {
    // Horizontal distance of the (un-smoothed) target from the player IS the dynamic
    // follow distance. Orbit mode holds zoom/orbit fixed, so this measures the pure
    // speed ramp. First update is the snap; the second computes the speed-based target.
    const followDistanceAt = (velZ) => {
      const cam = newCamera();
      cam.setMode('orbit');
      const player = new THREE.Vector3(0, 50, 0);
      const rot = new THREE.Euler(0, 0, 0);
      cam.initialize(player, rot);
      cam.update(player, rot, { x: 0, z: velZ }, () => 0); // first-frame snap
      cam.update(player, rot, { x: 0, z: velZ }, () => 0); // dynamic distance
      const t = cam.smoothingVectors.targetPosition;
      return Math.hypot(t.x - player.x, t.z - player.z);
    };
    const slow = followDistanceAt(0);   // speed 0   -> minDistance (15)
    const fast = followDistanceAt(30);  // speed >=20 -> maxDistance (25)
    check('at rest the camera sits at minDistance (~15)', approx(slow, 15, 0.5));
    check('at high speed the camera pulls back to maxDistance (~25)', approx(fast, 25, 0.5));
    check('faster travel pushes the camera farther back', fast > slow + 5);
  }

  console.log('\n--- auto mode: orbit eases back behind the player ---');
  {
    const cam = newCamera(); // default auto
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0); // snap (no easing)
    // Nudge the orbit off-center directly, clear the manual hold, then let auto ease it.
    cam.orbitYaw = 1.2;
    cam.manualHoldFrames = 0;
    for (let i = 0; i < 80; i++) cam.update(player, rot, { x: 0, z: 0 }, () => 0);
    check('auto-frame decays a nudged orbit back toward 0', Math.abs(cam.orbitYaw) < 0.1);
  }

  console.log('\n--- manual nudge suppresses auto easing briefly ---');
  {
    const cam = newCamera(); // auto
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0); // snap
    cam.orbit(1.0); // manual nudge -> hold window armed
    const held = cam.manualHoldFrames;
    for (let i = 0; i < 5; i++) cam.update(player, rot, { x: 0, z: 0 }, () => 0);
    check('orbit yaw holds (no easing) during the manual-hold window', approx(cam.orbitYaw, 1.0, 0.0001));
    check('the hold window counts down while held', cam.manualHoldFrames === held - 5);
  }

  console.log('\n--- update: terrain floor clamp (third-person) ---');
  {
    // Put the player far below the surface so the computed camera dips under terrain;
    // the clamp must lift it to terrainHeight + 5.
    const cam = newCamera();
    cam.setMode('orbit');
    const player = new THREE.Vector3(0, -100, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0); // first-frame snap (no clamp)
    cam.update(player, rot, { x: 0, z: 0 }, () => 0); // clamp applies here
    const terrain = Mountains.getTerrainHeight(cam.camera.position.x, cam.camera.position.z);
    check('clamps the camera to terrainHeight + 5 when it would sink below ground',
      approx(cam.camera.position.y, terrain + 5));
    check('the clamp lifts the camera well above the buried player',
      cam.camera.position.y > player.y + 50);
  }

  console.log('\n--- update: terrain clamp still holds for a side orbit ---');
  {
    // A 90° orbit can swing the camera over uphill terrain; the floor clamp must still
    // keep it above ground.
    const cam = newCamera();
    cam.setMode('orbit');
    cam.setOrbitYaw(Math.PI / 2);
    cam.manualHoldFrames = 0;
    const player = new THREE.Vector3(0, -100, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0);
    const terrain = Mountains.getTerrainHeight(cam.camera.position.x, cam.camera.position.z);
    check('side-orbit camera is still clamped above terrain',
      cam.camera.position.y >= terrain + 5 - 0.001);
  }

  console.log('\n--- update: first-person follows the head ---');
  {
    const cam = newCamera();
    cam.setMode('firstPerson');
    const player = new THREE.Vector3(5, 20, 5);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0);
    const p = cam.camera.position;
    // offset (-sin0*2.5+0.2, 10, -cos0*2.5) = (0.2, 10, -2.5)
    check('first-person update keeps the camera at head height + offset',
      approx(p.x, 5.2) && approx(p.y, 30) && approx(p.z, 2.5));
  }

  console.log('\n--- handleResize ---');
  {
    const cam = newCamera();
    cam.handleResize();
    check('handleResize syncs aspect to the window dimensions',
      approx(cam.camera.aspect, window.innerWidth / window.innerHeight));
  }

  console.log(`\nCAMERA TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
