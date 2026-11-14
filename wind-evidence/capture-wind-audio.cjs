const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('/workspace/scratch/a21195a756ba/snowglider/node_modules/playwright');
const output = __dirname;
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const BASE_COMMIT = '5738d94e8b3c6214e3c005256b802570c56cdbec';
const HEAD_COMMIT = '9660fc069c86b4a777f978a4b33e030c93922e8f';
const SOURCE_PATH = 'src/sfx.ts';
// Audio evidence qualifies this source module on these exact commits. A later
// change elsewhere in the game does not silently relabel these captures.
async function sourceStamp(root, commit) {
  const bytes = await fs.readFile(path.join(root, SOURCE_PATH));
  const committed = execFileSync('git', ['show', commit + ':' + SOURCE_PATH], { cwd: root });
  if (!bytes.equals(committed)) throw new Error('Uncommitted audio source at ' + root);
  return { commit, source: SOURCE_PATH, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const servers = [];
async function startServer(cwd, port) {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Vite timeout: ' + log)), 20000);
    child.stdout.on('data', chunk => { log += chunk; if (log.includes('Local:')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Vite exited ' + code + ': ' + log)); });
  });
}
(async () => {
  await startServer('/workspace/scratch/b943da49f5fb/snowglider', 8108);
  await startServer('/workspace/scratch/a21195a756ba/snowglider', 8107);
  const browser = await chromium.launch({ executablePath: '/home/agent/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--renderer-process-limit=1'] });
  const reports = {
    provenance: {
      before: await sourceStamp('/workspace/scratch/b943da49f5fb/snowglider', BASE_COMMIT),
      after: await sourceStamp('/workspace/scratch/a21195a756ba/snowglider', HEAD_COMMIT),
      capturedAt: new Date().toISOString(),
      engine: 'Chromium 152.0.7977.75 OfflineAudioContext',
      method: 'Production Sfx module, controlled read-only wind/velocity/camera inputs; no music or microphone',
      signals: '0–3s calm; 3–6s open gust; 6–10s headwind; 10–14s tailwind; 14–18s forest left; 18–22s camera reversal; 22–24s mute',
      measurement: 'Float audio samples before PCM16 conversion. Segment metrics exclude the first 1s and final 0.1s; global metrics cover the complete 24s.',
    },
  };
  try {
    for (const [label, port] of [['before', 8108], ['after', 8107]]) {
      const page = await browser.newPage();
      await page.route('**/wind-audio-evidence.html', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Wind-only audio capture</title>' }));
      await page.goto(`http://127.0.0.1:${port}/wind-audio-evidence.html`);
      const captured = await page.evaluate(async () => {
        const sampleRate = 24000, seconds = 24;
        const context = new OfflineAudioContext(2, sampleRate * seconds, sampleRate);
        const OriginalAudioContext = window.AudioContext;
        window.AudioContext = function() { return context; };
        window.isTestMode = true;
        window.testHooks = { sfxEnabled: true };
        localStorage.setItem('snowgliderMuted', 'false');
        // Reproducible baseline white noise; HEAD has its own private seeded noise.
        let seed = 0x61756469;
        const originalRandom = Math.random;
        Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
        const module = await import('/src/sfx.ts');
        const { Sfx } = module;
        Sfx.setMuted(false);
        Sfx.unlock();
        const stages = [
          { name: 'Calm at rest', start: 0, end: 3 },
          { name: 'Gust across open slope', start: 3, end: 6 },
          { name: 'Skiing into headwind', start: 6, end: 10 },
          { name: 'Skiing with tailwind', start: 10, end: 14 },
          { name: 'Forest wind from left', start: 14, end: 18 },
          { name: 'Camera turns: wind from right', start: 18, end: 22 },
          { name: 'Sound muted', start: 22, end: 24 },
        ];
        const update = (t) => {
          let windX = 0, windZ = 0, velocityZ = 0, strength = 0, gust = 0, forest = 0;
          if (t >= 3 && t < 6) {
            const phase = (t - 3) / 3;
            gust = Math.sin(phase * Math.PI);
            strength = 0.35 + gust * 0.55;
            windX = 2 + 5 * gust;
          } else if (t >= 6 && t < 14) {
            windZ = t < 10 ? 6 : -6;
            velocityZ = -10;
            strength = 0.8;
            gust = 0.75;
          } else if (t >= 14) {
            windX = 6;
            strength = 0.85;
            gust = 0.8;
            forest = 1;
          }
          const motion = { windX, windZ, velocityX: 0, velocityZ, cameraRightX: t < 18 ? 1 : -1, cameraRightZ: 0 };
          const mapping = module.windAudioForMotion?.(motion, strength);
          const pan = mapping?.environmentalPan ?? 0;
          Sfx.setMuted(t >= 22);
          Sfx.updateSkiing(Math.abs(velocityZ), 'glide', false, strength, motion);
          Sfx.updateWindHowl(strength, gust, pan);
          Sfx.updateForest(strength, gust, forest, pan);
        };
        update(0);
        const pending = [];
        for (let i = 1; i < seconds * 20; i++) {
          const t = i / 20;
          pending.push(context.suspend(t).then(async () => {
            update(context.currentTime);
            await context.resume();
          }));
        }
        const rendered = await context.startRendering();
        await Promise.all(pending);
        const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
        const measure = (start, end) => {
          let l = 0, r = 0, peak = 0, clipped = 0;
          const first = Math.ceil(start * sampleRate), last = Math.floor(end * sampleRate);
          for (let i = first; i < last; i++) {
            l += left[i] * left[i]; r += right[i] * right[i];
            peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
            if (Math.abs(left[i]) >= 1 || Math.abs(right[i]) >= 1) clipped++;
          }
          return { rmsLeft: Math.sqrt(l / (last - first)), rmsRight: Math.sqrt(r / (last - first)), peak, clippedSamples: clipped };
        };
        const metrics = stages.map(s => ({ ...s, ...measure(s.start + 1, s.end - 0.1) }));
        const global = measure(0, seconds);
        const wav = new ArrayBuffer(44 + left.length * 4);
        const view = new DataView(wav);
        const tag = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
        tag(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
        view.setUint16(32, 4, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, left.length * 4, true);
        for (let i = 0; i < left.length; i++) {
          view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
          view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
        }
        const bytes = new Uint8Array(wav);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        Sfx.teardown();
        Math.random = originalRandom;
        window.AudioContext = OriginalAudioContext;
        return { base64: btoa(binary), metrics, global, sampleRate, seconds };
      });
      await fs.writeFile(path.join(output, `wind-audio-${label}.wav`), Buffer.from(captured.base64, 'base64'));
      delete captured.base64;
      reports[label] = captured;
      await page.close();
    }
    await sourceStamp('/workspace/scratch/b943da49f5fb/snowglider', BASE_COMMIT);
    await sourceStamp('/workspace/scratch/a21195a756ba/snowglider', HEAD_COMMIT);
    await fs.writeFile(path.join(output, 'wind-audio-metrics.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports, null, 2));
  } finally { await browser.close(); for (const server of servers) server.kill(); }
})().catch(error => { console.error(error); for (const server of servers) server.kill(); process.exitCode = 1; });
