// @ts-check
// Execute the shipped classic-script runner in a real DOM with a virtual timer
// queue. Missing/crashed/hung suites used to finish with 0 failures and exit 0.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { EXPECTED_SUITES, isRendererFailure, validateBrowserResults } = require('./helpers/browser-results');
const source = fs.readFileSync(path.join(__dirname, 'unified-test-runner.js'), 'utf8');
const RUNNERS = ['runControlsTests', 'runCameraTests', 'runAudioTests', 'runGameTests',
  'runTreeTests', 'runAvalancheTests', 'runRegressionTests'];

async function runScenario(overrides = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://example.test/?test=unified', runScripts: 'outside-only'
  });
  const w = /** @type {any} */ (dom.window);
  Object.defineProperty(w.document, 'readyState', { value: 'complete' });
  const timers = new Map();
  let clock = 0, nextId = 0;
  w.setTimeout = (callback, delay = 0) => {
    timers.set(++nextId, { callback, at: clock + delay });
    return nextId;
  };
  w.clearTimeout = id => timers.delete(id);
  w.console.log = () => {};
  w.console.error = () => {};
  for (let i = 0; i < RUNNERS.length; i++) {
    const name = EXPECTED_SUITES[i];
    w[RUNNERS[i]] = Object.hasOwn(overrides, name) ? overrides[name] && (() => overrides[name](w)) : () => {
      w._unifiedTestCounts.passed++;
      w._testCompleteCallback(name);
    };
  }
  try {
    w.eval(source);
    let steps = 0;
    while (timers.size) {
      assert.ok(++steps < 100, 'runner timer queue must terminate');
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      clock = timer.at;
      timer.callback();
      // Flush an async runner's rejection handler before advancing its deadline.
      await Promise.resolve();
      await Promise.resolve();
    }
    return {
      results: JSON.parse(JSON.stringify({ ...w._unifiedTestCounts, expectedSuites: w._unifiedExpectedSuites })),
      summary: w.document.getElementById('unified-test-summary').textContent,
      clock
    };
  } finally {
    dom.window.close();
  }
}

async function main() {
  const healthy = await runScenario();
  assert.deepEqual(validateBrowserResults(healthy.results), []);
  assert.equal(healthy.results.passed, 7);
  assert.match(healthy.summary, /ALL TESTS PASSED/);

  const missing = await runScenario(Object.fromEntries(EXPECTED_SUITES.map(name => [name, null])));
  assert.equal(missing.results.passed, 0);
  assert.ok(missing.results.failed >= 7);
  assert.equal(missing.results.completed.length, 7);
  assert.equal(missing.results.runnerErrors.filter(message => /not a function/.test(message)).length, 7);
  assert.doesNotMatch(missing.summary, /ALL TESTS PASSED/);
  assert.ok(validateBrowserResults(missing.results).length > 0);

  /** @type {Array<[string, (window: any) => unknown]>} */
  const badRunners = [
    ['synchronous exception', () => { throw new Error('injected sync failure'); }],
    ['rejected promise', async () => { throw new Error('injected async failure'); }],
    ['zero assertions', w => w._testCompleteCallback('controls')],
    ['missing callback', () => {}],
    ['duplicate completion', w => {
      w._unifiedTestCounts.passed++;
      w._testCompleteCallback('controls');
      w._testCompleteCallback('controls');
    }],
    ['unknown completion', w => {
      w._testCompleteCallback('unknown');
      w._unifiedTestCounts.passed++;
      w._testCompleteCallback('controls');
    }],
    ['completion before start', w => {
      w._testCompleteCallback('camera');
      w._unifiedTestCounts.passed++;
      w._testCompleteCallback('controls');
    }]
  ];
  for (const [name, runner] of badRunners) {
    const { results, summary } = await runScenario({ controls: runner });
    assert.equal(results.completed.length, 7, `${name}: other suites still run`);
    assert.equal(new Set(results.completed).size, 7, `${name}: completion is never duplicated`);
    assert.ok(validateBrowserResults(results).length > 0, `${name}: fails the process contract`);
    assert.doesNotMatch(summary, /ALL TESTS PASSED/, name);
  }

  const alias = await runScenario({ gameplay: w => w._testCompleteCallback('game', new Error('legacy gameplay failure')) });
  assert.match(alias.results.suiteResults.gameplay.error, /legacy gameplay failure/);
  assert.equal(alias.results.completed.length, 7);

  const cameraTimeout = await runScenario({ camera: () => {} });
  assert.match(cameraTimeout.results.suiteResults.camera.error, /timed out/);
  const finalDuplicate = await runScenario({ regression: w => {
    w._unifiedTestCounts.passed++;
    w._testCompleteCallback('regression');
    w._testCompleteCallback('regression');
  } });
  assert.doesNotMatch(finalDuplicate.summary, /ALL TESTS PASSED/);
  assert.ok(validateBrowserResults(finalDuplicate.results).length > 0);

  // A process-level timeout/uncaught exception must fail even after genuine passes.
  const good = healthy.results;
  for (const bad of [
    null,
    {},
    { ...good, timeout: true },
    { ...good, passed: 0, failed: 0 },
    { ...good, passed: NaN },
    { ...good, failed: -1 },
    { ...good, completed: good.completed.slice(1) },
    { ...good, completed: [...good.completed, 'controls'] },
    { ...good, expectedSuites: [] },
    { ...good, suiteResults: {} },
    { ...good, runnerErrors: undefined }
  ]) assert.ok(validateBrowserResults(bad).length > 0);
  assert.ok(validateBrowserResults(good, ['uncaught in a later timer']).length > 0);
  assert.ok(validateBrowserResults(good, [], ['WebGLProgram: Shader Error 0']).length > 0);

  for (const message of [
    'THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false',
    'WebGLRenderer: Error creating WebGL context.',
    'WebGL: INVALID_OPERATION: drawElements: no valid shader program in use',
    '[SnowGlider] Fatal animation-loop error — stopping the run:'
  ]) assert.equal(isRendererFailure(message), true, message);
  for (const message of [
    'Scores: Firestore unavailable, using local storage',
    'Audio play failed: NotAllowedError',
    'THREE.WebGLRenderer: PCFSoftShadowMap has been deprecated.'
  ]) assert.equal(isRendererFailure(message), false, message);

  console.log('Unified runner: missing, thrown, rejected, hung, duplicate, empty, and uncaught-error cases fail; healthy suites pass.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
