// physics_invariant_harness.js
// Headless comparison of the pre-feature ("baseline") updateSnowman against the
// current snowman.js, to guard the load-bearing safety property of the ski-technique
// layer: with NO steering/brake input, grounded physics must stay byte-for-byte
// identical to the original (so the existing physics/regression/browser tests, which
// drive the real updateSnowman, keep passing).
//
//   baseline: tests/verification/snowman_baseline.js  (frozen pre-feature snapshot)
//   current : ../../src/snowman.js
//
// The process exit code is gated ONLY on that invariant (check 1) plus the
// clearly-correct technique checks (brake slows you; modified scrubs >= original;
// edge scrub at speed). Check 3 ("a turn should cost speed vs coasting") is a
// diagnostic for the deliberately-thin technique model and is reported but does NOT
// fail the build — deepening it is a tracked design decision, not a regression.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- Shared deterministic terrain (mirrors mountains.js downhill shape, no noise) ---
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

// Seeded PRNG so the auto-turn (Math.random) path is identical across runs.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function loadUpdate(file) {
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { window: { location: { search: '' } }, console: { log() {}, warn() {} }, Math: Object.create(Math), THREE: {} };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.Snowman.updateSnowman;
}

function fakeSnowman() {
  const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  const ls = ski(), rs = ski();
  return {
    position: { set() {} },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
                leftSki: ls, rightSki: rs, leftSkiBaseX: -1, rightSkiBaseX: 1 }
  };
}

// Run a descent; returns trajectory + final speed/distance.
function simulate(updateFn, controls, seed, steps = 220, dt = 1 / 60) {
  const rng = makeRng(seed);
  Math.random = rng; // both runs use identical sequence given same seed
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
  const velocity = { x: 0, z: -3 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const traj = [];
  for (let i = 0; i < steps; i++) {
    const r = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls,
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
    st = r;
    traj.push({ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z });
    if (pos.z < -195) break;
  }
  const last = traj[traj.length - 1];
  return { traj, finalSpeed: Math.sqrt(last.vx * last.vx + last.vz * last.vz),
           distance: -15 - pos.z, steps: traj.length, technique: st.technique };
}

// The frozen baseline is still a classic script, so it loads via vm.runInContext.
// src/snowman is now an ES module (issue #84, PR 2.8) and can't be evaluated
// that way, so import the REAL module and read its updateSnowman directly. The
// comparison is unchanged: both return the same updateSnowman(...) contract, and
// the harness injects terrain + controls as arguments (snowman reads no terrain
// globals). The async import means the checks run inside an async IIFE.
//
// Phase 3.7 (issue #84): snowman was renamed `.js` -> `.ts`. This harness runs
// under `npm run test:verify` (no `.js`->`.ts` resolve hook), and it imports
// snowman directly, so use the real `.ts` extension (Node strips the erasable
// types natively, like avalanche.ts).
(async () => {
const orig = loadUpdate(path.join(__dirname, 'snowman_baseline.js'));
const mod = (await import('../../src/snowman.ts')).Snowman.updateSnowman;
// updateSnowman reads window.treeCollisionRadius / window.location.search for its
// test-hook + debug-logging paths; the frozen baseline gets these from its vm
// sandbox, so provide the same minimal stub on the global for the imported module.
global.window = global.window || { location: { search: '' } };

const NONE = { left: false, right: false, up: false, down: false, jump: false };
const DOWN = { left: false, right: false, up: false, down: true, jump: false };
const RIGHT = { left: false, right: true, up: false, down: false, jump: false };

let hardFail = false; // gates the exit code on safety-critical checks only

// 1) Coasting must be identical (no input) — THE load-bearing invariant.
const a = simulate(orig, NONE, 12345);
const b = simulate(mod, NONE, 12345);
let maxDiff = 0;
const n = Math.min(a.traj.length, b.traj.length);
for (let i = 0; i < n; i++) {
  maxDiff = Math.max(maxDiff,
    Math.abs(a.traj[i].x - b.traj[i].x), Math.abs(a.traj[i].z - b.traj[i].z),
    Math.abs(a.traj[i].vx - b.traj[i].vx), Math.abs(a.traj[i].vz - b.traj[i].vz));
}
const invariantOk = maxDiff < 1e-9 && a.traj.length === b.traj.length;
console.log('--- Invariant: coasting (no input) baseline vs current [GATING] ---');
console.log('  steps:', a.traj.length, b.traj.length, '| max abs diff:', maxDiff.toExponential(3));
console.log('  PASS:', invariantOk ? 'IDENTICAL ✅' : 'DIFFERENT ❌');
if (!invariantOk) hardFail = true;

// 2) Snowplow (Down) should shed speed vs coasting on the current build [GATING]
const coast = simulate(mod, NONE, 777);
const plow = simulate(mod, DOWN, 777);
const brakeOk = plow.finalSpeed < coast.finalSpeed;
// Braking must bring the snowman to a stop but never reverse it uphill past the start
// (distance = -15 - pos.z; negative => climbed uphill). Guards the clamp on brakeImpulse.
const noReverse = plow.distance >= -0.01;
console.log('\n--- Snowplow brake (current): Down vs coast [GATING] ---');
console.log('  coast finalSpeed:', coast.finalSpeed.toFixed(2), 'distance:', coast.distance.toFixed(1));
console.log('  plow  finalSpeed:', plow.finalSpeed.toFixed(2), 'distance:', plow.distance.toFixed(1), '| technique:', plow.technique);
console.log('  PASS:', brakeOk ? 'brake slows you ✅' : 'no slowdown ❌');
console.log('  PASS:', noReverse ? 'brake does not reverse uphill ✅' : `reverses uphill (distance ${plow.distance.toFixed(2)}) ❌`);
if (!brakeOk || !noReverse) hardFail = true;

// 3) Hard turning at speed should scrub speed vs coasting straight [DIAGNOSTIC ONLY]
const turn = simulate(mod, RIGHT, 777);
const turnCostsSpeed = turn.finalSpeed < coast.finalSpeed;
console.log('\n--- Carving/skid (current): hold Right vs coast straight [DIAGNOSTIC] ---');
console.log('  coast finalSpeed:', coast.finalSpeed.toFixed(2));
console.log('  turn  finalSpeed:', turn.finalSpeed.toFixed(2), '| technique:', turn.technique);
console.log('  PASS:', turnCostsSpeed ? 'turning costs speed ✅'
  : 'turning free ❌ (known: technique model is intentionally thin — see Gap 4 / issues #48,#54)');

// 4) Same Right input: current should be <= baseline (added scrub) [GATING]
const turnOrig = simulate(orig, RIGHT, 777);
const scrubsAtLeastOrig = turn.finalSpeed <= turnOrig.finalSpeed + 1e-6;
console.log('\n--- Same Right input: baseline vs current final speed [GATING] ---');
console.log('  baseline:', turnOrig.finalSpeed.toFixed(2), '| current:', turn.finalSpeed.toFixed(2));
console.log('  PASS:', scrubsAtLeastOrig ? 'current scrubs >= baseline ✅' : 'unexpected ❌');
if (!scrubsAtLeastOrig) hardFail = true;

// 5) Clean high-speed demonstration of edge scrub: same hard-Right input, faster entry [GATING]
function simulateFast(updateFn, controls, seed, vz0) {
  const rng = makeRng(seed); Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -40, y: getTerrainHeight(0, -40) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir:false, verticalVelocity:0, lastTerrainHeight:getTerrainHeight(0,-40),
             airTime:0, jumpCooldown:0, turnPhase:0, currentTurnDirection:0, turnChangeCooldown:3 };
  for (let i=0;i<90;i++){
    st = updateFn(snowman, 1/60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
      st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
      3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function(){});
    if (pos.z < -195) break;
  }
  return Math.sqrt(velocity.x*velocity.x+velocity.z*velocity.z);
}
const fo = simulateFast(orig, RIGHT, 42, -20);
const fm = simulateFast(mod,  RIGHT, 42, -20);
const scrubAtSpeed = fm < fo;
console.log('\n--- High-speed hard turn (entry 20 u/s), same Right input [GATING] ---');
console.log('  baseline finalSpeed:', fo.toFixed(2), '| current finalSpeed:', fm.toFixed(2),
            '| scrub:', (fo-fm).toFixed(2), `(${((1-fm/fo)*100).toFixed(0)}% slower)`);
console.log('  PASS:', scrubAtSpeed ? 'edge scrub active at speed ✅' : 'no scrub ❌');
if (!scrubAtSpeed) hardFail = true;

console.log(`\nINVARIANT HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (safety invariant + technique gating checks hold)'}`);
process.exit(hardFail ? 1 : 0);
})();
