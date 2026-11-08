// @ts-check
// Current-version analytics must count current finishes (including Expert), ignore
// historical bests, and preserve the report's private-email exclusion.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync,
  statSync, chmodSync, symlinkSync, linkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Analytics unit tests must not access the network'); };
  try {
    const { readTiers, buildInsights, completeDays, fetchAllReportRows, fetchGa4,
      detectAnomalies, scanTrackedEvents, auditCoverage, writePrivateReport, readScoreLimits } = await import('../scripts/analytics-report.mjs');
    const D = await import('../src/difficulty.ts');
    const { PHYSICS_VERSION } = await import('../src/run-context.ts');
    const { MIN_VALID_SCORE_TIME, MAX_VALID_SCORE_TIME, MIN_SCORE_TIME_BY_DIFFICULTY } = await import('../src/score-limits.ts');
    const limits = readScoreLimits();
    assert.deepEqual(limits, { min: MIN_VALID_SCORE_TIME, max: MAX_VALID_SCORE_TIME,
      minByTier: MIN_SCORE_TIME_BY_DIFFICULTY });
    const tiers = readTiers();
    assert.deepEqual(tiers, D.DIFFICULTIES.map(({ id, ranked }) => ({
      id, ranked, field: D.userBestTimeField(id), collection: D.leaderboardCollectionName(id),
    })), 'every configured tier must use the current client schema');
    assert(tiers.some(t => t.id === 'expert'), 'Expert must be included');

    const users = [
      { id: 'current', displayName: 'Current', email: 'private-current@example.test',
        bestTime: 18, [`bestTimeV${PHYSICS_VERSION - 1}`]: 19, [D.userBestTimeField('blue')]: 25 },
      { id: 'expert', displayName: 'Expert', email: 'private-expert@example.test',
        [D.userBestTimeField('expert')]: 30 },
      { id: 'historical', displayName: 'Historical', email: 'private-old@example.test',
        bestTime: 19, bestTimeExpert: 20, [`bestTimeV${PHYSICS_VERSION - 1}`]: 21 },
    ];
    const board = [{ id: 'current', user: 'users/current', time: 25, tier: 'blue', achievedAt: '2026-09-08T00:00:00Z' }];
    const insights = buildInsights(users, board, Date.parse('2026-09-08'), tiers,
      limits);
    assert.equal(insights.kpis.completedRun, 2, 'current Blue and Expert finishes count; historical-only does not');
    assert.equal(insights.kpis.medianBestTime, 27.5, 'a faster legacy or prior-version Blue best cannot shadow the current version');
    assert.equal(insights.health.staleBoard, 0, 'current board rows compare against current user fields');
    assert.equal(insights.health.completedNotOnBoard, 1, 'Expert finish requires its own current board record');
    assert.equal(insights.players.find(u => u.id === 'historical').bestTime, null);
    assert(!JSON.stringify(insights).includes('@example.test'), 'private emails stay out of exports');

    const redacted = buildInsights(users, board, Date.parse('2026-09-08'), tiers,
      limits, { redact: true });
    assert(!JSON.stringify(redacted.players).includes('Current'));
    assert(redacted.players.every(u => u.id.startsWith('player_')));
    assert.equal(redacted.leaderboard[0].name, redacted.players[0].id);

    const multiTier = { id: 'multi', [D.userBestTimeField('blue')]: 25,
      [D.userBestTimeField('black')]: 12, [D.userBestTimeField('expert')]: 11,
      [D.userBestTimeField('bunny')]: 12 };
    const partialBoard = [{ id: 'multi', user: 'users/multi', time: 25, tier: 'blue' }];
    const tierInsights = buildInsights([multiTier], partialBoard, 0, tiers, limits);
    assert.equal(tierInsights.plausibility.excludedUserTimes, 1,
      '12 seconds is valid for Black but remains below Bunny and Blue floors');
    assert.equal(tierInsights.players[0].bestTime, 11, 'Expert uses its own floor');
    assert.equal(tierInsights.health.completedNotOnBoard, 1,
      'presence on Blue must not hide a missing Black or Expert board record');
    const completeBoard = [...partialBoard, { id: 'multi', user: 'users/multi', time: 12, tier: 'black' },
      { id: 'multi', user: 'users/multi', time: 11, tier: 'expert' }];
    const completeInsights = buildInsights([multiTier], completeBoard, 0, tiers, limits);
    assert.equal(completeInsights.health.completedNotOnBoard, 0);
    assert.equal(completeInsights.kpis.leaderboardEntries, 3);
    const malformedBoard = buildInsights([multiTier], [
      { id: 'different-user', user: 'users/multi', time: 25, tier: 'blue' },
      { id: 'multi', user: 42, time: 12, tier: 'black' },
    ], 0, tiers, limits);
    assert.equal(malformedBoard.kpis.leaderboardEntries, 0, 'malformed and mismatched owner references never rank');
    assert.equal(malformedBoard.health.orphanBoard, 2);
    assert.equal(malformedBoard.health.completedNotOnBoard, 1);

    // UTC has already rolled into tomorrow while the property is still on today.
    const now = Date.parse('2026-11-08T01:30:00Z');
    const dates = completeDays(now, 'America/Los_Angeles', 90);
    assert.equal(dates.length, 90);
    assert.equal(dates.at(-1), '20261106');
    assert.deepEqual(completeDays(Date.parse('2026-03-10T05:00:00Z'), 'America/Los_Angeles', 3),
      ['20260306', '20260307', '20260308'], 'DST does not duplicate or omit calendar days');
    const quietThenSpike = new Map([['finish', new Map([[dates.at(-1), 30]])]]);
    assert.equal(detectAnomalies(quietThenSpike, dates).length, 1, 'quiet days must remain in baseline');

    const calls = [];
    const all = await fetchAllReportRows(async body => {
      calls.push(body);
      return { rows: body.offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }], rowCount: 3 };
    }, { dimensions: [{ name: 'eventName' }] }, 2);
    assert.equal(all.rows.length, 3);
    assert.deepEqual(calls.map(c => c.offset), [0, 2]);
    await assert.rejects(fetchAllReportRows(async () => ({ rows: [], rowCount: 4 }), {}),
      /before the reported row count/);

    // Stub only the HTTP boundary: no credentials are read and no requests leave tests.
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options.body));
      requests.push(body);
      assert(options.signal instanceof AbortSignal, 'requests must have a deadline');
      return Response.json({ rows: [], rowCount: 0,
        metadata: { timeZone: 'America/Los_Angeles', subjectToThresholding: true } });
    };
    const queryOptions = { propertyId: '123', getToken: async () => 'synthetic-token', nowMs: now };
    const ga = await fetchGa4({ project_id: 'test-project', client_email: 'test@example.test' },
      { ...queryOptions, traffic: 'human' });
    assert(ga.available);
    assert.equal(ga.anomalies.days.at(-1), '20261106');
    assert(ga.warnings.some(w => w.includes('threshold')));
    assert(requests.every(r => r.dateRanges[0].endDate === 'yesterday'));
    assert(requests.every(r => r.dimensionFilter.filter.stringFilter.value === 'false'));
    requests.length = 0;
    const production = await fetchGa4({}, { ...queryOptions, hostname: 'SNOWGLIDER.AI' });
    assert(production.available);
    assert.equal(production.hostname, 'snowglider.ai');
    assert(requests.every(r => r.dimensionFilter.filter.fieldName === 'hostName'));
    assert(requests.every(r => r.dimensionFilter.filter.stringFilter.value === 'snowglider.ai'));
    for (const traffic of ['human', 'bot']) {
      requests.length = 0;
      await fetchGa4({}, { ...queryOptions, hostname: 'snowglider.ai', traffic });
      assert(requests.length > 0);
      for (const request of requests) {
        assert.deepEqual(request.dimensionFilter.andGroup.expressions, [
          { filter: { fieldName: 'customEvent:is_bot',
            stringFilter: { matchType: 'EXACT', value: traffic === 'bot' ? 'true' : 'false' } } },
          { filter: { fieldName: 'hostName',
            stringFilter: { matchType: 'EXACT', value: 'snowglider.ai', caseSensitive: false } } },
        ], 'both filters apply to every report, including anomaly pages');
      }
    }
    requests.length = 0;
    const unfiltered = await fetchGa4({}, queryOptions);
    assert.equal(unfiltered.hostname, null);
    assert(requests.every(r => !('dimensionFilter' in r)), 'no implicit hostname or traffic filter');
    assert(unfiltered.warnings.some(w => w.includes('hostname is unfiltered')));
    for (const hostname of ['https://snowglider.ai', 'snowglider.ai/path', 'snowglider.ai:443',
      'snowglider.ai?token=test', '', 'bad..host', '-bad.host', 'bad-.host', 'a'.repeat(64) + '.test']) {
      await assert.rejects(fetchGa4({}, { ...queryOptions, hostname }), /--hostname/);
    }

    await assert.rejects(fetchGa4({}, { ...queryOptions, traffic: 'invalid' }), /--traffic/);
    await assert.rejects(fetchGa4({}, { ...queryOptions, propertyId: '../invalid' }), /numeric/);
    globalThis.fetch = async () => Response.json({ error: { message: 'API disabled' } }, { status: 403 });
    const unavailable = await fetchGa4({}, queryOptions);
    assert.equal(unavailable.available, false);
    assert.match(unavailable.reason, /API disabled/);
    globalThis.fetch = async () => Response.json({ rows: [], rowCount: 0 });
    const noZone = await fetchGa4({}, queryOptions);
    assert(noZone.available);
    assert.equal(noZone.anomalies.available, false, 'unverifiable date window is not a clean bill of health');
    assert.match(noZone.anomalies.reason, /timezone/);

    // Retention/truncation warnings survive empty results from every report.
    const syntheticOptions = { ...queryOptions, nowMs: Date.parse('2025-01-07T12:00:00Z') };
    let reportIndex = 0;
    globalThis.fetch = async () => Response.json({ rows: [], rowCount: 0, metadata: {
      timeZone: 'UTC', dataTruncationReasons: [{
        dataTruncationType: 'DATA_TRUNCATION_TYPE_PROPERTY', dataTruncationDate: '2025-01-01',
        dataTruncationMessage: `Synthetic report ${++reportIndex} retention limit.`,
      }],
    } });
    const emptyTruncated = await fetchGa4({}, syntheticOptions);
    assert(emptyTruncated.available);
    assert.equal(reportIndex, 5);
    for (let index = 1; index <= reportIndex; index++) {
      assert(emptyTruncated.warnings.some(w => w.includes('DATA_TRUNCATION_TYPE_PROPERTY') &&
        w.includes('before 2025-01-01') && w.includes(`Synthetic report ${index} retention limit.`)),
      'each empty report must retain its truncation reason');
    }

    const pageOffsets = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options.body));
      if (body.dimensions?.length !== 2) return Response.json({ rows: [], rowCount: 0,
        metadata: { timeZone: 'UTC', dataTruncationReasons: [] } });
      pageOffsets.push(body.offset);
      return Response.json({ rowCount: 2, rows: [{
        dimensionValues: [{ value: `2025010${body.offset + 1}` }, { value: 'synthetic_event' }],
        metricValues: [{ value: '1' }],
      }], metadata: { dataTruncationReasons: [{
        dataTruncationType: 'DATA_TRUNCATION_TYPE_DATE_RANGE',
        dataTruncationDateRanges: [{ startDate: '2025-01-01', endDate: '2025-01-02' }],
        dataTruncationMessage: `Synthetic page ${body.offset}.`,
      }] } });
    };
    const pagedTruncated = await fetchGa4({}, syntheticOptions);
    assert(pagedTruncated.available && pagedTruncated.anomalies.available);
    assert.deepEqual(pageOffsets, [0, 1]);
    for (const offset of pageOffsets) {
      assert(pagedTruncated.warnings.some(w => w.includes(`Synthetic page ${offset}.`) &&
        w.includes('2025-01-01 → 2025-01-02')), 'earlier and later page metadata must survive');
    }

    for (const malformed of [null, {}, 'unexpected', [null, 7, {}, ['unexpected']]]) {
      globalThis.fetch = async () => Response.json({ rows: [], rowCount: 0, metadata: {
        timeZone: 'UTC', dataTruncationReasons: malformed,
      } });
      const malformedReport = await fetchGa4({}, syntheticOptions);
      assert(malformedReport.available);
      assert.equal(malformedReport.warnings.filter(w => w.includes('reason details unavailable')).length, 1,
        'repeated malformed reasons across reports must deduplicate');
    }
    let boundedBatch = 0;
    globalThis.fetch = async () => Response.json({ rows: [], rowCount: 0, metadata: {
      timeZone: 'UTC', dataTruncationReasons: Array.from({ length: 30 }, (_, index) => ({
        dataTruncationType: `SYNTHETIC_${boundedBatch++}_${index}`, dataTruncationMessage: 'x'.repeat(2000),
      })),
    } });
    const boundedReport = await fetchGa4({}, syntheticOptions);
    const boundedWarnings = boundedReport.warnings.filter(w => w.startsWith('GA4 data truncation:'));
    assert.equal(boundedWarnings.length, 21, 'bound distinct reasons across all reports');
    assert(boundedWarnings.every(w => w.length < 400), 'server-provided messages must be bounded');
    assert(boundedWarnings.some(w => w.includes('additional reasons omitted')));

    const tracked = scanTrackedEvents(join(__dirname, '..'));
    for (const event of ['new_high_score', 'login', 'client_error', 'unhandled_rejection']) {
      assert(tracked.some(e => e.event === event), `${event} must be discovered through its wrapper`);
    }
    assert(!auditCoverage(tracked).gaps.some(g => g.key === 'error-tracking'),
      'wired error capture must not be falsely reported as missing');
    assert(!auditCoverage(tracked).gaps.some(g => g.key === 'bot-filtering'),
      'literal event scanning cannot prove that traffic tags are absent');

    // A future bump and ranked flip must change the read plan automatically.
    // Malformed configuration must fail visibly, never fall back to old boards.
    const temp = mkdtempSync(join(tmpdir(), 'snowglider-analytics-schema-'));
    try {
      mkdirSync(join(temp, 'src'));
      writeFileSync(join(temp, 'src', 'wrappers.ts'), `
        logEvent(analytics, 'direct_event', {});
        logAnalyticsEvent('login', {});
        logScoreEvent('new_high_score', 30);
        this.captureError('client_error', error, 'test');
        this.captureError('unhandled_rejection', reason, 'test');
        this.emit('session_health', {});
      `);
      assert.deepEqual(scanTrackedEvents(temp).map(e => e.event), [
        'client_error', 'direct_event', 'login', 'new_high_score', 'session_health', 'unhandled_rejection',
      ]);

      const reportPath = join(temp, 'report.json');
      writePrivateReport(reportPath, '{"synthetic":true}');
      assert.equal(readFileSync(reportPath, 'utf8'), '{"synthetic":true}');
      if (process.platform !== 'win32') {
        assert.equal(statSync(reportPath).mode & 0o777, 0o600, 'new exports are private');
        chmodSync(reportPath, 0o644);
        writePrivateReport(reportPath, '{}');
        assert.equal(statSync(reportPath).mode & 0o777, 0o600, 'existing exports are made private');
        assert.equal(readFileSync(reportPath, 'utf8'), '{}', 'shorter reports truncate previous content');
        const outside = join(temp, 'unrelated.json');
        writeFileSync(outside, 'untouched', { mode: 0o644 });
        const beforeMode = statSync(outside).mode;
        symlinkSync(outside, join(temp, 'symlink.json'));
        assert.throws(() => writePrivateReport(join(temp, 'symlink.json'), 'changed'));
        linkSync(outside, join(temp, 'hardlink.json'));
        assert.throws(() => writePrivateReport(join(temp, 'hardlink.json'), 'changed'), /hard-link/);
        assert.equal(readFileSync(outside, 'utf8'), 'untouched');
        assert.equal(statSync(outside).mode, beforeMode, 'unrelated permissions stay unchanged');
      }
      const source = readFileSync(join(__dirname, '..', 'src', 'difficulty.ts'), 'utf8');
      writeFileSync(join(temp, 'src', 'difficulty.ts'), source.replace('ranked: true', 'ranked: false'));
      writeFileSync(join(temp, 'src', 'run-context.ts'), `export const PHYSICS_VERSION = ${PHYSICS_VERSION + 1};`);
      const next = readTiers(temp);
      assert(next.every(t => t.field.endsWith(`V${PHYSICS_VERSION + 1}`)
        && t.collection.startsWith(`leaderboard_v${PHYSICS_VERSION + 1}`)));
      assert.equal(next.find(t => t.id === 'bunny').ranked, false);
      writeFileSync(join(temp, 'src', 'run-context.ts'), 'export const PHYSICS_VERSION = NaN;');
      assert.throws(() => readTiers(temp), /Could not read the current physics version/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    console.log('ANALYTICS REPORT TESTS: schema, privacy, complete-day windows, pagination, traffic filters and failure paths passed');
  } finally {
    globalThis.fetch = savedFetch;
  }
})().catch(error => { console.error(error); process.exit(1); });
