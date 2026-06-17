/**
 * Puppeteer Test Runner for SnowGlider
 * 
 * Runs browser tests in headless Chrome for CI environments.
 * Usage: node tests/puppeteer-runner.js
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.TEST_PORT || 8081;  // Use different port to avoid conflicts
const TEST_TIMEOUT = 120000; // 2 minutes for all tests
const RESULTS_DIR = path.join(__dirname, '..', 'test-results');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    console.log('Starting http-server...');
    
    const server = spawn('npx', ['http-server', '-p', PORT, '-c-1'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let started = false;
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      if (!started && output.includes('Available on')) {
        started = true;
        console.log(`Server started on port ${PORT}`);
        // Give server a moment to be fully ready
        setTimeout(() => resolve(server), 1000);
      }
    });
    
    server.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });
    
    server.on('error', (err) => {
      reject(new Error(`Failed to start server: ${err.message}`));
    });
    
    // Timeout for server startup
    setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error('Server startup timeout'));
      }
    }, 15000);
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStartMenuRaceRegression(browser) {
  console.log('Running start menu race regression...');

  const page = await browser.newPage();
  const errors = [];
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

  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (request.url().endsWith('/src/snowglider.js')) {
      snowgliderRequestSeen();
      await releaseSnowgliderScriptPromise;
    }
    request.continue();
  });

  try {
    await page.goto(`http://localhost:${PORT}/index.html`, {
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

    if (errors.some(error => error.includes("Cannot read properties of null"))) {
      throw new Error(`Unexpected null DOM access error: ${errors.join('; ')}`);
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
    // Start the dev server
    server = await startServer();
    
    // Launch browser
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
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
    
    // Collect console logs
    const consoleLogs = [];
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(`[${msg.type()}] ${text}`);
      
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
    await page.goto(`http://localhost:${PORT}/index.html?test=unified`, {
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
    
    const results = await page.evaluate(() => {
      return new Promise((resolve) => {
        let pollCount = 0;
        
        const checkResults = () => {
          pollCount++;
          
          // Log state periodically
          if (pollCount % 10 === 0) {
            const counts = window._unifiedTestCounts;
            const hasRunner = !!window._unifiedTestResults;
            console.log(`Poll ${pollCount}: runner=${hasRunner}, counts=${JSON.stringify(counts)}`);
          }
          
          // Check if unified test runner has completed
          const summary = document.getElementById('unified-test-summary');
          if (summary && summary.textContent.includes('ALL TESTS COMPLETED')) {
            const counts = window._unifiedTestCounts || { passed: 0, failed: 0 };
            resolve({
              passed: counts.passed,
              failed: counts.failed,
              completed: counts.completed || [],
              summaryText: summary.textContent
            });
            return true;
          }
          
          // Also check if tests completed but summary text isn't updated
          const counts = window._unifiedTestCounts;
          if (counts && counts.completed && counts.completed.length >= 6) {
            resolve({
              passed: counts.passed,
              failed: counts.failed,
              completed: counts.completed,
              summaryText: summary ? summary.textContent : 'N/A'
            });
            return true;
          }
          
          return false;
        };
        
        // Check immediately
        if (checkResults()) return;
        
        // Poll for completion every second
        const interval = setInterval(() => {
          if (checkResults()) {
            clearInterval(interval);
          }
        }, 1000);
        
        // Timeout after 90 seconds
        setTimeout(() => {
          clearInterval(interval);
          const counts = window._unifiedTestCounts || { passed: 0, failed: 0 };
          const runnerActive = !!window._unifiedTestRunnerActive;
          resolve({
            passed: counts.passed,
            failed: counts.failed,
            completed: counts.completed || [],
            timeout: true,
            runnerActive: runnerActive
          });
        }, 90000);
      });
    });
    
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
    console.log(`Completed suites: ${results.completed.join(', ')}`);
    
    if (results.timeout) {
      console.log('WARNING: Tests timed out before completion');
    }
    
    if (errors.length > 0) {
      console.log('\nPage Errors:');
      errors.forEach(e => console.log(`  - ${e}`));
    }
    
    console.log('========================================\n');
    
    // Return exit code based on results
    return results.failed > 0 ? 1 : 0;
    
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
