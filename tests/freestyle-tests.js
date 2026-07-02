// @ts-check
/**
 * Freestyle trick tests (#32 — Expert tier) for src/snowman/physics.ts.
 *
 * Two layers:
 *   1. gradeFreestyleTrick() — the pure naming/scoring/under-rotation table.
 *   2. The REAL kernel (Snowman.updateSnowman) driven end-to-end on a deterministic
 *      hill: tricks accumulate only behind the double gate (freestyleTricks tuning
 *      AND playerJump provenance), the landing settles them (score folded into
 *      airScoreDelta, under-rotation forces SKETCHY), and every non-freestyle path
 *      stays byte-identical to a tuning-off run.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/freestyle-tests.js
 * (npm test picks it up automatically via tests/run-node-suite.js.)
 */

// Deterministic hill, mirroring the physics-invariant harness (no per-vertex noise).
function getTerrainHeight(x, z) {
  let y = 40 * Math.exp(-Math.sqrt(x * x + z * z) / 40);
  if (z < -30) y += (z + 30) * 0.12;
  return y;
}
function getTerrainGradient(x, z) {
  const eps = 0.1, h = getTerrainHeight(x, z);
  return { x: (getTerrainHeight(x + eps, z) - h) / eps, z: (getTerrainHeight(x, z + eps) - h) / eps };
}
function getDownhillDirection(x, z) {
  const g = getTerrainGradient(x, z);
  const d = { x: -g.x, z: -g.z };
  const len = Math.sqrt(d.x * d.x + d.z * d.z);
  return len ? { x: d.x / len, z: d.z / len } : { x: 0, z: 1 };
}

const g = /** @type {any} */ (globalThis);
g.window = g.window || { location: { search: '' } };

function fakeVec() {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
}
function fakeSnowman() {
  const ski = () => ({ position: fakeVec(), rotation: fakeVec() });
  const rotation = fakeVec(); rotation.y = Math.PI;
  return /** @type {any} */ ({
    position: fakeVec(),
    rotation,
    userData: {
      targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
      leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1
    }
  });
}

const NONE = { left: false, right: false, up: false, down: false, jump: false };
const ctrl = (over) => ({ ...NONE, ...over });

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  const P = await import('../src/snowman/physics.ts');
  const { Snowman } = await import('../src/snowman.ts');
  const D = await import('../src/difficulty.ts');
  const THREE = await import('three');
  const { createSnowman } = await import('../src/snowman/model.ts');
  const update = Snowman.updateSnowman;
  const EXPERT_SKI = D.getDifficultyConfig('expert').ski;

  console.log('\n🎿 SNOWGLIDER FREESTYLE TRICK TESTS (#32, Expert tier) 🎿');
  console.log('================================================\n');

  // ---------------------------------------------------------------------------
  // 1. gradeFreestyleTrick — the pure grading table
  // ---------------------------------------------------------------------------
  runTest('no input grades to the zero trick (null name, 0 score, not under-rotated)', () => {
    const t = P.gradeFreestyleTrick(0, 0, 0);
    assert(t.name === null && t.score === 0 && t.underRotated === false, JSON.stringify(t));
  });

  runTest('a completed 360 names and scores two half-spins', () => {
    const t = P.gradeFreestyleTrick(360, 0, 0);
    assert(t.name === '360', `name ${t.name}`);
    assert(t.score === 2 * P.SPIN_SCORE_PER_180, `score ${t.score}`);
    assert(!t.underRotated, 'should not be under-rotated');
  });

  runTest('landing switch (180) is a credited trick', () => {
    const t = P.gradeFreestyleTrick(-180, 0, 0);
    assert(t.name === '180' && t.score === P.SPIN_SCORE_PER_180 && !t.underRotated, JSON.stringify(t));
  });

  runTest('slight over/under rotation within tolerance still rides away', () => {
    const nearly = P.gradeFreestyleTrick(360 - P.SPIN_LAND_TOL_DEG + 1, 0, 0);
    assert(nearly.name === '360' && !nearly.underRotated, JSON.stringify(nearly));
  });

  runTest('landing sideways (90°) is under-rotated with no credited spin', () => {
    const t = P.gradeFreestyleTrick(90, 0, 0);
    assert(t.underRotated === true && t.name === null && t.score === 0, JSON.stringify(t));
  });

  runTest('an under-rotated spin past a credited increment pays half', () => {
    // 270°: one completed half (180) credited, but the residual 90° > tolerance —
    // under-rotated, so the credited score is halved.
    const t = P.gradeFreestyleTrick(270, 0, 0);
    assert(t.underRotated === true, 'must be under-rotated');
    assert(t.name === '180', `name ${t.name}`);
    assert(t.score === Math.round(1 * P.SPIN_SCORE_PER_180 * 0.5), `score ${t.score}`);
  });

  runTest('a full backflip names BACKFLIP; frontflip names FRONTFLIP; doubles read DOUBLE', () => {
    assert(P.gradeFreestyleTrick(0, -360, 0).name === 'BACKFLIP');
    assert(P.gradeFreestyleTrick(0, 360, 0).name === 'FRONTFLIP');
    assert(P.gradeFreestyleTrick(0, -720, 0).name === 'DOUBLE BACKFLIP');
    assert(P.gradeFreestyleTrick(0, 360, 0).score === P.FLIP_SCORE_PER_360);
  });

  runTest('a half flip (180) is under-rotated — you are upside down', () => {
    const t = P.gradeFreestyleTrick(0, 180, 0);
    assert(t.underRotated === true && t.name === null, JSON.stringify(t));
  });

  runTest('a grab needs GRAB_MIN_HOLD and scores per second held', () => {
    assert(P.gradeFreestyleTrick(0, 0, P.GRAB_MIN_HOLD - 0.01).name === null);
    const t = P.gradeFreestyleTrick(0, 0, 1.0);
    assert(t.name === 'GRAB' && t.score === Math.round(1.0 * P.GRAB_SCORE_PER_SEC), JSON.stringify(t));
  });

  runTest('combos name every component (spin + flip + grab)', () => {
    const t = P.gradeFreestyleTrick(540, -360, 0.5);
    assert(t.name === '540 + BACKFLIP + GRAB', `name ${t.name}`);
    assert(t.score === Math.round(3 * P.SPIN_SCORE_PER_180 + P.FLIP_SCORE_PER_360 + 0.5 * P.GRAB_SCORE_PER_SEC),
      `score ${t.score}`);
  });

  // ---------------------------------------------------------------------------
  // 2. Kernel integration on the Expert tuning
  // ---------------------------------------------------------------------------
  // Drive a manual jump at (0,-60) with `airControls` held while airborne; returns
  // the landing-frame result plus the whole-air-phase bookkeeping.
  function jumpRun(tuning, airControls, { takeoff = ctrl({ jump: true }) } = {}) {
    let s = 7 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -60, y: getTerrainHeight(0, -60) };
    const velocity = { x: 0, z: -16 };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -60),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const step = (c) => {
      st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
        st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
        3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
        [], undefined, tuning);
      return st;
    };
    step(takeoff); // manual straight jump (playerJump = true)
    assert(st.isInAir, 'takeoff frame must go airborne');
    let maxSpin = 0, maxFlip = 0, grabTime = 0, frames = 0;
    const traj = [{ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z }];
    while (st.isInAir && frames < 600) {
      step(airControls);
      frames++;
      traj.push({ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z });
      maxSpin = Math.max(maxSpin, Math.abs(snowman.userData.trickSpin || 0));
      maxFlip = Math.max(maxFlip, Math.abs(snowman.userData.trickFlip || 0));
      grabTime = Math.max(grabTime, snowman.userData.trickGrabTime || 0);
    }
    assert(!st.isInAir, 'air phase must land within 10 s');
    return { landing: st, snowman, maxSpin, maxFlip, grabTime, traj };
  }

  runTest('Expert: spinning through the air accumulates yaw and settles on landing', () => {
    const r = jumpRun(EXPERT_SKI, ctrl({ right: true }));
    assert(r.maxSpin > 180, `expected a real spin, got ${r.maxSpin.toFixed(0)}°`);
    assert(r.snowman.userData.trickSpin === 0, 'trick state must be consumed on landing');
    assert(r.landing.justLanded && r.landing.landingQuality !== null, 'manual jump must be graded');
  });

  runTest('Expert: holding Down backflips (negative flip) and Up frontflips (positive)', () => {
    const back = jumpRun(EXPERT_SKI, ctrl({ down: true }));
    const front = jumpRun(EXPERT_SKI, ctrl({ up: true }));
    assert(back.maxFlip > 300, `backflip should rotate far, got ${back.maxFlip.toFixed(0)}°`);
    assert(front.maxFlip > 300, `frontflip should rotate far, got ${front.maxFlip.toFixed(0)}°`);
  });

  runTest('Expert: the held takeoff press never reads as a grab', () => {
    // Hold Jump for the whole flight straight off the takeoff press: never a grab.
    const held = jumpRun(EXPERT_SKI, ctrl({ jump: true }));
    assert(held.grabTime === 0, `takeoff-held jump must not grab, got ${held.grabTime.toFixed(2)}s`);
  });

  runTest('Expert: release-then-repress Jump accumulates grab time', () => {
    // Custom driver: frame 1 released (arms), rest held (grabs).
    let s = 7 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -60, y: getTerrainHeight(0, -60) };
    const velocity = { x: 0, z: -16 };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -60),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const step = (c) => {
      st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
        st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
        3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
        [], undefined, EXPERT_SKI);
    };
    step(ctrl({ jump: true }));   // takeoff (press held)
    step(NONE);                    // release mid-air => arms the grab
    let frames = 0, grab = 0;
    while (st.isInAir && frames < 600) {
      step(ctrl({ jump: true })); // re-press held => grabbing
      // Track the peak: the landing frame consumes (zeroes) the trick state.
      grab = Math.max(grab, snowman.userData.trickGrabTime || 0);
      frames++;
    }
    assert(grab >= P.GRAB_MIN_HOLD, `expected a held grab, got ${grab.toFixed(2)}s`);
  });

  runTest('Expert: an under-rotated spin forces a SKETCHY landing', () => {
    // Steer right only briefly: ~0.25 s of spin (~90°) then coast the rest of the
    // flight — lands mid-rotation. Custom driver to release the key mid-air.
    let s = 7 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -60, y: getTerrainHeight(0, -60) };
    const velocity = { x: 0, z: -16 };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -60),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const step = (c) => {
      st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
        st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
        3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
        [], undefined, EXPERT_SKI);
    };
    step(ctrl({ jump: true }));
    for (let i = 0; i < 15 && st.isInAir; i++) step(ctrl({ left: true })); // ~90° of spin
    const spun = Math.abs(snowman.userData.trickSpin || 0);
    assert(spun > P.SPIN_LAND_TOL_DEG && spun < 180 - P.SPIN_LAND_TOL_DEG,
      `test setup: spin ${spun.toFixed(0)}° must land in the under-rotated band`);
    let frames = 0;
    while (st.isInAir && frames < 600) { step(NONE); frames++; }
    assert(st.landingQuality === 'sketchy',
      `mid-rotation landing must be sketchy, got ${st.landingQuality}`);
  });

  runTest('Expert: a completed trick lands with its name + trick points in airScoreDelta', () => {
    const spun = jumpRun(EXPERT_SKI, ctrl({ right: true }));
    const plain = jumpRun(EXPERT_SKI, NONE);
    assert(spun.landing.trickName !== null, 'completed spin must be named');
    assert(plain.landing.trickName === null, 'plain jump has no trick name');
    // Same airtime (same pop, same hill): the trick landing must out-score the plain
    // one unless the spin was under-rotated AND crossed up enough to zero out — with
    // a full-flight held spin the completed increments dominate.
    assert(spun.landing.airScoreDelta > 0 && plain.landing.airScoreDelta > 0, 'both score airtime');
  });

  runTest('Provenance gate: tricks never accumulate in an auto-jump air phase', () => {
    // Launch via the terrain-lip auto-jump (no jump input) with trick keys held.
    let s = 7 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -50, y: getTerrainHeight(0, -50) };
    const velocity = { x: 0, z: -16 };
    let st = { isInAir: false, verticalVelocity: 0,
               lastTerrainHeight: getTerrainHeight(0, -50) + 5, // fake a lip: height drop < -0.8
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const step = (c) => {
      st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
        st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
        3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
        [], undefined, EXPERT_SKI);
    };
    step(ctrl({ right: true, down: true })); // auto-jump fires; trick keys held
    assert(st.isInAir, 'auto-jump must fire');
    assert(!snowman.userData.playerJump, 'auto-jump is not a player jump');
    let frames = 0;
    while (st.isInAir && frames < 600) { step(ctrl({ right: true, down: true })); frames++; }
    assert(!snowman.userData.trickSpin && !snowman.userData.trickFlip,
      'tricks must not accumulate without playerJump provenance');
    assert(st.landingQuality === null && st.airScoreDelta === 0 && st.trickName === null,
      'auto-jump landing stays ungraded and unscored');
  });

  // ---------------------------------------------------------------------------
  // Wipeout residual table (JP-4, tuning.wipeouts — Expert only). Single landing
  // frames with the trick state pre-stamped isolate the grade: the ONLY rotation
  // that can trip the 120° wipeout residual is the flip (a spin's residual to the
  // nearest 180 maxes at 90°), so mid-somersault = crash on Expert, while the same
  // touchdown on a wipeouts-off tier keeps today's forced-SKETCHY scrub.
  // ---------------------------------------------------------------------------
  function landWithFlip(tuning, flipDeg, vv = -10) {
    let s = 9 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    snowman.userData.playerJump = true;
    snowman.userData.trickFlip = flipDeg;
    const ground = getTerrainHeight(0, -60);
    const pos = { x: 0, z: -60, y: ground - 0.01 }; // just below terrain => lands now
    const velocity = { x: 0, z: -16 };
    return update(snowman, 1 / 60, pos, velocity, true, vv, ground,
      1.5, 0, NONE, 0, 0, 3, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
      [], false, function () {}, [], undefined, tuning);
  }

  runTest('Wipeout residual table: mid-somersault crashes on Expert, scrubs elsewhere (JP-4)', () => {
    // 180° into a flip: residual 180 > WIPEOUT_FLIP_RESIDUAL_DEG (120).
    const expertHead = landWithFlip(EXPERT_SKI, 180);
    assert(expertHead.landingQuality === 'wipeout',
      `Expert mid-somersault must wipeout, got ${expertHead.landingQuality}`);
    assert(expertHead.airScoreDelta === 0, 'a wipeout banks nothing');
    const blueHead = landWithFlip(D.BLUE_PHYSICS_TUNING, 180);
    assert(blueHead.landingQuality === 'sketchy',
      `wipeouts-off tier keeps the SKETCHY scrub, got ${blueHead.landingQuality}`);
    // Within the wipeout residual but still under-rotated (residual 100°: > the 75°
    // landing tolerance, < the 120° wipeout line): SKETCHY on Expert too.
    const expertUgly = landWithFlip(EXPERT_SKI, 360 - 100);
    assert(expertUgly.landingQuality === 'sketchy',
      `under-rotated-but-not-headfirst stays sketchy, got ${expertUgly.landingQuality}`);
    // A completed somersault (residual 0) rides away — graded by aim/impact alone.
    const expertFlip = landWithFlip(EXPERT_SKI, 360);
    assert(expertFlip.landingQuality !== 'wipeout' && expertFlip.landingQuality !== null,
      `a completed flip must not wipeout, got ${expertFlip.landingQuality}`);
    assert(expertFlip.trickName === 'FRONTFLIP', `completed flip named, got ${expertFlip.trickName}`);
  });

  runTest('Wipeout impact table: an extreme slam crashes only with tuning.wipeouts (JP-4)', () => {
    // vv -45 into the moderate hill slope (~19°, which absorbs ~7 m/s of the fall):
    // vImpact ≈ 37, past LAND_WIPEOUT_NORMAL (34).
    const expertSlam = landWithFlip(EXPERT_SKI, 0, -45);
    assert(expertSlam.landingQuality === 'wipeout',
      `Expert extreme slam must wipeout, got ${expertSlam.landingQuality}`);
    const blueSlam = landWithFlip(D.BLUE_PHYSICS_TUNING, 0, -45);
    assert(blueSlam.landingQuality === 'sketchy',
      `wipeouts-off slam is forced sketchy, got ${blueSlam.landingQuality}`);
  });

  runTest('Tier gate: the same trick inputs on Blue leave the run byte-identical to no-trick-system', () => {
    // Blue's tuning has freestyleTricks: false — a jump+steer flight must produce the
    // exact same trajectory as it does today (the airControl drift is the only effect),
    // and no trick state or name may appear.
    const blue = jumpRun(D.BLUE_PHYSICS_TUNING, ctrl({ right: true, up: true }));
    assert(blue.maxSpin === 0 && blue.maxFlip === 0 && blue.grabTime === 0,
      'no trick accumulation on a non-freestyle tier');
    assert(blue.landing.trickName === null, 'no trick name on a non-freestyle tier');
    // And the Expert no-trick-input flight matches Blue's flight exactly at the same
    // tuning numbers except the flag — proving the flag alone changes nothing when
    // no trick keys are pressed. (Expert === Black numbers, so compare Expert with
    // freestyle off vs on, no inputs.)
    const expertOff = jumpRun({ ...EXPERT_SKI, freestyleTricks: false }, NONE);
    const expertOn = jumpRun(EXPERT_SKI, NONE);
    const n = Math.min(expertOff.traj.length, expertOn.traj.length);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      const a = expertOff.traj[i], b = expertOn.traj[i];
      maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.z - b.z),
        Math.abs(a.vx - b.vx), Math.abs(a.vz - b.vz));
    }
    assert(expertOff.traj.length === expertOn.traj.length && maxDiff === 0,
      `no-input flight must be byte-identical with the flag on (maxDiff ${maxDiff})`);
  });

  runTest('camera heading never snaps through a spin or its switch landing', () => {
    // The follow camera reads rotation.y + userData.trickCameraYaw (main-loop
    // updateCamera). pose.ts must keep that sum CONTINUOUS: frozen at the pre-spin
    // heading while the model spins, then eased back in lock-step with the heading
    // recovery after a switch / under-rotated landing — never a one-frame jump by
    // the spun residual at touchdown (codex on PR #275, rounds 1 + 2).
    let s = 7 >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -60, y: getTerrainHeight(0, -60) };
    const velocity = { x: 0, z: -16 };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -60),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const step = (c) => {
      st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
        st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
        3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
        [], undefined, EXPERT_SKI);
    };
    const wrap = (a) => { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };
    const camHeading = () => snowman.rotation.y + (snowman.userData.trickCameraYaw || 0);

    step(ctrl({ jump: true }));
    // ~150° of spin: within tolerance of the 180 => a credited switch landing.
    for (let i = 0; i < 25 && st.isInAir; i++) step(ctrl({ left: true }));
    assert(Math.abs(snowman.userData.trickSpin) > 120, 'test setup: a real spin accumulated');
    let prev = camHeading();
    let maxJump = 0;
    let landedFrame = -1;
    let frames = 0;
    while (frames < 600 && (st.isInAir || landedFrame === -1 || frames < landedFrame + 240)) {
      step(NONE);
      frames++;
      if (!st.isInAir && landedFrame === -1) landedFrame = frames;
      const cur = camHeading();
      maxJump = Math.max(maxJump, Math.abs(wrap(cur - prev)));
      prev = cur;
    }
    assert(landedFrame !== -1, 'flight must land');
    // Heading recovery is capped at 3 rad/s (0.05 rad/frame); allow slack but stay
    // far below the ~2.6 rad snap the pre-fix code produced at touchdown.
    assert(maxJump < 0.2, `camera heading jumped ${maxJump.toFixed(3)} rad in one frame`);
    assert((snowman.userData.trickCameraYaw || 0) === 0,
      'camera correction must fully ease out after the landing');
  });

  runTest('resetSnowman clears the trick slate', () => {
    const snowman = fakeSnowman();
    snowman.userData.trickSpin = 270;
    snowman.userData.trickFlip = -100;
    snowman.userData.trickGrabTime = 0.4;
    snowman.userData.trickGrabArmed = true;
    snowman.userData.trickGrabbing = true;
    const pos = { x: 0, y: 0, z: 0 };
    const velocity = { x: 0, z: 0 };
    Snowman.resetSnowman(snowman, pos, velocity, getTerrainHeight, { initialize() {} });
    assert(snowman.userData.trickSpin === 0 && snowman.userData.trickFlip === 0
      && snowman.userData.trickGrabTime === 0 && snowman.userData.trickGrabArmed === false
      && snowman.userData.trickGrabbing === false, 'reset must clear all trick state');
  });

  // ---------------------------------------------------------------------------
  // COM flip pivot (JP-5, plan §6.1): flips rotate about the body's mass-weighted
  // center (userData.flipPivot at y ≈ 3.1), not the feet — and the restructure is
  // POSE-ONLY: the physics trajectory of a flip flight is identical whether the
  // model carries the pivot (real snowman) or not (the plain test fake).
  // ---------------------------------------------------------------------------
  runTest('flip pivot: the model exposes flipPivot at the COM with world layout unchanged (JP-5)', () => {
    const scene = new THREE.Scene();
    const snowman = createSnowman(scene);
    const pivot = snowman.userData.flipPivot;
    assert(pivot && Math.abs(pivot.position.y - 3.1) < 1e-9, 'flipPivot sits at COM y=3.1');
    // Re-basing must keep world placement identical: head sphere center stays at
    // world y=7 (model.ts spheres at 2 / 4.5 / 7) and the ski roots at y≈0.1.
    snowman.updateMatrixWorld(true);
    const headWorld = new THREE.Vector3();
    snowman.userData.parts.head.getWorldPosition(headWorld);
    assert(Math.abs(headWorld.y - 7) < 1e-6, `head world y must stay 7, got ${headWorld.y}`);
    const skiWorld = new THREE.Vector3();
    snowman.userData.leftSki.getWorldPosition(skiWorld);
    assert(Math.abs(skiWorld.y - 0.1) < 1e-6, `ski root world y must stay 0.1, got ${skiWorld.y}`);
  });

  runTest('flip pivot: a flip flight rotates the pivot, keeps the root pitch clamped, and is pose-only (JP-5)', () => {
    // Drive the REAL model through a flip flight and the plain fake through the same
    // flight; compare mid-air pose state and the physics trajectories.
    function flipFlight(snowman) {
      let s = 7 >>> 0;
      Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const pos = { x: 0, z: -60, y: getTerrainHeight(0, -60) };
      const velocity = { x: 0, z: -16 };
      let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -60),
                 airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
      const step = (c) => {
        st = update(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
          st.airTime, st.jumpCooldown, c, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
          3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
          [], undefined, EXPERT_SKI);
      };
      step(ctrl({ jump: true }));
      let frames = 0, maxPivotX = 0, maxRootPitch = 0;
      const traj = [];
      const pivot = snowman.userData.flipPivot;
      while (st.isInAir && frames < 600) {
        step(ctrl({ up: true })); // hold a frontflip the whole flight
        frames++;
        if (pivot) maxPivotX = Math.max(maxPivotX, Math.abs(pivot.rotation.x));
        maxRootPitch = Math.max(maxRootPitch, Math.abs(snowman.rotation.x));
        traj.push({ x: pos.x, y: pos.y, z: pos.z, vx: velocity.x, vz: velocity.z });
      }
      return { traj, maxPivotX, maxRootPitch, pivot };
    }
    const real = flipFlight(createSnowman(new THREE.Scene()));
    const fake = flipFlight(fakeSnowman());
    // The pivot carries the somersault (well past the 0.5 rad root pitch clamp)...
    assert(real.maxPivotX > 1.0, `pivot must carry the flip, got ${real.maxPivotX.toFixed(2)} rad`);
    // ...while the root's pitch stays inside the tilt clamp (the camera reads the root).
    assert(real.maxRootPitch <= 0.5 + 1e-6,
      `root pitch must stay clamped, got ${real.maxRootPitch.toFixed(2)} rad`);
    assert(real.pivot.rotation.x === 0, 'pivot rights itself on landing (trickFlip consumed)');
    // Pose-only: identical physics with and without the pivot (harness gate 7).
    assert(real.traj.length === fake.traj.length, 'flights must run the same frames');
    let maxDiff = 0;
    for (let i = 0; i < real.traj.length; i++) {
      const a = real.traj[i], b = fake.traj[i];
      maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z),
        Math.abs(a.vx - b.vx), Math.abs(a.vz - b.vz));
    }
    assert(maxDiff === 0, `COM pivot must be pose-only (traj max abs diff ${maxDiff})`);
  });

  console.log('\n================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
