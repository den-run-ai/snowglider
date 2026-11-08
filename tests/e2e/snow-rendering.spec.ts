import { test, expect } from './fixtures';
import { captureRenderCanvas, prepareRenderScenario } from './render-scenarios';
import { SNOW_PHASES, prepareSnowFrame, enterSnowPhase, measureSnowSurface } from './snow-rendering-scenarios';

test('snow retains unclipped form and cool shade at both sun endpoints', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors = await prepareRenderScenario(page);
  await prepareSnowFrame(page);
  for (const phase of SNOW_PHASES) {
    await enterSnowPhase(page, phase);
    await testInfo.attach(`snow-player-${phase}`, { body: await captureRenderCanvas(page), contentType: 'image/png' });
    const { lit, shade, imageBase64 } = await measureSnowSurface(page);
    console.log('Snow GPU readback', JSON.stringify({ project: testInfo.project.name, phase, lit, shade }));
    await testInfo.attach(`snow-surface-probe-${phase}`, { body: Buffer.from(imageBase64, 'base64'), contentType: 'image/png' });
    await testInfo.attach(`snow-readback-${phase}`, { body: JSON.stringify({ lit, shade }, null, 2), contentType: 'application/json' });
    expect(lit.count, 'actual terrain covers the diagnostic target').toBe(256 * 256);
    expect(lit.clippedFraction, `${phase}: highlight headroom survives the real shader`).toBeLessThan(0.01);
    expect(lit.median, `${phase}: snow stays bright`).toBeGreaterThan(140);
    expect(lit.median, `${phase}: snow does not wash out`).toBeLessThan(245);
    expect(lit.p90 - lit.p10, `${phase}: terrain has visible form`).toBeGreaterThan(3);
    expect(shade.blue - shade.red, `${phase}: occluded snow receives cool skylight`).toBeGreaterThan(5);
    if (phase === 'midday') {
      expect(lit.median - shade.median, 'midday sun reveals the slope').toBeGreaterThan(15);
    }
  }
  expect(errors, 'no page or shader errors').toEqual([]);
});
