// @ts-check
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

// Like simulateCtrl(), but on a CONSTANT-slope terrain (downhill is -z, steepness ==
// `slope`) instead of the radial test hill. The radial hill gentles out underneath a
// descending snowman, which masks the snowplow's steady-state force balance; a constant
// slope shows it cleanly (e.g. a full wedge holding a terminal speed on a steep pitch).
// currentTurnDirection starts at 0 and only flips after the ~3s auto-turn cooldown, so
// for the short windows used here there is no auto-turn lateral velocity (vx stays 0).
function simulateSlope(updateFn, ctrl, { slope, vz0 = -8, steps = 60, dt = 1 / 60, seed = 7 }) {
  const gH = (x, z) => slope * z;          // z more negative => lower => downhill in -z
  const gG = () => ({ x: 0, z: slope });
  const gD = () => ({ x: 0, z: -1 });
  Math.random = makeRng(seed);
  const snowman = fakeSnowman();
  const pos = { x: 0, z: 0, y: gH(0, 0) };
  const velocity = { x: 0, z: vz0 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: gH(0, 0),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  for (let i = 0; i < steps; i++) {
    const c = typeof ctrl === 'function' ? ctrl(i) : ctrl;
    st = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, c,
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0, gH, gG, gD, [], false, function () {});
  }
  return { finalSpeed: Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z), z: pos.z };
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
const g = /** @type {any} */ (globalThis);
g.window = g.window || { location: { search: '' } };

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

// 2b) Snowplow stop-vs-slow-down gradation [GATING]. The wedge is a hold ramp
// (plowCharge): a quick TAP forms a shallow wedge that only trims speed, while a
// sustained HOLD deepens into a full wedge that brakes far harder. Over one fixed
// short window on the same moderate (~27deg) pitch the ordering must be
// hold < tap < coast — deeper/longer wedge => more speed shed. (Issue #54.)
const TAP_FRAMES = 18; // ~0.3s tap => a shallow wedge that only trims speed
const gradOpt = { slope: 0.5, vz0: -5, steps: 45 };
const gCoast = simulateSlope(mod, () => NONE, gradOpt).finalSpeed;
const gTap   = simulateSlope(mod, (i) => (i < TAP_FRAMES ? DOWN : NONE), gradOpt).finalSpeed;
const gHold  = simulateSlope(mod, () => DOWN, gradOpt).finalSpeed;
const gradOk = gHold < gTap - 0.1 && gTap < gCoast - 0.1;
console.log('\n--- Snowplow gradation: hold (full wedge) < tap (light wedge) < coast [GATING] ---');
console.log('  coast:', gCoast.toFixed(2), '| tap:', gTap.toFixed(2), '| hold:', gHold.toFixed(2));
console.log('  PASS:', gradOk ? 'deeper/longer wedge sheds more speed ✅' : 'gradation not monotonic ❌');
if (!gradOk) hardFail = true;

// 2c) Steep-slope failure, with the stop/fail boundary pinned to the Slope-HUD edge
// [GATING]. The full wedge's deceleration is capped at the blue→black-diamond tier
// edge (steepness 0.58 ≈ 30°), so the boundary must land *there*: a BLUE pitch just
// under it stops, a BLACK pitch just over it can only be slowed, and steeper black is
// faster still. The brake removes exactly its capped decel along travel (computed from
// the post-gravity speed), and the coast friction vanishes as v→0, so neither pushes
// the boundary past the HUD edge — this guards the regression codex flagged on #204
// where the boundary sat ~36° and a "black" pitch could still be fully stopped. Run on
// CONSTANT slopes so the steady state shows without the radial hill gentling out. This
// graceful degradation is what makes the steep upper mountain (and avalanche escape)
// actually demand real technique (#54).
const blueStop   = simulateSlope(mod, () => DOWN, { slope: 0.54, vz0: -8, steps: 240 }).finalSpeed; // ~28°, blue
const blackEdge  = simulateSlope(mod, () => DOWN, { slope: 0.62, vz0: -8, steps: 240 }).finalSpeed; // ~32°, just into black
const blackSteep = simulateSlope(mod, () => DOWN, { slope: 0.85, vz0: -8, steps: 240 }).finalSpeed; // ~40°, deep black
const steepFailOk = blueStop < 0.15 && blackEdge > 0.30 && blackSteep > blackEdge + 0.30;
console.log('\n--- Snowplow steep-slope failure (boundary pinned to the 30° black edge) [GATING] ---');
console.log('  blue  (~28°) full-plow finalSpeed:', blueStop.toFixed(2), '(should be ~0: stops)');
console.log('  black (~32°) full-plow finalSpeed:', blackEdge.toFixed(2), '(should be > 0: cannot stop)');
console.log('  black (~40°) full-plow finalSpeed:', blackSteep.toFixed(2), '(steeper => faster terminal)');
console.log('  PASS:', steepFailOk ? 'stops on blue, only slows on black, monotonic on steeper ✅' : 'boundary not at the black edge ❌');
if (!steepFailOk) hardFail = true;

// 2d) Plow charge tracks Brake through the air [GATING]. The wedge depth must advance
// from controls.down EVERY frame, not freeze while airborne — so releasing Brake on a
// jump relaxes the wedge for the landing and holding it pre-builds. Otherwise tap-vs-hold
// breaks around jumps (the regression codex flagged on #204). Braking itself stays
// grounded-only; this only governs the charge level. Force a sustained airborne phase
// (high above terrain, climbing) and read snowman.userData.plowCharge before/after.
function airCharge(startCharge, ctrl, frames = 12) {
  const sn = fakeSnowman(); sn.userData.plowCharge = startCharge;
  const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) + 30 }; // well above ground => stays airborne
  const vel = { x: 0, z: -3 };
  let st = { isInAir: true, verticalVelocity: 5, lastTerrainHeight: getTerrainHeight(0, -15),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  for (let i = 0; i < frames; i++) {
    st = mod(/** @type {any} */ (sn), 1 / 60, pos, vel, st.isInAir, st.verticalVelocity, st.lastTerrainHeight, st.airTime,
      st.jumpCooldown, ctrl, st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {});
  }
  return { plowCharge: sn.userData.plowCharge, airborne: st.isInAir };
}
const airReleased = airCharge(1.0, NONE);  // Brake released in the air => wedge relaxes
const airHeld     = airCharge(0.0, DOWN);  // Brake held in the air => wedge pre-builds
const airChargeOk = airReleased.airborne && airHeld.airborne
  && airReleased.plowCharge < 0.7 && airHeld.plowCharge > 0.1;
console.log('\n--- Snowplow charge tracks Brake through the air [GATING] ---');
console.log('  released-in-air plowCharge 1.0 ->', airReleased.plowCharge.toFixed(2), '(should fall: wedge relaxes)');
console.log('  held-in-air     plowCharge 0.0 ->', airHeld.plowCharge.toFixed(2), '(should rise: wedge pre-builds)');
console.log('  PASS:', airChargeOk ? 'charge follows Brake mid-air, not frozen ✅' : 'charge frozen in air ❌');
if (!airChargeOk) hardFail = true;

// 2e) Brake overrides accelerate [GATING]. Up and Down are independent key states, and
// the accelerate impulse (10) is stronger than a full wedge's brake cap (5.68); without
// the snowplow gate on Up, holding W+S would accelerate downhill instead of braking. On
// a green slope a full wedge + held Up must still STOP (not exceed plain coasting), and
// must end far slower than Up-only (tuck). Guards the regression codex flagged on #204.
const UP = { left: false, right: false, up: true, down: false, jump: false };
const DOWNUP = { left: false, right: false, up: true, down: true, jump: false };
const greenOpt = { slope: 0.30, vz0: -10, steps: 150 }; // ~17°, green: a full wedge stops here
const brakeUp = simulateSlope(mod, () => DOWNUP, greenOpt).finalSpeed;
const tuckUp  = simulateSlope(mod, () => UP, greenOpt).finalSpeed;
const overrideOk = brakeUp < 0.5 && brakeUp < tuckUp - 2.0;
console.log('\n--- Snowplow brake overrides accelerate (W+S held together) [GATING] ---');
console.log('  brake+up (green) finalSpeed:', brakeUp.toFixed(2), '(should be ~0: brake wins)');
console.log('  up-only  (tuck)  finalSpeed:', tuckUp.toFixed(2), '(accelerates)');
console.log('  PASS:', overrideOk ? 'brake overrides simultaneous accelerate ✅' : 'accelerate beats brake ❌');
if (!overrideOk) hardFail = true;

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

// 11) Frame-rate independence of cruising speed [GATING]. The coast/cruise drag is a
// per-frame multiplier (velocity *= 1-k) while the forces are delta-scaled, so before
// the dragFactor() fix the terminal speed scaled with frame rate: ~8 m/s at 60 FPS but
// ~32 m/s at the capped 0.1 s delta (~10 FPS). On a slow / mobile device that let a
// player just hold Up and rocket straight down the fall line — fast enough to slip
// between (and at the worst frame times tunnel through) the trees without ever
// steering (the "floor it forward, pass the obstacles without dodging" report). The
// fix raises each `1-k` to delta*60 so the drag integrates to the same speed lost per
// SECOND at any frame rate; the 60 Hz path is byte-identical (delta*60 == 1 exactly
// when delta === 1/60, and Math.pow(x,1) === x), guarded by check 1 above. Hold Up on
// a constant slope for a fixed ~6 s of wall-clock at three frame rates; the terminal
// speeds must now agree closely instead of diverging with the frame time.
const UP_CRUISE = { left: false, right: false, up: true, down: false, jump: false };
const cruiseSeconds = 6;
const cruiseSpeedAt = (dt) => simulateSlope(mod, () => UP_CRUISE,
  { slope: 0.3, vz0: -7, steps: Math.round(cruiseSeconds / dt), dt, seed: 7 }).finalSpeed;
const cruise60 = cruiseSpeedAt(1 / 60);
const cruise30 = cruiseSpeedAt(1 / 30);
const cruise10 = cruiseSpeedAt(1 / 10);
const cruiseMax = Math.max(cruise60, cruise30, cruise10);
const cruiseMin = Math.min(cruise60, cruise30, cruise10);
const cruiseSpread = (cruiseMax - cruiseMin) / cruise60;
// Within 10% across a 6x frame-rate range (measured ~4-5%); the un-fixed per-frame
// drag diverged ~300% (8 -> 32 m/s), so this gate is robust, not flaky.
const frameRateIndependent = cruiseSpread < 0.10;
console.log('\n--- Frame-rate independence: holding Up cruises at the same speed at any FPS [GATING] ---');
console.log('  60 FPS:', cruise60.toFixed(2), '| 30 FPS:', cruise30.toFixed(2), '| 10 FPS:', cruise10.toFixed(2),
  '| spread:', (cruiseSpread * 100).toFixed(1) + '%');
console.log('  PASS:', frameRateIndependent
  ? 'cruise speed is frame-rate independent ✅'
  : `cruise speed scales with frame rate (spread ${(cruiseSpread * 100).toFixed(0)}%) ❌`);
if (!frameRateIndependent) hardFail = true;

// 12) Bunny jump suppression (jump-system completion, workstream A) [GATING].
// The easy tier has NO jump verb: `manualJump: false` disables Space (straight jump
// AND hop turn) and `autoJump: false` keeps terrain lips from lofting. Two halves:
//   a) held-jump ≡ no-input — a Bunny run with Jump held EVERY frame must be
//      byte-identical to the same run with no input (the press is provably inert);
//   b) a lip frame that auto-jumps on default (Blue) tuning stays GROUNDED on Bunny
//      (isInAir false, pos.y glued to the terrain), with or without Jump held.
// Uses the real Bunny tuning from src/difficulty.ts so the shipped config is what's
// pinned, not a hand-rolled copy.
const BUNNY_SKI = (await import('../../src/difficulty.ts')).getDifficultyConfig('bunny').ski;
function simulateTuned(updateFn, controls, seed, tuning, steps = 220, dt = 1 / 60) {
  const rng = makeRng(seed);
  Math.random = rng;
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -15, y: getTerrainHeight(0, -15) };
  const velocity = { x: 0, z: -3 };
  let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, -15),
             airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const traj = [];
  for (let i = 0; i < steps; i++) {
    st = updateFn(snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls,
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
      [], undefined, tuning);
    traj.push({ x: pos.x, y: pos.y, z: pos.z, vx: velocity.x, vz: velocity.z, inAir: st.isInAir });
    if (pos.z < -195) break;
  }
  return traj;
}
const bunnyNone = simulateTuned(mod, NONE, 2026, BUNNY_SKI);
const bunnyHeld = simulateTuned(mod, JUMP, 2026, BUNNY_SKI);
let bunnyMaxDiff = 0;
let bunnyEverAir = false;
const bn = Math.min(bunnyNone.length, bunnyHeld.length);
for (let i = 0; i < bn; i++) {
  bunnyMaxDiff = Math.max(bunnyMaxDiff,
    Math.abs(bunnyNone[i].x - bunnyHeld[i].x), Math.abs(bunnyNone[i].z - bunnyHeld[i].z),
    Math.abs(bunnyNone[i].vx - bunnyHeld[i].vx), Math.abs(bunnyNone[i].vz - bunnyHeld[i].vz));
  bunnyEverAir = bunnyEverAir || bunnyNone[i].inAir || bunnyHeld[i].inAir;
}
const bunnyHeldIdentical = bunnyMaxDiff < 1e-9 && bunnyNone.length === bunnyHeld.length;
// b) the same fabricated lip frame that auto-jumps on default tuning (check 8's
// autoLip) must stay grounded on Bunny — no loft, pos.y snapped to the terrain.
function bunnyLipFrame(controls) {
  const snowman = fakeSnowman();
  const pos = { x: 0, z: -50, y: getTerrainHeight(0, -50) };
  const velocity = { x: 0, z: -16 }; // above the movingFast (>12) gate
  const lastTerrainHeight = getTerrainHeight(0, -50) + 5; // heightDifference < -0.8
  const r = mod(/** @type {any} */ (snowman), 1 / 60, pos, velocity, false, 0, lastTerrainHeight,
    0, 0, controls, 0, 0, 3, 3.0,
    getTerrainHeight, getTerrainGradient, getDownhillDirection, [], false, function () {},
    [], undefined, BUNNY_SKI);
  // The grounded path snaps pos.y to the terrain sampled at the PRE-step position
  // (x/z advance after the snap), so compare against that sample, not the new x/z.
  return { inAir: r.isInAir, groundedY: Math.abs(pos.y - getTerrainHeight(0, -50)) < 1e-9,
           playerJump: !!snowman.userData.playerJump };
}
const bunnyLipCoast = bunnyLipFrame(NONE);
const bunnyLipJump = bunnyLipFrame(JUMP);
const bunnySuppressionOk = bunnyHeldIdentical && !bunnyEverAir
  && !bunnyLipCoast.inAir && bunnyLipCoast.groundedY
  && !bunnyLipJump.inAir && bunnyLipJump.groundedY && !bunnyLipJump.playerJump;
console.log('\n--- Bunny jump suppression: held Jump ≡ no-input; lips never loft [GATING] ---');
console.log('  held-vs-none max abs diff:', bunnyMaxDiff.toExponential(3),
  '| steps:', bunnyNone.length, bunnyHeld.length, '| ever airborne:', bunnyEverAir);
console.log('  lip (no input): inAir', bunnyLipCoast.inAir, '| glued to terrain', bunnyLipCoast.groundedY);
console.log('  lip (Jump held): inAir', bunnyLipJump.inAir, '| glued to terrain', bunnyLipJump.groundedY,
  '| playerJump', bunnyLipJump.playerJump);
console.log('  PASS:', bunnySuppressionOk
  ? 'Bunny has no jump verb: press inert, lips grounded ✅'
  : 'a jump leaked onto Bunny ❌');
if (!bunnySuppressionOk) hardFail = true;

// 13) Scored obstacle clears: provenance + dedup + cap (JP-2, #245) [GATING].
// A *deliberate* jump sailing over a would-have-hit tree banks exactly ONE clear
// (many consecutive overlap frames dedup to one; CLEAR_SCORE banked once); the SAME
// flight without playerJump provenance (an auto-jump's air) banks nothing and its
// trajectory/velocity bytes are identical — clears must never touch physics. A pass
// over a dense row of obstacles caps at CLEAR_MAX_PER_AIR scored clears.
const PHYS = await import('../../src/snowman/physics.ts');
function clearFlight(playerJump, treeXs) {
  // A flat-terrain flight straight down -z THROUGH tree overlap columns, airborne
  // high above them (tree y=0, pos.y ≈ 12 > y+5, rising) so the suppression branch
  // fires on every overlap frame. Constant terrain isolates the collision layer.
  const gH = () => 0, gG = () => ({ x: 0, z: 0 }), gD = () => ({ x: 0, z: -1 });
  Math.random = makeRng(11);
  const snowman = fakeSnowman();
  snowman.userData.playerJump = playerJump;
  snowman.userData.clearsThisAir = 0;
  snowman.userData.clearedObstacles = {};
  const trees = treeXs.map((z) => ({ x: 0, y: 0, z }));
  const pos = { x: 0, z: 0, y: 12 };
  const velocity = { x: 0, z: -20 };
  // Launch rising hard (vv 20, airGravity 16 ⇒ rising for 1.25 s > the whole probe):
  // the tree suppression branch requires verticalVelocity > 0, so every obstacle
  // column must be crossed while still on the way up.
  let st = { isInAir: true, verticalVelocity: 20, lastTerrainHeight: 0,
             airTime: 0.2, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  let banked = 0, clearEvents = 0;
  const traj = [];
  for (let i = 0; i < 60; i++) {
    st = mod(/** @type {any} */ (snowman), 1 / 60, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, NONE,
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      gH, gG, gD, trees, false, function () {},
      [], (points) => { banked += points; });
    if (st.obstacleCleared) clearEvents++;
    traj.push({ x: pos.x, y: pos.y, z: pos.z, vx: velocity.x, vz: velocity.z });
  }
  return { banked, clearEvents, traj,
           clearsThisAir: snowman.userData.clearsThisAir };
}
// One tree at z=-10: the flight overlaps its 2.5 u radius for several frames.
const manualClear = clearFlight(true, [-10]);
const autoClear = clearFlight(false, [-10]);
let clearTrajDiff = 0;
for (let i = 0; i < Math.min(manualClear.traj.length, autoClear.traj.length); i++) {
  const a2 = manualClear.traj[i], b2 = autoClear.traj[i];
  clearTrajDiff = Math.max(clearTrajDiff, Math.abs(a2.x - b2.x), Math.abs(a2.y - b2.y),
    Math.abs(a2.z - b2.z), Math.abs(a2.vx - b2.vx), Math.abs(a2.vz - b2.vz));
}
// A dense row of 5 trees (all crossed while rising): dedup counts all 5, but only
// CLEAR_MAX_PER_AIR of them bank.
const denseClear = clearFlight(true, [-5, -7, -9, -11, -13]);
const clearsOk =
  manualClear.clearEvents === 1 && manualClear.banked === PHYS.CLEAR_SCORE &&
  manualClear.clearsThisAir === 1 &&
  autoClear.clearEvents === 0 && autoClear.banked === 0 &&
  clearTrajDiff < 1e-12 &&
  denseClear.banked === PHYS.CLEAR_MAX_PER_AIR * PHYS.CLEAR_SCORE &&
  denseClear.clearsThisAir === 5;
console.log('\n--- Scored obstacle clears: provenance, dedup, cap (JP-2) [GATING] ---');
console.log('  manual jump over 1 tree: events', manualClear.clearEvents,
  '| banked', manualClear.banked, '| clearsThisAir', manualClear.clearsThisAir);
console.log('  auto-jump same flight  : events', autoClear.clearEvents, '| banked', autoClear.banked,
  '| traj max abs diff vs manual:', clearTrajDiff.toExponential(3));
console.log('  dense row of 5 trees   : banked', denseClear.banked,
  `(cap ${PHYS.CLEAR_MAX_PER_AIR}×${PHYS.CLEAR_SCORE})`, '| clearsThisAir', denseClear.clearsThisAir);
console.log('  PASS:', clearsOk
  ? 'one scored clear per obstacle, provenance-gated, capped, physics untouched ✅'
  : 'clear scoring leaked / duplicated / uncapped ❌');
if (!clearsOk) hardFail = true;

// 14) Landing monotonicity (JP-4, §4.2) [GATING]. For the SAME touchdown velocity
// (equal airtime), a downslope landing must never grade WORSE than a flat landing —
// the surface falling away along travel absorbs the impact (vImpact = |v³·n| drops),
// which is the physical claim the impact-consistent grade makes. Single landing
// frames on constant slopes isolate the grade; playerJump pre-stamped.
function slopeLand(slope, vx, vz, vv, tuning, trickFlip = 0) {
  const gH = (x, z) => slope * z;
  const gG = () => ({ x: 0, z: slope });
  const gD = () => ({ x: 0, z: -1 });
  Math.random = makeRng(31);
  const snowman = fakeSnowman();
  snowman.userData.playerJump = true;
  if (trickFlip) snowman.userData.trickFlip = trickFlip;
  const pos = { x: 0, z: -60, y: gH(0, -60) - 0.01 }; // just below terrain => lands now
  const velocity = { x: vx, z: vz };
  const r = mod(/** @type {any} */ (snowman), 1 / 60, pos, velocity, true, vv, gH(0, -60),
    1.5, 0, NONE, 0, 0, 3, 3.0, gH, gG, gD, [], false, function () {},
    [], undefined, tuning);
  return { quality: r.landingQuality, airScore: r.airScoreDelta };
}
const GRADE_RANK = { wipeout: 0, sketchy: 1, ok: 2, clean: 3 };
// Three touchdown severities, each landed flat (slope 0) vs on a 27° downslope
// (slope 0.5), same velocity: the downslope grade must rank >= the flat grade.
const monoCases = [-15, -26, -34].map((vv) => ({
  vv,
  flat: slopeLand(0, 0, -16, vv, undefined),
  down: slopeLand(0.5, 0, -16, vv, undefined),
}));
const monotonicOk = monoCases.every((c) =>
  GRADE_RANK[c.down.quality] >= GRADE_RANK[c.flat.quality]);
// And the grade must actually SEPARATE somewhere (the vImpact term is live, not
// vacuously equal): the -26 m/s touchdown is clean on the downslope but not flat.
const separates = monoCases[1].down.quality === 'clean' && monoCases[1].flat.quality !== 'clean';
console.log('\n--- Landing monotonicity: downslope never grades worse than flat (JP-4) [GATING] ---');
for (const c of monoCases) {
  console.log(`  vv ${c.vv}: flat=${c.flat.quality} | 27° downslope=${c.down.quality}`);
}
console.log('  PASS:', monotonicOk && separates
  ? 'downslope >= flat at every severity, and the impact term separates grades ✅'
  : 'impact grading not monotonic with slope ❌');
if (!monotonicOk || !separates) hardFail = true;

// 15) Wipeout gate (JP-4) [GATING]. 'wipeout' must be UNREACHABLE when
// tuning.wipeouts is false (the Blue/Bunny/Black default), even at extreme impact
// or landing mid-somersault — those grade sketchy as before. With the flag on
// (Expert), the same landings are wipeouts and bank ZERO air score.
const EXPERT_SKI = (await import('../../src/difficulty.ts')).getDifficultyConfig('expert').ski;
const slamOff = slopeLand(0, 0, -16, -40, undefined);           // default (wipeouts false)
const slamOn = slopeLand(0, 0, -16, -40, EXPERT_SKI);           // Expert: extreme slam
const headOff = slopeLand(0, 0, -16, -10, undefined, 180);      // mid-somersault, flag off
const headOn = slopeLand(0, 0, -16, -10, EXPERT_SKI, 180);      // mid-somersault, Expert
const wipeoutGateOk =
  slamOff.quality === 'sketchy' && headOff.quality === 'sketchy' &&
  slamOn.quality === 'wipeout' && slamOn.airScore === 0 &&
  headOn.quality === 'wipeout' && headOn.airScore === 0;
console.log('\n--- Wipeout gate: unreachable without tuning.wipeouts; crash on Expert (JP-4) [GATING] ---');
console.log('  extreme slam  : default =', slamOff.quality, '| Expert =', slamOn.quality, `(airScore ${slamOn.airScore})`);
console.log('  mid-somersault: default =', headOff.quality, '| Expert =', headOn.quality, `(airScore ${headOn.airScore})`);
console.log('  PASS:', wipeoutGateOk
  ? 'wipeout gated to the flag; forced sketchy elsewhere; banks nothing ✅'
  : 'wipeout leaked past its gate ❌');
if (!wipeoutGateOk) hardFail = true;

console.log(`\nINVARIANT HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (safety invariant + technique gating checks hold)'}`);
process.exit(hardFail ? 1 : 0);
})();
