/**
 * Rock-gallery capture runner (rock realism recovery PR 1, issue #385).
 *
 * Drives the real app's `?gallery=rocks` page (src/visual/rock-gallery.ts) in
 * headless Chrome and saves midday + golden-hour PNGs of the fixed rock samples to
 * test-results/rock-gallery/. Review artifacts for PR screenshots — NOT a CI gate
 * (the CI gate is the text-metrics harness, tests/rock-visual-metrics-tests.js).
 *
 * #336 discipline — the capture must show the REAL player path, never the
 * automation fallback:
 *   - `navigator.webdriver` is defeated via an init script AND `?eztrees=1` is
 *     passed, so the player's EZ evergreen forest renders instead of the stylized
 *     automation cones;
 *   - before saving anything, the runner asserts the gallery rocks AND the EZ
 *     branch instances are actually attached (window.__rockGallery.stats()), and
 *     fails hard otherwise.
 *   - Math.random is seeded via the same init script, so terrain scatter/trees are
 *     reproducible capture-to-capture.
 *
 * Usage: npm run test:rocks:gallery
 *   (needs Chrome; set PUPPETEER_EXECUTABLE_PATH to use a system/preinstalled one)
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.GALLERY_PORT || 8082;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-results', 'rock-gallery');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Vite dev server (same probe pattern as tests/puppeteer-runner.js) ------------
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
      reject(err.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use; refusing to run the gallery against a pre-existing server`)
        : err);
    });
    probe.once('listening', () => probe.close(resolve));
    probe.listen({ host: '127.0.0.1', port: Number(port), exclusive: true });
  });
}

async function startServer() {
  console.log('Starting vite dev server...');
  await assertPortAvailable(PORT);
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  server.on('exit', (code, signal) => { exited = { code, signal }; });
  for (let i = 0; i < 60; i++) {
    if (exited) throw new Error(`Vite exited before ready (code ${exited.code}, signal ${exited.signal})`);
    if (await probeViteReady(PORT)) {
      console.log(`Server started on port ${PORT}`);
      return server;
    }
    await wait(500);
  }
  server.kill();
  throw new Error('Server startup timeout');
}

async function run() {
  let server;
  let browser;
  try {
    server = await startServer();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.error('Page error:', err.message));

    // Real-player-path setup (#336): defeat the webdriver automation gate and seed
    // Math.random so the surrounding terrain/forest layout reproduces run-to-run.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      let a = 0x5eed2026 >>> 0;
      Math.random = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    });

    console.log('Loading gallery page...');
    await page.goto(`http://127.0.0.1:${PORT}/index.html?gallery=rocks&eztrees=1`, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await page.waitForFunction(() => window.__rockGallery && window.__rockGallery.ready, { timeout: 60000 });

    // Assert the intended path actually rendered BEFORE saving anything.
    const stats = await page.evaluate(() => window.__rockGallery.stats());
    console.log('Gallery stats:', JSON.stringify(stats));
    if (stats.galleryRocks !== 16) {
      throw new Error(`Expected 16 gallery rocks (4 boulders + 4 cliffs + 8 pinch), got ${stats.galleryRocks}`);
    }
    if (!stats.ezBranchesAttached) {
      throw new Error('EZ forest branches are NOT attached — this capture would show the ' +
        'automation-fallback cone forest and misrepresent the game (#336). Aborting.');
    }
    if (stats.webdriver) {
      throw new Error('navigator.webdriver is still true — the automation gate was not defeated (#336).');
    }

    const save = async (name) => {
      const dataUrl = await page.evaluate(() => window.__rockGallery.capture());
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      const file = path.join(OUT_DIR, `rock-gallery-${name}.png`);
      fs.writeFileSync(file, png);
      console.log(`Saved ${path.relative(ROOT, file)} (${(png.length / 1024).toFixed(0)} KB)`);
    };
    const setView = async (view) => {
      await page.evaluate((v) => window.__rockGallery.setView(v), view);
      if (view === 'overview') return;
      // Assert the row being captured is actually inside the frame (#336).
      const proj = await page.evaluate(() => window.__rockGallery.projections());
      const row = proj.filter((p) => p.id.startsWith(view));
      const out = row.filter((p) => !p.inFrame);
      const expected = view === 'pinch' ? 8 : 4; // both sides of all four Black gates
      if (row.length !== expected || out.length > 0) {
        throw new Error(`Row '${view}' not fully in frame (want ${expected}): ${JSON.stringify(row)}`);
      }
    };
    const setPhase = (phase) => page.evaluate((p) => window.__rockGallery.setPhase(p), phase);

    // Midday first — the sun cycle only advances.
    await setPhase('midday');
    await save('midday');
    for (const view of ['boulder', 'cliff', 'pinch']) {
      await setView(view);
      await save(`midday-${view}`);
    }
    await setView('overview');
    await setPhase('golden');
    await save('golden');
    for (const view of ['boulder', 'cliff', 'pinch']) {
      await setView(view);
      await save(`golden-${view}`);
    }

    console.log('\nRock gallery captures complete.');
    return 0;
  } catch (err) {
    console.error('Rock gallery runner failed:', err.message);
    return 1;
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().then((code) => process.exit(code)).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
