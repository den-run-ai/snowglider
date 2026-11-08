import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RENDER_PHASES, REVIEW_SEED, prepareRenderScenario, enterRenderPhase,
  measureRenderPhase, assertRenderPhase, captureRenderCanvas, setObstructedOrbitFrame,
  AUTO_REVIEW_PHASES, setAutoReviewFrame
} from '../e2e/render-scenarios';
import { SNOW_PHASES, prepareSnowFrame, enterSnowPhase, measureSnowSurface } from '../e2e/snow-rendering-scenarios';

test('capture prescribed player phases for an explicit revision', async ({ page }, testInfo) => {
  const commit = process.env.RENDER_COMMIT;
  expect(commit, 'capture requires an exact commit, never an implicit/minted baseline').toMatch(/^[0-9a-f]{40}$/);
  const appDirectory = path.resolve(process.env.RENDER_APP_DIR || '.');
  expect(execFileSync('git', ['-C', appDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'served checkout matches the declared revision').toBe(commit);
  const output = path.resolve(process.env.RENDER_OUTPUT_DIR || 'test-results/render-review');
  await fs.mkdir(output, { recursive: true });
  const errors = await prepareRenderScenario(page);
  const frames = [];
  for (const phase of RENDER_PHASES) {
    await enterRenderPhase(page, phase);
    const metrics = await measureRenderPhase(page, phase);
    // Older BASE revisions legitimately predate the new batching structures.
    // Both captures still require actual effects, finite geometry and real draws.
    assertRenderPhase(metrics, false);
    const image = `${testInfo.project.name}-${phase}.png`;
    await fs.writeFile(path.join(output, image), await captureRenderCanvas(page));
    frames.push({ image, metrics });
  }
  for (const update of [0, 1, 2] as const) {
    const metrics = await setObstructedOrbitFrame(page, update);
    const image = `${testInfo.project.name}-${metrics.phase}.png`;
    await fs.writeFile(path.join(output, image), await captureRenderCanvas(page));
    frames.push({ image, metrics });
  }
  for (const phase of AUTO_REVIEW_PHASES) {
    const metrics = await setAutoReviewFrame(page, phase);
    expect(metrics.camera.every(Number.isFinite), `${phase}: finite camera`).toBe(true);
    expect(metrics.clearance, `${phase}: camera stays above terrain`).toBeGreaterThanOrEqual(5 - 1e-6);
    const image = `${testInfo.project.name}-${phase}.png`;
    await fs.writeFile(path.join(output, image), await captureRenderCanvas(page));
    frames.push({ image, metrics });
  }
  // Reload the actual player scene so both revisions begin from the exact static
  // midday endpoint. The game clock stays frozen while the real sun cycle moves
  // to golden hour; geometry, textures and camera stay identical between shots.
  const snowErrors = await prepareRenderScenario(page);
  await prepareSnowFrame(page);
  for (const phase of SNOW_PHASES) {
    await enterSnowPhase(page, phase);
    const { lit, shade } = await measureSnowSurface(page);
    console.log('Snow render review', JSON.stringify({ commit, project: testInfo.project.name, phase, lit, shade }));
    const image = `${testInfo.project.name}-snow-${phase}.png`;
    await fs.writeFile(path.join(output, image), await captureRenderCanvas(page));
    frames.push({ image, metrics: { phase: `snow-${phase}`, lit, shade } });
  }
  expect(errors, 'capture failed due to uncaught page/shader errors').toEqual([]);
  expect(snowErrors, 'snow capture failed due to uncaught page/shader errors').toEqual([]);
  await fs.writeFile(path.join(output, `${testInfo.project.name}.json`), JSON.stringify({
    schema: 1, commit, seed: REVIEW_SEED, device: testInfo.project.name,
    viewport: page.viewportSize(), frames
  }, null, 2));
});

// Run the same finish fixture against both exact revisions. Capture the entire
// viewport so review shows whether replay is reachable without scrolling; keep
// these UI images separate from the established canvas/physics comparison.
test('capture the finish dialog and replay controls', async ({ page }, testInfo) => {
  const output = path.resolve(process.env.RENDER_OUTPUT_DIR || 'test-results/render-review');
  await fs.mkdir(output, { recursive: true });
  if (testInfo.project.name === 'phone') await page.setViewportSize({ width: 428, height: 750 });
  const errors = await prepareRenderScenario(page);
  await enterRenderPhase(page, 'downhill');
  await page.evaluate(() => {
    const w = window as unknown as { simElapsed: number; showGameOver: (reason: string) => void };
    w.simElapsed = 20;
    w.showGameOver('You reached the end of the slope!');
  });
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await expect(page.locator('#courseResult')).toBeVisible();
  await page.screenshot({ path: path.join(output, `${testInfo.project.name}-finish-dialog.png`), animations: 'disabled' });
  expect(errors).toEqual([]);
});
