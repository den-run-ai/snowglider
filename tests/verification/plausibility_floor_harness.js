// @ts-check
// Measure every tier using the SAME corridor/kicker controller as winnability G5.
// These are sampled, hazard-cleared engine runs, not a proof of the fastest possible
// input sequence or a real-player success rate. Keep unmeasured tiers unranked.
const { pathToFileURL } = require('url');
const path = require('path');
const g = /** @type {any} */ (globalThis);
g.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
g.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const { ENSEMBLE_SEEDS, runTierDescent, summarizeTimes } = await import('../helpers/tier-descent.mjs');
  const { DIFFICULTIES } = await import('../../src/difficulty.ts');
  const { CourseModule } = await import('../../src/course.ts');
  const { FIXED_DT } = await import('../../src/game/main-loop.ts');
  const { MIN_VALID_SCORE_TIME } = await import('../../src/score-limits.ts');
  const { JUMP_BOOST_CAP, JUMP_BOOST_PER_SEC, LANDING_CLEAN_ALIGN } = await import('../../src/snowman/physics.ts');

  console.log('=== Per-tier finish distributions and plausibility-floor evidence ===');
  console.log(`dt ${FIXED_DT} | course ${CourseModule._config.COURSE_LENGTH} m | ${ENSEMBLE_SEEDS.length} predetermined seeds per tier/policy`);
  console.log(`jump tunables: cap=${JUMP_BOOST_CAP}, perSec=${JUMP_BOOST_PER_SEC}, cleanAlign=${LANDING_CLEAN_ALIGN}`);
  console.log('Real tier tuning, seeded corridor and kickers; trees/rocks/avalanche cleared. No tier ranking is changed.');
  console.log('  tier    policy  finish   min/median/p95/max (seconds)       top speed');
  let failed = 0;
  for (const config of DIFFICULTIES) {
    const measured = [];
    for (const mode of ['none', 'single', 'chain']) {
      const runs = ENSEMBLE_SEEDS.map(seed => runTierDescent(seed, config.id, { mode, withAvalanche: false }));
      const times = summarizeTimes(runs);
      const top = Math.max(...runs.map(r => r.maxSpeed));
      measured.push(...runs);
      const distribution = [times.min, times.median, times.p95, times.max]
        .map(t => Number.isFinite(t) ? t.toFixed(2) : 'DNF').join('/');
      console.log(`  ${config.id.padEnd(7)} ${mode.padEnd(6)} ${String(times.count).padStart(2)}/${ENSEMBLE_SEEDS.length}    ${distribution.padEnd(34)} ${top.toFixed(2)} m/s`);
      // G5's no-manual-jump line must remain finishable on the larger seed ensemble.
      // Single/chained jump policies may wipe out on Expert: report DNFs, never hide
      // failed runs inside a percentile or mislabel this controller as jump-optimal.
      if (mode === 'none' && times.count !== ENSEMBLE_SEEDS.length) failed++;
      if (!runs.every(r => Number.isFinite(r.maxSpeed) && Number.isFinite(r.z))) failed++;
    }
    const finishes = measured.filter(r => r.finished && !r.buried);
    const fastest = Math.min(...finishes.map(r => r.time));
    const maxObservedSpeed = Math.max(...measured.map(r => r.maxSpeed));
    const speedEquivalent = CourseModule._config.COURSE_LENGTH / maxObservedSpeed;
    // This is a conservative STARTING CANDIDATE relative to observed speed, not
    // a mathematically safe bound: an untested policy may exceed that speed.
    const candidate = Math.max(1, Math.floor(speedEquivalent * 0.85));
    const rejected = finishes.filter(r => r.time < MIN_VALID_SCORE_TIME).length;
    console.log(`    ${config.id}: fastest sampled ${fastest.toFixed(2)}s | distance / observed peak ${speedEquivalent.toFixed(2)}s | review candidate ${candidate}s`);
    console.log(`    configured floor ${config.minScoreTime}s (${config.ranked ? 'ranked' : 'practice'}); shared server floor ${MIN_VALID_SCORE_TIME}s would reject ${rejected}/${finishes.length} measured finishes`);
    // A currently ranked floor must at least accept every honest sampled finish.
    if (config.ranked && finishes.some(r => r.time < config.minScoreTime || r.time < MIN_VALID_SCORE_TIME)) failed++;
  }
  console.log('\nLimits: fixed canonical tier terrain, 60 gameplay seeds, one corridor-following controller, three jump policies; hazards cleared.');
  console.log('A sampled maximum speed is NOT a proven speed cap. Faster untested lines are not evidence of forgery.');
  console.log('Ranking additionally needs tier-aware client/server floors, server-rule tests/deployment, avalanche G5, and actual-player validation.');
  console.log(`\nPLAUSIBILITY FLOOR HARNESS: ${failed ? 'FAIL' : 'OK'} (${failed} failed gates; measurements do not enable ranked tiers)`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
