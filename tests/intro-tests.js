// @ts-check
/**
 * Unit tests for the cinematic intro fly-over (src/intro.ts, issue #51).
 *
 * Exercises the REAL IntroModule with no browser: the path math is plain-number
 * Catmull-Rom, the camera is the minimal `IntroCamera` stub, and the clock /
 * animation-frame scheduler are injected so the whole fly-over runs to completion
 * deterministically. Covers:
 *   - sampleSpline passes through its endpoints and stays bounded
 *   - buildDefaultKeyframes ends exactly at the supplied gameplay pose
 *   - the skip path places the camera at the end pose and completes synchronously
 *     WITHOUT scheduling an animation frame
 *   - a full driven fly-over starts at the first keyframe, lands exactly on the
 *     gameplay pose, fires onComplete exactly once, and renders every frame
 *   - mid-flight skip() jumps to the end pose and completes once
 *   - terrain clearance lifts the camera above a tall slope
 *
 * Run with the .js -> .ts resolve hook (intro.ts has erasable types only):
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/intro-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps == null ? 1e-9 : eps)) {
    throw new Error(`${msg || 'expected close'}: ${a} vs ${b} (eps ${eps})`);
  }
}

// Minimal camera stub matching the IntroCamera surface. Records the last set
// position and the last look-at target.
function makeCamera() {
  const cam = {
    pos: { x: NaN, y: NaN, z: NaN },
    look: { x: NaN, y: NaN, z: NaN },
  };
  cam.position = { set(x, y, z) { cam.pos = { x, y, z }; } };
  cam.lookAt = (x, y, z) => { cam.look = { x, y, z }; };
  return /** @type {any} */ (cam);
}

(async () => {
  const intro = await import('../src/intro.js');
  const { IntroModule, buildDefaultKeyframes, sampleSpline, prefersReducedMotion, INTRO_DURATION } = intro;

  console.log('\n🎬 SNOWGLIDER INTRO FLY-OVER TESTS (intro.ts) 🎬');
  console.log('================================================\n');

  runTest('sampleSpline passes through its endpoints', () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 5, z: -10 },
      { x: 4, y: 2, z: -30 },
      { x: -2, y: 9, z: -50 },
    ];
    const a = sampleSpline(pts, 0);
    const b = sampleSpline(pts, 1);
    near(a.x, 0, 1e-9, 'u=0 x'); near(a.y, 0, 1e-9, 'u=0 y'); near(a.z, 0, 1e-9, 'u=0 z');
    near(b.x, -2, 1e-9, 'u=1 x'); near(b.y, 9, 1e-9, 'u=1 y'); near(b.z, -50, 1e-9, 'u=1 z');
  });

  runTest('sampleSpline clamps out-of-range u to the endpoints', () => {
    const pts = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    const lo = sampleSpline(pts, -5);
    const hi = sampleSpline(pts, 5);
    near(lo.x, 1, 1e-9, 'clamp low'); near(hi.z, 6, 1e-9, 'clamp high');
  });

  runTest('buildDefaultKeyframes ends exactly at the gameplay pose', () => {
    const endPosition = { x: 0, y: 36, z: -30 };
    const endTarget = { x: 0, y: 27, z: -15 };
    const kf = buildDefaultKeyframes(endPosition, endTarget);
    assert(kf.length >= 2, 'has multiple keyframes');
    const last = kf[kf.length - 1];
    assert(last.pos.x === 0 && last.pos.y === 36 && last.pos.z === -30, 'last pos == endPosition');
    assert(last.target.x === 0 && last.target.y === 27 && last.target.z === -15, 'last target == endTarget');
    // The first keyframe is high above and down-course (an establishing shot).
    assert(kf[0].pos.y > endPosition.y, 'starts above the gameplay pose');
    assert(kf[0].pos.z < endPosition.z, 'starts further down-course than the gameplay pose');
  });

  runTest('prefersReducedMotion is false without a matchMedia-capable window', () => {
    assert(prefersReducedMotion() === false, 'no window/matchMedia -> false');
  });

  runTest('skip path: camera at end pose, onComplete sync, no animation frame scheduled', () => {
    const cam = makeCamera();
    let completed = 0;
    let rafCalls = 0;
    const endPosition = { x: 1, y: 36, z: -30 };
    const endTarget = { x: 0, y: 27, z: -15 };
    const handle = IntroModule.play({
      camera: cam,
      endPosition,
      endTarget,
      onComplete: () => { completed++; },
      skip: true,
      now: () => 0,
      raf: () => { rafCalls++; return 1; },
      showSkipButton: false,
    });
    assert(completed === 1, 'onComplete fired exactly once synchronously');
    assert(handle.done === true, 'handle reports done');
    assert(rafCalls === 0, 'no animation frame scheduled on the skip path');
    near(cam.pos.x, 1, 1e-9, 'end x'); near(cam.pos.y, 36, 1e-9, 'end y'); near(cam.pos.z, -30, 1e-9, 'end z');
    near(cam.look.x, 0, 1e-9, 'look x'); near(cam.look.z, -15, 1e-9, 'look z');
  });

  runTest('driven fly-over: starts at the first keyframe and lands on the gameplay pose', () => {
    const cam = makeCamera();
    let completed = 0;
    let renders = 0;
    /** @type {any} */
    let queued = null;
    let clock = 0;
    const duration = INTRO_DURATION;
    const endPosition = { x: 0, y: 36, z: -30 };
    const endTarget = { x: 0, y: 27, z: -15 };

    const handle = IntroModule.play({
      camera: cam,
      endPosition,
      endTarget,
      duration,
      onComplete: () => { completed++; },
      render: () => { renders++; },
      getTerrainHeight: () => 0, // flat, below the whole path -> no clamping
      now: () => clock,
      raf: (cb) => { queued = cb; return 1; },
      caf: () => { queued = null; },
      showSkipButton: false,
    });

    // First frame is at clock 0 -> the first keyframe (high, down-course).
    assert(queued !== null, 'an initial frame was scheduled');
    const kf = buildDefaultKeyframes(endPosition, endTarget);
    near(cam.pos.y, kf[0].pos.y, 1e-6, 'first frame at keyframe[0] y');
    near(cam.pos.z, kf[0].pos.z, 1e-6, 'first frame at keyframe[0] z');

    // Drive the clock across the duration in steps, invoking the queued frame.
    const steps = 40;
    for (let i = 1; i <= steps && queued && !handle.done; i++) {
      clock = (duration * 1000 * i) / steps;
      const cb = queued;
      cb(clock);
    }

    assert(handle.done === true, 'fly-over completed');
    assert(completed === 1, 'onComplete fired exactly once');
    assert(renders >= steps, `rendered every frame (got ${renders})`);
    // Landed exactly on the gameplay pose (finish() snaps to the end pose).
    near(cam.pos.x, 0, 1e-9, 'final x'); near(cam.pos.y, 36, 1e-9, 'final y'); near(cam.pos.z, -30, 1e-9, 'final z');
    near(cam.look.z, -15, 1e-9, 'final look z');

    // Re-invoking a stale frame callback is a no-op (no double onComplete).
    if (queued) queued(clock);
    assert(completed === 1, 'no double completion from a stale frame');
  });

  runTest('mid-flight skip() jumps to the gameplay pose and completes once', () => {
    const cam = makeCamera();
    let completed = 0;
    /** @type {any} */
    let queued = null;
    let clock = 0;
    const endPosition = { x: 0, y: 36, z: -30 };
    const endTarget = { x: 0, y: 27, z: -15 };

    const handle = IntroModule.play({
      camera: cam,
      endPosition,
      endTarget,
      onComplete: () => { completed++; },
      getTerrainHeight: () => 0,
      now: () => clock,
      raf: (cb) => { queued = cb; return 1; },
      caf: () => { queued = null; },
      showSkipButton: false,
    });

    // Advance a little, then skip.
    clock = 500;
    queued(clock);
    assert(!handle.done, 'not done before skip');
    handle.skip();
    assert(handle.done === true, 'done after skip');
    assert(completed === 1, 'onComplete fired once on skip');
    near(cam.pos.y, 36, 1e-9, 'skip lands on end pose y');
    near(cam.pos.z, -30, 1e-9, 'skip lands on end pose z');

    // A late frame callback after skip must not re-complete.
    if (queued) queued(clock);
    assert(completed === 1, 'no double completion after skip');
  });

  runTest('terrain clearance lifts the camera above a tall slope', () => {
    const cam = makeCamera();
    /** @type {any} */
    let queued = null;
    let clock = 0;
    const clearance = 6;
    const handle = IntroModule.play({
      camera: cam,
      endPosition: { x: 0, y: 36, z: -30 },
      endTarget: { x: 0, y: 27, z: -15 },
      onComplete: () => {},
      // Author a path point well below this terrain height so clamping must engage.
      keyframes: [
        { pos: { x: 0, y: 1, z: -100 }, target: { x: 0, y: 0, z: 0 } },
        { pos: { x: 0, y: 36, z: -30 }, target: { x: 0, y: 27, z: -15 } },
      ],
      getTerrainHeight: () => 200, // sky-high floor
      minCameraClearance: clearance,
      now: () => clock,
      raf: (cb) => { queued = cb; return 1; },
      caf: () => { queued = null; },
      showSkipButton: false,
    });
    // First frame (clock 0) sits at the low first keyframe -> must be lifted to floor+clearance.
    near(cam.pos.y, 200 + clearance, 1e-6, 'camera lifted above terrain');
    assert(queued !== null, 'frame scheduled');
    handle.skip();
  });

  console.log('\n================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
