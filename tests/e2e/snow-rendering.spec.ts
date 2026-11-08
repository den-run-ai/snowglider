import { test, expect } from './fixtures';
import { devices } from '@playwright/test';
import { captureRenderCanvas, prepareRenderScenario } from './render-scenarios';
import { SNOW_PHASES, prepareSnowFrame, enterSnowPhase, measureSnowSurface, captureSnowDetailFrame } from './snow-rendering-scenarios';

// This spec runs in both desktop engine projects. Give each engine an explicit
// touch/portrait context too: the dedicated mobile projects select UI specs by
// filename and otherwise would never run this material regression.
for (const [view, device] of Object.entries({
  desktop: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
  phone: { ...devices['Pixel 7'] },
})) {
  test.describe(`snow surface (${view})`, () => {
    const { defaultBrowserType: _browserType, ...contextOptions } = device;
    test.use(contextOptions);
    test('snow retains unclipped light-responsive relief and cool shade', async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      const errors = await prepareRenderScenario(page);
      await prepareSnowFrame(page);
      for (const phase of SNOW_PHASES) {
        await enterSnowPhase(page, phase);
        await testInfo.attach(`snow-player-${phase}`, { body: await captureRenderCanvas(page), contentType: 'image/png' });
        for (const view of ['closeup', 'grazing'] as const) {
          await testInfo.attach(`snow-${view}-${phase}`, { body: await captureSnowDetailFrame(page, view), contentType: 'image/png' });
        }
        const { lit, shade, relief, imageBase64, detailImageBase64 } = await measureSnowSurface(page);
        console.log('Snow GPU readback', JSON.stringify({ project: testInfo.project.name, view, phase, lit, shade, relief }));
        await testInfo.attach(`snow-surface-probe-${phase}`, { body: Buffer.from(imageBase64, 'base64'), contentType: 'image/png' });
        await testInfo.attach(`snow-detail-probe-${phase}`, { body: Buffer.from(detailImageBase64, 'base64'), contentType: 'image/png' });
        await testInfo.attach(`snow-readback-${phase}`, { body: JSON.stringify({ lit, shade, relief }, null, 2), contentType: 'application/json' });
        expect(lit.count, 'actual terrain covers the diagnostic target').toBe(256 * 256);
        expect(lit.clippedFraction, `${phase}: highlight headroom survives the real shader`).toBeLessThan(0.01);
        expect(lit.median, `${phase}: snow stays bright`).toBeGreaterThan(140);
        expect(lit.median, `${phase}: snow does not wash out`).toBeLessThan(245);
        expect(lit.p90 - lit.p10, `${phase}: terrain has visible form`).toBeGreaterThan(3);
        expect(shade.blue - shade.red, `${phase}: occluded snow receives cool skylight`).toBeGreaterThan(5);
        expect(relief.count, 'the full detail patch contributes to the normal comparison').toBe(256 * 256);
        expect(relief.detailed.clippedFraction, `${phase}: close-up snow retains highlight detail`).toBeLessThan(0.01);
        // The low golden sun backlights this slope, so much of its response comes
        // from skylight. The old surface measured only 0.66 / 0.12 mean luma
        // steps (midday / golden): changing albedo alone cannot pass these gates.
        expect(relief.meanAbsoluteLumaDelta, `${phase}: normal relief contributes visible lighting`).toBeGreaterThan(phase === 'midday' ? 2 : 0.5);
        expect(relief.p90AbsoluteLumaDelta, `${phase}: wind-ridge outlines respond to the light`).toBeGreaterThan(phase === 'midday' ? 4 : 1.5);
        if (phase === 'midday') {
          expect(lit.median - shade.median, 'midday sun reveals the slope').toBeGreaterThan(15);
        }
      }
      expect(errors, 'no page or shader errors').toEqual([]);
    });
  });
}
