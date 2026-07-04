// @ts-check
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
const g = /** @type {any} */ (globalThis);
g.window = dom.window;
g.document = dom.window.document;

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
  const { Camera, CAMERA_MODES, isThirdPerson, isCinematic, usesOrbitControls } = await import('../src/camera.ts');
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
    check('CAMERA_MODES lists the six modes in cycle order',
      CAMERA_MODES.join(',') === 'auto,follow,orbit,firstPerson,cameraman,drone');
    check('isThirdPerson() is true for every mode except the head cam',
      isThirdPerson('auto') && isThirdPerson('follow') && isThirdPerson('orbit') &&
      isThirdPerson('cameraman') && isThirdPerson('drone') && !isThirdPerson('firstPerson'));
    check('isCinematic() is true only for cameraman/drone',
      isCinematic('cameraman') && isCinematic('drone') &&
      !isCinematic('auto') && !isCinematic('follow') && !isCinematic('orbit') && !isCinematic('firstPerson'));
    check('usesOrbitControls() is true for auto/follow/orbit, false for FP + cinematic',
      usesOrbitControls('auto') && usesOrbitControls('follow') && usesOrbitControls('orbit') &&
      !usesOrbitControls('firstPerson') && !usesOrbitControls('cameraman') && !usesOrbitControls('drone'));
  }

  console.log('\n--- toggleCameraMode cycles all six modes ---');
  {
    const cam = newCamera();
    check('auto -> follow', cam.toggleCameraMode() === 'follow' && cam.mode === 'follow');
    check('follow -> orbit', cam.toggleCameraMode() === 'orbit' && cam.mode === 'orbit');
    check('orbit -> firstPerson', cam.toggleCameraMode() === 'firstPerson' && cam.mode === 'firstPerson');
    check('firstPerson -> cameraman', cam.toggleCameraMode() === 'cameraman' && cam.mode === 'cameraman');
    check('cameraman -> drone', cam.toggleCameraMode() === 'drone' && cam.mode === 'drone');
    check('drone -> auto (wraps)', cam.toggleCameraMode() === 'auto' && cam.mode === 'auto');
  }

  console.log('\n--- setMode jumps directly ---');
  {
    const cam = newCamera();
    check('setMode("orbit") returns and sets orbit', cam.setMode('orbit') === 'orbit' && cam.mode === 'orbit');
    check('setMode("firstPerson") switches to head cam', cam.setMode('firstPerson') === 'firstPerson');
  }

  console.log('\n--- setMode("follow") recenters the orbit, keeps the zoom ---');
  {
    // Follow is the classic behind-the-player chase: entering it must clear any manual
    // orbit + hold from Orbit mode (else the camera stays at the old side/front angle
    // for the hold window), while preserving the player's manual zoom (codex review).
    const cam = newCamera();
    cam.setMode('orbit');
    cam.orbit(1.2, 0.4);   // manual side/front angle + pitch, arms the hold window
    cam.adjustZoom(1.5);   // manual zoom out
    cam.setMode('follow');
    check('entering follow zeroes orbit yaw/pitch', cam.orbitYaw === 0 && cam.orbitPitch === 0);
    check('entering follow clears the manual-hold window', cam.manualHoldFrames === 0);
    check('entering follow preserves the manual zoom', approx(cam.zoom, 1.5));
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

  console.log('\n--- auto speed-zoom is transient, never leaks into manual zoom ---');
  {
    // Auto eases a TRANSIENT autoZoom with speed; it must NOT write the persisted
    // manual `zoom`, or a fast Auto run would leak a zoom into the next run's spawn
    // framing / into Follow/Orbit (codex review, PR #306).
    const cam = newCamera(); // auto
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 30 }, () => 0); // snap
    for (let i = 0; i < 80; i++) cam.update(player, rot, { x: 0, z: 30 }, () => 0); // fast Auto run
    check('auto speed zoom raises the transient autoZoom', cam.autoZoom > 1.1);
    check('auto speed zoom leaves the persisted manual zoom at 1', approx(cam.zoom, 1));

    // Restart (re-initialize) after the fast run must re-seat at the neutral view: the
    // transient autoZoom is cleared so spawn distance is the classic 15 (z at yaw 0).
    cam.initialize(player, rot);
    check('re-initialize clears the transient autoZoom', approx(cam.autoZoom, 1));
    check('spawn framing is neutral after a fast Auto run (z ~15)',
      approx(cam.camera.position.z, 15));

    // Leaving Auto drops the transient zoom so Follow/Orbit don't inherit it.
    cam.autoZoom = 1.2;
    cam.setMode('orbit');
    check('switching Auto -> Orbit clears the transient autoZoom', approx(cam.autoZoom, 1));
  }

  console.log('\n--- situational Auto framing: autoFrameTargets profile (issue #305 P3+) ---');
  {
    // Pure profile function: (speed, slope, turnRate, aspect, isInAir, avalancheDistance)
    // -> { zoom, pitch }. Landscape aspect (1.6) + everything calm is the neutral baseline.
    const cam = newCamera();
    const neutral = cam.autoFrameTargets(0, 0, 0, 1.6, false, Infinity);
    check('calm terrain frames neutrally (zoom ~1, pitch 0)',
      approx(neutral.zoom, 1) && approx(neutral.pitch, 0));

    // Slope framing is gated on motion: a parked/slow snowman on a steep gradient keeps the
    // neutral framing (no pull-back, no lift) — this is the spawn-neutrality fix (codex P2).
    const stoppedSteep = cam.autoFrameTargets(0, 0.8, 0, 1.6, false, Infinity);
    check('steep terrain does NOT pull back while stopped (slope gated on motion)',
      approx(stoppedSteep.zoom, 1) && approx(stoppedSteep.pitch, 0));

    // Once actually skiing, expert/steep terrain (big gradient) pulls the camera back AND
    // lifts it overhead so the drop below the rider stays in shot.
    const steep = cam.autoFrameTargets(10, 0.8, 0, 1.6, false, Infinity);
    const cruise = cam.autoFrameTargets(10, 0, 0, 1.6, false, Infinity); // same speed, flat ground
    check('steep/expert terrain pulls the camera back (vs same-speed flat)', steep.zoom > cruise.zoom + 0.2);
    check('steep/expert terrain lifts the camera overhead (pitch up)', steep.pitch > 0.2);

    // A jump pulls back AND lifts even harder so the landing zone is framed.
    const air = cam.autoFrameTargets(0, 0, 0, 1.6, true, Infinity);
    check('airborne (jump) pulls the camera back', air.zoom > neutral.zoom + 0.3);
    check('airborne (jump) lifts the camera overhead', air.pitch > 0.3);

    // A hard, twisty carve pulls the camera IN for tight tree-line framing.
    const turn = cam.autoFrameTargets(0, 0, 0.06, 1.6, false, Infinity);
    check('a hard carve pulls the camera IN (zoom < neutral)', turn.zoom < neutral.zoom);

    // Tall/portrait screens pull back for vertical context; a near avalanche widens out.
    const portrait = cam.autoFrameTargets(0, 0, 0, 0.5, false, Infinity);
    check('portrait aspect pulls the camera back', portrait.zoom > neutral.zoom);
    const danger = cam.autoFrameTargets(0, 0, 0, 1.6, false, 0);
    check('a near avalanche widens the shot', danger.zoom > neutral.zoom + 0.3);
    const safe = cam.autoFrameTargets(0, 0, 0, 1.6, false, 1000);
    check('a distant avalanche does not widen the shot', approx(safe.zoom, neutral.zoom));

    // Stacking every signal stays bounded (can't fling the camera to the horizon).
    const maxed = cam.autoFrameTargets(999, 5, 5, 0.4, true, 0);
    check('the combined situational zoom is clamped (< 2)', maxed.zoom < 2);
    check('the combined situational pitch is clamped (< ~0.7)', maxed.pitch < 0.7);
  }

  console.log('\n--- situational Auto framing: airborne context eases autoPitch/autoZoom, stays transient ---');
  {
    // Driving update() with an airborne context must ease the TRANSIENT autoPitch/autoZoom
    // up (lift + pull-back for the landing) without touching the persisted manual state,
    // and both must drop the moment Auto is left or the run restarts.
    const cam = newCamera(); // auto
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 15 }, () => 0); // snap
    for (let i = 0; i < 80; i++) {
      cam.update(player, rot, { x: 0, z: 15 }, () => 0, { isInAir: true });
    }
    check('airborne Auto run lifts the transient autoPitch', cam.autoPitch > 0.1);
    check('airborne Auto run raises the transient autoZoom', cam.autoZoom > 1.1);
    check('airborne Auto framing never writes the manual orbit pitch', approx(cam.orbitPitch, 0));

    // Leaving Auto drops BOTH transients so Follow/Orbit/FP don't inherit the reframe.
    cam.setMode('orbit');
    check('switching Auto -> Orbit clears the transient autoPitch', approx(cam.autoPitch, 0));

    // Re-initialize (restart) also clears the transient pitch and the turn-rate memory.
    cam.setMode('auto');
    cam.autoPitch = 0.4;
    cam.initialize(player, rot);
    check('re-initialize clears the transient autoPitch', approx(cam.autoPitch, 0));
    check('re-initialize clears the turn-rate memory', cam.lastTravelHeading === null);
  }

  console.log('\n--- situational Auto framing: autoPitch lifts the follow offset overhead ---');
  {
    // autoPitch feeds followOffset() the same way manual orbitPitch does: + raises the
    // camera height and shortens the horizontal reach (looking further down the slope).
    const cam = newCamera();
    const flat = cam.followOffset(15, 0);
    cam.autoPitch = 0.5;
    const lifted = cam.followOffset(15, 0);
    check('autoPitch raises the camera height', lifted.y > flat.y + 1);
    check('autoPitch shortens the horizontal follow reach', Math.abs(lifted.z) < Math.abs(flat.z));
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

  console.log('\n--- cinematic modes: cinematicTargets profile (issue #315) ---');
  {
    const cam = newCamera();
    // Profile: (mode, phase, slope, speed, isInAir) -> { angle, pitch, distMult }.
    // At rest the drone sits high + far and the cameraman low + close; neither has slope/air
    // lift yet (slope/air are gated on real downhill motion, like Auto's spawn-neutrality).
    const droneRest = cam.cinematicTargets('drone', 0, 0, 0, false);
    const camRest = cam.cinematicTargets('cameraman', 0, 0, 0, false);
    check('drone sits more overhead than the cameraman (bigger pitch)', droneRest.pitch > camRest.pitch);
    check('drone sits farther back than the cameraman (bigger distance mult)', droneRest.distMult > camRest.distMult);
    check('cameraman trails off to one side at rest (nonzero angle)', Math.abs(camRest.angle) > 0.3);

    // Steep/expert terrain WHILE SKIING pulls both modes back AND lifts them overhead.
    for (const mode of /** @type {Array<'drone' | 'cameraman'>} */ (['drone', 'cameraman'])) {
      const flat = cam.cinematicTargets(mode, 0, 0, 12, false);
      const steep = cam.cinematicTargets(mode, 0, 0.8, 12, false);
      check(`${mode}: expert terrain pulls the camera back (vs same-speed flat)`, steep.distMult > flat.distMult + 0.1);
      check(`${mode}: expert terrain lifts the camera overhead`, steep.pitch > flat.pitch + 0.05);
      // Slope framing is gated on motion: a parked snowman on the steep spawn keeps the rest pose.
      const parkedSteep = cam.cinematicTargets(mode, 0, 0.8, 0, false);
      const rest = mode === 'drone' ? droneRest : camRest;
      check(`${mode}: steep terrain does NOT pull back while stopped (gated on motion)`,
        approx(parkedSteep.distMult, rest.distMult) && approx(parkedSteep.pitch, rest.pitch));
      // A jump pulls back AND lifts even harder so the landing zone stays framed.
      const air = cam.cinematicTargets(mode, 0, 0, 12, true);
      check(`${mode}: airborne (jump) pulls the camera back`, air.distMult > flat.distMult + 0.1);
      check(`${mode}: airborne (jump) lifts the camera overhead`, air.pitch > flat.pitch + 0.05);
    }

    // The drone's circle advances with the frame clock; the cameraman weaves side to side.
    const droneA = cam.cinematicTargets('drone', 0, 0, 12, false).angle;
    const droneB = cam.cinematicTargets('drone', 30, 0, 12, false).angle;
    check('drone circle angle advances with the frame clock', droneB > droneA);
    const weaveA = cam.cinematicTargets('cameraman', 0, 0, 12, false).angle;
    const weaveB = cam.cinematicTargets('cameraman', 30, 0, 12, false).angle;
    check('cameraman weave angle oscillates with the frame clock', weaveA !== weaveB);
  }

  console.log('\n--- cinematic modes: cinematicOffset mirrors followOffset math ---');
  {
    const cam = newCamera();
    // At the same base distance the drone sits higher and farther out than the cameraman.
    const drone = cam.cinematicOffset('drone', 15, 0, 0, 0, 0, false);
    const man = cam.cinematicOffset('cameraman', 15, 0, 0, 0, 0, false);
    check('drone offset sits higher than the cameraman offset', drone.y > man.y);
    const droneDist = Math.hypot(drone.x, drone.z);
    const manDist = Math.hypot(man.x, man.z);
    check('drone offset sits farther out (horizontally) than the cameraman', droneDist > manDist);
    check('cinematicOffset returns a THREE.Vector3', /** @type {any} */ (drone).isVector3 === true);
  }

  console.log('\n--- cinematic modes: update() drives framing, stays above terrain, no manual leak ---');
  {
    const cam = newCamera();
    cam.setMode('drone');
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);
    cam.initialize(player, rot);
    // Drive a fast run so the situational terms engage; capture the orbit angle over frames.
    cam.update(player, rot, { x: 0, z: 20 }, () => 0); // first-frame snap
    const z0 = cam.camera.position.z;
    for (let i = 0; i < 60; i++) cam.update(player, rot, { x: 0, z: 20 }, () => 0);
    const z1 = cam.camera.position.z;
    check('drone circle moves the camera around the rider over time', Math.abs(z1 - z0) > 0.5);
    check('drone mode never writes the persisted manual zoom', approx(cam.zoom, 1));
    check('drone mode never writes the persisted manual orbit yaw/pitch',
      approx(cam.orbitYaw, 0) && approx(cam.orbitPitch, 0));

    // Terrain floor clamp still holds for the low cameraman cam over buried terrain.
    const low = newCamera();
    low.setMode('cameraman');
    const buried = new THREE.Vector3(0, -100, 0);
    low.initialize(buried, rot);
    low.update(buried, rot, { x: 0, z: 10 }, () => 0);
    low.update(buried, rot, { x: 0, z: 10 }, () => 0);
    const terrain = Mountains.getTerrainHeight(low.camera.position.x, low.camera.position.z);
    check('cameraman camera is still clamped above terrain', low.camera.position.y >= terrain + 5 - 0.001);
  }

  console.log('\n--- cinematic modes: entry seats directly at the cinematic pose (issue #315, PR #319) ---');
  {
    // Switching to Cam/Drone must frame the advertised view on the FIRST rendered frame,
    // not render one frame at the classic Follow pose (player + (0,8,15)) and then ease from
    // it — that read as a visible snap. Both initialize() and update()'s first-frame snap
    // must use the cinematic entry offset (via entryOffset).
    const player = new THREE.Vector3(0, 50, 0);
    const rot = new THREE.Euler(0, 0, 0);

    // Baseline: a follow camera entry seats at the classic pose (y = player+8).
    const follow = newCamera();
    follow.setMode('follow');
    follow.initialize(player, rot);
    check('follow entry is the classic behind pose (y ~ player+8)', approx(follow.camera.position.y, 58));

    // Drone entry seats HIGH overhead immediately (well above the follow height), both after
    // initialize() and after the first-frame snap — no Follow-pose intermediate frame.
    const drone = newCamera();
    drone.setMode('drone');
    drone.initialize(player, rot);
    const droneInitY = drone.camera.position.y;
    check('drone initialize() seats high overhead, not the follow pose', droneInitY > player.y + 14);
    drone.update(player, rot, { x: 0, z: 0 }, () => 0); // first-frame snap
    check('drone first-frame snap stays at the high aerial pose (no snap to follow)',
      drone.camera.position.y > player.y + 14 && approx(drone.camera.position.y, droneInitY, 0.001));

    // Cameraman entry seats off to the side immediately (nonzero x from the side trail),
    // where the classic follow pose would be x ~ 0 at yaw 0.
    const man = newCamera();
    man.setMode('cameraman');
    man.initialize(player, rot);
    check('cameraman initialize() seats off to the side (x != 0), not directly behind',
      Math.abs(man.camera.position.x) > 3);
    man.update(player, rot, { x: 0, z: 0 }, () => 0);
    check('cameraman first-frame snap keeps the side-trailing pose', Math.abs(man.camera.position.x) > 3);

    // The entry offset for a non-cinematic mode is byte-identical to followOffset (no regression).
    const auto = newCamera(); // auto
    const entry = auto.entryOffset(auto.minDistance, 0, player);
    const classic = auto.followOffset(auto.minDistance, 0);
    check('entryOffset falls back to followOffset for non-cinematic modes',
      approx(entry.x, classic.x) && approx(entry.y, classic.y) && approx(entry.z, classic.z));
  }

  console.log('\n--- cameraman path-follow: model-yaw flip does not orbit-flip the target (issue #337) ---');
  {
    // The bug: cameraman used `playerRotation.y + angle`, so a sudden model-yaw flip (terrain /
    // pose) whipped the camera to the opposite lane around the rider. Path-follow reads the
    // travelled trajectory, not the instantaneous yaw. To isolate the YAW's effect from the
    // camera's normal per-frame drift, run two identical cameramen down the same straight line
    // and differ ONLY in the model yaw on the final frame; the targets must be (near) identical.
    const runCameraman = (finalYaw) => {
      const cam = newCamera();
      cam.setMode('cameraman');
      const rot = new THREE.Euler(0, 0, 0);
      const player = new THREE.Vector3(0, 50, 0);
      const vel = { x: 0, z: 20 }; // straight downhill, fast enough to source heading from velocity
      cam.initialize(player, rot);
      cam.update(player, rot, vel, () => 0); // first-frame snap
      for (let i = 0; i < 60; i++) { player.z += 0.5; cam.update(player, rot, vel, () => 0); }
      player.z += 0.5;
      cam.update(player, new THREE.Euler(0, finalYaw, 0), vel, () => 0);
      return cam.smoothingVectors.targetPosition.clone();
    };
    const straight = runCameraman(0);           // no yaw change
    const flipped = runCameraman(Math.PI);      // 180° model-yaw flip on the last frame
    // Old orbit-derived math would swing the target by ~2·horiz (tens of units) across the rider.
    check('a π model-yaw flip does not move the cameraman target across the rider (x)',
      Math.abs(flipped.x - straight.x) < 0.5);
    check('a π model-yaw flip does not move the cameraman target across the rider (z)',
      Math.abs(flipped.z - straight.z) < 0.5);
  }

  console.log('\n--- cameraman path-follow: a curving line turns the camera gradually (issue #337) ---');
  {
    // Feed a straight line, then abruptly steer the travel direction 90°. The framing heading
    // must ease (turn over many frames), never snap lane-to-lane in a single frame.
    const cam = newCamera();
    cam.setMode('cameraman');
    const rot = new THREE.Euler(0, 0, 0);
    const player = new THREE.Vector3(0, 50, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 20 }, () => 0); // snap
    for (let i = 0; i < 60; i++) { player.z += 0.5; cam.update(player, rot, { x: 0, z: 20 }, () => 0); }
    const h0 = cam.cameramanHeading; // ~0 (travelling +z)
    // One frame of a 90° steer (now travelling +x): heading must NOT jump the full 90°.
    player.x += 0.5;
    cam.update(player, rot, { x: 20, z: 0 }, () => 0);
    const h1 = cam.cameramanHeading;
    check('the framing heading does not snap the full turn in one frame',
      Math.abs(h1 - h0) < 0.5); // a 90° (~1.57 rad) snap would blow past this
    // Keep steering +x for many frames: the heading converges toward the new travel direction.
    for (let i = 0; i < 140; i++) { player.x += 0.5; cam.update(player, rot, { x: 20, z: 0 }, () => 0); }
    const h2 = cam.cameramanHeading;
    check('the framing heading converges toward the new travel direction over many frames',
      h2 > h0 + 0.5);
  }

  console.log('\n--- cameraman lookAt eases toward the target instead of copying it (issue #337) ---');
  {
    // The old code copied playerPosition into lookAtPosition and looked at it immediately, so the
    // view snapped. Cameraman now eases the smoothed lookAt toward the desired subject target.
    const cam = newCamera();
    cam.setMode('cameraman');
    const rot = new THREE.Euler(0, 0, 0);
    const player = new THREE.Vector3(0, 50, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 0 }, () => 0); // snap: lookAtPosition seeded to player (x=0)
    // Teleport the subject far in +x with no velocity (no look-ahead); the lookAt must ease, not jump.
    const moved = new THREE.Vector3(100, 50, 0);
    cam.update(moved, rot, { x: 0, z: 0 }, () => 0);
    const look1 = cam.smoothingVectors.lookAtPosition.x;
    check('cameraman lookAt moves only partway toward the jumped target on the first frame',
      look1 > 1 && look1 < 99);
    // Over many frames it converges onto the target.
    for (let i = 0; i < 200; i++) cam.update(moved, rot, { x: 0, z: 0 }, () => 0);
    check('cameraman lookAt converges onto the target over many frames',
      approx(cam.smoothingVectors.lookAtPosition.x, 100, 1));

    // Non-cameraman modes keep the byte-identical straight-copy lookAt (ease factor 1.0).
    const follow = newCamera();
    follow.setMode('orbit');
    const p = new THREE.Vector3(0, 50, 0);
    follow.initialize(p, rot);
    follow.update(p, rot, { x: 0, z: 0 }, () => 0); // snap
    const jumped = new THREE.Vector3(40, 50, 0);
    follow.update(jumped, rot, { x: 0, z: 0 }, () => 0);
    check('non-cameraman lookAt still copies the target exactly (no easing regression)',
      approx(follow.smoothingVectors.lookAtPosition.x, 40));
  }

  console.log('\n--- cameraman path state resets on restart / mode (re)entry (issue #337) ---');
  {
    const cam = newCamera();
    cam.setMode('cameraman');
    const rot = new THREE.Euler(0, 0, 0);
    const player = new THREE.Vector3(0, 50, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 20 }, () => 0); // snap
    for (let i = 0; i < 30; i++) { player.z += 0.5; cam.update(player, rot, { x: 0, z: 20 }, () => 0); }
    check('cameraman records path history while active', cam.cameramanPath.length > 1);
    cam.initialize(new THREE.Vector3(0, 50, 0), rot);
    check('re-initialize (restart) clears the cameraman path',
      cam.cameramanPath.length === 0 && cam.cameramanPathDistance === 0 && cam.cameramanHeading === null);
    // Re-entering cameraman via setMode also clears any stale stint.
    cam.cameramanPath.push({ x: 999, y: 0, z: 999, s: 5, heading: 0 });
    cam.cameramanPathDistance = 5;
    cam.setMode('orbit');
    cam.setMode('cameraman');
    check('re-entering cameraman clears a stale path from the previous stint',
      cam.cameramanPath.length === 0 && cam.cameramanHeading === null);
  }

  console.log('\n--- cameraman path-follow: target height anchors to the uphill trail point (issue #337, PR #356) ---');
  {
    // The trail point is uphill of the rider on a descent (higher terrain). Anchoring the target
    // height to the rider's (lower) y would seat it at/below terrain at the trail x/z, so the
    // floor clamp drags the camera along the ground. Anchoring to trail.y preserves the elevated
    // low-side pose. Two runs share identical horizontal motion (=> identical framing/height);
    // only the y-profile differs, isolating the anchor: the descending run must lift MORE.
    const runProfile = (descend) => {
      const cam = newCamera();
      cam.setMode('cameraman');
      const rot = new THREE.Euler(0, 0, 0);
      const player = new THREE.Vector3(0, 200, 0);
      const vel = { x: 0, z: 20 };
      cam.initialize(player, rot);
      cam.update(player, rot, vel, () => 0); // snap
      for (let i = 0; i < 60; i++) {
        player.z += 0.8;
        if (descend) player.y -= 0.8; // steep descent: trail behind stays higher than the rider
        cam.update(player, rot, vel, () => 0);
      }
      return { targetY: cam.smoothingVectors.targetPosition.y, playerY: player.y };
    };
    const flat = runProfile(false);
    const desc = runProfile(true);
    const flatLift = flat.targetY - flat.playerY; // == height only (trail.y == player.y)
    const descLift = desc.targetY - desc.playerY; // == height + (uphill trail.y - player.y)
    check('descending cameraman target lifts above the rider by more than the flat case (trail.y anchor)',
      descLift > flatLift + 3);
  }

  console.log('\n--- cameraman path: history trims, slow-speed heading, empty-path fallback (issue #337) ---');
  {
    const cam = newCamera();
    cam.setMode('cameraman');
    const rot = new THREE.Euler(0, 0, 0);
    const player = new THREE.Vector3(0, 50, 0);
    cam.initialize(player, rot);
    cam.update(player, rot, { x: 0, z: 20 }, () => 0); // snap
    // Travel well past CAMERAMAN_HISTORY_DISTANCE (120u) so the oldest samples are trimmed.
    for (let i = 0; i < 400; i++) { player.z += 0.8; cam.update(player, rot, { x: 0, z: 20 }, () => 0); }
    check('path history stays bounded after long travel (oldest samples trimmed)',
      cam.cameramanPath.length > 2 && cam.cameramanPath.length < 300 &&
      (cam.cameramanPathDistance - cam.cameramanPath[0].s) <= 121);

    // Slow-speed sample derives heading from the position delta, not the (near-zero) velocity.
    const c2 = newCamera();
    c2.resetCameramanPath();
    c2.recordCameramanPath(new THREE.Vector3(0, 0, 0), { x: 0, z: 0 }, 0.3);
    c2.recordCameramanPath(new THREE.Vector3(1, 0, 1), { x: 0, z: 0 }, 0.3); // speed 0 -> atan2(dx,dz)=π/4
    const last = c2.cameramanPath[c2.cameramanPath.length - 1];
    check('a slow-speed sample takes its heading from the position delta', approx(last.heading, Math.PI / 4, 0.001));

    // sampleCameramanTrail on an empty path returns a finite fallback instead of throwing.
    const c3 = newCamera();
    c3.resetCameramanPath();
    const fb = c3.sampleCameramanTrail(5);
    check('sampleCameramanTrail on an empty path returns a finite fallback',
      Number.isFinite(fb.x) && Number.isFinite(fb.y) && Number.isFinite(fb.z));
  }

  console.log('\n--- cameraman path: long frames stay evenly spaced; heading seeds from travel (issue #337, PR #356) ---');
  {
    // A long/hitchy frame (or high speed) that covers several spacings must lay each missed
    // sample ALONG the segment at ~CAMERAMAN_SAMPLE_SPACING, not one endpoint sample — otherwise
    // the path spacing (and the sampled trail/heading) would be frame-rate dependent.
    const cam = newCamera();
    cam.resetCameramanPath();
    cam.recordCameramanPath(new THREE.Vector3(0, 0, 0), { x: 0, z: 20 }, 0); // seed at origin
    cam.recordCameramanPath(new THREE.Vector3(0, 0, 3.0), { x: 0, z: 20 }, 0); // one 3.0u frame
    const gaps = [];
    for (let i = 1; i < cam.cameramanPath.length; i++) gaps.push(cam.cameramanPath[i].s - cam.cameramanPath[i - 1].s);
    check('a long frame inserts several evenly-spaced samples along the segment (not one endpoint)',
      cam.cameramanPath.length >= 4 && gaps.length >= 3 && gaps.every(g => approx(g, 0.75)));

    // Frame-rate independence: the same 3.0u path taken in 4 small frames vs 1 big frame yields
    // (near) identical sample spacing and a matching sampled trail point.
    const fine = newCamera();
    fine.resetCameramanPath();
    fine.recordCameramanPath(new THREE.Vector3(0, 0, 0), { x: 0, z: 20 }, 0);
    for (let k = 1; k <= 4; k++) fine.recordCameramanPath(new THREE.Vector3(0, 0, 0.75 * k), { x: 0, z: 20 }, 0);
    check('a long frame and many short frames produce the same total path distance',
      approx(cam.cameramanPathDistance, fine.cameramanPathDistance, 0.01));

    // The FIRST sample seeds its heading from travel (velocity), not a temporarily-flipped model
    // yaw — so entering/restarting cameraman while moving can't start the camera on the wrong lane.
    const seed = newCamera();
    seed.resetCameramanPath();
    seed.recordCameramanPath(new THREE.Vector3(0, 0, 0), { x: 20, z: 0 }, Math.PI); // travel +x (π/2), yaw flipped to π
    check('the first cameraman sample seeds heading from travel, not the flipped model yaw',
      approx(seed.cameramanPath[0].heading, Math.PI / 2, 0.001) && approx(seed.cameramanHeading, Math.PI / 2, 0.001));
    // With no travel signal it still falls back to the model yaw.
    const still = newCamera();
    still.resetCameramanPath();
    still.recordCameramanPath(new THREE.Vector3(0, 0, 0), { x: 0, z: 0 }, 0.4); // stopped
    check('a stopped first sample falls back to the model yaw', approx(still.cameramanPath[0].heading, 0.4, 0.001));
  }

  console.log('\n--- cameraman entry snap frames from travel, not a flipped model yaw (issue #337, PR #356) ---');
  {
    // Switching to cameraman mid-run (V/tray) calls initialize() then update()'s first-frame snap.
    // If playerRotation.y is momentarily flipped, a yaw-based entry would seat the FIRST rendered
    // frame on the wrong lane before path-follow engages. The entry now frames from velocity, so
    // two entries with the same travel but opposite yaw land at the same camera pose.
    const entryFor = (yaw) => {
      const cam = newCamera();
      cam.setMode('cameraman');
      const player = new THREE.Vector3(0, 50, 0);
      const rot = new THREE.Euler(0, yaw, 0);
      cam.initialize(player, rot);
      cam.update(player, rot, { x: 0, z: 20 }, () => 0); // first-frame snap with forward travel
      return cam.camera.position.clone();
    };
    const straight = entryFor(0);
    const flipped = entryFor(Math.PI); // 180° model-yaw flip, same +z travel
    check('cameraman entry snap is immune to a flipped model yaw when moving (x)',
      Math.abs(straight.x - flipped.x) < 1);
    check('cameraman entry snap is immune to a flipped model yaw when moving (z)',
      Math.abs(straight.z - flipped.z) < 1);

    // Entry with no travel still uses the model yaw (unchanged behaviour: opposite yaw flips side).
    const restEntry = (yaw) => {
      const cam = newCamera();
      cam.setMode('cameraman');
      const player = new THREE.Vector3(0, 50, 0);
      cam.initialize(player, new THREE.Euler(0, yaw, 0));
      return cam.camera.position.clone();
    };
    check('a stopped cameraman entry still frames from the model yaw',
      Math.abs(restEntry(0).x - restEntry(Math.PI).x) > 3);

    // The entry pose must match the FIRST steady path-follow frame (side + up, no trailing term),
    // so the position smoothing doesn't swing the camera around the rider on the next frame. The
    // old cinematicOffset entry seated a full `horiz` behind/side, ~a right-angle away from the
    // steady side pose → a large horizontal gap; the fixed entry gap is just the radial ease.
    const noSnap = newCamera();
    noSnap.setMode('cameraman');
    const p2 = new THREE.Vector3(0, 50, 0);
    const r2 = new THREE.Euler(0, 0, 0);
    const v2 = { x: 0, z: 20 };
    noSnap.initialize(p2, r2);
    noSnap.update(p2, r2, v2, () => 0);            // frame 1: entry snap
    const entryPos = noSnap.camera.position.clone();
    noSnap.update(p2, r2, v2, () => 0);            // frame 2: first steady path-follow target
    const steadyTarget = noSnap.smoothingVectors.targetPosition.clone();
    const horizGap = Math.hypot(steadyTarget.x - entryPos.x, steadyTarget.z - entryPos.z);
    check('cameraman entry pose matches the first steady frame (no swing-around snap)', horizGap < 9);
    check('cameraman entry and first steady frame are on the same side of the rider (x sign)',
      Math.sign(entryPos.x) === Math.sign(steadyTarget.x) && Math.abs(entryPos.x) > 1);
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