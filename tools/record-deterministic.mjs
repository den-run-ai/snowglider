// Deterministic demo recorder for the README video. Not part of the test suite.
//
// The game renders at only a few fps under headless software-GL, so a real-time
// screencast is choppy. Instead we install a *virtual clock*: requestAnimationFrame
// and performance.now()/Date.now() are overridden so the page's animation only
// advances when we "pump" it. During init we auto-pump (≈ real time) so loading and
// the game-start sequence run normally; during capture we pump exactly one fixed
// timestep per screenshot. Each screenshot is therefore a genuine render at an exact
// game-time, so the assembled 30fps clip is perfectly smooth with no interpolation.
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const URL = process.env.REC_URL || 'https://snowglider.ai/?intro=off';
const OUT = process.env.REC_OUT || '/tmp/demo-det';
const FPS = Number(process.env.REC_FPS || 30);
const SECONDS = Number(process.env.REC_SECONDS || 20);
const W = Number(process.env.REC_W || 1280), H = Number(process.env.REC_H || 720);
const CLEAN = process.env.REC_CLEAN === '1';
const PROBE = process.env.REC_PROBE === '1'; // fast survival probe: no screenshots, one run
const SEED = process.env.REC_SEED != null ? Number(process.env.REC_SEED) : null;
const DT = 1000 / FPS;
const FRAMES = Math.round(FPS * SECONDS);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Installed before any page script runs: freezes time and rAF behind a pump(),
// and (optionally) seeds Math.random so tree layout / avalanche are reproducible.
function installVirtualClock(seed) {
  if (seed != null) {
    let a = seed >>> 0;
    Math.random = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const cbs = [];
  let vnow = 0, nid = 1;
  window.requestAnimationFrame = function (cb) { const id = nid++; cbs.push([id, cb]); return id; };
  window.cancelAnimationFrame = function (id) { const i = cbs.findIndex(e => e[0] === id); if (i >= 0) cbs.splice(i, 1); };
  try { Object.defineProperty(performance, 'now', { value: () => vnow, configurable: true }); }
  catch (e) { try { performance.now = () => vnow; } catch (_) {} }
  const baseEpoch = Date.now();
  try { Date.now = () => baseEpoch + vnow; } catch (e) {}
  window.__vclock = {
    pump(dt) { vnow += dt; const run = cbs.splice(0, cbs.length); for (const [, cb] of run) { try { cb(vnow); } catch (e) { console.error('raf', e); } } return run.length; },
    now: () => vnow,
    pending: () => cbs.length,
  };
}

const browser = await puppeteer.launch({
  headless: 'new', acceptInsecureCerts: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
    '--ignore-certificate-errors', '--allow-insecure-localhost',
    '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installVirtualClock, SEED);
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Auto-pump (≈ real time) so async init / game-start can complete.
  let autoPump = setInterval(() => { page.evaluate((dt) => window.__vclock.pump(dt), DT).catch(() => {}); }, 16);

  await page.waitForFunction(() => typeof window.initializeGameWithAudio === 'function', { timeout: 30000 });
  await page.waitForSelector('#startGameButton', { timeout: 10000 });
  await page.click('#startGameButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('startGameContainer');
    return c && c.style.display === 'none';
  }, { timeout: 10000 });

  if (CLEAN) {
    await page.addStyleTag({ content: `
      #controlsInfo, #gameStatsContainer, #courseHud, #resetBtn, #cameraToggleBtn,
      .touch-control, #authContainer, #introSkipBtn, #audioControlBtn,
      #gameOverOverlay, #courseResult,
      div[style*="z-index: 3000"] { display: none !important; }
    ` });
  }

  await wait(1200); // let the opening settle under auto-pump
  clearInterval(autoPump);
  await wait(150); // let any in-flight auto-pump evaluate settle

  // Pump until the game loop is actually alive (re-queuing in our virtual rAF) for
  // a few consecutive frames, so death-detection doesn't fire on a cold-start frame.
  const pump = (dt) => page.evaluate((d) => window.__vclock.pump(d), dt);
  async function warmUntilAlive() {
    let alive = 0;
    for (let i = 0; i < 90 && alive < 6; i++) { const n = await pump(DT); if (n > 0) alive++; else alive = 0; }
    return alive >= 6;
  }
  await warmUntilAlive();
  // The very first start frame tends to register a spurious game-over under the
  // virtual clock; a restart drops us into a clean, stable run (verified visually).
  await page.evaluate(() => { if (typeof window.restartGame === 'function') window.restartGame(); });
  await warmUntilAlive();

  // Scripted gentle symmetric slalom on the virtual timeline (frame indices).
  const held = new Set();
  const setKey = async (key, down) => {
    if (down && !held.has(key)) { held.add(key); await page.keyboard.down(key); }
    if (!down && held.has(key)) { held.delete(key); await page.keyboard.up(key); }
  };
  // Per-frame steering plan: a short straight glide to build speed, then a gentle
  // symmetric slalom that weaves around the fall line for skiing "life" without
  // wandering into the side trees (a tuck bombs straight into them; this survives).
  const plan = new Array(FRAMES).fill(null);
  const glide = Math.round(FPS * 1.2);
  const hold = Math.round(FPS * 0.7), gap = Math.round(FPS * 0.45);
  let f = glide, dir = 'ArrowLeft';
  while (f < FRAMES) {
    for (let i = 0; i < hold && f < FRAMES; i++, f++) plan[f] = dir;
    f += gap;
    dir = dir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
  }

  // Fast survival probe: one pass, no screenshots, report how long the run lasts
  // for this seed/plan. Used to pick a seed that survives well before the (slow)
  // screenshot capture.
  if (PROBE) {
    let dead = 0, survived = 0;
    for (let i = 0; i < FRAMES; i++) {
      const want = plan[i];
      await setKey('ArrowLeft', want === 'ArrowLeft');
      await setKey('ArrowRight', want === 'ArrowRight');
      await setKey('ArrowUp', want === 'ArrowUp');
      const n = await pump(DT);
      if (n === 0) { if (++dead >= 2) { survived = i - 1; break; } } else { dead = 0; survived = i; }
    }
    console.log(`SEED ${SEED} survived ${survived} frames (${(survived / FPS).toFixed(1)}s)`);
    await browser.close();
    process.exit(0);
  }

  console.log(`Deterministic capture: ${FRAMES} frames @ ${FPS}fps (${SECONDS}s game-time)...`);

  // The run can die unpredictably (a tree, or burial by the randomly-seeded
  // avalanche), which freezes the loop. To reliably harvest a long clean clip we
  // capture a long session and auto-restart whenever the loop goes idle; the build
  // step then extracts the longest contiguous segment of distinct frames.
  const ran = new Array(FRAMES).fill(0);
  let deadStreak = 0, runStart = 0, planIdx = 0;
  for (let i = 0; i < FRAMES; i++) {
    const want = plan[(planIdx++) % plan.length];
    await setKey('ArrowLeft', want === 'ArrowLeft');
    await setKey('ArrowRight', want === 'ArrowRight');
    await setKey('ArrowUp', want === 'ArrowUp');
    const n = await pump(DT);
    ran[i] = n;
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    fs.writeFileSync(path.join(OUT, `f${String(i).padStart(5, '0')}.jpg`), buf);

    if (n === 0) {
      deadStreak++;
      if (deadStreak >= 2) {
        // Loop is dead/frozen → restart for a fresh run and re-prime the loop.
        await setKey('ArrowLeft', false); await setKey('ArrowRight', false); await setKey('ArrowUp', false);
        await page.evaluate(() => { if (typeof window.restartGame === 'function') window.restartGame(); });
        await warmUntilAlive();
        console.log(`  frame ${i}: run ended (lasted ~${((i - runStart) / FPS).toFixed(1)}s) — restarted`);
        deadStreak = 0; runStart = i + 1; planIdx = 0;
      }
    } else {
      deadStreak = 0;
    }
    if (i % 60 === 0) console.log(`  frame ${i}/${FRAMES}`);
  }
  await setKey('ArrowLeft', false); await setKey('ArrowRight', false); await setKey('ArrowUp', false);
  fs.writeFileSync(path.join(OUT, 'ran.json'), JSON.stringify(ran));
  console.log(`Done -> ${OUT} (${FRAMES} frames)`);
} finally {
  await browser.close();
}
