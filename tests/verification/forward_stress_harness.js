// forward_stress_harness.js
// Robustness stress test for the "floor it forward and blow past the obstacles"
// class of bug (PR #209). Unlike physics_invariant_harness.js — which pins coasting
// on a synthetic constant slope — this drives the REAL physics kernel
// (Snowman.updateSnowman) over the REAL analytic terrain with the REAL procedurally
// placed trees + rocks, holding ONLY Up (forward, never steering), across several
// frame rates and tree layouts. It guards two properties that broke before the
// frame-rate-independent drag fix:
//
//   1. NO TUNNELING — the collision check is a discrete point-vs-radius test, so a
//      per-frame step larger than the tree radius can skip a tree disk entirely. The
//      harness replays each frame's prev->cur segment against every tree disk and
//      asserts zero uncaught pass-throughs, and that the worst per-frame step stays
//      below the collision radius, at every tested frame rate (incl. the capped
//      0.1 s delta = ~10 FPS).
//
//   2. FRAME-RATE-BOUNDED SPEED — terminal cruise speed holding Up must not balloon
//      at low frame rate. Before the fix it scaled ~4x (8 -> 32 m/s) from 60 to
//      10 FPS, which is what let a slow-device player rocket straight down the fall
//      line past the trees. The gate caps the 10-FPS/60-FPS max-speed ratio.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/forward_stress_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + tree/rock placement touch (no DOM/WebGL).
global.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
global.document = undefined; // trees/rocks skip canvas textures when document is absent
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Seeded PRNG so tree/rock placement and the auto-turn are reproducible.
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
  return { children, add(o) { children.push(o); }, remove(o) { const i = children.indexOf(o); if (i >= 0) children.splice(i, 1); }, userData: {} };
}

function fakeSnowman() {
  const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  return {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1 },
  };
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { Snowman } = await import('../../src/snowman.ts');
  const terrain = await import('../../src/mountains/terrain.ts');
  const { Trees } = await import('../../src/mountains/trees.ts');
  const { addRocks } = await import('../../src/mountains/rocks.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;

  const TREE_RADIUS = 2.5;            // mirrors collision.ts default treeCollisionRadius
  const UP = { left: false, right: false, up: true, down: false, jump: false };
  const SEEDS = [12345, 777, 42, 9001];
  const FRAME_RATES = [1 / 60, 1 / 30, 1 / 10]; // 60, 30, and the capped-delta 10 FPS

  // One descent holding Up. Trees/rocks are generated from `layoutSeed` (fixed per
  // seed so every frame rate skis the SAME mountain); the auto-turn uses a fixed
  // descent seed so the only variable across the FRAME_RATES loop is dt.
  function runDescent(layoutSeed, dt) {
    Math.random = makeRng(layoutSeed);
    const scene = makeScene();
    // Silence the unconditional placement logs (Trees.addTrees / addRocks) so the
    // harness output stays readable; restore immediately after.
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    const treePositions = Trees.addTrees(scene);
    const rockPositions = addRocks(scene);
    console.log = _log; console.warn = _warn;

    Math.random = makeRng(0xC0FFEE ^ layoutSeed); // deterministic auto-turn, independent of dt
    const snowman = fakeSnowman();
    const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);

    let reason = null;
    const showGameOver = (r) => { if (!reason) reason = r; };
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };

    let maxSpeed = 0, maxStep = 0, tunnelFrames = 0;
    const MAX_FRAMES = Math.ceil(120 / dt); // 2 min of in-game wall clock cap
    for (let f = 0; f < MAX_FRAMES; f++) {
      const prevX = pos.x, prevZ = pos.z;
      st = Snowman.updateSnowman(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, UP, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        treePositions, true, showGameOver, rockPositions);
      snowman.position.set(pos.x, pos.y, pos.z);

      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed > maxSpeed) maxSpeed = speed;
      const step = Math.hypot(pos.x - prevX, pos.z - prevZ);
      if (step > maxStep) maxStep = step;

      // Tunneling probe: did the prev->cur segment pass THROUGH a tree disk that
      // neither endpoint sampled inside (so the point-based check missed it)?
      for (const t of treePositions) {
        if (pointSegmentDistance(t.x, t.z, prevX, prevZ, pos.x, pos.z) < TREE_RADIUS &&
            Math.hypot(prevX - t.x, prevZ - t.z) >= TREE_RADIUS &&
            Math.hypot(pos.x - t.x, pos.z - t.z) >= TREE_RADIUS) {
          tunnelFrames++;
        }
      }

      if (reason || pos.z < -195) break;
    }
    return { maxSpeed, maxStep, tunnelFrames, reason, trees: treePositions.length, rocks: rockPositions.length };
  }

  let hardFail = false;

  // --- 1) No tunneling at any frame rate / layout [GATING] ---
  let totalTunnel = 0, worstStep = 0, worstStepDt = 0;
  // --- 2) Frame-rate-bounded speed [GATING] ---
  let worstSpeedRatio = 0, worstSpeedSeed = 0;
  const rows = [];
  for (const seed of SEEDS) {
    const byDt = {};
    for (const dt of FRAME_RATES) {
      const r = runDescent(seed, dt);
      byDt[dt] = r;
      totalTunnel += r.tunnelFrames;
      if (r.maxStep > worstStep) { worstStep = r.maxStep; worstStepDt = dt; }
      rows.push({ seed, fps: Math.round(1 / dt), ...r });
    }
    const ratio = byDt[1 / 10].maxSpeed / byDt[1 / 60].maxSpeed;
    if (ratio > worstSpeedRatio) { worstSpeedRatio = ratio; worstSpeedSeed = seed; }
  }

  console.log('=== Forward-only stress: real terrain + trees + rocks, holding Up ===');
  console.log('  seed     FPS  trees rocks  maxSpeed  maxStep  tunnel  outcome');
  for (const r of rows) {
    console.log('  %s  %s   %s   %s   %s   %s    %s    %s',
      String(r.seed).padStart(6), String(r.fps).padStart(3), String(r.trees).padStart(4),
      String(r.rocks).padStart(4), r.maxSpeed.toFixed(2).padStart(6), r.maxStep.toFixed(3).padStart(6),
      String(r.tunnelFrames).padStart(4), r.reason || `z<-195 (finish)`);
  }

  const noTunneling = totalTunnel === 0 && worstStep < TREE_RADIUS;
  console.log('\n--- No collision tunneling at any frame rate [GATING] ---');
  console.log('  total uncaught pass-throughs:', totalTunnel,
    '| worst per-frame step:', worstStep.toFixed(3), `(at ${Math.round(1 / worstStepDt)} FPS)`, '| tree radius:', TREE_RADIUS);
  console.log('  PASS:', noTunneling ? 'every step stays inside the collision radius ✅' : 'a frame stepped past a tree disk ❌');
  if (!noTunneling) hardFail = true;

  // Before the fix this ratio was ~4 (8 -> 32 m/s); 1.6 leaves margin for the small
  // discrete-integration drift while still failing hard on a per-frame-drag regression.
  const SPEED_RATIO_CAP = 1.6;
  const speedBounded = worstSpeedRatio < SPEED_RATIO_CAP;
  console.log('\n--- Cruise speed does not balloon at low frame rate [GATING] ---');
  console.log('  worst 10-FPS / 60-FPS max-speed ratio:', worstSpeedRatio.toFixed(2),
    `(seed ${worstSpeedSeed})`, '| cap:', SPEED_RATIO_CAP);
  console.log('  PASS:', speedBounded ? 'low-FPS speed stays bounded ✅' : 'speed scales with frame rate ❌');
  if (!speedBounded) hardFail = true;

  console.log(`\nFORWARD STRESS HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (no tunneling; speed frame-rate bounded)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
