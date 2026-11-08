// @ts-check
const assert = require('node:assert/strict');
(async () => {
  const { runTelemetryContext, prepareRunTelemetry, startRunTelemetry, endRunTelemetry, flushRunTelemetry } = await import('../src/run-telemetry.js');
  const { setWorldContext, setRunSeed, PHYSICS_VERSION } = await import('../src/run-context.js');
  setWorldContext(1234, true);
  assert.deepEqual(runTelemetryContext('expert', true), {
    difficulty: 'expert', physics_version: PHYSICS_VERSION,
    practice: 'true', timing_compromised: 'true',
    run_mode: 'practice', challenge_entry: 'none',
  });
  setRunSeed(null);
  assert.deepEqual(runTelemetryContext('blue'), {
    difficulty: 'blue', physics_version: PHYSICS_VERSION,
    practice: 'false', timing_compromised: 'false',
    run_mode: 'regular', challenge_entry: 'none',
  });
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const events = [];
  window.firebaseModules = { logEvent: (name, params) => events.push({ name, params }) };
  const state = {};
  prepareRunTelemetry(state);
  prepareRunTelemetry(state);
  endRunTelemetry(state, { outcome: 'finish', time: 30 });
  assert.equal(events.length, 0, 'intro/loading/preparation cannot count a run or completion');
  startRunTelemetry(state, 'blue');
  startRunTelemetry(state, 'blue');
  assert.deepEqual(events.map(e => e.name), ['game_start'], 'visible frames and late starts must be idempotent');
  assert.equal(events[0].params.run_attempt, 'first');
  assert.equal(events[0].params.funnel_version, 2);
  assert.equal(env.window.sessionStorage.getItem('snowgliderTabRuns'), '1');
  endRunTelemetry(state, { outcome: 'finish', time: 30, scoreEligible: true });
  endRunTelemetry(state, { outcome: 'finish', time: 30, scoreEligible: true });
  endRunTelemetry(state, { outcome: 'crash', time: 30, reason: 'late callback' });
  startRunTelemetry(state, 'blue');
  assert.deepEqual(events.map(e => e.name), ['game_start', 'complete_run'], 'one terminal event wins until a fresh reset');
  assert.equal(events[1].params.score_eligible, 'true');

  prepareRunTelemetry(state);
  assert.equal(events.at(-1).name, 'game_reset', 'replay resets the already-played attempt');
  assert.equal(events.at(-1).params.run_attempt, 'first', 'reset retains the replaced attempt context');
  setWorldContext(5678, true);
  startRunTelemetry(state, 'expert');
  assert.equal(events.at(-1).params.run_attempt, 'second');
  // The endpoint must retain the run that actually started even if ambient globals
  // change after it, without exposing a seed/nonce/account identity.
  setRunSeed(null);
  endRunTelemetry(state, { outcome: 'finish', time: 35, timingCompromised: true });
  const ended = events.at(-1);
  assert.equal(ended.params.difficulty, 'expert');
  assert.equal(ended.params.practice, 'true');
  assert.equal(ended.params.timing_compromised, 'true');
  assert.equal(ended.params.score_eligible, 'false');
  assert.equal(ended.params.run_attempt, 'second');

  prepareRunTelemetry(state, true);
  assert.equal(events.at(-1).params.timing_compromised, 'true');
  startRunTelemetry(state, 'bunny');
  endRunTelemetry(state, { outcome: 'crash', time: 2, reason: 'runtime_error' });
  assert.equal(events.at(-1).name, 'game_over');
  assert.equal(events.at(-1).params.run_attempt, 'later');
  assert.equal(events.at(-1).params.reason, 'runtime_error');
  assert.equal(env.window.sessionStorage.getItem('snowgliderTabRuns'), '3');
  for (let i = 0; i < 20; i++) {
    prepareRunTelemetry(state);
    startRunTelemetry(state, 'black');
    endRunTelemetry(state, { outcome: 'finish', time: NaN });
  }
  assert.equal(env.window.sessionStorage.getItem('snowgliderTabRuns'), '3', 'tab counter stays bounded');
  assert.equal(events.at(-1).params.run_attempt, 'later');
  assert.ok(!('time' in events.at(-1).params), 'non-finite time cannot enter Analytics');
  assert.ok(events.every(e => !('uid' in e.params) && !('seed' in e.params) && !('nonce' in e.params)));

  events.length = 0;
  delete window.firebaseModules;
  const lateRun = {};
  setWorldContext(9876, true);
  startRunTelemetry(lateRun, 'expert');
  startRunTelemetry(lateRun, 'expert');
  assert.equal(events.length, 0, 'a missing optional sink never delays playable starts');
  setRunSeed(null);
  window.firebaseModules = { logEvent: (name, params) => events.push({ name, params }) };
  startRunTelemetry(lateRun, 'blue');
  assert.deepEqual(events.map(e => e.name), ['game_start'], 'a later active frame flushes the original start once');
  assert.equal(events[0].params.difficulty, 'expert');
  assert.equal(events[0].params.practice, 'true', 'a delayed start retains its actual gameplay context');
  endRunTelemetry(lateRun, { outcome: 'finish', time: 32 });
  flushRunTelemetry();
  assert.deepEqual(events.map(e => e.name), ['game_start', 'complete_run']);

  events.length = 0;
  delete window.firebaseModules;
  const lateFinished = {};
  startRunTelemetry(lateFinished, 'blue');
  endRunTelemetry(lateFinished, { outcome: 'finish', time: 30, scoreEligible: true });
  prepareRunTelemetry(lateFinished);
  startRunTelemetry(lateFinished, 'black');
  endRunTelemetry(lateFinished, { outcome: 'crash', time: 4, reason: 'Tree Collision' });
  window.firebaseModules = { logEvent: (name, params) => events.push({ name, params }) };
  flushRunTelemetry();
  flushRunTelemetry();
  assert.deepEqual(events.map(e => e.name), ['game_start', 'complete_run', 'game_reset', 'game_start', 'game_over'],
    'auth readiness after a result flushes start/finish/reset in order, once');
  assert.equal(events[0].params.difficulty, 'blue');
  assert.equal(events[3].params.difficulty, 'black');

  events.length = 0;
  delete window.firebaseModules;
  const evicted = {};
  startRunTelemetry(evicted, 'expert');
  for (let i = 0; i < 20; i++) {
    const pending = {};
    startRunTelemetry(pending, 'bunny');
    endRunTelemetry(pending, { outcome: 'finish', time: 30 + i });
    prepareRunTelemetry(pending);
  }
  window.firebaseModules = { logEvent: (name, params) => events.push({ name, params }) };
  endRunTelemetry(evicted, { outcome: 'finish', time: 55 });
  flushRunTelemetry();
  assert.equal(events.length, 16 * 3, 'late telemetry memory is bounded to 16 whole attempts');
  assert.ok(events.every(e => e.params.difficulty === 'bunny'), 'an evicted start cannot emit an orphan finish later');
  for (let i = 0; i < events.length; i += 3) {
    assert.deepEqual(events.slice(i, i + 3).map(e => e.name), ['game_start', 'complete_run', 'game_reset']);
  }
  assert.equal(events[1].params.time, 34, 'overflow retains the newest attempts in order');

  events.length = 0;
  const failedStart = {};
  window.firebaseModules.logEvent = () => { throw new Error('Analytics unavailable'); };
  startRunTelemetry(failedStart, 'blue');
  window.firebaseModules.logEvent = (name, params) => events.push({ name, params });
  endRunTelemetry(failedStart, { outcome: 'finish', time: 30 });
  flushRunTelemetry();
  assert.equal(events.length, 0, 'a throwing start sink cannot later produce an orphan completion');

  Object.defineProperty(env.window, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
  window.firebaseModules.logEvent = () => { throw new Error('Analytics unavailable'); };
  assert.doesNotThrow(() => {
    prepareRunTelemetry(state);
    startRunTelemetry(state, 'blue');
    endRunTelemetry(state, { outcome: 'finish', time: 25 });
    prepareRunTelemetry(state);
    delete window.firebaseModules;
    startRunTelemetry(state, 'blue');
    endRunTelemetry(state, { outcome: 'finish', time: 25 });
  }, 'storage and Analytics failures cannot block start, replay or finish');
  env.teardown();
  console.log('Run telemetry: playable starts, bounded replay context, single terminals, late delivery and service failures passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
