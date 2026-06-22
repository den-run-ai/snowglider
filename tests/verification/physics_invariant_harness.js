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
// The process exit code is gated on that invariant (check 1) plus the
// clearly-correct technique checks (brake slows you; a committed carve holds more
// speed than panic-steering; modified scrubs >= original; edge scrub at speed).
// Check 3 used to be a non-gating diagnostic for the deliberately-thin technique
// model ("a turn should cost speed vs coasting"); issues #48/#54 deepened that
// model into a real carve-vs-skid speed trade-off, so check 3 is now the GATING
// carve-vs-skid comparison (with the old terrain-dependent line kept as 3b diag).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
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

// Like simulate(), but the controls are a per-frame function ctrl(i) so we can
// drive distinct steering *patterns* (a held carve vs. chatter-skidding). Used by
// the carve-vs-skid gating check; configurable entry speed/position so both
// patterns share the same terrain envelope.
function simulateCtrl(updateFn, ctrl, seed, { steps = 120, dt = 1 / 60, z0 = -40, vz0 = -20 } = {}) {
  const rng = makeRng(seed);
  Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: z0, y: getTerrainHeight(0, z0) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, z0),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  for (let i = 0; i < steps; i++) {
    st = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, ctrl(i),
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
    if (pos.z < -195) break;
  }
  return { finalSpeed: Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z), x: pos.x };
}

// The frozen baseline is still a classic script, so it loads via vm.runInContext.
// src/snowman is now an ES module (issue #84, PR 2.8) and can't be evaluated
// that way, so import the REAL module and read its updateSnowman directly. The
// comparison is unchanged: both return the same updateSnowman(...) contract, and
// the harness injects terrain + controls as arguments (snowman reads no terrain
// globals). The async import means the checks run inside an async IIFE.
//
// Phase 3.7 (issue #84): snowman was renamed `.js` -> `.ts` and then moved behind
// a thin `src/snowman.ts` facade (`export * from './snowman/index.js'`).
//
// Stage R3.8 (issue #34): `index.ts` now imports smaller snowman submodules via
// `.js` specifiers, matching the app's source convention. Register the same
// `.js` -> `.ts` resolver used by the Node suites before importing the public facade
// so `npm run test:verify` still works when run directly.
(async () => {
const orig = loadUpdate(path.join(__dirname, 'snowman_baseline.js'));
await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
const mod = (await import('../../src/snowman.ts')).Snowman.updateSnowman;
// updateSnowman reads window.treeCollisionRadius / window.location.search for its
// test-hook + debug-logging paths; the frozen baseline gets these from its vm
// sandbox, so provide the same minimal stub on the global for the imported module.
global.window = global.window || { location: { search: '' } };

const NONE = { left: false, right: false, up: false, down: false, jump: false };
const DOWN = { left: false, right: false, up: false, down: true, jump: false };
const RIGHT = { left: false, right: true, up: false, down: false, jump: false };
const LEFT = { left: true, right: false, up: false, down: false, jump: false };

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

// 3) Carve vs skid: a committed carve must hold meaningfully more speed than
// panic-steering [GATING]. This is the speed-management trade-off from issues
// #48/#54 — the deepening the technique model was "intentionally thin" on.
// Both runs link turns that oscillate around the fall line (they end at nearly
// the same x, so terrain is shared); they differ only in *reversal frequency*:
//   - carve   : long, committed arcs (24-frame edges) — carveCharge locks in.
//   - chatter : reverse the edge every other frame — carveCharge never engages.
// The chatter run must finish clearly slower. (Measured spread ~40%+; the gate
// requires a conservative 12% so it stays robust, not flaky.)
const PERIOD = 24;
const carveCtrl = (i) => (Math.floor(i / PERIOD) % 2 === 0 ? RIGHT : LEFT);
const chatterCtrl = (i) => (i % 2 === 0 ? RIGHT : LEFT);
const carveRun = simulateCtrl(mod, carveCtrl, 777);
const chatterRun = simulateCtrl(mod, chatterCtrl, 777);
const carveSpread = carveRun.finalSpeed / chatterRun.finalSpeed - 1;
const carveHoldsSpeed = carveSpread > 0.12;
console.log('\n--- Carve vs skid: linked carves vs chatter-skidding [GATING] ---');
console.log('  carve   finalSpeed:', carveRun.finalSpeed.toFixed(2), '@x', carveRun.x.toFixed(1));
console.log('  chatter finalSpeed:', chatterRun.finalSpeed.toFixed(2), '@x', chatterRun.x.toFixed(1));
console.log('  PASS:', carveHoldsSpeed
  ? `carve holds speed (+${(carveSpread * 100).toFixed(0)}% vs skid) ✅`
  : `carve advantage too small (+${(carveSpread * 100).toFixed(0)}%) ❌`);
if (!carveHoldsSpeed) hardFail = true;

// 3b) A turn at speed still costs speed (no free lunch) [DIAGNOSTIC]. Compared
// against a held-Right coast reference, which on this synthetic radial terrain
// curves onto a steeper line, so this stays informational rather than gating.
const turn = simulate(mod, RIGHT, 777);
console.log('  diag: held-Right', turn.finalSpeed.toFixed(2), 'vs meander-coast', coast.finalSpeed.toFixed(2),
  '| technique:', turn.technique, '(terrain-dependent; not gated)');

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

// 6) Carve reachable: a sustained, committed turn (held Right) must lock the edge
// in far enough to read as a "carve" — the speed-holding mastery turn above the
// uncommitted skidded "parallel" turn (issues #48/#54). carveCharge builds only
// while steering, so this is also gated behind input and cannot affect coasting. [GATING]
function simulateTech(updateFn, controls, seed, { steps = 120, dt = 1 / 60, z0 = -40, vz0 = -12 } = {}) {
  const rng = makeRng(seed); Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: z0, y: getTerrainHeight(0, z0) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, z0),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const seen = new Set();
  for (let i = 0; i < steps; i++) {
    st = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
      st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
      3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
    if (st.technique) seen.add(st.technique);
    if (pos.z < -195) break;
  }
  return { seen };
}
const parRun = simulateTech(mod, RIGHT, 777);
const reachesCarve = parRun.seen.has('carve');
console.log('\n--- Carve: sustained committed turn reaches the carve tier [GATING] ---');
console.log('  techniques seen on held-Right:', [...parRun.seen].join(', '));
console.log('  PASS:', reachesCarve ? 'committed turn locks into a carve ✅' : 'never reached carve ❌');
if (!reachesCarve) hardFail = true;

// 7) Hop turn (Jump + steer): a quick edge-set pivot that snaps the heading toward
// the steer direction MUCH harder than a plain steering frame, and scrubs speed
// (issue #48). Both probes share an identical 20-frame held-Right prefix (same
// seed), then differ only on the final frame: plain Right vs Right+Jump. [GATING]
const RIGHTJUMP = { left: false, right: true, up: false, down: false, jump: true };
function hopProbe(updateFn, lastControls, seed, { K = 20, vz0 = -16 } = {}) {
  const rng = makeRng(seed); Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -40, y: getTerrainHeight(0, -40) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -40),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const step = (ctrl) => {
    st = updateFn(snowman, 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity, st.lastTerrainHeight,
      st.airTime, st.jumpCooldown, ctrl, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown,
      3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
  };
  for (let i = 0; i < K; i++) step(RIGHT);
  const headingBefore = Math.atan2(velocity.x, velocity.z);
  const speedBefore = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  step(lastControls);
  const heading = Math.atan2(velocity.x, velocity.z);
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  return { deflect: Math.abs(heading - headingBefore), speedBefore, speed, technique: st.technique };
}
const plainStep = hopProbe(mod, RIGHT, 4242);
const hopStep = hopProbe(mod, RIGHTJUMP, 4242);
const hopPivotsHarder = hopStep.deflect > plainStep.deflect * 1.5;
const hopScrubs = hopStep.speed < hopStep.speedBefore;
console.log('\n--- Hop turn: Jump + steer pivots harder and scrubs speed [GATING] ---');
console.log('  plain-steer heading deflect:', plainStep.deflect.toFixed(3), 'rad');
console.log('  hop-turn    heading deflect:', hopStep.deflect.toFixed(3), 'rad', '| technique:', hopStep.technique);
console.log('  hop speed:', hopStep.speedBefore.toFixed(2), '->', hopStep.speed.toFixed(2));
console.log('  PASS:', hopPivotsHarder ? `hop snaps heading ~${(hopStep.deflect / Math.max(plainStep.deflect, 1e-6)).toFixed(1)}x harder ✅` : 'hop pivot too weak ❌');
console.log('  PASS:', hopScrubs ? 'hop scrubs speed ✅' : 'hop did not scrub ❌');
if (!hopPivotsHarder || !hopScrubs) hardFail = true;

// 8) Takeoff precedence + provenance (meaningful jumps #47, §3.1). On a single
// frame that *also* satisfies the terrain auto-jump condition (a steep lip at
// speed), pressing Jump must win: it produces the stronger manual pop and stamps
// the air phase `playerJump = true`, while the unpressed lip stays the weaker
// auto-jump stamped `playerJump = false`. This guards both the `!controls.jump`
// auto-jump guard and the userData provenance lifecycle. [GATING]
const JUMP = { left: false, right: false, up: false, down: false, jump: true };
function lipFrame(updateFn, controls) {
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -50, y: getTerrainHeight(0, -50) };
  const velocity = { x: 0, z: -16 }; // speed 16 > the movingFast (>12) gate
  // Pretend last frame's terrain was 5 u higher so heightDifference < -0.8 fires.
  const lastTerrainHeight = getTerrainHeight(0, -50) + 5;
  const r = updateFn(snowman, 1 / 60, pos, velocity, false, 0, lastTerrainHeight,
    0, 0, controls, 0, 0, 3, 3.0,
    getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
  return { vv: r.verticalVelocity, inAir: r.isInAir, playerJump: !!snowman.userData.playerJump };
}
const autoLip = lipFrame(mod, NONE);
const jumpLip = lipFrame(mod, JUMP);
const precedenceOk = autoLip.inAir && jumpLip.inAir &&
  jumpLip.vv > autoLip.vv &&            // manual pop is stronger than the auto pop
  jumpLip.playerJump === true &&        // pressed lip credited to the player
  autoLip.playerJump === false;         // unpressed lip stays an auto-jump
console.log('\n--- Takeoff precedence: Jump wins over the terrain auto-jump on a lip [GATING] ---');
console.log('  auto-jump (no input): vv', autoLip.vv.toFixed(2), '| playerJump', autoLip.playerJump);
console.log('  manual jump (Jump)  : vv', jumpLip.vv.toFixed(2), '| playerJump', jumpLip.playerJump);
console.log('  PASS:', precedenceOk
  ? 'pressed lip = stronger player jump; unpressed lip = auto-jump ✅'
  : 'jump did not win the lip frame / provenance wrong ❌');
if (!precedenceOk) hardFail = true;

// 9) Landing-quality grade: a CLEAN manual-jump landing (heading aligned with the
// fall line) must finish FASTER than a SKETCHY one (heading crossed up) from the
// same speed + airtime — the clean-landing boost vs scrub (§3.2/§3.3). A single
// landing frame with playerJump pre-stamped isolates the grade. [GATING]
function landProbe(updateFn, vx, vz, airTime, playerJump, seed = 999) {
  const rng = makeRng(seed); Math.random = rng;
  const snowman = fakeSnowman();
  snowman.userData.playerJump = playerJump;
  const x = 0, z = -60, ground = getTerrainHeight(x, z);
  const pos = { x, z, y: ground - 0.01 }; // just below terrain => lands this frame
  const velocity = { x: vx, z: vz };
  const r = updateFn(snowman, 1 / 60, pos, velocity, true, 0, ground,
    airTime, 0, NONE, 0, 0, 3, 3.0,
    getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
  return { quality: r.landingQuality, airScore: r.airScoreDelta,
           speedAfter: Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z) };
}
// At (0,-60) the fall line points ~straight down-slope (-z), so (0,-V) is aligned
// (CLEAN) and (V,0) is crossed up (SKETCHY).
const cleanLand = landProbe(mod, 0, -18, 1.5, true);
const sketchyLand = landProbe(mod, 18, 0, 1.5, true);
// A middling alignment (~0.7 vs the (0,-1) fall line at (0,-60)) lands in the OK band:
// neither boosted nor scrubbed, but still scored for the airtime.
const okLand = landProbe(mod, 13, -13, 1.5, true);
const gradeOk = cleanLand.quality === 'clean' && sketchyLand.quality === 'sketchy' &&
  okLand.quality === 'ok' && cleanLand.speedAfter > okLand.speedAfter &&
  okLand.speedAfter > sketchyLand.speedAfter && cleanLand.airScore > sketchyLand.airScore;
console.log('\n--- Landing grade: CLEAN > OK > SKETCHY finishing speed [GATING] ---');
console.log('  clean   :', cleanLand.quality, '| speedAfter', cleanLand.speedAfter.toFixed(2), '| airScore', cleanLand.airScore);
console.log('  ok      :', okLand.quality, '| speedAfter', okLand.speedAfter.toFixed(2), '| airScore', okLand.airScore);
console.log('  sketchy :', sketchyLand.quality, '| speedAfter', sketchyLand.speedAfter.toFixed(2), '| airScore', sketchyLand.airScore);
console.log('  PASS:', gradeOk ? 'clean boosts > ok neutral > sketchy scrubs ✅' : 'grade did not separate clean/ok/sketchy ❌');
if (!gradeOk) hardFail = true;

// 10) Provenance gate: a NON-player landing (auto-jump / hop, playerJump=false) is
// never graded or scored — no landingQuality, no airScore — even with an identical
// heading + airtime to the CLEAN case above. Guards the §3.1 reward leak. [GATING]
const autoLand = landProbe(mod, 0, -18, 1.5, false);
const provenanceGated = autoLand.quality === null && autoLand.airScore === 0;
console.log('\n--- Provenance gate: auto-jump landing earns no boost / score [GATING] ---');
console.log('  auto landing:', 'quality', autoLand.quality, '| airScore', autoLand.airScore);
console.log('  PASS:', provenanceGated ? 'non-player landing not rewarded ✅' : 'reward leaked to a non-player landing ❌');
if (!provenanceGated) hardFail = true;

console.log(`\nINVARIANT HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (safety invariant + technique gating checks hold)'}`);
process.exit(hardFail ? 1 : 0);
})();
