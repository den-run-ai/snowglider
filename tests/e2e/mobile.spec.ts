import { test, expect, type Page } from '@playwright/test';
import { gotoGame, startGame, getControls } from './helpers';

// Step 3 — mobile touch + viewport E2E. Runs on an emulated iPhone (WebKit). The
// game's control layer (src/controls.ts) enables touch input when it detects a
// mobile UA, splitting the screen into regions (left/right third, top/bottom
// middle, center=jump). These specs verify those regions actually drive the
// shared controls state and that the mobile HUD renders.

// The game's document-level touch handlers only read changedTouches[].clientX/Y/
// identifier (see controls.ts processTouchInput), so a minimal hand-built event
// drives the same code path cross-browser without depending on the TouchEvent /
// Touch constructors (whose shapes differ across engines).
async function dispatchTouch(
  page: Page,
  type: 'touchstart' | 'touchend',
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ({ type, x, y }) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      const point = { identifier: 0, clientX: x, clientY: y, pageX: x, pageY: y, target: document.body };
      Object.defineProperty(ev, 'changedTouches', { value: [point] });
      Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [point] });
      document.dispatchEvent(ev);
    },
    { type, x, y },
  );
}

test.describe('mobile touch', () => {
  test('touch regions drive the shared controls state', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const size = page.viewportSize();
    expect(size, 'mobile project must define a viewport').not.toBeNull();
    const { width, height } = size!;

    // Left region = left third, vertical middle (controls.ts updateTouchRegions).
    await dispatchTouch(page, 'touchstart', width * 0.15, height * 0.5);
    expect((await getControls(page))?.left).toBe(true);
    await dispatchTouch(page, 'touchend', width * 0.15, height * 0.5);
    expect((await getControls(page))?.left).toBe(false);

    // Center region = jump.
    await dispatchTouch(page, 'touchstart', width * 0.5, height * 0.5);
    expect((await getControls(page))?.jump).toBe(true);
    await dispatchTouch(page, 'touchend', width * 0.5, height * 0.5);
    expect((await getControls(page))?.jump).toBe(false);
  });

  test('mobile renders the canvas and on-screen touch controls', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    // The three.js canvas is visible on the mobile viewport.
    await expect(page.locator('#gameCanvas canvas')).toBeVisible();

    // Mobile UA => the game creates visual touch-region overlays (controls.ts
    // showVisualControls), one per region.
    await expect(page.locator('.touch-control').first()).toBeVisible();
    expect(await page.locator('.touch-control').count()).toBeGreaterThan(0);
  });
});
