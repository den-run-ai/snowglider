// @ts-check
// Exercise the collector used by the real process: an unresponsive renderer never
// resolves page.evaluate and cannot run its in-page setTimeout callback.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const { EXPECTED_SUITES } = require('./helpers/browser-results');
const { collectBrowserResults, writeBrowserArtifacts, closeBrowser } = require('./puppeteer-runner');

async function main() {
  const result = { passed: 7, failed: 0 };
  assert.equal(await collectBrowserResults({ evaluate: async () => result }, 1000), result);
  const evaluationError = new Error('Protocol disconnected');
  await assert.rejects(collectBrowserResults({ evaluate: async () => { throw evaluationError; } }, 1000), error => error === evaluationError);

  const runner = path.join(__dirname, 'puppeteer-runner.js');
  const hung = spawnSync(process.execPath, ['-e', `
    const { collectBrowserResults } = require(process.argv[1]);
    // Simulate the open CDP/browser handles while its renderer is wedged.
    setInterval(() => {}, 100);
    collectBrowserResults({ evaluate: () => new Promise(() => {}) }, 25, 10)
      .then(() => process.exit(0), error => {
        console.error(error.message);
        process.exit(1);
      });
  `, runner], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(hung.error);
  assert.equal(hung.status, 1, 'a wedged renderer must fail without an external CI timeout');
  assert.match(hung.stderr, /Browser test results timed out after 35ms \(Node deadline\)/);

  const healthy = spawnSync(process.execPath, ['-e', `
    const { collectBrowserResults } = require(process.argv[1]);
    collectBrowserResults({ evaluate: async () => ({ passed: 7 }) }, 60000)
      .then(result => console.log(result.passed));
  `, runner], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(healthy.error);
  assert.equal(healthy.status, 0, 'successful collection clears its Node deadline');
  assert.equal(healthy.stdout.trim(), '7');

  const dom = new JSDOM('<body><div id="unified-test-summary">Partial suite result</div></body>', { runScripts: 'outside-only' });
  const w = /** @type {any} */ (dom.window);
  w._unifiedTestCounts = { passed: 3, failed: 0, completed: ['controls'] };
  w._unifiedExpectedSuiteCount = 7;
  w._unifiedExpectedSuites = EXPECTED_SUITES;
  let partial;
  try {
    // Execute the real page callback after a simulated CDP delay. Equal Node/page
    // timers used to abort before the responsive page returned this evidence.
    partial = await collectBrowserResults({ evaluate: async (callback, timeout) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return w.eval(`(${callback.toString()})(${timeout})`);
    } }, 40, 200);
    assert.equal(partial.timeout, true);
    assert.equal(partial.passed, 3);
    assert.equal(partial.summaryText, 'Partial suite result');
  } finally {
    dom.window.close();
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snowglider-browser-artifacts-'));
  const good = {
    passed: 7, failed: 0, completed: [...EXPECTED_SUITES], expectedSuites: EXPECTED_SUITES,
    suiteResults: Object.fromEntries(EXPECTED_SUITES.map(name => [name, { assertions: 1 }])), runnerErrors: []
  };
  try {
    const responsive = {
      screenshot: async ({ path: output }) => fs.writeFileSync(output, 'test screenshot'),
      evaluate: async () => good
    };
    const timedOut = await writeBrowserArtifacts(responsive, partial, {
      resultsDir: directory, consoleLogs: ['partial diagnostic log'], timeoutMs: 50
    });
    assert.equal(timedOut.timeout, true, 'late completion must not erase the suite timeout');
    assert.ok(timedOut.validationFailures.includes('Browser tests timed out'));
    assert.ok(fs.existsSync(path.join(directory, 'test-results.png')));
    assert.equal(fs.readFileSync(path.join(directory, 'console-logs.txt'), 'utf8'), 'partial diagnostic log');
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
    assert.equal(persisted.timeout, true);

    // All three post-completion CDP stages can independently stall. Exercise the
    // production artifact writer, preserving prior evidence while failing closed.
    for (const stage of ['coverage', 'screenshot', 'final read']) {
      const never = () => new Promise(() => {});
      const failures = await writeBrowserArtifacts({
        ...responsive,
        ...(stage === 'screenshot' ? { screenshot: never } : {}),
        ...(stage === 'final read' ? { evaluate: never } : {})
      }, good, {
        resultsDir: directory, consoleLogs: [`before ${stage} stalled`], timeoutMs: 20,
        collectCoverage: stage === 'coverage' ? never : null
      });
      assert.ok(failures.validationFailures.some(message => message.includes('Node deadline')), stage);
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8')).passed, 7);
      assert.match(fs.readFileSync(path.join(directory, 'console-logs.txt'), 'utf8'), /stalled/);
      if (stage === 'screenshot') assert.equal(fs.existsSync(path.join(directory, 'test-results.png')), false, 'no stale screenshot survives');
    }
    const coverageWarning = await writeBrowserArtifacts(responsive, good, {
      resultsDir: directory, collectCoverage: async () => { throw new Error('coverage unavailable'); }
    });
    assert.deepEqual(coverageWarning.validationFailures, []);
    assert.deepEqual(coverageWarning.artifactWarnings, ['coverage unavailable']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const signals = [];
  await assert.rejects(closeBrowser({
    close: () => new Promise(() => {}),
    process: () => ({ kill: signal => signals.push(signal) })
  }, 25), /Browser cleanup timed out after 25ms \(Node deadline\)/);
  assert.deepEqual(signals, ['SIGKILL'], 'stuck graceful cleanup kills its owned browser');
  await closeBrowser({ close: async () => {}, process: () => assert.fail('healthy browser must not be killed') }, 1000);
  console.log('Puppeteer deadlines: hung page fails in Node; healthy completion clears timers; hung cleanup is bounded.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
