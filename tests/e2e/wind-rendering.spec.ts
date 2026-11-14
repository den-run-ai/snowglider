import { test, expect } from './fixtures';
import { prepareRenderScenario, enterRenderPhase } from './render-scenarios';
import { measureTreeWindNormals } from './wind-rendering-probe';

test('wind-deformed trees keep lighting normals on the actual bent surface', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'GPU transform feedback is qualified on Chromium');
  test.setTimeout(120_000);
  const errors = await prepareRenderScenario(page);
  await enterRenderPhase(page, 'downhill');
  const result = await measureTreeWindNormals(page);
  await testInfo.attach('tree-wind-gpu-normals', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.length, 'all near/far branch, needle and snow variants execute').toBeGreaterThanOrEqual(7);
  for (const item of result) {
    expect(item.finite, item.key).toBe(true);
    expect(item.glError, item.key).toBe(0);
    expect(item.normalErrorDegrees, `${item.key}: GPU normal follows finite-difference geometry`).toBeLessThan(0.3);
  }
  expect(Math.max(...result.map(r => r.unbentErrorDegrees)), 'the old undeformed normals fail this geometry gate').toBeGreaterThan(1);
  expect(errors, 'no live scene/shader errors').toEqual([]);
});
