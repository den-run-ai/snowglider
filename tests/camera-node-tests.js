// camera-node-tests.js
// Headless, c8-instrumented coverage for src/camera.ts (the follow-camera).
//
// Until now src/camera.ts was exercised ONLY by the browser suite (?test=camera),
// which needs the live WebGL game and so never counts toward Node coverage — camera
// was one of the weakest-covered modules. camera.ts uses three.js math objects
// (PerspectiveCamera/Vector3/Euler) and reads terrain through the imported
// `Mountains.getTerrainHeight`; none of that needs a GPU, so the whole class runs
// under jsdom. This harness drives both camera modes (third- and first-person),
// the speed-based follow distance, and the terrain floor clamp.
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
  const { Camera } = await import('../src/camera.ts');
  const { Mountains } = await import('../src/mountains.js');

  const newCamera = () => new Camera(new THREE.Scene());

  console.log('--- construction defaults ---');
  {
    const cam = newCamera();
    check('starts in thirdPerson mode', cam.mode === 'thirdPerson');
    check('getCamera() returns the underlying PerspectiveCamera',
      cam.getCamera() === cam.camera && cam.camera instanceof THREE.PerspectiveCamera);
    check('isFirstFrame starts true, frameCount starts 0',
      cam.isFirstFrame === true && cam.frameCount === 0);
    check('follow-distance parameters are min 15 / max 25 / threshold 20',
      cam.minDistance === 15 && cam.maxDistance === 25 && cam.speedThreshold === 20);
  }

  console.log('\n--- toggleCameraMode ---');
  {
    const cam = newCamera();
    const first = cam.toggleCameraMode();
    check('toggle from thirdPerson returns and sets firstPerson',
      first === 'firstPerson' && cam.mode === 'firstPerson');
    const second = cam.toggleCameraMode();
    check('toggling again round-trips back to thirdPerson',
      second === 'thirdPerson' && cam.mode === 'thirdPerson');
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
    cam.toggleCameraMode(); // -> firstPerson
    cam.initialize(new THREE.Vector3(0, 20, 0), new THREE.Euler(0, 0, 0));
    // offset (-sin0*2.5+0.2, 10, -cos0*2.5) = (0.2, 10, -2.5)
    const p = cam.camera.position;
    check('seats the camera just above/behind the head',
      approx(p.x, 0.2) && approx(p.y, 30) && approx(p.z, -2.5));
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

  console.log('\n--- update: follow distance grows with speed (third-person) ---');
  {
    // Horizontal distance of the (un-smoothed) target from the player IS the dynamic
    // follow distance. First update is the snap; the second computes the speed-based
    // target, so drive two updates and read smoothingVectors.targetPosition.
    const followDistanceAt = (velZ) => {
      const cam = newCamera();
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

  console.log('\n--- update: terrain floor clamp (third-person) ---');
  {
    // Put the player far below the surface so the computed camera dips under terrain;
    // the clamp must lift it to terrainHeight + 5.
    const cam = newCamera();
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

  console.log('\n--- update: first-person follows the head ---');
  {
    const cam = newCamera();
    cam.toggleCameraMode(); // -> firstPerson
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
