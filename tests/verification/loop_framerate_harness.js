// @ts-check
// loop_framerate_harness.js
// Frame-rate-EQUIVALENCE + tunnel-zero gate for the fixed-timestep run LOOP.
//
// The sibling harnesses pin the PHYSICS KERNEL: physics_invariant_harness.js drives
// Snowman.updateSnowman at a fixed 1/60 and freezes coasting byte-for-byte;
// forward_stress_harness.js sweeps the kernel across frame rates and gates no-tunnel /
// bounded-speed. This harness instead exercises the thing that USED to run variable dt —
// the run loop's scheduler — by driving the REAL kernel through the REAL accumulator
// (src/game/fixed-timestep.ts `planSubsteps`, the exact code main-loop.ts uses) at
// several render frame rates, and proves the two properties the fixed timestep newly
// guarantees:
//
//   1. FRAME-RATE EQUIVALENCE (the new guarantee). Because physics only ever advances in
//      whole 1/60 s steps, the sequence of physics states is INDEPENDENT of render rate:
//      after the same number of fixed steps, a 30 / 50 / 144 / jittery-FPS run lands on
//      byte-identical pos/velocity to the 60 FPS run. The old variable-dt loop failed
//      this (its step size WAS the render delta); the accumulator is what makes it pass.
//   2. TUNNEL-ZERO AT LOW FPS (issue: §6.3). Driving the loop even at 10 FPS, every
//      per-substep displacement stays `velocity / 60` — well under the smallest obstacle
//      collision radius — so the diagnostics `tunnelRisk` count is zero by construction.
//      The old loop stepped `velocity * 0.1` at 10 FPS and tunnelled through trees.
//
// It reuses the kernel + analytic terrain like the other harnesses (no DOM/WebGL), and
// seeds Math.random so the in-kernel auto-turn is reproducible across runs.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/loop_framerate_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + terrain touch (no DOM/WebGL).
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Seeded PRNG so the in-kernel auto-turn (Math.random) is identical across runs — the
// ONLY thing that could otherwise differ between two render schedules.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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
  const { FIXED_DT, MAX_SUBSTEPS, planSubsteps } = await import('../../src/game/fixed-timestep.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const SEED = 12345;
  const HOLD_UP = { left: false, right: false, up: true, down: false, jump: false };
  // The smallest obstacle radius the discrete collision check guards (trees 2.5, the
  // smallest collidable rock ~1.69). main-loop.ts's Diag uses the same min; a per-substep
  // step at/over this is a tunnel risk.
  const MIN_COLLISION_RADIUS = 1.69;
  const TOTAL_FIXED_STEPS = 1800; // 30 s of simulated time on the fixed grid

  // Drive the loop's accumulator at a given render-frame schedule and run the REAL kernel
  // for exactly `totalFixedSteps` fixed steps (so two schedules are compared after the
  // same amount of SIMULATED time, not the same wall-clock — the leftover accumulator,
  // always < one step, must not bias the comparison). `frameDt` is a number (fixed render
  // rate) or a function (i)=>dt for a jittery schedule. Returns the final physics state
  // plus the worst per-substep displacement (the tunnel-risk observable).
  function runLoop(frameDt, totalFixedSteps) {
    Math.random = makeRng(0xC0FFEE ^ SEED); // deterministic auto-turn, independent of schedule
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const showGameOver = () => {};

    let accumulator = 0, stepsRun = 0, frame = 0, worstStep = 0, maxSubstepsHit = 0;
    while (stepsRun < totalFixedSteps) {
      const rawDelta = typeof frameDt === 'function' ? frameDt(frame) : frameDt;
      frame++;
      const plan = planSubsteps(accumulator, rawDelta);
      accumulator = plan.accumulator;
      if (plan.steps === MAX_SUBSTEPS) maxSubstepsHit++;
      for (let i = 0; i < plan.steps && stepsRun < totalFixedSteps; i++) {
        const prevX = pos.x, prevZ = pos.z;
        st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
          st.lastTerrainHeight, st.airTime, st.jumpCooldown, HOLD_UP, st.turnPhase, st.currentTurnDirection,
          st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
          [], true, showGameOver, []);
        snowman.position.set(pos.x, pos.y, pos.z);
        const step = Math.hypot(pos.x - prevX, pos.z - prevZ);
        if (step > worstStep) worstStep = step;
        stepsRun++;
      }
    }
    return { x: pos.x, y: pos.y, z: pos.z, vx: velocity.x, vz: velocity.z, worstStep, framesRun: frame, maxSubstepsHit };
  }

  let hardFail = false;

  // --- 1) Frame-rate equivalence: every render rate matches 60 FPS exactly ---------
  // 60 FPS does exactly one substep per frame; the others fold multiple/partial frames
  // through the accumulator. Same fixed-step count => identical physics state.
  const ref = runLoop(1 / 60, TOTAL_FIXED_STEPS);
  /** @type {Array<{name:string, dt:any}>} */
  const SCHEDULES = [
    { name: '30 FPS', dt: 1 / 30 },
    { name: '50 FPS', dt: 1 / 50 },
    { name: '144 FPS', dt: 1 / 144 },
    { name: '120 FPS', dt: 1 / 120 },
    // Jittery variable FPS: alternating-ish render deltas in the 30..144 FPS band, all
    // below the spiral-guard ceiling so no fixed step is ever dropped.
    { name: 'jittery', dt: (i) => [1 / 144, 1 / 60, 1 / 90, 1 / 33, 1 / 110, 1 / 45][i % 6] },
  ];
  // Physics is deterministic on the fixed grid, so the match should be EXACT; allow a hair
  // for floating-point summation order in the accumulator.
  const EPS = 1e-9;
  console.log('=== Loop frame-rate equivalence: real kernel through the real accumulator ===');
  console.log('  reference 60 FPS after %d fixed steps: x=%s z=%s vz=%s (frames=%d)',
    TOTAL_FIXED_STEPS, ref.x.toFixed(6), ref.z.toFixed(6), ref.vz.toFixed(6), ref.framesRun);
  console.log('\n--- 1) Trajectory matches 60 FPS within %s [GATING] ---', EPS);
  let worstDrift = 0, worstDriftName = '';
  for (const sch of SCHEDULES) {
    const r = runLoop(sch.dt, TOTAL_FIXED_STEPS);
    const drift = Math.max(Math.abs(r.x - ref.x), Math.abs(r.y - ref.y), Math.abs(r.z - ref.z),
      Math.abs(r.vx - ref.vx), Math.abs(r.vz - ref.vz));
    if (drift > worstDrift) { worstDrift = drift; worstDriftName = sch.name; }
    const ok = drift <= EPS;
    console.log('  %s  drift=%s  frames=%s  %s',
      sch.name.padEnd(8), drift.toExponential(2), String(r.framesRun).padStart(5), ok ? '✅' : '❌ DIVERGED');
    if (!ok) hardFail = true;
  }
  console.log('  worst drift vs 60 FPS:', worstDrift.toExponential(2), `(${worstDriftName})`, '| cap:', EPS);

  // --- 2) Tunnel-zero: per-substep step stays under the smallest obstacle radius -----
  // Drive the loop across the whole rate range INCLUDING the capped 10 FPS the old loop
  // tunnelled at. Every per-substep displacement is bounded by velocity/60, so it can
  // never reach an obstacle radius — diagnostics' tunnelRisk is zero by construction.
  console.log('\n--- 2) No tunnel risk: worst per-substep step < %su at any render rate [GATING] ---', MIN_COLLISION_RADIUS);
  const RATES = [
    { name: '144 FPS', dt: 1 / 144 },
    { name: '60 FPS', dt: 1 / 60 },
    { name: '30 FPS', dt: 1 / 30 },
    { name: '10 FPS', dt: 1 / 10 }, // the capped-delta regime the old loop tunnelled in
  ];
  let worstSubstep = 0, worstSubstepName = '';
  for (const rate of RATES) {
    const r = runLoop(rate.dt, TOTAL_FIXED_STEPS);
    if (r.worstStep > worstSubstep) { worstSubstep = r.worstStep; worstSubstepName = rate.name; }
    console.log('  %s  worst substep=%su  (maxSubsteps hit %d frames)',
      rate.name.padEnd(8), r.worstStep.toFixed(3), r.maxSubstepsHit);
  }
  const tunnelZero = worstSubstep < MIN_COLLISION_RADIUS;
  console.log('  worst per-substep step over all rates:', worstSubstep.toFixed(3) + 'u', `(${worstSubstepName})`,
    '| radius:', MIN_COLLISION_RADIUS);
  console.log('  PASS:', tunnelZero ? 'every fixed step stays inside the collision radius — tunnelRisk == 0 ✅'
                                    : 'a fixed step reached an obstacle radius ❌');
  if (!tunnelZero) hardFail = true;

  console.log(`\nLOOP FRAME-RATE HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)'
    : 'OK ✅ (render-rate-independent trajectory; tunnelRisk zero by construction)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
