// @ts-check
// Exercise the collector used by the real process: an unresponsive renderer never
// resolves page.evaluate and cannot run its in-page setTimeout callback.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectBrowserResults, closeBrowser } = require('./puppeteer-runner');

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
    collectBrowserResults({ evaluate: () => new Promise(() => {}) }, 25)
      .then(() => process.exit(0), error => {
        console.error(error.message);
        process.exit(1);
      });
  `, runner], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(hung.error);
  assert.equal(hung.status, 1, 'a wedged renderer must fail without an external CI timeout');
  assert.match(hung.stderr, /Browser test results timed out after 25ms \(Node deadline\)/);

  const healthy = spawnSync(process.execPath, ['-e', `
    const { collectBrowserResults } = require(process.argv[1]);
    collectBrowserResults({ evaluate: async () => ({ passed: 7 }) }, 60000)
      .then(result => console.log(result.passed));
  `, runner], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(healthy.error);
  assert.equal(healthy.status, 0, 'successful collection clears its Node deadline');
  assert.equal(healthy.stdout.trim(), '7');

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
