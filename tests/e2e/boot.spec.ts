import { test, expect } from '@playwright/test';

// Step 1 — cross-browser boot smoke. Runs on chromium + webkit (the closest CI
// proxy for Safari). Nothing in the repo ran on the Safari engine before, so the
// load-bearing checks are deliberately about the things that break there first:
// the three.js renderer's WebGL canvas actually mounting, the engine supporting
// WebGL2 at all, and boot raising no uncaught error.
test.describe('boot smoke', () => {
  test('loads the menu, mounts a WebGL canvas, and wires up start without fatal errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });

    // The start menu is present and interactive.
    await expect(page.locator('#startGameButton')).toBeVisible();

    // The three.js renderer appends its <canvas> into #gameCanvas at module load.
    await expect(page.locator('#gameCanvas canvas')).toHaveCount(1);

    // The renderer needs WebGL2; assert the engine provides it independently of the
    // game. This is historically the first thing to fail under headless WebKit.
    const hasWebGL2 = await page.evaluate(
      () => !!document.createElement('canvas').getContext('webgl2'),
    );
    expect(hasWebGL2, 'WebGL2 context unavailable in this browser engine').toBe(true);

    // The deferred orchestrator finished wiring the start entry point.
    await page.waitForFunction(
      () => typeof (window as Window & { initializeGameWithAudio?: unknown }).initializeGameWithAudio === 'function',
    );

    expect(pageErrors, `unexpected page errors during boot:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
