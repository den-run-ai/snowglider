import { test, expect } from './fixtures';

// E2E coverage for the dispose-audit teardown (disposeGame). The orchestrator's
// teardown wiring in src/snowglider.ts — disposeSnowGlider, the `disposed` guard, the
// pending-start-timer / intro-handle cancellation — only runs in a full browser (real
// WebGLRenderer + module graph), so it's unreachable from the headless Node suites that
// cover game/teardown.ts directly. These specs drive the published `window.disposeGame`
// against a real run and assert the §6 plan properties end-to-end: the loop stops, the
// instance-owned DOM nodes are removed, a second dispose is a no-op, and — crucially —
// no uncaught error fires from a stray frame rendering against a disposed context.

type DisposeWindow = Window & {
  disposeGame?: () => void;
  gameActive?: boolean;
  initializeGameWithAudio?: () => void;
};

async function waitForOrchestrator(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as DisposeWindow).initializeGameWithAudio === 'function',
  );
}

test.describe('disposeGame teardown', () => {
  test('tears down a live run cleanly and is idempotent', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await waitForOrchestrator(page);

    // Pre-conditions: the renderer canvas + the instance-owned overlay/button mount.
    await expect(page.locator('#gameCanvas canvas')).toHaveCount(1);
    await expect(page.locator('#cameraToggleBtn')).toHaveCount(1);

    // Start a live run (intro is skipped under automation -> short loading delay).
    await page.click('#startGameButton');
    await page.waitForFunction(() => (window as DisposeWindow).gameActive === true);

    // Tear it down.
    await page.evaluate(() => (window as DisposeWindow).disposeGame!());

    // Loop stopped and every instance-owned DOM node is gone (so a remount can't hit a
    // stale duplicate-ID node).
    expect(await page.evaluate(() => (window as DisposeWindow).gameActive)).toBe(false);
    await expect(page.locator('#gameCanvas')).toHaveCount(0);
    await expect(page.locator('#gameOverOverlay')).toHaveCount(0);
    await expect(page.locator('#cameraToggleBtn')).toHaveCount(0);

    // Idempotent: a second dispose must be a no-op, not a throw.
    await page.evaluate(() => (window as DisposeWindow).disposeGame!());

    // Give any orphaned rAF a couple of frames to (not) fire against the dead context.
    await page.waitForTimeout(150);
    expect(pageErrors, `unexpected page errors during teardown:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('dispose during the start delay cancels the pending loop start', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await waitForOrchestrator(page);

    // Click Start, then dispose immediately — well inside the ~1.8s loading delay,
    // before the deferred startGameplayLoop fires. The `disposed` guard + the cleared
    // timer must keep the loop from ever starting against the torn-down renderer.
    await page.click('#startGameButton');
    await page.evaluate(() => (window as DisposeWindow).disposeGame!());

    // Wait past the 1800ms delayed start; gameActive must stay false (loop never ran).
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => (window as DisposeWindow).gameActive)).toBe(false);
    expect(pageErrors, `unexpected page errors after a mid-startup dispose:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('dispose during the cinematic intro cuts the fly-over short', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ?intro=force plays the fly-over even under automation (the manual-QA / e2e seam).
    await page.goto('/index.html?intro=force', { waitUntil: 'domcontentloaded' });
    await waitForOrchestrator(page);

    await page.click('#startGameButton');
    // The intro is running once the body gets the `intro-active` class.
    await page.waitForFunction(() => document.body.classList.contains('intro-active'));

    // Dispose mid-fly-over: this exercises the activeIntro.skip() cancellation path
    // (its private rAF is cancelled, so no further renderer.render on a dead context).
    await page.evaluate(() => (window as DisposeWindow).disposeGame!());

    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as DisposeWindow).gameActive)).toBe(false);
    expect(pageErrors, `unexpected page errors after disposing mid-intro:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
