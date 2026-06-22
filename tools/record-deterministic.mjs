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
    // Keep the gameplay HUD (controls list, stats incl. the technique Status field,
    // course progress + avalanche warning) so the clip actually shows the controls
    // and technique; hide only account/dev chrome and end-of-run overlays. Pin the
    // stats panel into a compact top-right box so it never covers the centred
    // snowman, and keep the controls list tucked in the top-left corner.
    await page.addStyleTag({ content: `
      #resetBtn, #cameraToggleBtn, .touch-control, #authContainer, #introSkipBtn,
      #audioControlBtn, #gameOverOverlay, #courseResult,
      div[style*="z-index: 3000"] { display: none !important; }
      #gameStatsContainer {
        top: 8px !important; right: 8px !important; left: auto !important;
        max-width: 200px !important; font-size: 12px !important; padding: 6px 9px !important;
        overflow: visible !important;
      }
      #gameStatsContent {
        display: flex !important; flex-direction: column !important; gap: 4px !important;
        max-height: none !important; overflow: visible !important;
      }
      .stat-item { display: flex !important; flex-direction: column !important; }
      #controlsInfo { font-size: 12px !important; opacity: 0.92; }
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

  // --- Choreography: a deliberate run that demonstrates each ski technique, a
  // jump, then the avalanche giving chase — instead of an aimless slalom.
  // Each segment is [technique, seconds]; 'parallel' alternates quick L/R turns,
  // 'jump' pulses Space. Keys: ArrowUp=tuck, ArrowDown=snowplow, ArrowLeft/Right=
  // carve/turn. A long closing tuck travels far enough to wake the avalanche.
  const SEGMENTS = [
    ['glide', 1.2],   // ease in, build speed
    ['tuck', 2.3],    // ⬆ tuck — straight-line, aero crouch, top speed
    ['right', 1.8],   // ➡ carve — hold a smooth wide arc
    ['left', 1.8],    // ⬅ carve the other way
    ['parallel', 1.6],// quick parallel turns (scrub speed)
    ['tuck', 1.7],    // rebuild speed into the jump
    ['jump', 1.5],    // ⎵ jump — launch at speed and get air
    ['tuck', 1.8],    // land and bomb downhill (wakes the avalanche)
    ['plow', 1.5],    // ⬇ snowplow / pizza — wedge and slow
    ['tuck', 9.0],    // outrun, then get chased down by the avalanche
  ];
  const steer = new Array(FRAMES).fill(null); // per-frame turn/tuck/plow key or null
  const jumpFrames = new Set();               // frames to hold Space (jump)
  {
    let f = 0;
    for (const [tech, secs] of SEGMENTS) {
      const len = Math.round(FPS * secs);
      if (tech === 'parallel') {
        let d = 'ArrowRight';
        for (let i = 0; i < len; i++) {
          if (i > 0 && i % Math.round(FPS * 0.55) === 0) d = d === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
          if (f + i < FRAMES) steer[f + i] = d;
        }
      } else if (tech === 'jump') {
        for (let i = 0; i < 3; i++) if (f + i < FRAMES) jumpFrames.add(f + i); // brief Space hold
      } else {
        const key = tech === 'tuck' ? 'ArrowUp' : tech === 'plow' ? 'ArrowDown'
          : tech === 'left' ? 'ArrowLeft' : tech === 'right' ? 'ArrowRight' : null;
        for (let i = 0; i < len && f + i < FRAMES; i++) steer[f + i] = key;
      }
      f += len;
    }
  }
  // Desired held keys for a given frame (steer key + Space during a jump).
  const keysAt = (i) => {
    const set = new Set();
    if (steer[i]) set.add(steer[i]);
    if (jumpFrames.has(i)) set.add('Space');
    return set;
  };
  const held = new Set();
  const applyKeys = async (target) => {
    for (const k of [...held]) if (!target.has(k)) { held.delete(k); await page.keyboard.up(k); }
    for (const k of target) if (!held.has(k)) { held.add(k); await page.keyboard.down(k); }
  };

  // Fast survival probe: one pass, no screenshots, report how long the run lasts
  // for this seed/choreography. Used to pick a seed that survives the whole show.
  if (PROBE) {
    let dead = 0, survived = 0;
    for (let i = 0; i < FRAMES; i++) {
      await applyKeys(keysAt(i));
      const n = await pump(DT);
      if (n === 0) { if (++dead >= 2) { survived = i - 1; break; } } else { dead = 0; survived = i; }
    }
    console.log(`SEED ${SEED} survived ${survived} frames (${(survived / FPS).toFixed(1)}s)`);
    await browser.close();
    process.exit(0);
  }

  console.log(`Deterministic capture: ${FRAMES} frames @ ${FPS}fps (${SECONDS}s game-time)...`);

  // The run can still die (a tree, or burial by the avalanche), freezing the loop.
  // Auto-restart on death; the build step keeps the longest contiguous clean run.
  const ran = new Array(FRAMES).fill(0);
  let deadStreak = 0, runStart = 0;
  for (let i = 0; i < FRAMES; i++) {
    await applyKeys(keysAt(i));
    const n = await pump(DT);
    ran[i] = n;
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    fs.writeFileSync(path.join(OUT, `f${String(i).padStart(5, '0')}.jpg`), buf);

    if (n === 0) {
      deadStreak++;
      if (deadStreak >= 2) {
        await applyKeys(new Set());
        await page.evaluate(() => { if (typeof window.restartGame === 'function') window.restartGame(); });
        await warmUntilAlive();
        console.log(`  frame ${i}: run ended (lasted ~${((i - runStart) / FPS).toFixed(1)}s) — restarted`);
        deadStreak = 0; runStart = i + 1;
      }
    } else {
      deadStreak = 0;
    }
    if (i % 60 === 0) console.log(`  frame ${i}/${FRAMES}`);
  }
  await applyKeys(new Set());
  fs.writeFileSync(path.join(OUT, 'ran.json'), JSON.stringify(ran));
  console.log(`Done -> ${OUT} (${FRAMES} frames)`);
} finally {
  await browser.close();
}
