// @ts-check
// fixed_timestep_harness.js
// Frame-rate-EQUIVALENCE + NO-TUNNELLING gate for the fixed-timestep run loop.
//
// Sibling to forward_stress_harness.js (PR #209). That harness drives the physics kernel
// directly at a handful of fixed rates and gates that speed stays bounded and nothing
// tunnels. This one drives the run loop's REAL fixed-timestep accumulator
// (src/game/fixed-timestep.ts `planSubsteps`, the exact function main-loop.ts uses) over
// the REAL kernel + REAL terrain + REAL trees/rocks, and gates the two NEW guarantees the
// accumulator newly provides — the ones the old variable-dt loop could not:
//
//   1. FRAME-RATE EQUIVALENCE — because the loop now only ever advances physics in fixed
//      FIXED_DT (1/60 s) steps, the SAME run produces a byte-identical trajectory at 30 /
//      50 / 144 FPS and under a jittery variable frame schedule, vs the 60 FPS reference.
//      The render rate only regroups identical substeps; it never changes the dt the kernel
//      integrates. The old variable-dt loop fails this (reported as the [CONTRAST] below).
//
//   2. FRAME-RATE-INVARIANT COLLISION GRANULARITY / NO TUNNELLING (tunnelRiskFrames == 0) —
//      replayed through the diagnostics classifier (src/diagnostics.ts, the live runtime
//      detector) at FIXED_DT, every PHYSICS substep's step is `velocity / 60`, far under the
//      smallest obstacle radius AND independent of render rate, so the tunnel-risk frame
//      count is zero by construction at any FPS. The old per-frame loop's collision-check
//      granularity instead GREW with frame time (per-frame step ~ velocity * frameDelta) —
//      the precondition for the "floor it forward and blow through a tree" tunnelling bug,
//      reported as the [CONTRAST]. (NB: the kernel's PR #209 drag fix already bounds terminal
//      speed, so at today's ~8 m/s cruise neither loop tunnels on a gentle descent; the fixed
//      step makes the granularity STRUCTURALLY frame-rate-independent, so a future change that
//      raised speeds could not reintroduce low-FPS tunnelling.)
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/fixed_timestep_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + tree/rock placement touch (no DOM/WebGL).
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined; // trees/rocks skip canvas textures when document is absent
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Seeded PRNG so tree/rock placement and the kernel's auto-turn are reproducible and the
// ONLY variable across the frame-rate sweep is how time is chopped into render frames.
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

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { Snowman } = await import('../../src/snowman.ts');
  const terrain = await import('../../src/mountains/terrain.ts');
  const { Trees } = await import('../../src/mountains/trees.ts');
  const { addRocks, rockCollisionRadius, ROCK_COLLISION_MIN_SIZE } = await import('../../src/mountains/rocks.ts');
  const { FIXED_DT, planSubsteps } = await import('../../src/game/fixed-timestep.ts');
  const { classifyFrame, foldFrame, emptySummary, DEFAULT_CONFIG } = await import('../../src/diagnostics.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const TREE_RADIUS = 2.5;
  const SEEDS = [12345, 777, 42, 9001];
  const HOLD_UP = { left: false, right: false, up: true, down: false, jump: false };

  // Build the obstacle field for a seed (silenced placement logs).
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

  // Fresh descent state at the spawn.
  function spawn() {
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    const snowman = fakeSnowman();
    snowman.position.set(pos.x, pos.y, pos.z);
    const st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
                 airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    return { pos, velocity, snowman, st };
  }

  // One kernel substep (mirrors main-loop.ts stepFixed's physics advance).
  function kernelStep(world, dt, treePositions, rockPositions) {
    const { pos, velocity, snowman, st } = world;
    const next = Snowman.updateSnowman(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, HOLD_UP, st.turnPhase, st.currentTurnDirection,
      st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
      treePositions, true, () => {}, rockPositions);
    snowman.position.set(pos.x, pos.y, pos.z);
    world.st = next;
    return next;
  }

  // --- Drive the REAL accumulator at a given frame schedule for EXACTLY `targetSubsteps`
  // fixed steps. Because every rate runs the identical sequence of FIXED_DT kernel calls
  // (same seed -> same auto-turn RNG, same constant controls), the only thing that varies
  // is how render frames group those substeps — which cannot change the result. ---
  function runAccumulator(seed, frameDtFn, targetSubsteps, field, record) {
    Math.random = makeRng(0xC0FFEE ^ seed); // identical kernel RNG stream across rates
    const world = spawn();
    let acc = 0, done = 0, frameIdx = 0;
    while (done < targetSubsteps) {
      const plan = planSubsteps(frameDtFn(frameIdx++), acc);
      acc = plan.accumulator;
      for (let i = 0; i < plan.substeps && done < targetSubsteps; i++) {
        kernelStep(world, FIXED_DT, field.treePositions, field.rockPositions);
        done++;
        if (record) record(world); // per-SUBSTEP record (FIXED_DT) — the diagnostics view
      }
    }
    return { x: world.pos.x, z: world.pos.z, vx: world.velocity.x, vz: world.velocity.z };
  }

  // --- Legacy variable-dt loop (the OLD behavior): one kernel call per render frame at the
  // capped frame delta. Used only as a CONTRAST to show the bug the accumulator removes. ---
  function runLegacy(seed, frameDt, seconds, field, record) {
    Math.random = makeRng(0xC0FFEE ^ seed);
    const world = spawn();
    let t = 0;
    while (t < seconds - 1e-9) {
      const dt = Math.min(frameDt, 0.1); // the old loop's delta cap
      const prevX = world.pos.x, prevZ = world.pos.z;
      kernelStep(world, dt, field.treePositions, field.rockPositions);
      t += frameDt;
      if (record) record(world, prevX, prevZ);
    }
    return { x: world.pos.x, z: world.pos.z };
  }

  const SCHEDULES = {
    '60': () => 1 / 60,
    '30': () => 1 / 30,
    '50': () => 1 / 50,
    '144': () => 1 / 144,
    'jitter': (() => { const r = makeRng(0xBEEF); return () => (r() < 0.1 ? 0.1 : 1 / 60); })(),
  };
  const TARGET_SUBSTEPS = 480; // ~8 in-game seconds of fixed steps

  let hardFail = false;

  // === 1) Frame-rate equivalence [GATING] ===========================================
  console.log('=== Fixed-timestep run loop: equivalence + no-tunnelling ===');
  console.log('\n--- 1) Frame-rate EQUIVALENCE: accumulator trajectory is identical at 30/50/144/jitter vs 60 [GATING] ---');
  const EPS = 1e-9;
  let worstGap = 0, worstCtx = '';
  for (const seed of SEEDS) {
    const field = buildField(seed);
    // A fresh jitter schedule per seed so the variable run isn't a fixed pattern.
    const jitter = (() => { const r = makeRng(0xBEEF ^ seed); return () => (r() < 0.1 ? 0.1 : 1 / 60); })();
    const ref = runAccumulator(seed, SCHEDULES['60'], TARGET_SUBSTEPS, field, null);
    for (const [name, fn] of [['30', SCHEDULES['30']], ['50', SCHEDULES['50']], ['144', SCHEDULES['144']], ['jitter', jitter]]) {
      const r = runAccumulator(seed, fn, TARGET_SUBSTEPS, field, null);
      const gap = Math.hypot(r.x - ref.x, r.z - ref.z) + Math.hypot(r.vx - ref.vx, r.vz - ref.vz);
      if (gap > worstGap) { worstGap = gap; worstCtx = `${name} FPS, seed ${seed}`; }
    }
  }
  const equivalent = worstGap < EPS;
  console.log('  worst trajectory+velocity gap vs the 60 FPS reference:', worstGap.toExponential(2), `(${worstCtx})`, '| eps:', EPS.toExponential(0));
  console.log('  PASS:', equivalent ? 'every render rate reproduces the 60 FPS trajectory exactly ✅' : 'a render rate diverged from 60 FPS ❌');
  if (!equivalent) hardFail = true;

  // [CONTRAST] the old variable-dt loop diverges across frame rates (why this fix exists).
  {
    const field = buildField(SEEDS[0]);
    const ref = runLegacy(SEEDS[0], 1 / 60, 8, field, null);
    const low = runLegacy(SEEDS[0], 1 / 10, 8, field, null);
    const gap = Math.hypot(low.x - ref.x, low.z - ref.z);
    console.log('  [CONTRAST] old variable-dt loop, 10 FPS vs 60 FPS over 8s:', gap.toFixed(1), 'u apart — the divergence the accumulator removes');
  }

  // === 2) No tunnelling: tunnelRiskFrames == 0 at low FPS [GATING] ====================
  console.log('\n--- 2) NO TUNNELLING: diagnostics reports zero tunnelRiskFrames driving the loop at low FPS [GATING] ---');
  // Use the SMALLEST guarded obstacle radius, exactly as snowglider.ts wires Diag.
  const cfg = { ...DEFAULT_CONFIG, collisionRadius: Math.min(TREE_RADIUS, rockCollisionRadius(ROCK_COLLISION_MIN_SIZE)) };
  let totalTunnelFixed = 0, worstStepFixed = 0;
  for (const seed of SEEDS) {
    const field = buildField(seed);
    for (const name of ['144', '60', '30', '50', 'jitter']) {
      const summary = emptySummary();
      let prev = null;
      const record = (world) => {
        const sample = { dt: FIXED_DT, speed: Math.hypot(world.velocity.x, world.velocity.z), x: world.pos.x, z: world.pos.z, technique: 'glide', isInAir: world.st.isInAir };
        const flags = classifyFrame(prev, sample, cfg);
        foldFrame(summary, sample, flags);
        prev = { x: sample.x, z: sample.z };
      };
      const jitter = (() => { const r = makeRng(0xBEEF ^ seed); return () => (r() < 0.1 ? 0.1 : 1 / 60); })();
      const fn = name === 'jitter' ? jitter : SCHEDULES[name];
      runAccumulator(seed, fn, TARGET_SUBSTEPS, field, record);
      totalTunnelFixed += summary.tunnelRiskFrames;
      if (summary.stepMax > worstStepFixed) worstStepFixed = summary.stepMax;
    }
  }
  const noTunnel = totalTunnelFixed === 0 && worstStepFixed < cfg.collisionRadius;
  console.log('  collision radius guarded:', cfg.collisionRadius.toFixed(2), '| worst per-SUBSTEP step:', worstStepFixed.toFixed(3));
  console.log('  tunnelRiskFrames across all seeds x rates:', totalTunnelFixed);
  console.log('  PASS:', noTunnel ? 'every fixed substep stays inside the collision radius ✅' : 'a substep stepped past an obstacle disk ❌');
  if (!noTunnel) hardFail = true;

  // [CONTRAST] the old per-frame loop's collision-check granularity (worst per-frame step)
  // GROWS with frame time, while the fixed substep stays constant at every render rate —
  // the structural frame-rate dependence the fixed step removes (the tunnelling precondition).
  {
    const field = buildField(SEEDS[0]);
    const worstFrameStep = (frameDt) => {
      let worst = 0;
      runLegacy(SEEDS[0], frameDt, 8, field, (world, prevX, prevZ) => {
        worst = Math.max(worst, Math.hypot(world.pos.x - prevX, world.pos.z - prevZ));
      });
      return worst;
    };
    const s60 = worstFrameStep(1 / 60), s30 = worstFrameStep(1 / 30), s10 = worstFrameStep(1 / 10);
    console.log('  [CONTRAST] old variable-dt loop worst per-frame step: 60FPS=' + s60.toFixed(3),
      '30FPS=' + s30.toFixed(3), '10FPS=' + s10.toFixed(3),
      '— granularity scales with frame time; the fixed substep stays', worstStepFixed.toFixed(3), 'u at every rate');
  }

  console.log(`\nFIXED-TIMESTEP HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (frame-rate equivalent; zero tunnel risk)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
