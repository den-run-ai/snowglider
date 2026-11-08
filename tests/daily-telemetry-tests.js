// @ts-check
const assert = require('node:assert/strict');
(async () => {
  const { runTelemetryContext } = await import('../src/run-telemetry.js');
  const rc = await import('../src/run-context.js');
  const session = await import('../src/daily-session.js');
  const daily = await import('../src/daily-challenge.js');
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/' });
  const now = new Date('2026-11-08T12:00:00Z');
  const challenge = daily.createDailyChallenge('2026-11-08', 'blue');
  const dailyUrl = daily.buildDailyChallengeUrl(challenge);
  const friendUrl = daily.buildDailyChallengeUrl(challenge, undefined, 26000);

  function assertContext(difficulty, runMode, entry, practice = false, compromised = false) {
    const stamp = rc.getRunStamp();
    assert.deepEqual(runTelemetryContext(difficulty, compromised), {
      difficulty, physics_version: rc.PHYSICS_VERSION,
      practice: practice ? 'true' : 'false',
      timing_compromised: compromised ? 'true' : 'false',
      run_mode: runMode, challenge_entry: entry,
    }, 'context contains only bounded fields, never invitation identity or target');
    assert.deepEqual(rc.getRunStamp(), stamp, 'reading attribution must not change the run');
  }

  function configure(href) {
    env.window.history.replaceState({}, '', href);
    return session.configureDailySession(env.window.location.search, now);
  }

  try {
    rc.setWorldContext(1234, true);
    assertContext('expert', 'practice', 'none', true, true);
    rc.setRunSeed(null);
    assertContext('blue', 'regular', 'none');

    assert.equal(configure('/').kind, 'none');
    assert.equal(rc.getRunStamp().seed, rc.CANONICAL_WORLD_SEED);
    assertContext('blue', 'regular', 'none');
    rc.rewindRunStreams(42);
    assertContext('blue', 'regular', 'none');
    assert.equal(configure('/?seed=1234').kind, 'none');
    assert.equal(rc.getRunStamp().seed, 1234);
    assertContext('expert', 'practice', 'none', true);
    configure(`/?seed=${challenge.seed}`);
    assertContext('blue', 'practice', 'none', true);

    // Entry is determined by the valid invitation locked at scene build, for
    // every tier. Timing health remains separate from the kind of run played.
    for (const tier of /** @type {const} */ (['bunny', 'blue', 'black', 'expert'])) {
      const mountain = daily.createDailyChallenge('2026-11-08', tier);
      assert.equal(configure(daily.buildDailyChallengeUrl(mountain)).kind, 'daily');
      assert.equal(rc.getRunStamp().seed, mountain.seed);
      assertContext(tier, 'daily', 'daily', true);
      configure(daily.buildDailyChallengeUrl(mountain, undefined, 26000));
      assertContext(tier, 'daily', 'friend', true);
      assertContext(tier, 'daily', 'friend', true, true);
    }

    for (const search of [
      '?daily=broken', `${new URL(dailyUrl).search}&beat=0`,
      new URL(dailyUrl).search.replace(`pv=${rc.PHYSICS_VERSION}`, 'pv=999'),
    ]) {
      assert.notEqual(configure(`/${search}`).kind, 'daily');
      assertContext('blue', 'practice', 'none', true);
    }

    // A stale daily selection cannot relabel another world, nonce, tier or
    // regular run, even when the invitation itself was valid.
    configure(friendUrl);
    rc.setWorldContext(challenge.seed + 1, true);
    assertContext('blue', 'practice', 'none', true);
    configure(friendUrl);
    rc.rewindRunStreams(1);
    assertContext('blue', 'practice', 'none', true);
    configure(friendUrl);
    assertContext('black', 'practice', 'none', true);
    rc.setWorldContext(challenge.seed, false);
    assertContext('blue', 'regular', 'none');

    // URL edits are not scene builds: adding or removing daily/friend metadata
    // cannot change attribution for the run already in progress.
    configure(friendUrl);
    const locked = session.getDailySelection();
    for (const href of ['/', '/?seed=9', dailyUrl,
      daily.buildDailyChallengeUrl(daily.createDailyChallenge('2026-11-07', 'black'))]) {
      env.window.history.replaceState({}, '', href);
      assert.equal(session.getDailySelection(), locked);
      assertContext('blue', 'daily', 'friend', true);
    }
    configure(dailyUrl);
    env.window.history.replaceState({}, '', friendUrl);
    assertContext('blue', 'daily', 'daily', true);
    configure('/');
    env.window.history.replaceState({}, '', friendUrl);
    assertContext('blue', 'regular', 'none');

    configure(friendUrl);
    session.clearDailySession();
    assertContext('blue', 'practice', 'none', true);
    configure('/');
    assertContext('blue', 'regular', 'none');
  } finally {
    session.clearDailySession();
    rc.setRunSeed(null);
    env.teardown();
  }
  console.log('Run telemetry: bounded regular/practice/daily/friend attribution, provenance and URL isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
