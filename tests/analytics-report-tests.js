// @ts-check
// Current-version analytics must count V3 finishes (including Expert), ignore
// historical bests, and preserve the report's private-email exclusion.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Analytics unit tests must not access the network'); };
  try {
    const { readTiers, buildInsights } = await import('../scripts/analytics-report.mjs');
    const D = await import('../src/difficulty.ts');
    const { PHYSICS_VERSION } = await import('../src/run-context.ts');
    const { MIN_VALID_SCORE_TIME, MAX_VALID_SCORE_TIME } = await import('../src/score-limits.ts');
    const tiers = readTiers();
    assert.deepEqual(tiers, D.DIFFICULTIES.map(({ id, ranked }) => ({
      id, ranked, field: D.userBestTimeField(id), collection: D.leaderboardCollectionName(id),
    })), 'every configured tier must use the current client schema');
    assert(tiers.some(t => t.id === 'expert'), 'Expert must be included');

    const users = [
      { id: 'current', displayName: 'Current', email: 'private-current@example.test',
        bestTime: 18, [D.userBestTimeField('blue')]: 25 },
      { id: 'expert', displayName: 'Expert', email: 'private-expert@example.test',
        [D.userBestTimeField('expert')]: 30 },
      { id: 'historical', displayName: 'Historical', email: 'private-old@example.test',
        bestTime: 19, bestTimeExpert: 20 },
    ];
    const board = [{ user: 'users/current', time: 25, tier: 'blue', achievedAt: '2026-09-08T00:00:00Z' }];
    const insights = buildInsights(users, board, Date.parse('2026-09-08'), tiers,
      { min: MIN_VALID_SCORE_TIME, max: MAX_VALID_SCORE_TIME });
    assert.equal(insights.kpis.completedRun, 2, 'current Blue and Expert finishes count; historical-only does not');
    assert.equal(insights.kpis.medianBestTime, 27.5, 'the faster historical Blue best cannot shadow V3');
    assert.equal(insights.health.staleBoard, 0, 'V3 board rows compare against V3 user fields');
    assert.equal(insights.health.completedNotOnBoard, 0, 'Expert-only unranked finish needs no global board');
    assert.equal(insights.players.find(u => u.id === 'historical').bestTime, null);
    assert(!JSON.stringify(insights).includes('@example.test'), 'private emails stay out of exports');

    // A future bump and ranked flip must change the read plan automatically.
    // Malformed configuration must fail visibly, never fall back to old boards.
    const temp = mkdtempSync(join(tmpdir(), 'snowglider-analytics-schema-'));
    try {
      mkdirSync(join(temp, 'src'));
      const source = readFileSync(join(__dirname, '..', 'src', 'difficulty.ts'), 'utf8');
      writeFileSync(join(temp, 'src', 'difficulty.ts'), source.replace('ranked: false', 'ranked: true'));
      writeFileSync(join(temp, 'src', 'run-context.ts'), `export const PHYSICS_VERSION = ${PHYSICS_VERSION + 1};`);
      const next = readTiers(temp);
      assert(next.every(t => t.field.endsWith(`V${PHYSICS_VERSION + 1}`)
        && t.collection.startsWith(`leaderboard_v${PHYSICS_VERSION + 1}`)));
      assert.equal(next.find(t => t.id === 'bunny').ranked, true);
      writeFileSync(join(temp, 'src', 'run-context.ts'), 'export const PHYSICS_VERSION = NaN;');
      assert.throws(() => readTiers(temp), /Could not read the current physics version/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    console.log('ANALYTICS REPORT TESTS: current-schema mapping, mixed-version insights, Expert, privacy and future-bump guards passed');
  } finally {
    globalThis.fetch = savedFetch;
  }
})().catch(error => { console.error(error); process.exit(1); });
