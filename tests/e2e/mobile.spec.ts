import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
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

// Regression for the dead finish-screen share buttons on mobile. controls.ts
// attaches document-level touchstart/touchmove/touchend handlers that
// preventDefault() every touch outside the scrollable guides; on a touch engine a
// preventDefault() on the first touchmove OR on touchend suppresses the synthesized
// click. The share buttons (bound to `click`) therefore did nothing on a phone
// unless share-menu.ts keeps their whole touch sequence off `document`. A real
// page.tap() routes through that exact WebKit pipeline, so this fails (the click
// never lands) if the defuse ever regresses — which the .click()-driven unit tests
// cannot catch.
test.describe('mobile share buttons', () => {
  test('tapping a share button fires its click (gameplay touch handlers do not eat it)', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    // Surface the finish result panel (which owns the share controls) without
    // skiing the whole course: backdate the run clock past the 4s minimum-valid-
    // time guard, then drive the real game-over finish path. This builds
    // #courseResult inside the (z-index 1000, full-screen) game-over overlay.
    await page.evaluate(() => {
      const w = window as unknown as { startTime: number; showGameOver: (r: string) => void };
      w.startTime = performance.now() - 5000;
      w.showGameOver('You reached the end of the slope!');
    });

    const shareBtn = page.locator('#shareResultBtn');
    const imageBtn = page.locator('#shareImageBtn');
    await expect(shareBtn).toBeVisible();
    await expect(imageBtn).toBeVisible();

    // Count real click events on each visible share button. The listeners fire
    // synchronously during click dispatch, so a tap that produces a click bumps the
    // counter regardless of what the button's own handler then does.
    await page.evaluate(() => {
      const w = window as unknown as { __shareClicks: { primary: number; image: number } };
      w.__shareClicks = { primary: 0, image: 0 };
      document.getElementById('shareResultBtn')!
        .addEventListener('click', () => { w.__shareClicks.primary++; });
      document.getElementById('shareImageBtn')!
        .addEventListener('click', () => { w.__shareClicks.image++; });
    });

    await shareBtn.tap();
    await imageBtn.tap();

    await page.waitForFunction(() => {
      const c = (window as unknown as { __shareClicks: { primary: number; image: number } }).__shareClicks;
      return c.primary > 0 && c.image > 0;
    });
  });
});
