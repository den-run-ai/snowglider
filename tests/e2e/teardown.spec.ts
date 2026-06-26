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

    // Tear it down. disposeGame rebinds window.disposeGame to a no-op (not delete), so the
    // public idempotence contract holds: a second call THROUGH window stays a safe no-op.
    await page.evaluate(() => {
      (window as DisposeWindow).disposeGame!(); // real teardown
      (window as DisposeWindow).disposeGame!(); // second call via window — must not throw
    });

    // Every instance-owned DOM node is gone (so a remount can't hit a stale duplicate-ID
    // node).
    await expect(page.locator('#gameCanvas')).toHaveCount(0);
    await expect(page.locator('#gameOverOverlay')).toHaveCount(0);
    await expect(page.locator('#cameraToggleBtn')).toHaveCount(0);
    // Subsystem HUD (CourseModule / EffectsModule) is gone too — a clean unmount leaves
    // no fixed-position course/avalanche UI over the host page.
    await expect(page.locator('#courseHud')).toHaveCount(0);
    await expect(page.locator('#courseFlash')).toHaveCount(0);
    await expect(page.locator('#avalancheBanner')).toHaveCount(0);
    await expect(page.locator('#avalancheMeter')).toHaveCount(0);
    await expect(page.locator('#avalancheVignette')).toHaveCount(0);

    // Every window.* handle this instance installed is deleted — no stale start/reset
    // APIs callable, and no accessor closure keeping the disposed scene/renderer reachable.
    // (disposeGame is intentionally retained as a no-op for idempotence; checked below.)
    const handlesCleared = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const names = ['initializeGameWithAudio', 'resetSnowman', 'restartGame',
        'toggleCameraView', 'showGameOver', 'scene', 'renderer', 'camera', 'snowman', 'pos',
        'velocity', 'snowSplash', 'terrain', 'gameActive', 'updateCamera', 'updateSnowman',
        'testHooks'];
      return names.filter((n) => w[n] !== undefined);
    });
    expect(handlesCleared, `window handles still present after dispose: ${handlesCleared.join(', ')}`).toEqual([]);
    // disposeGame stays a callable no-op so a remount/double-cleanup through window is safe.
    expect(await page.evaluate(() => typeof (window as DisposeWindow).disposeGame)).toBe('function');

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

    // Wait past the 1800ms delayed start. The teardown ran (initializeGameWithAudio is
    // deleted) and the deferred loop never started — a loop against the torn-down renderer
    // would throw on renderer.render after context loss, so zero page errors is the proof.
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => typeof (window as DisposeWindow).initializeGameWithAudio)).toBe('undefined');
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
    // Teardown completed (initializeGameWithAudio deleted) and the cancelled fly-over
    // rendered nothing against the disposed context (zero page errors).
    expect(await page.evaluate(() => typeof (window as DisposeWindow).initializeGameWithAudio)).toBe('undefined');
    expect(pageErrors, `unexpected page errors after disposing mid-intro:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
