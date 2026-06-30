import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

// Integration coverage for the run-loop's fatal-error guard (game/main-loop.ts +
// src/ui/fatal-error-overlay.ts). The loop reschedules its requestAnimationFrame at the
// TOP of each frame, so before this guard an uncaught error in the frame body left rAF
// spinning on a frozen screen with no feedback — the "silent freeze" a stale mobile
// cache could trigger. The guard catches it, stops the loop, and shows a one-tap reload.
//
// We inject a real frame error by poisoning a property the loop reads every frame: the
// shared player position object (window.pos, the same object the loop holds by identity)
// gets a `z` getter that throws. The next frame throws inside the loop body -> the guard
// fires -> the recovery overlay appears and the loop stops rescheduling.
test.describe('fatal run-loop error recovery', () => {
  test('a throwing frame stops the loop and shows the reload overlay', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await gotoGame(page);
    await startGame(page);

    // Poison the per-frame position read so the very next frame throws.
    await page.evaluate(() => {
      const w = window as unknown as { pos: { z: number } };
      const real = w.pos.z;
      Object.defineProperty(w.pos, 'z', {
        configurable: true,
        get() { throw new Error('injected frame error'); },
        set() { /* swallow physics writes; the read above throws first */ },
      });
      void real;
    });

    // The recovery overlay appears...
    await expect(page.locator('#fatalErrorOverlay')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#fatalErrorReloadBtn')).toBeVisible();

    // ...the loop has stopped (gameActive cleared by the fatal handler)...
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { gameActive?: boolean }).gameActive))
      .toBe(false);

    // ...and it logged the fatal error rather than failing silently.
    expect(consoleErrors.some((t) => /Fatal animation-loop error/.test(t))).toBe(true);

    // The Reload button triggers a navigation/reload (asserted via the load event).
    await Promise.all([
      page.waitForLoadState('load'),
      page.click('#fatalErrorReloadBtn'),
    ]);
  });
});
