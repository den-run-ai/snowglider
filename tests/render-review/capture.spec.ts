import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RENDER_PHASES, REVIEW_SEED, prepareRenderScenario, enterRenderPhase,
  measureRenderPhase, assertRenderPhase, captureRenderCanvas, setObstructedOrbitFrame
} from '../e2e/render-scenarios';

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
  expect(errors, 'capture failed due to uncaught page/shader errors').toEqual([]);
  await fs.writeFile(path.join(output, `${testInfo.project.name}.json`), JSON.stringify({
    schema: 1, commit, seed: REVIEW_SEED, device: testInfo.project.name,
    viewport: page.viewportSize(), frames
  }, null, 2));
});
