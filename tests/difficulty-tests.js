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
  check('four tiers in easy->hard order (bunny, blue, black, expert)',
    ids.length === 4 && ids[0] === 'bunny' && ids[1] === 'blue' && ids[2] === 'black'
    && ids[3] === 'expert');
  check('default tier is blue (the classic game)', D.DEFAULT_DIFFICULTY === 'blue');
  // Picker copy must not promise mechanics that aren't wired yet (labels-only stage):
  // no "avalanche"/"steep"/"dense" until the per-tier tuning PR makes them true.
  check('blurbs avoid promising unshipped mechanics',
    D.DIFFICULTIES.every((c) => !/avalanche|steep|dense/i.test(c.blurb)));
  check('storage key is snowgliderDifficulty', D.DIFFICULTY_STORAGE_KEY === 'snowgliderDifficulty');

  check('isDifficulty accepts known ids, rejects junk',
    D.isDifficulty('bunny') && D.isDifficulty('blue') && D.isDifficulty('black')
    && D.isDifficulty('expert')
    && !D.isDifficulty('rainbow') && !D.isDifficulty(null) && !D.isDifficulty(undefined));
  check('getDifficultyConfig resolves a known id',
    D.getDifficultyConfig('black').id === 'black');
  check('getDifficultyConfig falls back to the default tier on junk',
    D.getDifficultyConfig('nope').id === 'blue' && D.getDifficultyConfig(undefined).id === 'blue');

  // Persistence helpers operate on an injected Storage (so they're testable headlessly).
  /** A minimal but complete Storage (length/clear/key included) so it satisfies the
   *  `Storage` parameter type under tsconfig.tests.json's @ts-check. */
  const fakeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      clear: () => { m.clear(); },
      key: (i) => Array.from(m.keys())[i] ?? null,
      get length() { return m.size; },
    };
  };
  const store = fakeStorage();
  check('readStoredDifficulty defaults to blue on an empty store',
    D.readStoredDifficulty(store) === 'blue');
  D.storeDifficulty('black', store);
  check('storeDifficulty round-trips through readStoredDifficulty',
    D.readStoredDifficulty(store) === 'black'
    && store.getItem(D.DIFFICULTY_STORAGE_KEY) === 'black');
  store.setItem(D.DIFFICULTY_STORAGE_KEY, 'rainbow');
  check('readStoredDifficulty falls back to blue on a junk stored value',
    D.readStoredDifficulty(store) === 'blue');
  check('read/store are no-throw when storage is null (Node / private mode)',
    D.readStoredDifficulty(null) === 'blue' && (D.storeDifficulty('black', null), true));

  // resolveActiveDifficulty prefers a valid live pick, else storage, else default.
  const stored = fakeStorage();
  stored.setItem(D.DIFFICULTY_STORAGE_KEY, 'bunny');
  check('resolveActiveDifficulty uses a valid live pick over storage',
    D.resolveActiveDifficulty('black', stored) === 'black');
  check('resolveActiveDifficulty falls back to storage when the live pick is junk',
    D.resolveActiveDifficulty(undefined, stored) === 'bunny'
    && D.resolveActiveDifficulty('rainbow', stored) === 'bunny');
  check('resolveActiveDifficulty falls back to default with no pick + no storage',
    D.resolveActiveDifficulty(undefined, null) === 'blue');

  // runTierNeedsRebuild: the scene (corridor/gates/obstacles/avalanche) is baked from the
  // built tier, so a run needs a rebuild exactly when its tier differs — except under
  // automation, which must stay on one reload-free path.
  check('runTierNeedsRebuild: same tier needs no rebuild',
    D.runTierNeedsRebuild('black', 'black', false) === false);
  check('runTierNeedsRebuild: a different tier needs a rebuild',
    D.runTierNeedsRebuild('black', 'blue', false) === true);
  check('runTierNeedsRebuild: never rebuilds under automation (tests stay on one path)',
    D.runTierNeedsRebuild('black', 'blue', true) === false
    && D.runTierNeedsRebuild('black', 'black', true) === false);

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
  // The ski tuning is the frozen numeric constants plus the boolean feature flags:
  // freestyleTricks (#32), the per-tier jump availability pair manualJump/autoJump
  // (workstream A), and wipeouts (workstream C). On Blue: tricks off, both jumps ON,
  // wipeouts OFF — exactly today's shipped mechanics, so the default tier's kernel
  // path is unchanged.
  const flagKeys = ['freestyleTricks', 'manualJump', 'autoJump', 'wipeouts', 'lipLaunch'];
  check('BLUE_PHYSICS_TUNING matches the frozen physics constants verbatim',
    frozenKeys.every((k) => D.BLUE_PHYSICS_TUNING[k] === FROZEN[k])
    && D.BLUE_PHYSICS_TUNING.freestyleTricks === false
    && D.BLUE_PHYSICS_TUNING.manualJump === true
    && D.BLUE_PHYSICS_TUNING.autoJump === true
    && D.BLUE_PHYSICS_TUNING.wipeouts === false
    && D.BLUE_PHYSICS_TUNING.lipLaunch === false
    && Object.keys(D.BLUE_PHYSICS_TUNING).length === frozenKeys.length + flagKeys.length);

  // Every tier's ski tuning carries the full key set with finite numbers.
  check('every tier ski tuning has the full key set with finite numbers',
    D.DIFFICULTIES.every((c) =>
      frozenKeys.every((k) => typeof c.ski[k] === 'number' && Number.isFinite(c.ski[k]))
      && flagKeys.every((k) => typeof c.ski[k] === 'boolean')
      && Object.keys(c.ski).length === frozenKeys.length + flagKeys.length));

  // Per-tier jump availability (workstream A): Bunny has NO jump verb — Space/touch
  // does nothing and lips never auto-pop — while every other tier keeps today's full
  // jump mechanics. The unsupported manualJump:false + autoJump:true combination
  // (held Jump would suppress auto-pops and diverge from no-input) must never ship.
  check('Bunny has no jumps (manualJump and autoJump both false)',
    D.getDifficultyConfig('bunny').ski.manualJump === false
    && D.getDifficultyConfig('bunny').ski.autoJump === false);
  check('Blue/Black/Expert keep the full jump verbs (manualJump and autoJump true)',
    ['blue', 'black', 'expert'].every((t) =>
      D.getDifficultyConfig(t).ski.manualJump === true
      && D.getDifficultyConfig(t).ski.autoJump === true));
  check('no tier ships the unsupported manualJump:false + autoJump:true combination',
    D.DIFFICULTIES.every((c) => c.ski.manualJump || !c.ski.autoJump));

  // Wipeouts (workstream C): only Expert crashes on an extreme landing — every other
  // tier keeps the forgiving scrub, so their manual-jump landings never end a run.
  check('wipeouts are Expert-only (ski.wipeouts)',
    D.getDifficultyConfig('expert').ski.wipeouts === true
    && D.DIFFICULTIES.every((c) => c.id === 'expert' || c.ski.wipeouts === false));

  // Designed air (workstream E / JP-6): lip-geometry launches and sculpted kickers
  // are Expert-exclusive for now (adopted plan decision §10.4) — every other tier
  // keeps the frozen auto-jump constants and byte-identical terrain (no features).
  check('lipLaunch is Expert-only (ski.lipLaunch)',
    D.getDifficultyConfig('expert').ski.lipLaunch === true
    && D.DIFFICULTIES.every((c) => c.id === 'expert' || c.ski.lipLaunch === false));
  const expertFeatures = D.getDifficultyConfig('expert').features;
  check('Expert ships 3–5 well-formed, in-run kickers on the channel floor',
    Array.isArray(expertFeatures)
    && expertFeatures.length >= 3 && expertFeatures.length <= 5
    && expertFeatures.every((k) =>
      k.z < -30 && k.z > -185 // lips inside the run, clear of the start and finish
      && k.length > 0 && k.height > 0 && k.halfWidth > 0
      // the ramp spans at most the corridor channel floor, so off-kicker on-line
      // terrain stays the corridor's exact channel
      && k.halfWidth <= (D.getDifficultyConfig('expert').terrain?.channelHalfWidth ?? Infinity)));
  check('no other tier ships terrain features (byte-identical guardrail)',
    D.DIFFICULTIES.every((c) => c.id === 'expert' || c.features === undefined));

  // Freestyle tricks (#32) are the Expert tier's differentiator — and Expert-ONLY:
  // every other tier's kernel keeps the flag off so its air phase is unchanged.
  check('freestyle tricks are Expert-only (ski.freestyleTricks)',
    D.getDifficultyConfig('expert').ski.freestyleTricks === true
    && D.DIFFICULTIES.every((c) => c.id === 'expert' || c.ski.freestyleTricks === false));
  // Expert is "after Hard": Black's exact handling numbers, tricks unlocked on top.
  check('Expert ski tuning === Black handling (numbers verbatim) + the freestyle flag',
    frozenKeys.every((k) =>
      D.getDifficultyConfig('expert').ski[k] === D.getDifficultyConfig('black').ski[k]));

  check('ranked: only Blue is ranked for now (Bunny/Black/Expert unranked until floors measured)',
    D.getDifficultyConfig('blue').ranked === true
    && D.getDifficultyConfig('bunny').ranked === false
    && D.getDifficultyConfig('black').ranked === false
    && D.getDifficultyConfig('expert').ranked === false);

  console.log('--- Per-tier course line (the `line` block, fed to course-line.ts) ---');
  const lineKeys = ['curviness', 'amplitude', 'controlPoints'];
  check('every tier carries a well-formed line block (finite curviness/amplitude/controlPoints)',
    D.DIFFICULTIES.every((c) =>
      c.line && lineKeys.every((k) => typeof c.line[k] === 'number' && Number.isFinite(c.line[k]))));
  // Bunny + Blue MUST be straight (curviness 0 ⇒ laneX ≡ 0) — the byte-identical guarantee.
  check('Bunny and Blue are straight (curviness 0)',
    D.getDifficultyConfig('bunny').line.curviness === 0
    && D.getDifficultyConfig('blue').line.curviness === 0);
  // Black is the winding corridor: a non-trivial, bounded serpentine.
  const blackLine = D.getDifficultyConfig('black').line;
  check('Black winds (curviness > 0, amplitude > 0, controlPoints > 0)',
    blackLine.curviness > 0 && blackLine.amplitude > 0 && blackLine.controlPoints > 0);
  // Expert reuses Black's line difficulty, re-seeded so it is its own fixed course.
  const expertLine = D.getDifficultyConfig('expert').line;
  check('Expert winds like Black but on its own seed',
    expertLine.curviness === blackLine.curviness
    && expertLine.amplitude === blackLine.amplitude
    && expertLine.controlPoints === blackLine.controlPoints
    && D.getDifficultyConfig('expert').seed !== D.getDifficultyConfig('black').seed);

  // Terrain corridor (D3.2b): only Black banks the terrain into a channel; Bunny/Blue
  // carry NO corridor (terrain absent) so they build today's exact terrain.
  const blackTerrain = D.getDifficultyConfig('black').terrain;
  check('Black carries a well-formed terrain corridor (channelHalfWidth/wallRamp/wallHeight > 0)',
    blackTerrain && blackTerrain.channelHalfWidth > 0 && blackTerrain.wallRamp > 0 && blackTerrain.wallHeight > 0);
  check('Bunny and Blue carry no terrain corridor (straight ⇒ today\'s terrain)',
    D.getDifficultyConfig('bunny').terrain === undefined
    && D.getDifficultyConfig('blue').terrain === undefined);

  console.log('--- Per-tier avalanche (the `avalanche` block, fed to AvalancheSystem — D3.2d) ---');
  const avKeys = ['enabled', 'triggerDistance', 'boulderCount', 'slideSpeedBase', 'slideSpeedJitter'];
  check('every tier carries a well-formed avalanche block (all keys present, right types)',
    D.DIFFICULTIES.every((c) => c.avalanche
      && typeof c.avalanche.enabled === 'boolean'
      && avKeys.slice(1).every((k) => typeof c.avalanche[k] === 'number')));
  // Blue == today's shipped slide, VERBATIM — the byte-identical guardrail: 80 u trigger, 120
  // boulders, -(7 + rand*3) m/s. Any drift here changes the default tier's avalanche.
  const blueAv = D.getDifficultyConfig('blue').avalanche;
  check('Blue avalanche === BLUE_AVALANCHE (today\'s exact slide: 80 u / 120 / 7 / 3, enabled)',
    blueAv === D.BLUE_AVALANCHE
    && blueAv.enabled === true && blueAv.triggerDistance === 80 && blueAv.boulderCount === 120
    && blueAv.slideSpeedBase === 7 && blueAv.slideSpeedJitter === 3);
  // Bunny is OFF — the easy tier is a calm learning run (no slide arms).
  check('Bunny avalanche is disabled (enabled === false)',
    D.getDifficultyConfig('bunny').avalanche.enabled === false);
  // Black fires EARLIER (shorter trigger), FASTER (higher base speed), and HEAVIER (more
  // boulders) than Blue — validated as still winnable by the follow-the-line winnability gate.
  const blackAv = D.getDifficultyConfig('black').avalanche;
  check('Black avalanche is on, earlier + faster + heavier than Blue',
    blackAv.enabled === true
    && blackAv.triggerDistance < blueAv.triggerDistance
    && blackAv.slideSpeedBase > blueAv.slideSpeedBase
    && blackAv.boulderCount >= blueAv.boulderCount);
  // Expert keeps Black's slide (the tier after Hard is not an easier mountain).
  const expertAv = D.getDifficultyConfig('expert').avalanche;
  check('Expert avalanche matches Black\'s slide',
    expertAv.enabled === true
    && expertAv.triggerDistance === blackAv.triggerDistance
    && expertAv.boulderCount === blackAv.boulderCount
    && expertAv.slideSpeedBase === blackAv.slideSpeedBase
    && expertAv.slideSpeedJitter === blackAv.slideSpeedJitter);

  console.log('--- Per-tier scoring storage names (Blue == original, zero migration) ---');
  // The ACTIVE key is namespaced by physics/world version (#403 review); the
  // legacy unversioned key is retained read-only as the historical record.
  const PV = (await import('../src/run-context.ts')).PHYSICS_VERSION;
  check('localBestTimeKey: versioned base; Blue un-suffixed within it; others suffixed',
    D.localBestTimeKey('blue') === `snowgliderBestTime_v${PV}`
    && D.localBestTimeKey('bunny') === `snowgliderBestTime_v${PV}_bunny`
    && D.localBestTimeKey('black') === `snowgliderBestTime_v${PV}_black`
    && D.localBestTimeKey('expert') === `snowgliderBestTime_v${PV}_expert`);
  check('legacyBestTimeKey keeps the pre-versioning shapes (historical record)',
    D.legacyBestTimeKey('blue') === 'snowgliderBestTime'
    && D.legacyBestTimeKey('bunny') === 'snowgliderBestTime_bunny');
  check('leaderboardCollectionName: Blue == leaderboard; others are siblings',
    D.leaderboardCollectionName('blue') === 'leaderboard'
    && D.leaderboardCollectionName('bunny') === 'leaderboard_bunny'
    && D.leaderboardCollectionName('black') === 'leaderboard_black'
    && D.leaderboardCollectionName('expert') === 'leaderboard_expert');
  check('userBestTimeField: Blue == bestTime; others are dedicated fields',
    D.userBestTimeField('blue') === 'bestTime'
    && D.userBestTimeField('bunny') === 'bestTimeBunny'
    && D.userBestTimeField('black') === 'bestTimeBlack'
    && D.userBestTimeField('expert') === 'bestTimeExpert');

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
