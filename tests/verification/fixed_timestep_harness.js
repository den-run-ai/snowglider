// @ts-check
// fixed_timestep_harness.js
// Frame-rate-INDEPENDENCE gate for the run loop's fixed-timestep accumulator
// (src/game/fixed-step.ts + game/main-loop.ts). Sibling to forward_stress_harness.js
// and avalanche_framerate_harness.js, but it targets the LOOP, not the kernel.
//
// physics_invariant_harness.js proves the kernel is byte-identical at 1/60. This
// harness proves the thing built on top of it: when the loop advances physics through
// the accumulator (planFrameSteps), the trajectory it produces is independent of the
// render frame rate — 30, 50, 144 Hz and a jittery variable rate all trace the SAME
// fixed-grid path the kernel pins, because physics only ever advances in 1/60 s steps.
// The pre-accumulator variable-dt loop fails this (coarse-dt Euler drifts with FPS);
// the accumulator is what makes it pass.
//
// It guards three properties:
//
//   1. FRAME-RATE EQUIVALENCE [GATING] — driving the accumulator at any render rate
//      and any jitter executes the same ordered sequence of 1/60 s kernel steps, so the
//      state after K fixed steps is byte-identical to a direct K-step reference run.
//      (Contrast: the variable-dt loop driving the kernel at dt = 1/FPS drifts tens of
//      units — reported as a diagnostic.)
//   2. TUNNEL-FREE BY CONSTRUCTION [GATING] — every fixed substep moves velocity * 1/60,
//      so at any sane speed the per-step displacement stays well under the 2.5u collision
//      radius regardless of render FPS. Shown via diagnostics.ts: the accumulator path
//      reports ZERO tunnelRisk frames where a 10-FPS variable-dt step at the same speed
//      reports many.
//   3. SPIRAL-OF-DEATH GUARD [GATING] — a single huge frame delta (tab backgrounded, GC
//      hitch) runs at most MAX_SUBSTEPS steps and leaves the accumulator < FIXED_DT, so
//      one slow frame can never queue an unbounded number of physics steps.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/fixed_timestep_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + tree/rock placement + diagnostics touch (no
// DOM/WebGL). addEventListener is a no-op so Diag.init's error-handler wiring is safe.
const g = /** @type {any} */ (globalThis);
g.window = {
  location: { search: '' },
  matchMedia: () => ({ matches: false }),
  terrainMesh: null,
  addEventListener: () => {},
};
g.document = undefined; // trees/rocks skip canvas textures; Diag skips the DOM overlay
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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

const UP = { left: false, right: false, up: true, down: false, jump: false };
const mk = (over) => ({ ...UP, ...over });

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { Snowman } = await import('../../src/snowman.ts');
  const terrain = await import('../../src/mountains/terrain.ts');
  const { Trees } = await import('../../src/mountains/trees.ts');
  const { addRocks } = await import('../../src/mountains/rocks.ts');
  const { FIXED_DT, MAX_SUBSTEPS, planFrameSteps } = await import('../../src/game/fixed-step.ts');
  const { Diag } = await import('../../src/diagnostics.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const COLLISION_RADIUS = 2.5; // mirrors collision.ts default treeCollisionRadius
  let hardFail = false;

  // Build the (seeded) obstacle field once; reused across every scenario so the only
  // variable is how render frames are chunked into fixed steps.
  function buildField(seed) {
    Math.random = makeRng(seed);
    const scene = makeScene();
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    const treePositions = Trees.addTrees(scene);
    const rockPositions = addRocks(scene);
    console.log = _log; console.warn = _warn;
    return { treePositions, rockPositions };
  }

  // Fresh kernel state + snowman at the spawn, optionally with an injected velocity.
  function freshRun(vx = 0, vz = -3) {
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: vx, z: vz };
    snowman.position.set(pos.x, pos.y, pos.z);
    const st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
                 airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    return { snowman, pos, velocity, st };
  }

  // One fixed 1/60 s kernel step. `controls` are keyed to the GLOBAL fixed-step index by
  // the caller, so two render schedules that execute the same number of steps feed the
  // kernel the same inputs in the same order — the basis of the equivalence gate.
  function kernelStep(env, field, controls) {
    const { snowman, pos, velocity, st } = env;
    Math.random = env.turnRng; // deterministic auto-turn, independent of frame schedule
    const r = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
      st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
      field.treePositions, true, () => {}, field.rockPositions);
    env.st = { isInAir: r.isInAir, verticalVelocity: r.verticalVelocity, lastTerrainHeight: r.lastTerrainHeight,
               airTime: r.airTime, jumpCooldown: r.jumpCooldown, turnPhase: r.turnPhase,
               currentTurnDirection: r.currentTurnDirection, turnChangeCooldown: r.turnChangeCooldown };
    snowman.position.set(pos.x, pos.y, pos.z);
    return r;
  }

  // Reference: K fixed steps driven directly (the trajectory the harness pins).
  function referenceRun(seed, field, K, controlsFn) {
    const env = freshRun();
    env.turnRng = makeRng(0xC0FFEE ^ seed);
    for (let k = 0; k < K; k++) kernelStep(env, field, controlsFn(k));
    return env;
  }

  // The same K fixed steps, but reached by feeding a render-frame schedule through the
  // accumulator (planFrameSteps), exactly as game/main-loop.ts does. Stops the instant K
  // steps have executed (mid-frame if needed) so the final state is comparable to the
  // reference. Returns the final state + the worst per-substep displacement seen.
  function accumulatorRun(seed, field, K, controlsFn, nextDelta) {
    const env = freshRun();
    env.turnRng = makeRng(0xC0FFEE ^ seed);
    let accumulator = 0, executed = 0, maxStep = 0;
    let guard = 0; // wall-clock frame cap so a bug can't spin forever
    while (executed < K && guard++ < K * 4 + 1000) {
      const plan = planFrameSteps(accumulator, nextDelta(), FIXED_DT, MAX_SUBSTEPS);
      accumulator = plan.accumulator;
      for (let i = 0; i < plan.substeps && executed < K; i++) {
        const px = env.pos.x, pz = env.pos.z;
        kernelStep(env, field, controlsFn(executed));
        maxStep = Math.max(maxStep, Math.hypot(env.pos.x - px, env.pos.z - pz));
        executed++;
      }
    }
    return { env, executed, maxStep };
  }

  function stateGap(a, b) {
    return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) +
           Math.hypot(a.velocity.x - b.velocity.x, a.velocity.z - b.velocity.z) +
           Math.abs(a.pos.y - b.pos.y);
  }

  // ============================================================================
  // 1) FRAME-RATE EQUIVALENCE [GATING]
  // ============================================================================
  // Controls keyed to the fixed-step index (a time-keyed slalom): identical input
  // sequence for any schedule that executes the same number of steps.
  const controlsFn = (k) => {
    const tSec = k * FIXED_DT;
    return Math.floor(tSec / 1.2) % 2 === 0 ? mk({ right: true }) : mk({ left: true });
  };
  const SEEDS = [12345, 777, 42];
  const SIM_SECONDS = 6;
  const K = Math.round(SIM_SECONDS / FIXED_DT); // fixed steps in the comparison window

  // Render schedules: constant rates that DON'T divide 60 evenly (50, 144) plus 30, and
  // a jittery variable rate (GC-hitch flavour). Each is a () => dt generator.
  const schedules = {
    '30fps': () => 1 / 30,
    '50fps': () => 1 / 50,
    '144fps': () => 1 / 144,
    'jitter': (() => { const r = makeRng(0xBEEF); return () => (r() < 0.1 ? 0.05 : 1 / 60 + (r() - 0.5) * 0.01); })(),
  };

  let worstEquivGap = 0, worstEquivCtx = '';
  for (const seed of SEEDS) {
    const field = buildField(seed);
    const ref = referenceRun(seed, field, K, controlsFn);
    for (const [name, gen] of Object.entries(schedules)) {
      const { env, executed } = accumulatorRun(seed, field, K, controlsFn, gen);
      const gap = executed === K ? stateGap(env, ref) : Infinity;
      if (gap > worstEquivGap) { worstEquivGap = gap; worstEquivCtx = `${name} seed ${seed} (executed ${executed}/${K})`; }
    }
  }
  // Same FIXED_DT steps, same order, same inputs => byte-identical floating point.
  const EQUIV_EPS = 1e-9;
  const equiv = worstEquivGap < EQUIV_EPS;
  console.log('=== Fixed-timestep accumulator: drive the LOOP at 30/50/144/jitter FPS ===');
  console.log('\n--- 1) Frame-rate equivalence (trajectory matches the 1/60 reference) [GATING] ---');
  console.log('  worst state gap vs 60 Hz fixed-grid reference:', worstEquivGap.toExponential(2), `(${worstEquivCtx})`, '| eps:', EQUIV_EPS);
  console.log('  PASS:', equiv ? 'every render rate traces the identical fixed-grid path ✅' : 'a render rate drifted from the fixed grid ❌');
  if (!equiv) hardFail = true;

  // Contrast diagnostic: the OLD variable-dt loop (kernel stepped at dt = 1/FPS) drifts.
  {
    const seed = 12345;
    const field = buildField(seed);
    const ref = referenceRun(seed, field, K, controlsFn);
    const env = freshRun();
    env.turnRng = makeRng(0xC0FFEE ^ seed);
    let t = 0, k = 0;
    const dt = 1 / 10;
    while (t < SIM_SECONDS) { kernelStepVar(env, field, controlsFn(k++), dt); t += dt; }
    function kernelStepVar(e, f, controls, d) {
      const { snowman, pos, velocity, st } = e;
      Math.random = e.turnRng;
      const r = Snowman.updateSnowman(snowman, d, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        f.treePositions, true, () => {}, f.rockPositions);
      e.st = { isInAir: r.isInAir, verticalVelocity: r.verticalVelocity, lastTerrainHeight: r.lastTerrainHeight,
               airTime: r.airTime, jumpCooldown: r.jumpCooldown, turnPhase: r.turnPhase,
               currentTurnDirection: r.currentTurnDirection, turnChangeCooldown: r.turnChangeCooldown };
      snowman.position.set(pos.x, pos.y, pos.z);
    }
    const drift = stateGap(env, ref);
    console.log('  [diagnostic] old variable-dt loop @10 FPS drift vs reference:', drift.toFixed(2),
      '— coarse-dt Euler; what the accumulator removes');
  }

  // ============================================================================
  // 2) TUNNEL-FREE BY CONSTRUCTION [GATING], via diagnostics.ts
  // ============================================================================
  // Drive the SAME high-speed descent two ways and let Diag classify the per-step
  // displacement. Diag fires tunnelRisk when a recorded step >= the collision radius.
  Diag.init({ frameCapSec: 0.1, collisionRadius: COLLISION_RADIUS });
  const tunnelSeed = 9001;
  const field = buildField(tunnelSeed);
  const INJECT_VZ = -36; // well above terminal: a single 0.1 s step would clear 2.5u

  // (a) Variable-dt loop @10 FPS: one Diag sample per frame at dt = 0.1.
  Diag.reset();
  {
    const env = freshRun(0, INJECT_VZ);
    env.turnRng = makeRng(0xC0FFEE ^ tunnelSeed);
    let k = 0;
    for (let f = 0; f < 25; f++) {
      const r = Snowman.updateSnowman(env.snowman, 0.1, env.pos, env.velocity, env.st.isInAir, env.st.verticalVelocity,
        env.st.lastTerrainHeight, env.st.airTime, env.st.jumpCooldown, UP, env.st.turnPhase, env.st.currentTurnDirection,
        env.st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        field.treePositions, true, () => {}, field.rockPositions);
      env.st = { isInAir: r.isInAir, verticalVelocity: r.verticalVelocity, lastTerrainHeight: r.lastTerrainHeight,
                 airTime: r.airTime, jumpCooldown: r.jumpCooldown, turnPhase: r.turnPhase,
                 currentTurnDirection: r.currentTurnDirection, turnChangeCooldown: r.turnChangeCooldown };
      Diag.record({ dt: 0.1, speed: r.currentSpeed, x: env.pos.x, z: env.pos.z, technique: r.technique, isInAir: r.isInAir });
      k++;
    }
  }
  const varSnap = Diag.snapshot();
  const varTunnel = varSnap.summary.tunnelRiskFrames;

  // (b) Accumulator loop @10 FPS render: 6 fixed substeps per frame, one Diag sample per
  // SUBSTEP at dt = FIXED_DT — the displacement the player actually moves.
  Diag.reset();
  {
    const env = freshRun(0, INJECT_VZ);
    env.turnRng = makeRng(0xC0FFEE ^ tunnelSeed);
    let accumulator = 0;
    for (let f = 0; f < 25; f++) {
      const plan = planFrameSteps(accumulator, 0.1, FIXED_DT, MAX_SUBSTEPS);
      accumulator = plan.accumulator;
      for (let i = 0; i < plan.substeps; i++) {
        const r = kernelStep(env, field, UP);
        Diag.record({ dt: FIXED_DT, speed: r.currentSpeed, x: env.pos.x, z: env.pos.z, technique: r.technique, isInAir: r.isInAir });
      }
    }
  }
  const fixedSnap = Diag.snapshot();
  const fixedTunnel = fixedSnap.summary.tunnelRiskFrames;

  console.log('\n--- 2) Tunnel-free by construction (diagnostics tunnelRisk frames) [GATING] ---');
  console.log(`  variable-dt @10 FPS (inject vz=${INJECT_VZ}): tunnelRiskFrames =`, varTunnel,
    `| stepMax = ${varSnap.summary.stepMax.toFixed(2)}u`);
  console.log('  fixed-step accumulator (same descent):     tunnelRiskFrames =', fixedTunnel,
    `| stepMax = ${fixedSnap.summary.stepMax.toFixed(2)}u`);
  const tunnelFree = fixedTunnel === 0 && fixedSnap.summary.stepMax < COLLISION_RADIUS && varTunnel > 0;
  console.log('  PASS:', tunnelFree
    ? 'accumulator keeps every step under the radius where variable-dt tunnels ✅'
    : 'expected zero tunnel frames under the accumulator and >0 under variable-dt ❌');
  if (!tunnelFree) hardFail = true;

  // ============================================================================
  // 3) SPIRAL-OF-DEATH GUARD [GATING]
  // ============================================================================
  // A single enormous frame delta must run at most MAX_SUBSTEPS steps and leave the
  // accumulator below FIXED_DT (so alpha stays in [0,1) and time can't pile up).
  const huge = planFrameSteps(0, 5.0, FIXED_DT, MAX_SUBSTEPS); // 5 s frame (tab backgrounded)
  const guardOk = huge.substeps === MAX_SUBSTEPS && huge.accumulator < FIXED_DT &&
                  huge.alpha >= 0 && huge.alpha < 1;
  // And the maintained invariant: starting from acc < FIXED_DT, a normal frame leaves
  // acc < FIXED_DT (induction base for alpha in [0,1)).
  const normal = planFrameSteps(FIXED_DT * 0.9, 1 / 144, FIXED_DT, MAX_SUBSTEPS);
  const invariantOk = normal.accumulator < FIXED_DT && normal.alpha < 1;
  console.log('\n--- 3) Spiral-of-death guard + accumulator invariant [GATING] ---');
  console.log(`  5 s frame => substeps=${huge.substeps} (cap ${MAX_SUBSTEPS}), leftover=${huge.accumulator.toFixed(4)} (< ${FIXED_DT.toFixed(4)}), alpha=${huge.alpha.toFixed(3)}`);
  console.log('  PASS:', guardOk && invariantOk ? 'one slow frame is capped; accumulator stays bounded ✅' : 'spiral guard or invariant broken ❌');
  if (!(guardOk && invariantOk)) hardFail = true;

  console.log(`\nFIXED-TIMESTEP HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (frame-rate equivalent; tunnel-free; spiral-guarded)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
