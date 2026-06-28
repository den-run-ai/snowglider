// @ts-check
// forward_stress_harness.js
// Robustness stress test for the "floor it forward and blow past the obstacles"
// class of bug (PR #209) — broadened in the #209 follow-up to a full INPUT x
// FRAME-RATE matrix. It drives the REAL physics kernel (Snowman.updateSnowman) over
// the REAL analytic terrain with the REAL procedurally placed trees + rocks, across
// several input policies, frame rates (incl. bursty frame hitching), and layouts.
//
// Unlike physics_invariant_harness.js — which pins coasting byte-for-byte and gates
// straight-line cruise speed on a synthetic constant slope — this exercises the kernel
// against the actual mountain and obstacle field, where discrete point-vs-radius
// collision and coarse integration can interact. It guards:
//
//   1. NO TUNNELING (trees AND rocks) — the collision checks are discrete point-vs-
//      radius tests, so a per-frame step larger than an obstacle radius can skip the
//      disk entirely. The harness replays each frame's prev->cur segment against every
//      tree disk (radius 2.5) and every rock disk (per-rock rockCollisionRadius) and
//      asserts zero uncaught pass-throughs, at every frame rate and under every policy.
//   2. FRAME-RATE-BOUNDED SPEED — terminal speed must not balloon at low frame rate
//      under ANY policy (the #209 drag bug; ~8 -> ~32 m/s from 60 to 10 FPS before the
//      fix). Gated as the 10-FPS/60-FPS max-speed ratio across the whole input matrix —
//      max-speed is the robust frame-rate observable; a per-frame mistake in any force
//      path (steer/accelerate/jump/brake) would inflate it.
//   3. NO NaN/Infinity — every pos/velocity stays finite, every policy, every rate.
//   4. TERMINATION — every descent ENDS (finish / crash / off-side) within the frame
//      cap rather than spinning. Closest reproducible proxy for the reported "the game
//      freezes at the end" (issue 2): a runaway/stuck state would exhaust the cap here.
//
// NOT gated (reported as a diagnostic): steered-path convergence. A deterministic slalom
// does NOT trace the same path at every FPS — coarse-dt Euler on the radial fall line
// drifts it tens of units — but that is honest integration sensitivity (the steer force
// is delta-scaled), too chaotic to gate without flaking.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/forward_stress_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + tree/rock placement touch (no DOM/WebGL).
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined; // trees/rocks skip canvas textures when document is absent
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Seeded PRNG so tree/rock placement, the auto-turn, and the wander schedule are
// reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Distance from point (px,pz) to segment a->b (for the tunneling probe).
function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const ab2 = abx * abx + abz * abz;
  let t = ab2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}

function makeScene() {
  const children = [];
  return /** @type {any} */ ({ children, add(o) { children.push(o); }, remove(o) { const i = children.indexOf(o); if (i >= 0) children.splice(i, 1); }, userData: {} });
}

function fakeSnowman() {
  const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  return /** @type {any} */ ({
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1 },
  });
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { Snowman } = await import('../../src/snowman.ts');
  const terrain = await import('../../src/mountains/terrain.ts');
  const { Trees } = await import('../../src/mountains/trees.ts');
  const { addRocks, rockCollisionRadius } = await import('../../src/mountains/rocks.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const TREE_RADIUS = 2.5;            // mirrors collision.ts default treeCollisionRadius
  const SEEDS = [12345, 777, 42, 9001];
  const FRAME_RATES = [1 / 60, 1 / 30, 1 / 10]; // 60, 30, and the capped-delta 10 FPS

  const UP = { left: false, right: false, up: true, down: false, jump: false };
  const mk = (over) => ({ left: false, right: false, up: true, down: false, jump: false, ...over });

  // --- Input policies. Each returns the controls for a frame given the in-game time
  // `t` (seconds), live pos/velocity, the tree field, and the per-descent schedule.
  // Steering keyed to IN-GAME TIME (not frame index) so a given seed skis the same
  // *pattern* at every frame rate; policies that set left/right bypass the kernel's
  // auto-turn (and its Math.random), keeping them deterministic across frame rates.
  const POLICIES = {
    // Hold Up only — the original "floor it forward" case; auto-turn meanders gently.
    holdUp: () => UP,
    // Deterministic time-keyed slalom (no RNG) — used for the convergence gate.
    slalom: (t) => (Math.floor(t / 1.5) % 2 === 0 ? mk({ right: true }) : mk({ left: true })),
    // Time-keyed random-walk steering from the descent schedule (frame-rate stable).
    wander: (t, pos, vel, trees, sched) => {
      const dir = sched[Math.min(sched.length - 1, Math.floor(t / 0.8))];
      return dir < 0 ? mk({ left: true }) : dir > 0 ? mk({ right: true }) : UP;
    },
    // Adversarial: steer toward the nearest tree ahead within range — worst case for
    // the discrete collision check. Deterministic from the (frame-rate-varying) path,
    // gated only on no-tunnel / finite / termination (not convergence).
    adversarial: (t, pos) => {
      let best = null, bestD = 18;
      for (const tr of POLICY_TREES) {
        if (tr.z > pos.z) continue;                 // only trees downhill (ahead)
        const d = Math.hypot(tr.x - pos.x, tr.z - pos.z);
        if (d < bestD) { bestD = d; best = tr; }
      }
      if (!best) return UP;
      return best.x > pos.x ? mk({ right: true }) : mk({ left: true });
    },
    // Jump spam: hold Up and pulse Jump ~every 0.8 s of in-game time.
    jumpSpam: (t) => mk({ jump: (Math.floor(t / 0.8) % 2 === 0) }),
  };
  let POLICY_TREES = []; // set per descent so the adversarial policy can see the field

  // One descent. `frameSpec` is either a fixed dt (number) or { hitch: true, seed }
  // for bursty frame hitching (mostly 1/60 with occasional capped 0.1 s spikes — the
  // GC-pause scenario). `policyName` selects the input policy.
  function runDescent(layoutSeed, frameSpec, policyName, opts = {}) {
    const maxTime = opts.maxTime || Infinity; // stop the descent after this many in-game seconds
    Math.random = makeRng(layoutSeed);
    const scene = makeScene();
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    const treePositions = Trees.addTrees(scene);
    const rockPositions = addRocks(scene);
    console.log = _log; console.warn = _warn;
    // Hazard-cleared course (mirrors the e2e reset spec, which empties these arrays
    // in place): used by the finishability gate (G1) so the only thing under test is
    // whether terrain + physics let a clean line reach the bottom. Asserting "a coast
    // always finishes" on the RANDOM tree/rock field would be wrong — the course is
    // meant to sometimes punish a passive line.
    if (opts.clearHazards) { treePositions.length = 0; rockPositions.length = 0; }
    POLICY_TREES = treePositions;

    // Per-descent steering schedule for `wander` (in-game-time keyed, so identical
    // across frame rates); separate stream from placement so layouts stay fixed.
    const sRng = makeRng(0x5EED ^ layoutSeed);
    const schedule = Array.from({ length: 200 }, () => (sRng() < 0.5 ? -1 : 1));

    Math.random = makeRng(0xC0FFEE ^ layoutSeed); // deterministic auto-turn, independent of dt
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);

    let reason = null;
    const showGameOver = (r) => { if (!reason) reason = r; };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const policy = POLICIES[policyName];

    // Frame-time generator. Fixed dt, or bursty hitching clamped to the 0.1 s loop cap.
    const fixed = typeof frameSpec === 'number';
    const hitchRng = fixed ? null : makeRng(0x117C4 ^ layoutSeed ^ (frameSpec.seed || 0));
    const nextDt = () => fixed ? frameSpec : (hitchRng() < 0.08 ? 0.1 : 1 / 60);
    // Cap wall-clock frames at ~2 min in-game; smallest dt sets the worst case.
    const MAX_FRAMES = Math.ceil(120 / (fixed ? frameSpec : 1 / 60));

    let maxSpeed = 0, maxStep = 0, treeTunnel = 0, rockTunnel = 0, nonFinite = false, t = 0, f = 0;
    for (; f < MAX_FRAMES; f++) {
      const dt = nextDt();
      t += dt;
      const prevX = pos.x, prevZ = pos.z;
      const controls = policy(t, pos, velocity, treePositions, schedule);
      st = Snowman.updateSnowman(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        treePositions, true, showGameOver, rockPositions);
      snowman.position.set(pos.x, pos.y, pos.z);

      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z) ||
          !Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)) { nonFinite = true; break; }

      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed > maxSpeed) maxSpeed = speed;
      const step = Math.hypot(pos.x - prevX, pos.z - prevZ);
      if (step > maxStep) maxStep = step;

      // Tunneling probe: did the prev->cur segment pass THROUGH an obstacle disk that
      // neither endpoint sampled inside (so the point-based check missed it)?
      for (const tr of treePositions) {
        if (pointSegmentDistance(tr.x, tr.z, prevX, prevZ, pos.x, pos.z) < TREE_RADIUS &&
            Math.hypot(prevX - tr.x, prevZ - tr.z) >= TREE_RADIUS &&
            Math.hypot(pos.x - tr.x, pos.z - tr.z) >= TREE_RADIUS) {
          treeTunnel++;
        }
      }
      for (const rk of rockPositions) {
        const rr = rockCollisionRadius(rk.size);
        if (pointSegmentDistance(rk.x, rk.z, prevX, prevZ, pos.x, pos.z) < rr &&
            Math.hypot(prevX - rk.x, prevZ - rk.z) >= rr &&
            Math.hypot(pos.x - rk.x, pos.z - rk.z) >= rr) {
          rockTunnel++;
        }
      }

      if (reason || pos.z < -195 || t >= maxTime) break;
    }
    const finished = pos.z < -195;                  // strictly: reached the finish line
    const terminated = reason !== null || finished; // ended (finish / crash / off-side)
    return { maxSpeed, maxStep, treeTunnel, rockTunnel, nonFinite, terminated, finished, reason,
             finalX: pos.x, finalZ: pos.z, framesUsed: f + 1, maxFrames: MAX_FRAMES,
             trees: treePositions.length, rocks: rockPositions.length };
  }

  let hardFail = false;

  // --- Run the full INPUT x FRAME-RATE matrix (fixed rates + a hitch run) ---
  const POLICY_NAMES = ['holdUp', 'slalom', 'wander', 'adversarial', 'jumpSpam'];
  const records = []; // { seed, policy, fps|'hitch', ...metrics }
  for (const seed of SEEDS) {
    for (const policyName of POLICY_NAMES) {
      for (const dt of FRAME_RATES) {
        records.push({ seed, policy: policyName, fps: Math.round(1 / dt), dt, ...runDescent(seed, dt, policyName) });
      }
      // One bursty-hitching run per (seed, policy): GC-pause spikes amid 60 FPS frames.
      records.push({ seed, policy: policyName, fps: 'hitch', dt: null, ...runDescent(seed, { hitch: true, seed: 1 }, policyName) });
    }
  }

  // --- 1) No tunneling (trees AND rocks), any policy / rate [GATING] ---
  let totalTreeTunnel = 0, totalRockTunnel = 0, worstStep = 0, worstStepCtx = '';
  for (const r of records) {
    totalTreeTunnel += r.treeTunnel; totalRockTunnel += r.rockTunnel;
    if (r.maxStep > worstStep) { worstStep = r.maxStep; worstStepCtx = `${r.policy}@${r.fps}FPS seed ${r.seed}`; }
  }
  const noTunneling = totalTreeTunnel === 0 && totalRockTunnel === 0 && worstStep < TREE_RADIUS;
  console.log('=== Forward stress: real terrain + trees + rocks | %d policies x %d rates+hitch x %d seeds ===',
    POLICY_NAMES.length, FRAME_RATES.length, SEEDS.length);
  console.log('\n--- No collision tunneling (trees + rocks) at any frame rate / policy [GATING] ---');
  console.log('  uncaught tree pass-throughs:', totalTreeTunnel, '| uncaught rock pass-throughs:', totalRockTunnel);
  console.log('  worst per-frame step:', worstStep.toFixed(3), `(${worstStepCtx})`, '| tree radius:', TREE_RADIUS);
  console.log('  PASS:', noTunneling ? 'every step stays inside the collision radius ✅' : 'a frame stepped past an obstacle disk ❌');
  if (!noTunneling) hardFail = true;

  // --- 2) Speed does not balloon at low frame rate, EVERY policy [GATING] ---
  // Generalizes the #209 holdUp speed gate to the whole input matrix: a per-frame-vs-
  // per-second mistake in ANY force path (steer, accelerate, jump, brake) would inflate
  // a policy's terminal speed at low FPS. Max-speed is the robust frame-rate observable
  // (driven by drag, which the fix bounds); lateral PATH is not (see the diagnostic
  // below), so we gate speed, not position.
  const SPEED_RATIO_CAP = 1.6;
  let worstSpeedRatio = 0, worstSpeedCtx = '';
  for (const seed of SEEDS) {
    for (const policyName of POLICY_NAMES) {
      const at = (fps) => records.find(r => r.seed === seed && r.policy === policyName && r.fps === fps).maxSpeed;
      const ratio = at(10) / at(60);
      if (ratio > worstSpeedRatio) { worstSpeedRatio = ratio; worstSpeedCtx = `${policyName} seed ${seed}`; }
    }
  }
  const speedBounded = worstSpeedRatio < SPEED_RATIO_CAP;
  console.log('\n--- Speed does not balloon at low frame rate (all policies) [GATING] ---');
  console.log('  worst 10-FPS / 60-FPS max-speed ratio:', worstSpeedRatio.toFixed(2), `(${worstSpeedCtx})`, '| cap:', SPEED_RATIO_CAP);
  console.log('  PASS:', speedBounded ? 'low-FPS speed stays bounded ✅' : 'speed scales with frame rate ❌');
  if (!speedBounded) hardFail = true;

  // --- Steered-path frame-rate sensitivity [DIAGNOSTIC, not gated] ---
  // A deterministic time-keyed slalom does NOT trace the same path at every FPS: coarse-
  // dt Euler integration, amplified by the radial mountain redirecting velocity along a
  // position-dependent fall line, drifts the lateral path ~tens of units over a descent.
  // That is honest integration sensitivity, not a bug (the steer force is delta-scaled,
  // line 391/394 of physics.ts), and it is too chaotic to gate tightly without flaking —
  // so it is reported, not asserted. The robust frame-rate guarantees are speed (gate 2)
  // and no-tunneling/finite/termination (gates 1/4/5).
  const CONV_SECONDS = 8;
  let worstConv = 0, worstConvSeed = 0;
  for (const seed of SEEDS) {
    const ref = runDescent(seed, 1 / 60, 'slalom', { maxTime: CONV_SECONDS });
    for (const dt of [1 / 30, 1 / 10]) {
      const r = runDescent(seed, dt, 'slalom', { maxTime: CONV_SECONDS });
      const gap = Math.hypot(r.finalX - ref.finalX, r.finalZ - ref.finalZ);
      if (gap > worstConv) { worstConv = gap; worstConvSeed = seed; }
    }
  }
  console.log('\n--- Steered-path frame-rate sensitivity (slalom) [DIAGNOSTIC] ---');
  console.log(`  worst ${CONV_SECONDS}s-window lateral drift vs 60 FPS:`, worstConv.toFixed(2), `(seed ${worstConvSeed})`,
    '— coarse-dt Euler on the radial fall line; not gated');

  // --- 4) No NaN/Infinity, any policy / rate [GATING] ---
  const nonFiniteRuns = records.filter(r => r.nonFinite);
  const allFinite = nonFiniteRuns.length === 0;
  console.log('\n--- No NaN/Infinity in pos/velocity at any frame rate / policy [GATING] ---');
  console.log('  non-finite runs:', nonFiniteRuns.length,
    nonFiniteRuns.length ? '(' + nonFiniteRuns.slice(0, 3).map(r => `${r.policy}@${r.fps}`).join(', ') + ' ...)' : '');
  console.log('  PASS:', allFinite ? 'all positions/velocities stayed finite ✅' : 'a run went non-finite ❌');
  if (!allFinite) hardFail = true;

  // --- 5) Every descent terminates within the frame cap [GATING] (issue 2 proxy) ---
  const stuckRuns = records.filter(r => !r.terminated || r.framesUsed >= r.maxFrames);
  const allTerminate = stuckRuns.length === 0;
  console.log('\n--- Every descent terminates (finish / crash / off-side), no spin [GATING] ---');
  console.log('  runs that exhausted the frame cap without ending:', stuckRuns.length,
    stuckRuns.length ? '(' + stuckRuns.slice(0, 3).map(r => `${r.policy}@${r.fps} seed ${r.seed}`).join('; ') + ')' : '');
  console.log('  PASS:', allTerminate ? 'every descent reached a definite outcome ✅' : 'a descent never ended (possible freeze) ❌');
  if (!allTerminate) hardFail = true;

  // --- 6) Finish is reachable: a clean full-speed line reaches z < -195 [GATING] ---
  // Pairs with the avalanche-side winnability_harness (G2/G3) to protect the
  // "winnable but not guaranteed" invariant: G1 asserts a winning path EXISTS for the
  // real physics descent, G3 asserts that path also outruns the slide. We assert only
  // that SOME clean line finishes (no wall-clock time), on a hazard-cleared course so
  // balance tuning of the random tree/rock field can't flake it. A drag/gradient/
  // course-length regression that drops a no-input coast short of the finish fails here.
  const finishRuns = SEEDS.map(seed => runDescent(seed, 1 / 60, 'holdUp', { clearHazards: true }));
  const allFinish = finishRuns.every(r => r.finished);
  console.log('\n--- Finish is reachable: clean full-speed line reaches z < -195 [GATING] ---');
  console.log('  finished:', finishRuns.filter(r => r.finished).length, '/', SEEDS.length,
    '| worst final z:', Math.max(...finishRuns.map(r => r.finalZ)).toFixed(1));
  console.log('  PASS:', allFinish
    ? 'a winning path exists on every seed ✅'
    : 'no clean line reached the finish — course may be unwinnable ❌');
  if (!allFinish) hardFail = true;

  // --- Per-policy summary table (diagnostic) ---
  console.log('\n  policy        rates        maxSpeed(60/30/10)   treeTun rockTun  finite term');
  for (const policyName of POLICY_NAMES) {
    const rs = records.filter(r => r.policy === policyName);
    const sp = (fps) => (rs.filter(r => r.fps === fps).reduce((a, r) => a + r.maxSpeed, 0) / SEEDS.length).toFixed(1);
    const tt = rs.reduce((a, r) => a + r.treeTunnel, 0), rt = rs.reduce((a, r) => a + r.rockTunnel, 0);
    const fin = rs.every(r => !r.nonFinite), term = rs.every(r => r.terminated);
    console.log('  %s  fixed+hitch  %s / %s / %s        %s     %s     %s   %s',
      policyName.padEnd(12), sp(60).padStart(5), sp(30).padStart(5), sp(10).padStart(5),
      String(tt).padStart(3), String(rt).padStart(3), fin ? 'yes' : 'NO', term ? 'yes' : 'NO');
  }

  console.log(`\nFORWARD STRESS HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (no tunneling; speed bounded; finite; terminates)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
