// @ts-check
// Exercise comparison IO and acceptance behavior with actual PNG fixtures. A
// missing baseline, incomplete capture or revision mismatch must never be green.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PNG } = require('playwright-core/lib/utilsBundle');
const yaml = require('js-yaml');

async function main() {
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/render-review.yml'), 'utf8'));
  // The real capture boots index.html through Vite; the document owns its module
  // graph/import map and loads styles/main.css, which styles the game canvas.
  for (const filename of ['index.html', 'styles/main.css', 'vite.config.js', 'src/main.ts',
    'tests/e2e/render-scenarios.ts', 'playwright.render-review.config.ts',
    'scripts/compare-render-review.mjs', 'package-lock.json']) {
    assert.ok(workflow.on.pull_request.paths.some(pattern => path.matchesGlob(filename, pattern)),
      `render review must run when ${filename} changes alone`);
  }
  const { compareRenderReview, REVIEW_DEVICES, REVIEW_PHASES } = await import('../scripts/compare-render-review.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowglider-render-review-'));
  const base = path.join(temp, 'base'), head = path.join(temp, 'head'), out = path.join(temp, 'comparison');
  const baseCommit = 'a'.repeat(40), headCommit = 'b'.repeat(40);
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  png.data[0] = 0; // nonblank fixture
  const original = PNG.sync.write(png);
  async function capture(directory, commit) {
    await fs.mkdir(directory, { recursive: true });
    for (const device of REVIEW_DEVICES) {
      const frames = [];
      for (const phase of REVIEW_PHASES) {
        const image = `${device}-${phase}.png`;
        await fs.writeFile(path.join(directory, image), original);
        frames.push({ image, metrics: { phase } });
      }
      await fs.writeFile(path.join(directory, `${device}.json`), JSON.stringify({ schema: 1, commit, seed: 42, device, frames }));
    }
  }
  try {
    await capture(base, baseCommit);
    await capture(head, headCommit);
    const options = { baselineDir: base, candidateDir: head, outputDir: out };
    const same = await compareRenderReview(options);
    assert.equal(same.mode, 'review-only');
    assert.equal(same.differences, 0);
    assert.equal(same.frames.length, 16);
    assert.equal(same.approvedBaseline, null);
    assert.match(await fs.readFile(path.join(out, 'index.html'), 'utf8'), /not an approved visual baseline/);

    png.data[4] = 0;
    await fs.writeFile(path.join(head, 'desktop-spray.png'), PNG.sync.write(png));
    const review = await compareRenderReview(options);
    assert.equal(review.differences, 1);
    assert.equal(review.frames.find(frame => frame.phase === 'spray' && frame.device === 'desktop').changedRatio, .25);
    const gated = await compareRenderReview({ ...options, approvedBaseline: baseCommit });
    assert.equal(gated.mode, 'approved-baseline');
    assert.equal(gated.differences, 1);
    const command = [path.join(__dirname, '../scripts/compare-render-review.mjs'), base, head, out];
    const reviewExit = spawnSync(process.execPath, command, { env: { ...process.env, RENDER_APPROVED_BASELINE_SHA: '' } });
    const gateExit = spawnSync(process.execPath, command, { env: { ...process.env, RENDER_APPROVED_BASELINE_SHA: baseCommit } });
    assert.equal(reviewExit.status, 0, 'unapproved visual differences are review evidence');
    assert.equal(gateExit.status, 1, 'explicit approved-baseline differences fail the actual CLI');
    assert.deepEqual(await fs.readFile(path.join(base, 'desktop-spray.png')), original, 'comparison must not update the baseline');
    await assert.rejects(compareRenderReview({ ...options, approvedBaseline: headCommit }), /does not match/);
    await assert.rejects(compareRenderReview({ ...options, approvedBaseline: 'main' }), /full 40/);
    await assert.rejects(compareRenderReview({ ...options, baselineDir: path.join(temp, 'missing') }), /ENOENT/);
    await fs.unlink(path.join(base, 'phone-crash.png'));
    await assert.rejects(compareRenderReview(options), /ENOENT/);
    await fs.writeFile(path.join(base, 'phone-crash.png'), original);
    const manifestPath = path.join(base, 'phone.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.frames[0].image = '../escape.png';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(compareRenderReview(options), /unsafe image/);
    manifest.frames[0].image = 'phone-spawn.png';
    manifest.frames.pop();
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(compareRenderReview(options), /incomplete/);
    console.log('Render review: exact revisions, complete PNG sets, real diffs, explicit approval, immutable/missing baseline and safe paths verified.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
