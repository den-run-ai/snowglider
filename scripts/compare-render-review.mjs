// Same-runner BASE/HEAD image review; only an explicitly approved commit can turn
// differences into a visual acceptance gate. Missing inputs always fail. No code
// path creates/updates a baseline. PNG comes from the pinned Playwright toolchain.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle');

export const REVIEW_DEVICES = ['desktop', 'phone'];
export const REVIEW_PHASES = ['spawn', 'downhill', 'avalanche', 'spray', 'crash',
  'orbit-entry', 'orbit-first-update', 'orbit-second-update'];
const SHA = /^[0-9a-f]{40}$/;
const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

async function readCapture(directory) {
  const captures = [];
  for (const device of REVIEW_DEVICES) {
    const capture = JSON.parse(await fs.readFile(path.join(directory, `${device}.json`), 'utf8'));
    if (capture.schema !== 1 || !SHA.test(capture.commit) || !Number.isInteger(capture.seed) || capture.device !== device ||
        !Array.isArray(capture.frames) || capture.frames.length !== REVIEW_PHASES.length) {
      throw new Error(`Invalid/incomplete ${device} capture manifest in ${directory}`);
    }
    for (let i = 0; i < REVIEW_PHASES.length; i++) {
      const phase = REVIEW_PHASES[i];
      const frame = capture.frames[i];
      if (frame.image !== `${device}-${phase}.png` || frame.metrics?.phase !== phase) {
        throw new Error(`Missing, duplicated or unsafe image name for ${device}/${phase}`);
      }
      const bytes = await fs.readFile(path.join(directory, frame.image));
      const png = PNG.sync.read(bytes);
      if (!png.width || !png.height) throw new Error(`Empty screenshot: ${frame.image}`);
      // All-black/transparent screenshots must not establish a false clean pair.
      let varied = false;
      for (let pixel = 4; pixel < png.data.length; pixel += 4) {
        if (png.data[pixel] !== png.data[0] || png.data[pixel + 1] !== png.data[1] || png.data[pixel + 2] !== png.data[2]) {
          varied = true;
          break;
        }
      }
      if (!varied) throw new Error(`Blank screenshot: ${frame.image}`);
      captures.push({ commit: capture.commit, seed: capture.seed, device, phase, image: frame.image, metrics: frame.metrics, bytes, png });
    }
  }
  if (new Set(captures.map(capture => capture.commit)).size !== 1) throw new Error('Capture projects used different commits');
  return captures;
}

export async function compareRenderReview({ baselineDir, candidateDir, outputDir, approvedBaseline = '', maxChangedRatio = 0.001, pixelThreshold = 16 }) {
  if (approvedBaseline && !SHA.test(approvedBaseline)) throw new Error('Approved baseline must be a full 40-character commit SHA');
  if (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) throw new Error('Invalid changed-pixel ratio');
  if (!Number.isInteger(pixelThreshold) || pixelThreshold < 0 || pixelThreshold > 255) throw new Error('Invalid channel threshold');
  const [baseline, candidate] = await Promise.all([readCapture(baselineDir), readCapture(candidateDir)]);
  const baseCommit = baseline[0].commit;
  const headCommit = candidate[0].commit;
  if (approvedBaseline && approvedBaseline !== baseCommit) throw new Error('Captured baseline does not match the explicitly approved commit');
  await Promise.all(['base', 'head', 'diff'].map(folder => fs.mkdir(path.join(outputDir, folder), { recursive: true })));
  const frames = [];
  for (let i = 0; i < baseline.length; i++) {
    const before = baseline[i], after = candidate[i];
    if (before.image !== after.image || before.seed !== after.seed) throw new Error('Capture scenarios/seeds differ');
    const a = before.png, b = after.png;
    const sameSize = a.width === b.width && a.height === b.height;
    const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
    const diff = new PNG({ width, height });
    let changed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const out = (y * width + x) * 4;
        const ai = (y * a.width + x) * 4, bi = (y * b.width + x) * 4;
        const outside = x >= a.width || y >= a.height || x >= b.width || y >= b.height;
        const different = outside || [0, 1, 2, 3].some(channel => Math.abs(a.data[ai + channel] - b.data[bi + channel]) > pixelThreshold);
        if (different) changed++;
        const grey = outside ? 40 : Math.round((b.data[bi] + b.data[bi + 1] + b.data[bi + 2]) / 6);
        diff.data[out] = different ? 255 : grey;
        diff.data[out + 1] = different ? 40 : grey;
        diff.data[out + 2] = different ? 80 : grey;
        diff.data[out + 3] = 255;
      }
    }
    const ratio = changed / (width * height);
    frames.push({ image: before.image, device: before.device, phase: before.phase,
      sameSize, changedPixels: changed, changedRatio: ratio,
      before: before.metrics, after: after.metrics,
      exceedsTolerance: !sameSize || ratio > maxChangedRatio });
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'base', before.image), before.bytes),
      fs.writeFile(path.join(outputDir, 'head', after.image), after.bytes),
      fs.writeFile(path.join(outputDir, 'diff', before.image), PNG.sync.write(diff))
    ]);
  }
  const report = { schema: 1, mode: approvedBaseline ? 'approved-baseline' : 'review-only',
    baseCommit, headCommit, approvedBaseline: approvedBaseline || null, pixelThreshold, maxChangedRatio,
    differences: frames.filter(frame => frame.exceedsTolerance).length, frames };
  const cards = frames.map(frame => `<article><h2>${escape(frame.device)} / ${escape(frame.phase)} — ${(frame.changedRatio * 100).toFixed(2)}% changed</h2>
    <div class="images">${['base', 'head', 'diff'].map(side => `<figure><figcaption>${side}</figcaption><a href="${side}/${frame.image}"><img src="${side}/${frame.image}" alt="${side} ${escape(frame.phase)}"></a></figure>`).join('')}</div>
    <details><summary>Metrics and camera state</summary><pre>${escape(JSON.stringify({ before: frame.before, after: frame.after }, null, 2))}</pre></details></article>`).join('\n');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SnowGlider rendering comparison</title>
    <style>body{font:16px system-ui;margin:24px;background:#172130;color:#e9f1fa}h1{font-size:24px}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0}img{width:100%;height:auto}article{margin:32px 0}pre{white-space:pre-wrap}a{color:inherit}@media(max-width:700px){.images{grid-template-columns:1fr}}</style>
    <h1>SnowGlider rendering comparison</h1><p>${report.mode === 'review-only' ? 'Review evidence; differences require human assessment. This is not an approved visual baseline.' : 'Comparison against an explicitly approved commit.'}</p>
    <p>Base <code>${baseCommit}</code><br>Head <code>${headCommit}</code></p>
    <p>Fixed practice seed and prescribed phase positions; exact 60 Hz simulation steps. Canvas captures exclude HTML overlays. Timings are CPU submission and GPU-finished service times on this runner, not device FPS guarantees.</p>
    <p>${report.differences}/${frames.length} images exceed ${(maxChangedRatio * 100).toFixed(2)}% changed pixels at channel threshold ${pixelThreshold}. Source baseline captures remain unchanged; this report does not approve them.</p>${cards}</html>`;
  await Promise.all([
    fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2)),
    fs.writeFile(path.join(outputDir, 'index.html'), html)
  ]);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baselineDir, candidateDir, outputDir] = process.argv.slice(2);
  if (!baselineDir || !candidateDir || !outputDir) throw new Error('Usage: node scripts/compare-render-review.mjs BASE_DIR HEAD_DIR OUTPUT_DIR');
  const report = await compareRenderReview({ baselineDir, candidateDir, outputDir,
    approvedBaseline: process.env.RENDER_APPROVED_BASELINE_SHA || '',
    maxChangedRatio: Number(process.env.RENDER_MAX_CHANGED_RATIO || '0.001') });
  console.log(JSON.stringify({ mode: report.mode, base: report.baseCommit, head: report.headCommit, differences: report.differences }));
  if (report.mode === 'approved-baseline' && report.differences) process.exitCode = 1;
}
