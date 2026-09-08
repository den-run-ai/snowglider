// @ts-check
// rng_frame_rate_harness.js
// Cross-refresh-rate RNG-isolation gate (issue #400). Sibling to
// fixed_timestep_harness.js: that one proves the fixed-step accumulator makes the
// trajectory frame-rate independent when nothing else consumes the RNG stream;
// THIS one proves the RunContext stream split holds that property even when a
// cosmetic layer draws random values on every RENDER frame — the audit's P0:
// per-render-frame cosmetic draws on the shared global stream meant a 144 Hz
// panel consumed far more of the stream than a 30 Hz one before the physics
// auto-turn asked for its next value, so refresh rate changed gameplay.
//
//   1. SEEDED EQUIVALENCE [GATING] — with a run seed set, the kernel's auto-turn
//      draws come from the private 'physics' gameplay stream, so the trajectory
//      is BYTE-IDENTICAL at 30/60/144 Hz even while every render frame burns a
//      varying number of global Math.random values (the stand-in for cosmetic
//      pollution under the OLD shared-stream design).
//   2. UNSEEDED DIVERGENCE [DIAGNOSTIC] — without a seed the gameplay stream is
//      a Math.random passthrough (the byte-identical-baseline contract), so the
//      same per-render-frame pollution shifts the auto-turns and the rates
//      diverge. That is today's production behavior, printed here as the
//      motivating contrast, not gated (it is exactly what setRunSeed fixes).
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/rng_frame_rate_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals (mirrors fixed_timestep_harness.js).
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

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
  const RC = await import('../../src/run-context.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const realRandom = Math.random;
  let pass = 0, fail = 0;
  const check = (gating, name, cond, detail) => {
    const tag = cond ? 'PASS ✅' : (gating ? 'FAIL ❌' : 'note');
    console.log(`  ${tag}: ${name}${detail ? ` — ${detail}` : ''}`);
    if (gating) { cond ? pass++ : fail++; }
  };

  // One fixed obstacle field for every profile (seeded layout, like the sibling
  // harness). Built once so every rate sees the same world.
  const LAYOUT_SEED = 0xA11CE;
  Math.random = makeRng(LAYOUT_SEED);
  const scene = makeScene();
  const _log = console.log, _warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const treePositions = Trees.addTrees(scene);
  const rockPositions = addRocks(scene);
  console.log = _log; console.warn = _warn;
  Math.random = realRandom;

  const NO_INPUT = { left: false, right: false, up: false, down: false, jump: false };
  const RUN_SECONDS = 15; // several auto-turn cooldown cycles (first draw ~t=3 s)

  /**
   * Drive the REAL kernel through the main-loop accumulator at a fixed render
   * rate, burning `pollutionAt(frameIndex)` global Math.random draws every
   * RENDER frame (the cosmetic stand-in) plus a couple of cosmetic-stream draws.
   * The GLOBAL stream is seeded identically per profile, so unseeded runs model
   * exactly the old shared-stream world.
   * @param {number} hz  render rate
   * @param {number|null} runSeed  RunContext seed (null = today's passthrough)
   */
  function runAtRate(hz, runSeed) {
    RC.setRunSeed(runSeed); // also resets every stream: each profile replays from the top
    Math.random = makeRng(0xC0FFEE); // same global stream for every profile
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const showGameOver = () => {};

    const frameDelta = 1 / hz;
    const frames = Math.round(RUN_SECONDS * hz);
    const traj = [];
    let accumulator = 0, nonFinite = false;
    for (let f = 0; f < frames; f++) {
      // Cosmetic pollution: a varying number of global draws per RENDER frame —
      // more frames per second = more draws, exactly the old failure shape —
      // plus private cosmetic-stream draws (which must never matter).
      const burn = 1 + (f % 3);
      for (let b = 0; b < burn; b++) Math.random();
      RC.cosmeticRandom('snowParticles');
      RC.cosmeticRandom('avalanchePowder');

      accumulator += Math.min(frameDelta, MAX_SUBSTEPS * FIXED_DT);
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
          st.lastTerrainHeight, st.airTime, st.jumpCooldown, NO_INPUT, st.turnPhase, st.currentTurnDirection,
          st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
          treePositions, true, showGameOver, rockPositions);
        snowman.position.set(pos.x, pos.y, pos.z);
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) { nonFinite = true; break; }
        traj.push({ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z });
        accumulator -= FIXED_DT;
        substeps++;
      }
      if (substeps >= MAX_SUBSTEPS && accumulator >= FIXED_DT) accumulator = 0;
      if (nonFinite) break;
    }
    Math.random = realRandom;
    RC.setRunSeed(null);
    return { traj, nonFinite };
  }

  /** Max absolute per-step difference over the common prefix of two runs. */
  function maxAbsDiff(a, b) {
    const n = Math.min(a.traj.length, b.traj.length);
    let m = 0;
    for (let i = 0; i < n; i++) {
      m = Math.max(m,
        Math.abs(a.traj[i].x - b.traj[i].x), Math.abs(a.traj[i].z - b.traj[i].z),
        Math.abs(a.traj[i].vx - b.traj[i].vx), Math.abs(a.traj[i].vz - b.traj[i].vz));
    }
    return m;
  }

  console.log('\n=== RNG isolation across refresh rates (issue #400) ===');
  console.log(`kernel: real updateSnowman | ${RUN_SECONDS} s no-input coast | pollution: 1-3 global draws + 2 cosmetic draws per render frame\n`);

  console.log('--- 1) SEEDED: same run seed => byte-identical at every rate [GATING] ---');
  const SEED = 0xABCD1234;
  const s30 = runAtRate(30, SEED);
  const s60 = runAtRate(60, SEED);
  const s144 = runAtRate(144, SEED);
  const d3060 = maxAbsDiff(s30, s60);
  const d60144 = maxAbsDiff(s60, s144);
  check(true, 'no NaN/Infinity at any rate', !s30.nonFinite && !s60.nonFinite && !s144.nonFinite);
  // Fixed-step counts may differ by ONE step across rates: float accumulation of
  // 1/hz frame deltas can leave the final substep a hair under FIXED_DT (e.g.
  // 2160 x 1/144 sums to just below 15.0). The byte-identical comparison below
  // runs over the common prefix, which is the property that matters.
  const stepCounts = [s30.traj.length, s60.traj.length, s144.traj.length];
  check(true, 'fixed-step counts agree to within the 1-step float residue',
    Math.max(...stepCounts) - Math.min(...stepCounts) <= 1,
    stepCounts.join('/'));
  check(true, '30 Hz vs 60 Hz trajectory byte-identical under per-frame cosmetic pollution',
    d3060 === 0, `max abs diff ${d3060.toExponential(3)}`);
  check(true, '60 Hz vs 144 Hz trajectory byte-identical under per-frame cosmetic pollution',
    d60144 === 0, `max abs diff ${d60144.toExponential(3)}`);
  const r1 = runAtRate(60, SEED);
  check(true, 'replaying the same seed at the same rate reproduces the run exactly',
    maxAbsDiff(s60, r1) === 0);
  const r2 = runAtRate(60, 0x5EED);
  check(true, 'a different seed is a genuinely different run',
    maxAbsDiff(s60, r2) > 1e-3, `diff ${maxAbsDiff(s60, r2).toExponential(3)}`);

  console.log('\n--- 2) UNSEEDED: the passthrough world diverges under the same pollution [DIAGNOSTIC] ---');
  const u30 = runAtRate(30, null);
  const u144 = runAtRate(144, null);
  const du = maxAbsDiff(u30, u144);
  check(false, 'unseeded 30 Hz vs 144 Hz diverge (the motivating failure, fixed by setRunSeed)',
    du > 1e-3, `max abs diff ${du.toExponential(3)}`);

  console.log(`\nRNG FRAME-RATE HARNESS: ${fail === 0 ? 'OK ✅' : 'FAILING ❌'} (${pass} gates passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
