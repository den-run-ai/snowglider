#!/usr/bin/env node
// Review evidence, not pixel baselines: show the actual EZ forest behind the HUD.
// Uses the installed Playwright Chromium; never downloads a browser or git ref.
// HUD_BASE_REF=<local commit SHA> adds four before images from a temporary worktree.
// Without HUD_BASE_REF, capture only the four current images.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const output = join(root, 'test-results', 'hud-review');
const baseRef = process.env.HUD_BASE_REF?.trim();
const evidence = [];
let temporaryDirectory;
let beforeWorktree;
let browser;

function git(args) {
  // Container checkouts can have a different owner, and actions/checkout's
  // temporary safe.directory config is not inherited by subsequent steps.
  // Trust only this canonical checkout for this command; never modify Git config.
  return execFileSync('git', ['-c', `safe.directory=${root}`, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function stopServer(child) {
  if (!child.pid) return; // A failed spawn has no process to terminate.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await stopped;
  }
}

async function withServer(directory, port, capture) {
  const child = spawn(process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let startupError;
  child.on('error', error => { startupError = error; });
  const collectLog = chunk => { log = (log + chunk.toString()).slice(-12000); };
  child.stdout.on('data', collectLog);
  child.stderr.on('data', collectLog);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Vite exited before readiness:\n${log}`);
      // The Local banner belongs to this spawned child. A stale listener alone
      // must not pass readiness while --strictPort is about to reject our child.
      if (log.includes('Local:')) {
        try {
          const response = await fetch(`${baseUrl}/@vite/client`, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          if (response.ok) { ready = true; break; }
        } catch { /* Wait for this child's Vite endpoint to become ready. */ }
      }
      await delay(200);
    }
    if (!ready) throw new Error(`Vite did not become ready on port ${port}:\n${log}`);
    await capture(baseUrl);
  } finally {
    await stopServer(child);
  }
}

async function setExpanded(page, selector, expanded, touch) {
  const button = page.locator(selector);
  if (await button.getAttribute('aria-expanded') !== String(expanded)) {
    if (touch) await button.tap();
    else await button.click();
  }
  await page.waitForFunction(({ selector, expanded }) =>
    document.querySelector(selector)?.getAttribute('aria-expanded') === String(expanded), { selector, expanded });
}

async function captureVersion(label, directory, port, commit) {
  await withServer(directory, port, async baseUrl => {
    for (const viewport of [
      { name: 'phone', width: 390, height: 700, touch: true },
      { name: 'desktop', width: 1440, height: 900, touch: false },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
        ...(viewport.touch ? { userAgent: devices['iPhone 13'].userAgent } : {}),
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
        await page.goto(`${baseUrl}/index.html?eztrees=1&intro=off`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.initializeGameWithAudio === 'function');
        if (viewport.touch) await page.locator('#startGameButton').tap();
        else await page.locator('#startGameButton').click();
        await page.waitForFunction(() => window.gameActive === true);
        // Pause the timed run through the existing public state seam. Rendering
        // and asynchronous EZ loading continue; no fake terrain or DOM is used.
        await page.evaluate(() => new Promise(resolve => {
          window.gameActive = false;
          requestAnimationFrame(() => resolve());
        }));
        await page.waitForFunction(() => window.terrainMesh?.parent?.children.some(child =>
          child.name === 'forestInstanced' && child.userData.forestPart === 'ezBranches'));
        await page.locator('#gameCanvas canvas').waitFor({ state: 'visible' });
        // Preserve each revision's actual defaults for sibling panels. In the
        // before layout auth can cover Stats, so normalizing it could prevent
        // capturing the very overlap this evidence is meant to reveal.
        for (const expanded of [false, true]) {
          await setExpanded(page, '#toggleCamera', expanded, viewport.touch);
          await delay(350); // Allow the old panel's 300ms CSS transition to settle.
          const filename = `${label}-${viewport.name}-${expanded ? 'expanded' : 'collapsed'}.png`;
          await page.screenshot({ path: join(output, filename), animations: 'disabled' });
          evidence.push({
            filename, commit, viewport, cameraExpanded: expanded,
            ...await page.evaluate(() => ({
              url: location.href,
              ezBranchMeshes: window.terrainMesh.parent.children.filter(child =>
                child.name === 'forestInstanced' && child.userData.forestPart === 'ezBranches').length,
              panels: ['controlsInfo', 'gameStatsContainer', 'authContainer', 'cameraControls', 'courseHud'].map(id => {
                const element = document.getElementById(id);
                const bounds = element?.getBoundingClientRect();
                return { id, collapsed: element?.classList.contains('collapsed'), bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null };
              }),
            })),
          });
          await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
          console.log(`HUD review: ${filename}`);
        }
      } finally {
        await context.close();
      }
    }
  });
}

try {
  await mkdir(output, { recursive: true });
  let baseCommit;
  if (baseRef) {
    if (!/^[a-f0-9]{7,40}$/i.test(baseRef)) throw new Error('HUD_BASE_REF must be a local commit SHA. Fetch it before running this script.');
    baseCommit = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'snowglider-hud-')));
    const candidate = join(temporaryDirectory, 'before');
    git(['worktree', 'add', '--detach', candidate, baseCommit]);
    beforeWorktree = candidate;
    await symlink(join(root, 'node_modules'), join(beforeWorktree, 'node_modules'), 'dir');
  }
  browser = await chromium.launch({ headless: true });
  if (beforeWorktree) await captureVersion('before', beforeWorktree, 8084, baseCommit);
  await captureVersion('after', root, 8085, git(['rev-parse', 'HEAD']));
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (beforeWorktree) git(['worktree', 'remove', '--force', beforeWorktree]);
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
