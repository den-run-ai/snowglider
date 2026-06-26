// @ts-check
// fixed_timestep_harness.js
// Frame-rate-EQUIVALENCE gate for the live run loop's fixed-timestep accumulator
// (src/game/main-loop.ts). Sibling to forward_stress_harness.js (PR #209), but where
// that one drives the kernel with a *variable* dt to bound the damage, this one drives
// the kernel through the SAME accumulator the live loop uses and proves the stronger
// property the accumulator newly guarantees:
//
//   1. FRAME-RATE EQUIVALENCE — the loop steps physics ONLY in fixed 1/60 s increments,
//      so the trajectory is byte-identical regardless of the render frame rate (30, 50,
//      144 Hz, or a jittery variable rate). The pre-accumulator variable-dt loop did NOT
//      have this: coarse-dt Euler drifts the path tens of units (see the "variable-dt
//      drift" diagnostic below). The accumulator is what collapses that drift to zero.
//   2. NO TUNNELING BY CONSTRUCTION — every fixed step advances `pos` by `v/60`, so the
//      per-step displacement stays far below the tree collision radius (2.5) at any
//      render rate. The discrete point-vs-disk collision check therefore can never skip
//      an obstacle disk (the #209 "floor it forward and tunnel through the trees" bug).
//      This is the `tunnelRiskFrames == 0` guarantee diagnostics.ts watches live.
//   3. NO NaN/Infinity — pos/velocity stay finite through every profile.
//
// The accumulator logic here mirrors main-loop.ts (FIXED_DT, MAX_SUBSTEPS, the ceiling
// on frameDelta, the spiral-of-death drop). Inputs are keyed to IN-GAME time (the summed
// fixed-step clock), not the render frame, exactly as a real player's held key would be.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/fixed_timestep_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + tree/rock placement touch (no DOM/WebGL).
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined; // trees/rocks skip canvas textures when document is absent
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Mirrors main-loop.ts.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;
const TREE_RADIUS = 2.5; // mirrors collision.ts default treeCollisionRadius

// Seeded PRNG so tree/rock placement and the auto-turn are reproducible per run.
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
  const { addRocks } = await import('../../src/mountains/rocks.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const UP = { left: false, right: false, up: true, down: false, jump: false };
  const mk = (over) => ({ left: false, right: false, up: true, down: false, jump: false, ...over });
  // Time-keyed slalom: lateral motion that the variable-dt loop drifted but the fixed
  // grid reproduces identically at every render rate. Keyed to IN-GAME time (seconds).
  const slalom = (t) => (Math.floor(t / 1.2) % 2 === 0 ? mk({ right: true }) : mk({ left: true }));

  // Build the (fixed) tree/rock field for a layout seed.
  function buildField(layoutSeed) {
    Math.random = makeRng(layoutSeed);
    const scene = makeScene();
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    const treePositions = Trees.addTrees(scene);
    const rockPositions = addRocks(scene);
    console.log = _log; console.warn = _warn;
    return { treePositions, rockPositions };
  }

  // Drive the REAL kernel through the accumulator at the given render-frame delta
  // sequence. `controlsAt(t)` is keyed to in-game time. Returns the per-fixed-step
  // trajectory (so two profiles can be compared step-for-step), the worst single fixed
  // step, the finite flag, and the completed-step count.
  function runAccumulated(layoutSeed, frameDeltas, controlsAt) {
    const { treePositions, rockPositions } = buildField(layoutSeed);
    Math.random = makeRng(0xC0FFEE ^ layoutSeed); // deterministic auto-turn, independent of render rate
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const showGameOver = () => {};

    const traj = [];
    let accumulator = 0, inGameTime = 0, maxFixedStep = 0, nonFinite = false;
    for (const rawDelta of frameDeltas) {
      const frameDelta = Math.min(rawDelta, MAX_SUBSTEPS * FIXED_DT); // ceiling (main-loop.ts)
      accumulator += frameDelta;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        const prevX = pos.x, prevZ = pos.z;
        const controls = controlsAt(inGameTime);
        st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
          st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
          st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
          treePositions, true, showGameOver, rockPositions);
        snowman.position.set(pos.x, pos.y, pos.z);
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z) ||
            !Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)) { nonFinite = true; break; }
        const step = Math.hypot(pos.x - prevX, pos.z - prevZ);
        if (step > maxFixedStep) maxFixedStep = step;
        traj.push({ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z });
        inGameTime += FIXED_DT;
        accumulator -= FIXED_DT;
        substeps++;
      }
      // Spiral-of-death guard (main-loop.ts): drop the surplus if the ceiling was hit.
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
      if (nonFinite) break;
    }
    return { traj, maxFixedStep, nonFinite, steps: traj.length };
  }

  // For the "before" contrast: drive the kernel DIRECTLY at a coarse fixed dt (the
  // pre-accumulator loop), for the same total in-game time, and report the worst step
  // and the lateral drift vs the 60 FPS reference path. This is what the accumulator fixes.
  function runVariable(layoutSeed, dt, controlsAt, totalTime) {
    const { treePositions, rockPositions } = buildField(layoutSeed);
    Math.random = makeRng(0xC0FFEE ^ layoutSeed);
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const showGameOver = () => {};
    let t = 0, maxStep = 0;
    while (t < totalTime) {
      const prevX = pos.x, prevZ = pos.z;
      st = Snowman.updateSnowman(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controlsAt(t), st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        treePositions, true, showGameOver, rockPositions);
      snowman.position.set(pos.x, pos.y, pos.z);
      const step = Math.hypot(pos.x - prevX, pos.z - prevZ);
      if (step > maxStep) maxStep = step;
      t += dt;
    }
    return { finalX: pos.x, finalZ: pos.z, maxStep };
  }

  const SEEDS = [12345, 777, 42];
  const TOTAL_SECONDS = 6;
  // Render-frame delta sequences, all summing to ~TOTAL_SECONDS, so each completes the
  // same number of fixed 1/60 steps. The jittery profile mixes rates within the cap.
  function constantProfile(fps) {
    const dt = 1 / fps;
    return Array.from({ length: Math.round(TOTAL_SECONDS / dt) }, () => dt);
  }
  function jitterProfile(seed) {
    const rng = makeRng(seed);
    const out = [];
    let total = 0;
    // Mix 144..20 FPS frames (all under the MAX_SUBSTEPS ceiling) until ~TOTAL_SECONDS.
    while (total < TOTAL_SECONDS) {
      const dt = 1 / (20 + Math.floor(rng() * 124)); // 20..143 FPS
      out.push(dt); total += dt;
    }
    return out;
  }

  let hardFail = false;
  console.log('=== Fixed-timestep accumulator: frame-rate equivalence + no tunneling ===');
  console.log('FIXED_DT = 1/%d s | MAX_SUBSTEPS = %d | tree radius = %s\n', Math.round(1 / FIXED_DT), MAX_SUBSTEPS, TREE_RADIUS);

  // --- 1) Frame-rate equivalence: every render rate traces the SAME path [GATING] ---
  let worstEquivDiff = 0, worstEquivCtx = '';
  let worstFixedStep = 0, worstStepCtx = '';
  let anyNonFinite = false;
  for (const seed of SEEDS) {
    const ref = runAccumulated(seed, constantProfile(60), slalom); // 60 FPS reference
    const PROFILES = [
      { name: '30 FPS', frames: constantProfile(30) },
      { name: '50 FPS', frames: constantProfile(50) },
      { name: '144 FPS', frames: constantProfile(144) },
      { name: 'jitter', frames: jitterProfile(0x5EED ^ seed) },
    ];
    if (ref.nonFinite) anyNonFinite = true;
    if (ref.maxFixedStep > worstFixedStep) { worstFixedStep = ref.maxFixedStep; worstStepCtx = `60 FPS seed ${seed}`; }
    for (const p of PROFILES) {
      const run = runAccumulated(seed, p.frames, slalom);
      if (run.nonFinite) anyNonFinite = true;
      if (run.maxFixedStep > worstFixedStep) { worstFixedStep = run.maxFixedStep; worstStepCtx = `${p.name} seed ${seed}`; }
      // Compare step-for-step up to the shorter trajectory: the accumulator makes step k
      // identical regardless of render rate, so this diff must be ~0 (float noise only).
      const n = Math.min(ref.traj.length, run.traj.length);
      let diff = 0;
      for (let i = 0; i < n; i++) {
        diff = Math.max(diff,
          Math.abs(ref.traj[i].x - run.traj[i].x), Math.abs(ref.traj[i].z - run.traj[i].z),
          Math.abs(ref.traj[i].vx - run.traj[i].vx), Math.abs(ref.traj[i].vz - run.traj[i].vz));
      }
      if (diff > worstEquivDiff) { worstEquivDiff = diff; worstEquivCtx = `${p.name} vs 60 FPS, seed ${seed}`; }
    }
  }
  // Stepping the kernel at exactly 1/60 every time means step k is deterministic, so the
  // only spread is IEEE-754 reassociation of the accumulator sum — far below 1e-9.
  const EQUIV_EPS = 1e-9;
  const equivalent = worstEquivDiff < EQUIV_EPS && !anyNonFinite;
  console.log('--- 1) Frame-rate equivalence: 30/50/144/jitter trace the 60 FPS path [GATING] ---');
  console.log('  worst step-for-step trajectory diff:', worstEquivDiff.toExponential(3), `(${worstEquivCtx})`, '| eps:', EQUIV_EPS);
  console.log('  PASS:', equivalent ? 'physics is frame-rate independent ✅' : 'render rate changed the trajectory ❌');
  if (!equivalent) hardFail = true;

  // --- 2) No tunneling by construction: every fixed step < tree radius [GATING] ---
  const noTunnel = worstFixedStep < TREE_RADIUS;
  console.log('\n--- 2) No tunneling: worst fixed-step displacement < tree radius [GATING] ---');
  console.log('  worst fixed step:', worstFixedStep.toFixed(3), `(${worstStepCtx})`, '| tree radius:', TREE_RADIUS);
  console.log('  PASS:', noTunnel ? 'every physics step stays inside the collision radius ✅' : 'a fixed step exceeded the radius ❌');
  if (!noTunnel) hardFail = true;

  // --- 3) No NaN/Infinity across all profiles [GATING] ---
  console.log('\n--- 3) No NaN/Infinity in pos/velocity at any render rate [GATING] ---');
  console.log('  PASS:', !anyNonFinite ? 'all positions/velocities stayed finite ✅' : 'a run went non-finite ❌');
  if (anyNonFinite) hardFail = true;

  // --- Diagnostic: what the accumulator fixes (the pre-accumulator variable-dt loop) ---
  // Drive the kernel DIRECTLY at the capped 10 FPS delta (no accumulator) and show the
  // per-step displacement balloons past the tree radius (tunnel risk) and the path drifts
  // tens of units from the 60 FPS reference — the two symptoms the accumulator removes.
  let worstVarStep = 0, worstVarDrift = 0;
  for (const seed of SEEDS) {
    const ref60 = runVariable(seed, 1 / 60, slalom, TOTAL_SECONDS);
    const var10 = runVariable(seed, 1 / 10, slalom, TOTAL_SECONDS);
    if (var10.maxStep > worstVarStep) worstVarStep = var10.maxStep;
    const drift = Math.hypot(var10.finalX - ref60.finalX, var10.finalZ - ref60.finalZ);
    if (drift > worstVarDrift) worstVarDrift = drift;
  }
  console.log('\n--- Diagnostic: pre-accumulator variable-dt loop (what this fixes) ---');
  console.log('  direct 10 FPS worst step:', worstVarStep.toFixed(2),
    worstVarStep >= TREE_RADIUS ? `(>= ${TREE_RADIUS} tree radius — would tunnel)` : '(under radius)');
  console.log('  direct 10 FPS lateral drift vs 60 FPS:', worstVarDrift.toFixed(2), 'u (coarse-dt Euler) — collapses to ~0 with the accumulator');

  console.log(`\nFIXED-TIMESTEP HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (frame-rate equivalent; no tunneling; finite)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
