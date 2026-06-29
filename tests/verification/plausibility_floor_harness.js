// @ts-check
// plausibility_floor_harness.js
// Measures the leaderboard *plausibility floor* empirically — replacing the guessed
// MIN_VALID_SCORE_TIME = 4 placeholder with a number derived from the SHIPPED physics —
// and answers issue #229's open question ("is a ~14 s record plausible?") with data, along
// the two distinct axes the follow-up plan calls out:
//
//   * ENGINE-ACHIEVABILITY — can the shipped Snowman kernel produce a given finish time at
//     all? This is the right oracle for an integrity floor (reject what the engine cannot
//     produce). Measured here as the *jump-optimal* line: chain clean manual-jump landings
//     to stack the compounding clean-landing boost (physics.ts JUMP_BOOST_*), the engine's
//     fastest possible descent.
//   * REAL-WORLD REALISM — could a real skier hit it? The cruise model is already roughly
//     realistic for the ~7° sustained pitch; the one unrealistic mechanic is the clean-
//     landing boost, which has NO cumulative cap, so repeated clean airs ratchet speed
//     arbitrarily above the gravity-justified terminal. The *one-jump* line (a single
//     boost, no ratchet) is the realistic fast line; comparing it to jump-optimal exposes
//     the ratchet as RATCHET_RATIO = oneJump / jumpOptimal.
//
// Three bounds per seed, all driving the REAL Snowman.updateSnowman over the REAL terrain
// down a hazard-cleared fall line at fixed dt = 1/60 (no DOM/WebGL):
//   noJump      — hold-forward, never jump            -> the slow bound (gravity terminal)
//   oneJump     — exactly one clean manual jump       -> a realistic fast line
//   jumpOptimal — chain clean manual jumps (ratchet)  -> the engine-fastest time
//
// Terrain is DETERMINISTIC: getTerrainHeight(x, z) is a closed-form function with no seed.
// Seeds vary only hazard placement + the avalanche RNG and the no-input auto-turn stream —
// NOT steepness. This harness runs hazard-free, so the only per-seed variation is the
// auto-turn RNG on frames with no steering input; the speed/time basis is otherwise fixed.
// (Per-seed output is kept for parity with winnability_harness.js and to surface any
// auto-turn sensitivity.)
//
// Bounds are read from the SHIPPED constants (CourseModule._config for course geometry,
// physics.ts JUMP_BOOST_* / LANDING_CLEAN_ALIGN for the boost tunables) — no hard-coded
// -195 / 180 / speed literals — so moving the finish or retuning the boost re-points this
// gate at the real course automatically.
//
// No wall-clock assertion: the only "assertion" is that every measured line finishes within
// the in-game time cap (a deterministic property at fixed dt), so this can sit in the
// deploy-gating `npm test` without flaking on render delta.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/plausibility_floor_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + terrain touch (no DOM/WebGL). document stays
// undefined so nothing pulls in sprite pools; keeps each descent deterministic from the seed.
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

const FIXED_DT = 1 / 60;     // fine step: deterministic, matches the physics-invariant basis
const MAX_TIME = 120;        // s of in-game time per descent (cap; a clean run finishes ~22-26 s)

const SEEDS = [12345, 777, 42, 9001, 31337, 1, 2, 3, 4, 5];

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Minimal stand-in for the snowman group the kernel mutates (mirrors winnability_harness).
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
  const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;
  const { CourseModule } = await import('../../src/course.ts');
  // Jump-boost tunables from the single source (physics.ts) — reported, not copied.
  const { JUMP_BOOST_CAP, JUMP_BOOST_PER_SEC, LANDING_CLEAN_ALIGN } = await import('../../src/snowman/physics.ts');
  // Course geometry derives from collision.ts FINISH_Z via course.ts (single source).
  const { START_Z, FINISH_Z, COURSE_LENGTH } = CourseModule._config;

  // Drive the real kernel down a hazard-cleared fall line. `mode`:
  //   'none'   — never jump (slow bound)
  //   'single' — one clean manual jump (realistic fast line)
  //   'chain'  — jump on every grounded off-cooldown centered frame (engine-fastest ratchet)
  // Jumps fire only while centered (|x| < CENTER_TOL) and not steering, so they read as
  // straight, well-aligned (CLEAN) jumps rather than speed-scrubbing hop turns; off-center
  // frames steer back toward the fall line instead. Returns finish time + diagnostics.
  function measureLine(seed, mode) {
    Math.random = makeRng(seed);
    const snowman = fakeSnowman();
    const pos = { x: 0, z: START_Z, y: getTerrainHeight(0, START_Z) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(0, START_Z),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const noop = () => {};
    const CENTER_TOL = 0.5;
    let t = 0, maxSpeed = 0, finished = false, cleanLandings = 0, jumps = 0, jumpedOnce = false;

    while (t < MAX_TIME) {
      t += FIXED_DT;
      const grounded = !st.isInAir;
      const offCooldown = st.jumpCooldown <= 0;
      const centered = Math.abs(pos.x) < CENTER_TOL;
      let wantJump = false;
      if (mode !== 'none' && grounded && offCooldown && centered) {
        if (mode === 'chain') wantJump = true;
        else if (mode === 'single' && !jumpedOnce) wantJump = true;
      }
      // Jump (straight, no steer) OR steer back to the fall line — never both, so a jump
      // is never turned into a hop turn.
      const controls = wantJump
        ? { left: false, right: false, up: true, down: false, jump: true }
        : { left: pos.x > 0.4, right: pos.x < -0.4, up: true, down: false, jump: false };
      if (wantJump) { jumpedOnce = true; jumps++; }

      st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        [], true, noop, []);
      snowman.position.set(pos.x, pos.y, pos.z);

      if (st.landingQuality === 'clean') cleanLandings++;
      const sp = Math.hypot(velocity.x, velocity.z); if (sp > maxSpeed) maxSpeed = sp;
      if (pos.z <= FINISH_Z) { finished = true; break; }
    }
    return { time: finished ? t : Infinity, finished, maxSpeed, cleanLandings, jumps };
  }

  console.log('=== Plausibility floor: real skiing physics over the real course ===');
  console.log(`dt = 1/60 | start z = ${START_Z} | finish z = ${FINISH_Z} | course ${COURSE_LENGTH} m | seeds = ${SEEDS.length}`);
  console.log(`jump-boost tunables (physics.ts): JUMP_BOOST_CAP=${JUMP_BOOST_CAP} JUMP_BOOST_PER_SEC=${JUMP_BOOST_PER_SEC} LANDING_CLEAN_ALIGN=${LANDING_CLEAN_ALIGN}`);
  console.log('terrain is DETERMINISTIC (closed-form, no seed); per-seed variation is the no-input auto-turn RNG only — hazards are cleared here.\n');

  const rows = SEEDS.map(seed => {
    const noJump = measureLine(seed, 'none');
    const oneJump = measureLine(seed, 'single');
    const jumpOptimal = measureLine(seed, 'chain');
    return { seed, noJump, oneJump, jumpOptimal };
  });

  console.log('  seed       noJump   oneJump   jumpOptimal   (jumpOptimal clean/total)   ratchet');
  for (const r of rows) {
    const ratchet = (r.oneJump.time / r.jumpOptimal.time);
    const f = x => (Number.isFinite(x.time) ? x.time.toFixed(2) + 's' : 'DNF').padStart(8);
    console.log(`  ${String(r.seed).padStart(8)}  ${f(r.noJump)}  ${f(r.oneJump)}  ${f(r.jumpOptimal).padStart(12)}     ${String(r.jumpOptimal.cleanLandings)}/${String(r.jumpOptimal.jumps)}`.padEnd(78) + `   ${ratchet.toFixed(2)}x`);
  }

  const fin = rows.flatMap(r => [r.noJump, r.oneJump, r.jumpOptimal]);
  const allFinished = fin.every(x => x.finished);

  const min = sel => Math.min(...rows.map(sel));
  const max = sel => Math.max(...rows.map(sel));
  const avg = sel => rows.reduce((a, r) => a + sel(r), 0) / rows.length;

  const minNoJump = min(r => r.noJump.time);
  const minOneJump = min(r => r.oneJump.time);
  const minJumpOptimal = min(r => r.jumpOptimal.time);
  // RATCHET_RATIO > 1 would mean chaining jumps is FASTER than a single jump (the
  // compounding-boost exploit the plan hypothesised). < 1 means jumping is net-slower.
  const ratchetRatio = avg(r => r.oneJump.time / r.jumpOptimal.time);

  // The engine-fastest descent across EVERY measured line/seed — the integrity oracle.
  const engineFastest = Math.min(minNoJump, minOneJump, minJumpOptimal);
  // The fastest top speed any line reached (the friction-capped terminal). You physically
  // cannot cross COURSE_LENGTH faster than COURSE_LENGTH / topSpeed, so this is the hard
  // theoretical lower bound on any honest finish time.
  const maxTopSpeed = Math.max(
    max(r => r.noJump.maxSpeed), max(r => r.oneJump.maxSpeed), max(r => r.jumpOptimal.maxSpeed));
  const theoreticalMin = COURSE_LENGTH / maxTopSpeed;

  // Integrity floor: sit BELOW the hard theoretical minimum (so a legitimate engine run can
  // never be rejected) yet far ABOVE any forged sub-physics time. A 15% margin under the
  // theoretical minimum, floored to a whole second.
  const recommendedFloor = Math.max(1, Math.floor(theoreticalMin * 0.85));

  console.log('\n--- Summary ---');
  console.log(`  noJump (slow bound)            min ${minNoJump.toFixed(2)}s  avg ${avg(r => r.noJump.time).toFixed(2)}s`);
  console.log(`  oneJump (one clean jump)       min ${minOneJump.toFixed(2)}s  avg ${avg(r => r.oneJump.time).toFixed(2)}s`);
  console.log(`  jumpOptimal (chained jumps)    min ${minJumpOptimal.toFixed(2)}s  avg ${avg(r => r.jumpOptimal.time).toFixed(2)}s`);
  console.log(`  engine-FASTEST (min all lines) ${engineFastest.toFixed(2)}s`);
  console.log(`  max top speed (any line)       ${maxTopSpeed.toFixed(2)} m/s -> theoretical min finish ${theoreticalMin.toFixed(2)}s (= ${COURSE_LENGTH} m / top speed)`);
  console.log(`  RATCHET_RATIO (oneJump/jumpOptimal, avg) = ${ratchetRatio.toFixed(2)}x  ${ratchetRatio >= 1.3 ? '(RATCHET present — chained boosts FASTER)' : '(NO ratchet — chaining jumps is net-SLOWER, jumping wastes airtime it never recovers)'}`);
  console.log(`  RECOMMENDED engine-achievability FLOOR = ${recommendedFloor} s  (15% under the ${theoreticalMin.toFixed(2)}s theoretical minimum)`);
  console.log('\n  Classification (issue #229 item 2):');
  if (ratchetRatio >= 1.3) {
    console.log('   * RATCHET present: the engine reaches fast times only by stacking the uncapped clean-landing boost (no real-ski analogue)');
    console.log('     -> EXPLOIT/UNREALISTIC: cap the cumulative boost (PR B), then set the floor under the capped terminal (PR C).');
  } else {
    console.log('   * NO ratchet: chaining jumps does NOT beat a clean cruise — the shipped engine cannot produce a sub-cruise time.');
    console.log(`     A record well below the engine-fastest (~${engineFastest.toFixed(0)}s) is therefore FORGED, not engine-reachable.`);
    console.log(`     -> Raise MIN_VALID_SCORE_TIME to ~${recommendedFloor}s and purge sub-floor entries (PR C). No PR B needed.`);
  }

  const ok = allFinished;
  console.log(`\nPLAUSIBILITY FLOOR HARNESS: ${ok ? 'OK ✅ (all lines finish; floor measured)' : 'FAIL ❌ (a measured line did not finish within the time cap)'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
