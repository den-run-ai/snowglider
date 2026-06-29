// @ts-check
// difficulty-tests.js — guards the difficulty config spine (src/difficulty.ts) and
// the kernel tuning API extracted from src/snowman/physics.ts.
//
// Two things must hold for the first difficulty-tiers stage:
//   1. The config spine is well-formed and Blue is authoritative-current — Blue's ski
//      tuning is BLUE_PHYSICS_TUNING verbatim, and BLUE_PHYSICS_TUNING equals the
//      frozen physics constants (a guard against accidental edits to the default tier).
//   2. The tuning param is wired end-to-end and BACKWARD-COMPATIBLE: omitting it (or
//      passing BLUE_PHYSICS_TUNING) yields a byte-identical trajectory, while passing a
//      different tier (Black, lower friction) actually changes the descent — proving the
//      param is live, not dead code.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/difficulty-tests.js

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  PASS ✅: ${name}`); passed++; }
  else { console.log(`  FAIL ❌: ${name}`); failed++; }
}

// --- Shared constant-slope terrain (mirrors the invariant harness's simulateSlope) ---
const SLOPE = 0.35;
const gH = (x, z) => SLOPE * z;
const gG = () => ({ x: 0, z: SLOPE });
const gD = () => ({ x: 0, z: -1 });

function fakeSnowman() {
  const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  const ls = ski(), rs = ski();
  return {
    position: { set() {} },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: {
      targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
      leftSki: ls, rightSki: rs, leftSkiBaseX: -1, rightSkiBaseX: 1
    }
  };
}

// Drive a tuck descent (Up held) so friction differences between tiers show up.
// Returns the full trajectory and the final speed.
function descend(updateFn, tuning, { steps = 120, dt = 1 / 60 } = {}) {
  // Deterministic auto-turn RNG (not exercised here — Up is held so steering is on),
  // but seed it anyway so the run is reproducible.
  let s = 7 >>> 0;
  Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const snowman = fakeSnowman();
  const pos = { x: 0, z: 0, y: gH(0, 0) };
  const velocity = { x: 0, z: -8 };
  const controls = { left: false, right: false, up: true, down: false, jump: false };
  let st = {
    isInAir: false, verticalVelocity: 0, lastTerrainHeight: gH(0, 0),
    airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3
  };
  const traj = [];
  for (let i = 0; i < steps; i++) {
    st = updateFn(
      snowman, dt, pos, velocity, st.isInAir, st.verticalVelocity,
      st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls,
      st.turnPhase, st.currentTurnDirection, st.turnChangeCooldown, 3.0,
      gH, gG, gD, [], false, function () {}, [], undefined, tuning
    );
    traj.push({ x: pos.x, z: pos.z, vx: velocity.x, vz: velocity.z });
  }
  const last = traj[traj.length - 1];
  return { traj, finalSpeed: Math.sqrt(last.vx * last.vx + last.vz * last.vz) };
}

function maxTrajDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    m = Math.max(m, Math.abs(a[i].x - b[i].x), Math.abs(a[i].z - b[i].z),
      Math.abs(a[i].vx - b[i].vx), Math.abs(a[i].vz - b[i].vz));
  }
  return m;
}

(async () => {
  await import('../tests/loaders/register-ts-resolve.mjs').catch(() => {});
  const D = await import('../src/difficulty.ts');
  const { MIN_VALID_SCORE_TIME } = await import('../src/score-limits.ts');
  const { Snowman } = await import('../src/snowman.ts');
  const update = Snowman.updateSnowman;

  // updateSnowman's collision/finish path reads window.* (test-hook + debug-log
  // seams); provide the same minimal stub the invariant harness uses headlessly.
  const g = /** @type {any} */ (globalThis);
  g.window = g.window || { location: { search: '' } };

  console.log('--- Config spine integrity ---');
  const ids = D.DIFFICULTIES.map((c) => c.id);
  check('three tiers in easy->hard order (bunny, blue, black)',
    ids.length === 3 && ids[0] === 'bunny' && ids[1] === 'blue' && ids[2] === 'black');
  check('default tier is blue (the classic game)', D.DEFAULT_DIFFICULTY === 'blue');
  // Picker copy must not promise mechanics that aren't wired yet (labels-only stage):
  // no "avalanche"/"steep"/"dense" until the per-tier tuning PR makes them true.
  check('blurbs avoid promising unshipped mechanics',
    D.DIFFICULTIES.every((c) => !/avalanche|steep|dense/i.test(c.blurb)));
  check('storage key is snowgliderDifficulty', D.DIFFICULTY_STORAGE_KEY === 'snowgliderDifficulty');

  check('isDifficulty accepts known ids, rejects junk',
    D.isDifficulty('bunny') && D.isDifficulty('blue') && D.isDifficulty('black')
    && !D.isDifficulty('expert') && !D.isDifficulty(null) && !D.isDifficulty(undefined));
  check('getDifficultyConfig resolves a known id',
    D.getDifficultyConfig('black').id === 'black');
  check('getDifficultyConfig falls back to the default tier on junk',
    D.getDifficultyConfig('nope').id === 'blue' && D.getDifficultyConfig(undefined).id === 'blue');

  // Persistence helpers operate on an injected Storage (so they're testable headlessly).
  const fakeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  };
  const store = fakeStorage();
  check('readStoredDifficulty defaults to blue on an empty store',
    D.readStoredDifficulty(store) === 'blue');
  D.storeDifficulty('black', store);
  check('storeDifficulty round-trips through readStoredDifficulty',
    D.readStoredDifficulty(store) === 'black'
    && store.getItem(D.DIFFICULTY_STORAGE_KEY) === 'black');
  store.setItem(D.DIFFICULTY_STORAGE_KEY, 'expert');
  check('readStoredDifficulty falls back to blue on a junk stored value',
    D.readStoredDifficulty(store) === 'blue');
  check('read/store are no-throw when storage is null (Node / private mode)',
    D.readStoredDifficulty(null) === 'blue' && (D.storeDifficulty('black', null), true));

  const blue = D.getDifficultyConfig('blue');
  check('Blue is authoritative-current: blue.ski === BLUE_PHYSICS_TUNING',
    blue.ski === D.BLUE_PHYSICS_TUNING);
  check('Blue floor == the measured shipped floor (score-limits.ts)',
    blue.minScoreTime === MIN_VALID_SCORE_TIME);

  // Guard the frozen Blue constants against accidental edits.
  const FROZEN = {
    gravity: 9.8, airGravity: 16, baseFriction: 0.012, frictionRamp: 0.020,
    gripBase: 0.6, carveLock: 0.6, carveBuild: 1.5, carveRelease: 3.0,
    parallelTurnForce: 19.0, carveTurnForce: 10.0, tuckAccel: 10.0,
    plowDecelLight: 3.14, plowDecelFull: 5.68, skidScrubMax: 0.10, airControl: 5.0,
  };
  const frozenKeys = Object.keys(FROZEN);
  check('BLUE_PHYSICS_TUNING matches the frozen physics constants verbatim',
    frozenKeys.every((k) => D.BLUE_PHYSICS_TUNING[k] === FROZEN[k])
    && Object.keys(D.BLUE_PHYSICS_TUNING).length === frozenKeys.length);

  // Every tier's ski tuning carries the full key set with finite numbers.
  check('every tier ski tuning has the full key set with finite numbers',
    D.DIFFICULTIES.every((c) =>
      frozenKeys.every((k) => typeof c.ski[k] === 'number' && Number.isFinite(c.ski[k]))
      && Object.keys(c.ski).length === frozenKeys.length));

  console.log('--- Kernel tuning API: backward compatibility ---');
  const omitted = descend(update, undefined);
  const explicitBlue = descend(update, D.BLUE_PHYSICS_TUNING);
  check('omitting tuning == passing BLUE_PHYSICS_TUNING (byte-identical)',
    maxTrajDiff(omitted.traj, explicitBlue.traj) === 0);

  console.log('--- Kernel tuning API: the param is live ---');
  const black = descend(update, D.getDifficultyConfig('black').ski);
  const bunny = descend(update, D.getDifficultyConfig('bunny').ski);
  // Black has lower friction than Blue, so a tuck descent ends faster; Bunny has
  // higher friction, so it ends slower. If the param were ignored all three would
  // match Blue, so any ordering proves the tuning actually reaches the kernel.
  check('Black tuning (lower friction) ends faster than Blue',
    black.finalSpeed > explicitBlue.finalSpeed + 1e-6);
  check('Bunny tuning (higher friction) ends slower than Blue',
    bunny.finalSpeed < explicitBlue.finalSpeed - 1e-6);

  console.log(`\n================================================`);
  console.log(`Difficulty tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
