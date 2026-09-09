/**
 * Puppeteer Test Runner for SnowGlider
 * 
 * Runs browser tests in headless Chrome for CI environments.
 * Usage: node tests/puppeteer-runner.js
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { isRendererFailure, validateBrowserResults } = require('./helpers/browser-results');
const {
  startBrowserCoverage,
  foldPageCoverage,
  writeBrowserReports,
  createCoverageMap
} = require('./coverage/browser-coverage');

const PORT = process.env.TEST_PORT || 8081;  // Use different port to avoid conflicts
const TEST_TIMEOUT = 90000; // Existing whole-suite deadline, now a failing outcome
const RESULTS_DIR = path.join(__dirname, '..', 'test-results');
const ROOT = path.join(__dirname, '..');
// Opt-in browser coverage (step 2 of the honest-coverage work). Off by default so
// `npm run test:browser` stays fast/unchanged; CI sets BROWSER_COVERAGE for the
// coverage upload. The unified suite (index.html?test=unified) runs every browser
// test, so instrumenting that one page captures the full browser surface.
const COLLECT_COVERAGE = process.env.BROWSER_COVERAGE === '1' || process.env.BROWSER_COVERAGE === 'true';
const COVERAGE_DIR = path.join(ROOT, 'coverage', 'browser');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Probe a Vite-specific endpoint so a stale or unrelated listener already on the
// port can't masquerade as a ready dev server (`--strictPort` makes our own Vite
// exit rather than reuse it). Vite serves `/@vite/client` with status 200; only
// that counts as ready.
function probeViteReady(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/@vite/client`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use; refusing to run browser tests against a pre-existing server`));
        return;
      }
      reject(err);
    });

    probe.once('listening', () => {
      probe.close(resolve);
    });

    probe.listen({
      host: '127.0.0.1',
      port: Number(port),
      exclusive: true
    });
  });
}

async function startServer() {
  // Serve through Vite's dev server rather than http-server: game modules are
  // now ES modules and (as of Phase 3) some are TypeScript, which a browser can't
  // execute raw. Vite transpiles `.ts` on the fly and resolves the `./x.js`
  // import specifiers to their `.ts` sources, so the suite exercises the real
  // shipped modules over the same module graph the production build ships. (It
  // also single-sources three through Vite's dep optimizer, removing the
  // dual-instance hazard the raw import-map path had.)
  console.log('Starting vite dev server...');
  await assertPortAvailable(PORT);

  const server = spawn(
    'npx',
    ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  server.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.log(`[vite] ${output}`);
  });
  server.stderr.on('data', (data) => {
    console.error('Server stderr:', data.toString());
  });

  // Record an early exit (e.g. `--strictPort` and the port was already taken, so
  // Vite refuses to start) so we can fail loudly instead of probing whatever else
  // is on the port.
  let exitInfo = null;
  server.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const startupError = new Promise((_resolve, reject) => {
    server.on('error', (err) => reject(new Error(`Failed to start server: ${err.message}`)));
  });

  // Poll Vite's own endpoint for up to ~30s (its first cold dep-optimize is slow).
  const ready = (async () => {
    for (let i = 0; i < 60; i++) {
      if (exitInfo) {
        throw new Error(`Vite exited before becoming ready (code ${exitInfo.code}, signal ${exitInfo.signal})`);
      }
      if (await probeViteReady(PORT)) {
        await wait(100);
        if (exitInfo) {
          throw new Error(`Vite exited during readiness probe (code ${exitInfo.code}, signal ${exitInfo.signal})`);
        }
        console.log(`Server started on port ${PORT}`);
        return server;
      }
      await wait(500);
    }
    server.kill();
    throw new Error('Server startup timeout');
  })();

  return Promise.race([ready, startupError]);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStartMenuRaceRegression(browser) {
  console.log('Running start menu race regression...');

  const page = await browser.newPage();
  const errors = [];
  const rendererErrors = [];
  let releaseSnowgliderScript;
  let snowgliderRequestSeen;

  const releaseSnowgliderScriptPromise = new Promise(resolve => {
    releaseSnowgliderScript = resolve;
  });
  const snowgliderRequestSeenPromise = new Promise(resolve => {
    snowgliderRequestSeen = resolve;
  });

  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  page.on('console', (msg) => {
    if (isRendererFailure(msg.text())) rendererErrors.push(msg.text());
  });

  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    // Match the orchestrator's dynamic import regardless of any Vite-appended
    // query (e.g. `?t=…`/`?import`) — `pathname` strips the query string.
    let pathname;
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = request.url();
    }
    // snowglider was renamed .js -> .ts (issue #84, Phase 3.9). Depending on how
    // Vite rewrites the deferred dynamic import, the served request may be `.js`
    // (Vite serves the .ts content for it) or the resolved `.ts` path — match both
    // so the delayed-load start-menu regression keeps exercising the deferral.
    if (pathname.endsWith('/src/snowglider.js') || pathname.endsWith('/src/snowglider.ts')) {
      snowgliderRequestSeen();
      await releaseSnowgliderScriptPromise;
    }
    request.continue();
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForSelector('#startGameButton', { timeout: 10000 });
    await page.click('#startGameButton');

    await page.waitForFunction(() => {
      const button = document.getElementById('startGameButton');
      return button && button.disabled && button.getAttribute('aria-busy') === 'true';
    }, { timeout: 5000 });

    const pendingState = await page.evaluate(() => {
      const startContainer = document.getElementById('startGameContainer');
      const gameCanvas = document.getElementById('gameCanvas');

      return {
        startContainerDisplay: startContainer ? startContainer.style.display : null,
        gameCanvasExists: !!gameCanvas,
        canInitializeGame: typeof window.initializeGameWithAudio === 'function'
      };
    });

    if (pendingState.startContainerDisplay === 'none') {
      throw new Error('Start screen hid before the game canvas was ready');
    }

    await Promise.race([
      snowgliderRequestSeenPromise,
      wait(30000).then(() => {
        throw new Error('Timed out waiting for delayed snowglider.js request');
      })
    ]);

    releaseSnowgliderScript();

    await page.waitForFunction(() => {
      const button = document.getElementById('startGameButton');
      const startContainer = document.getElementById('startGameContainer');
      const gameCanvas = document.getElementById('gameCanvas');
      return button &&
        startContainer &&
        gameCanvas &&
        !button.disabled &&
        button.getAttribute('aria-busy') !== 'true' &&
        startContainer.style.display !== 'none' &&
        typeof window.initializeGameWithAudio === 'function';
    }, { timeout: 30000 });

    await page.click('#startGameButton');

    await page.waitForFunction(() => {
      const startContainer = document.getElementById('startGameContainer');
      const gameCanvas = document.getElementById('gameCanvas');
      return startContainer &&
        gameCanvas &&
        startContainer.style.display === 'none' &&
        gameCanvas.style.display === 'block';
    }, { timeout: 30000 });

    if (errors.length || rendererErrors.length) {
      throw new Error(`Start-menu page/renderer errors: ${[...errors, ...rendererErrors].join('; ')}`);
    }

    console.log('PASS: start menu re-enables Start for a gesture-backed deferred start');
  } finally {
    releaseSnowgliderScript();
    await page.close();
  }
}

async function runBrowserTests() {
  let server;
  let browser;
  
  try {
    // Puppeteer 25 is ESM-only; keep this CommonJS runner's import asynchronous.
    const { default: puppeteer } = await import('puppeteer');
    // Start the dev server
    server = await startServer();
    
    // Launch browser
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    await runStartMenuRaceRegression(browser);

    const page = await browser.newPage();

    // Start V8 coverage before navigating so the initial module graph is
    // instrumented. Best-effort: a coverage failure must never fail the suite.
    if (COLLECT_COVERAGE) {
      try {
        await startBrowserCoverage(page);
      } catch (covErr) {
        console.warn('Browser coverage: failed to start:', covErr.message);
      }
    }

    // Collect console logs
    const consoleLogs = [];
    const rendererErrors = [];
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(`[${msg.type()}] ${text}`);
      if (isRendererFailure(text)) rendererErrors.push(text);
      
      // Print test results and important events to stdout
      if (text.includes('PASS:') || text.includes('FAIL:') || 
          text.includes('UNIFIED') || text.includes('TEST') ||
          text.includes('passed') || text.includes('failed')) {
        console.log(text);
      }
    });
    
    // Track errors
    const errors = [];
    page.on('pageerror', (err) => {
      errors.push(err.message);
      console.error('Page error:', err.message);
    });
    
    // Navigate to test page
    console.log('Loading test page...');
    await page.goto(`http://127.0.0.1:${PORT}/index.html?test=unified`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait for page to be fully ready
    await page.waitForSelector('canvas', { timeout: 10000 });
    console.log('Canvas loaded');
    
    // Simulate user interaction to trigger audio tests and unlock audio context.
    // The unified results overlay (zIndex 99999) can cover the body's center, so
    // click a fixed top-left corner outside it; tolerate failure since autoplay is
    // already permitted via the --autoplay-policy launch flag.
    try {
      await page.mouse.click(5, 5);
    } catch (clickErr) {
      console.warn('Audio-unlock click skipped:', clickErr.message);
    }
    await new Promise(r => setTimeout(r, 1000));
    
    // Wait for tests to complete
    console.log('Running tests...');
    
    let results = await page.evaluate((timeoutMs) => {
      return new Promise((resolve) => {
        let interval;
        let deadline;
        const snapshot = () => ({
          ...window._unifiedTestCounts,
          expectedSuites: window._unifiedExpectedSuites,
          summaryText: document.getElementById('unified-test-summary')?.textContent || 'N/A'
        });
        const finish = (timeout) => {
          clearInterval(interval);
          clearTimeout(deadline);
          resolve({ ...snapshot(), timeout });
        };
        const checkResults = () => {
          const counts = window._unifiedTestCounts;
          const expected = window._unifiedExpectedSuiteCount;
          if (Number.isInteger(expected) && expected > 0 && counts?.completed?.length >= expected) {
            finish(false);
            return true;
          }
          return false;
        };
        if (checkResults()) return;
        interval = setInterval(checkResults, 1000);
        deadline = setTimeout(() => finish(true), timeoutMs);
      });
    }, TEST_TIMEOUT);

    // Stop and persist browser coverage now that the suite has finished but the
    // page is still alive. Best-effort: never let coverage break the test run.
    if (COLLECT_COVERAGE) {
      try {
        const coverageMap = createCoverageMap();
        await foldPageCoverage(page, coverageMap, ROOT);
        fs.mkdirSync(COVERAGE_DIR, { recursive: true });
        writeBrowserReports(coverageMap, COVERAGE_DIR);
        console.log(`Browser coverage written: ${coverageMap.files().filter(f => f.includes(`${path.sep}src${path.sep}`)).length} src files -> ${path.relative(ROOT, COVERAGE_DIR)}/lcov.info`);
      } catch (covErr) {
        console.warn('Browser coverage: failed to write report:', covErr.message);
      }
    }

    // Take a screenshot of results
    await page.screenshot({
      path: path.join(RESULTS_DIR, 'test-results.png'),
      fullPage: true
    });
    
    // Save console logs
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'console-logs.txt'),
      consoleLogs.join('\n')
    );
    
    // Re-read after screenshot/coverage work so late duplicate callbacks or runner
    // errors cannot hide behind the first completion snapshot. Preserve timeout.
    results = { ...results, ...await page.evaluate(() => ({
      ...window._unifiedTestCounts,
      expectedSuites: window._unifiedExpectedSuites
    })) };
    const failures = validateBrowserResults(results, errors, rendererErrors);
    results.pageErrors = errors;
    results.rendererErrors = rendererErrors;
    results.validationFailures = failures;

    // Save results JSON
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'results.json'),
      JSON.stringify(results, null, 2)
    );
    
    // Print summary
    console.log('\n========================================');
    console.log('BROWSER TEST RESULTS');
    console.log('========================================');
    console.log(`Passed: ${results.passed}`);
    console.log(`Failed: ${results.failed}`);
    console.log(`Completed suites: ${(results.completed || []).join(', ')}`);
    
    if (results.timeout) {
      console.log('WARNING: Tests timed out before completion');
    }
    
    if (errors.length > 0) {
      console.log('\nPage Errors:');
      errors.forEach(e => console.log(`  - ${e}`));
    }
    
    console.log('========================================\n');
    
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    return failures.length > 0 ? 1 : 0;
    
  } catch (error) {
    console.error('Test runner error:', error.message);
    return 1;
  } finally {
    // Cleanup
    if (browser) {
      await browser.close();
    }
    if (server) {
      server.kill();
    }
  }
}

// Run tests
runBrowserTests().then((exitCode) => {
  process.exit(exitCode);
}).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
