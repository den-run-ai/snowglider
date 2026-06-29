// @ts-check
// winnability_harness.js
// Two-sided winnability gate for the avalanche — the property neither existing harness
// covers (forward_stress_harness.js gates termination/finishability of the descent;
// avalanche_framerate_harness.js gates the boulder kernel in isolation; NEITHER runs the
// real skiing physics against a live slide):
//
//   G3  the course is WINNABLE — driving the REAL Snowman physics down a hazard-cleared
//       fall line against the REAL avalanche, at least one seed reaches the finish without
//       being buried. Uses the real achievable skier speed, so a physics/balance change
//       that drops the player below the escape speed (course becomes UNwinnable) fails here.
//   G2  the slide is a REAL THREAT — a too-slow descent is buried before the finish, every
//       seed. A change that neuters the avalanche (so it can never catch anyone) fails here.
//
// Why G3 drives the real kernel instead of a fixed-speed point: a hard-coded "fast" speed
// can stay winnable on paper while the real player has slowed below the escape boundary
// (the deploy-gating `npm test` would still pass). The real top skiing speed is ~8.2 m/s.
// The avalanche boulder speed was tuned (avalanche.ts trigger(): -(7 + rand*3)) so a real
// skilled line reliably outruns it — before that, after the frame-rate physics fixes
// removed a low-FPS speed bonus, even a clean centered line was buried on most seeds
// (the player-reported regression; see the winnability follow-up issue). G3 therefore
// asserts the stronger property the tune guarantees: a skilled line escapes on EVERY seed.
// "Not guaranteed" still holds below the escape boundary — a genuinely slow line (G2) is
// always buried, and the boundary band (~4-5.5 m/s) is mixed (reported in the diagnostic).
//
// Course bounds are read from the SHIPPED constants (CourseModule._config /
// AVALANCHE_TRIGGER_DISTANCE), not hard-coded, so moving the finish or retuning the trigger
// re-points this gate at the real course automatically.
//
// Fixed dt = 1/60 so the per-frame point-in-sphere burial test can't tunnel (a coarse dt
// lets a fast player skip through a boulder between samples).
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/winnability_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + avalanche + terrain touch (no DOM/WebGL). document
// stays undefined so the avalanche powder-sprite pool is skipped (and its Math.random()
// calls with it), keeping every descent byte-deterministic from the seed alone.
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

const FIXED_DT = 1 / 60;     // fine step: conservative burial sampling, no tunneling
const MAX_TIME = 90;         // s of in-game time per descent (cap; a clean run finishes ~26 s)
// Boulder count + burial radius are NOT copied here — COUNT comes from the shipped
// AVALANCHE_BOULDER_COUNT, and burial is checked via the same arg-less checkBurial(pos)
// the live loop calls, so it inherits whatever default the game uses (Codex review).

// A heavily-braking / snowplowing player's speed, for the G2 threat check. Constant point
// (a real snowplow on this slope stalls before the slide ever triggers, so a fixed slow
// speed is the faithful "slow but still moving downhill" model). Buried on every seed with
// comfortable margin (the all-seeds-buried boundary sits ~4.25 m/s; the all-seeds-escape
// boundary ~5.5), so the slide stays a real threat to a genuinely slow line.
const SLOW_SPEED = 4.0;

const SEEDS = [12345, 777, 42, 9001, 31337, 1, 2, 3, 4, 5];

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Minimal stand-in for the snowman group the kernel mutates (mirrors forward_stress_harness).
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
  const THREE = await import('three');
  const { Snowman } = await import('../../src/snowman.ts');
  const { AvalancheSystem } = await import('../../src/avalanche.ts');
  const terrain = await import('../../src/mountains/terrain.ts');
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;
  // Course bounds + trigger distance from the SHIPPED source, so a balance change to the
  // course length or trigger re-points this gate automatically (Codex review).
  const { CourseModule } = await import('../../src/course.ts');
  const { AVALANCHE_TRIGGER_DISTANCE, AVALANCHE_BOULDER_COUNT } = await import('../../src/game/scene-setup.ts');
  const COUNT = AVALANCHE_BOULDER_COUNT;                 // shipped boulder count (single source of truth)
  // FINISH_Z here traces to the real finish trigger: course.ts derives it from
  // collision.ts FINISH_Z (the same constant the live run ends on), so moving the finish
  // re-points this gate at where players actually finish, not a stale copy.
  const { START_Z, FINISH_Z, COURSE_LENGTH } = CourseModule._config;
  const TRIGGER_Z = START_Z - AVALANCHE_TRIGGER_DISTANCE; // where distanceTraveled crosses the threshold

  function makeAvalanche(scene) {
    const av = new AvalancheSystem(scene, COUNT);
    av.setTerrainFunction(getTerrainHeight);
    return av;
  }

  // --- Real-physics descent vs. the real avalanche -------------------------------
  // Drives Snowman.updateSnowman down a hazard-cleared fall line (so the avalanche is the
  // only variable, mirroring G1's hazard-clear), triggering + advancing the real
  // AvalancheSystem exactly as main-loop.ts does, at fixed dt. `policy === 'center'` holds
  // Up and nudges back toward the fall line (the skilled straight-line player); 'up' is a
  // bare hold-Up coast. Returns the outcome + the real top speed reached.
  function runRealDescent(seed, policy) {
    Math.random = makeRng(seed);                 // one stream: auto-turn AND boulder spawn
    const _log = console.log; console.log = () => {};
    const scene = /** @type {any} */ ({ children: [], add() {}, remove() {}, userData: {} });
    const av = makeAvalanche(scene);
    const snowman = fakeSnowman();
    const pos = { x: 0, z: START_Z, y: getTerrainHeight(0, START_Z) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, START_Z),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };

    let triggered = false, lastAvZ = START_Z, buried = false, finished = false, t = 0, maxSpeed = 0, minDist = Infinity;
    const noop = () => {};
    while (t < MAX_TIME) {
      t += FIXED_DT;
      // Avalanche FIRST (trigger + advance), exactly as the live loop orders it: a slide
      // arms every AVALANCHE_TRIGGER_DISTANCE travelled from the last (re)arm point.
      if (!triggered && (lastAvZ - pos.z) > AVALANCHE_TRIGGER_DISTANCE) { av.trigger(snowman.position); triggered = true; }
      if (triggered) av.update(FIXED_DT);

      const controls = policy === 'center'
        ? { left: pos.x > 0.4, right: pos.x < -0.4, up: true, down: false, jump: false }
        : { left: false, right: false, up: true, down: false, jump: false };
      st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        [], true, noop, []);
      snowman.position.set(pos.x, pos.y, pos.z);

      const sp = Math.hypot(velocity.x, velocity.z); if (sp > maxSpeed) maxSpeed = sp;
      if (triggered) {
        if (av.checkBurial(snowman.position)) { buried = true; break; }   // arg-less = live default radius
        minDist = Math.min(minDist, av.getClosestDistance(snowman.position));
        // Surviving the slide does NOT end the run: the live loop only resets + re-arms
        // (a fresh slide can fire after another AVALANCHE_TRIGGER_DISTANCE), so keep going
        // and require an actual finish. This refuses a balance where the first slide merely
        // slips past without the skier proving they reach FINISH_Z under the repeated loop.
        if (av.hasPassed(snowman.position)) { av.reset(); triggered = false; lastAvZ = pos.z; }
      }
      if (pos.z <= FINISH_Z) { finished = true; break; }
    }
    av.dispose();
    console.log = _log;
    return { buried, finished, maxSpeed, minDist, z: pos.z };
  }

  // --- Constant-speed point vs. the real avalanche (G2 threat + boundary scan) ----
  function runConstantDescent(seed, speed) {
    Math.random = makeRng(seed);
    const _log = console.log; console.log = () => {};
    const scene = /** @type {any} */ ({ children: [], add() {}, remove() {}, userData: {} });
    const av = makeAvalanche(scene);
    const player = { x: 0, y: getTerrainHeight(0, TRIGGER_Z), z: TRIGGER_Z };
    av.trigger(player);                                   // first slide fires at the trigger line
    console.log = _log;

    let triggered = true, lastAvZ = TRIGGER_Z, buried = false, finished = false, t = 0;
    while (t < MAX_TIME) {
      if (!triggered && (lastAvZ - player.z) > AVALANCHE_TRIGGER_DISTANCE) { av.trigger(player); triggered = true; }
      if (triggered) av.update(FIXED_DT);
      player.z -= speed * FIXED_DT;
      player.y = getTerrainHeight(player.x, player.z);
      if (triggered) {
        if (av.checkBurial(player)) { buried = true; break; }            // arg-less = live default radius
        // Mirror the live loop: surviving a slide only resets + re-arms; keep going until
        // an actual finish so a re-triggered slide still gets its chance.
        if (av.hasPassed(player)) { av.reset(); triggered = false; lastAvZ = player.z; }
      }
      if (player.z <= FINISH_Z) { finished = true; break; }
      t += FIXED_DT;
    }
    av.dispose();
    return { buried, finished };
  }

  // --- Gate runner ---------------------------------------------------------------
  let failed = 0;
  function gate(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '✅' : '❌'}  ${detail}`);
    if (!ok) failed++;
  }

  console.log('=== Winnability: real skiing physics vs. the real avalanche ===');
  console.log(`dt = 1/60 | start z = ${START_Z} | trigger z = ${TRIGGER_Z} (dist ${AVALANCHE_TRIGGER_DISTANCE}) | finish z = ${FINISH_Z} | course ${COURSE_LENGTH} m | seeds = ${SEEDS.length}`);

  // G3: real physics descent vs. real avalanche.
  const real = SEEDS.map(s => runRealDescent(s, 'center'));
  const escapes = real.filter(r => r.finished && !r.buried).length;
  const realTop = Math.max(...real.map(r => r.maxSpeed));

  console.log('\n--- G3: the course is winnable with the real skier (hazard-cleared) [GATING] ---');
  gate('a real skilled (centered, full-speed) line reaches the finish without burial, every seed',
    escapes === SEEDS.length,
    `escaped ${escapes}/${SEEDS.length} seeds | real top speed ${realTop.toFixed(2)} m/s`);

  // G2: a too-slow line is buried, every seed.
  const slow = SEEDS.map(s => runConstantDescent(s, SLOW_SPEED));
  console.log('\n--- G2: a too-slow line is buried (the slide is a real threat) [GATING] ---');
  gate(`a ${SLOW_SPEED} m/s descent is buried before finishing, every seed`,
    slow.every(r => r.buried && !r.finished),
    `buried ${slow.filter(r => r.buried).length}/${SEEDS.length}`);

  // Diagnostic: the constant-speed escape boundary, for context on the margin.
  let boundary = null;
  for (let v = 5.0; v <= 12.0; v += 0.5) {
    if (SEEDS.every(s => { const r = runConstantDescent(s, v); return r.finished && !r.buried; })) { boundary = v; break; }
  }
  console.log('\n--- Margin [DIAGNOSTIC, not gated] ---');
  console.log(`  constant-speed all-seeds escape boundary: ${boundary ? boundary.toFixed(1) + ' m/s' : '>12 m/s'} | real top speed: ${realTop.toFixed(2)} m/s`);

  console.log(`\nWINNABILITY HARNESS: ${failed ? 'FAIL ❌' : 'OK ✅ (winnable with the real skier; lethal when slow)'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
