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

  test('mobile renders the canvas and subtle touch affordances by default (regression)', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    // The three.js canvas is visible on the mobile viewport.
    await expect(page.locator('#gameCanvas canvas')).toBeVisible();

    // REGRESSION GUARD: the five touch affordance pads (left/right/up/down/jump) are
    // gameplay UI and must render by default on mobile. Debug-gating all the zone
    // visuals off (the "snow plates" over-fix) made players report the touch controls
    // as having disappeared.
    const affordances = page.locator('.touch-control.touch-affordance');
    await expect(affordances).toHaveCount(5);
    for (const name of ['left', 'right', 'up', 'down', 'jump']) {
      await expect(page.locator(`.touch-${name}`)).toBeVisible();
    }

    // ...and they must be the small faint pads, NOT the full-region debug rectangles —
    // reusing those as production UI would reintroduce the "floating white plates".
    await expect(page.locator('.touch-control.touch-debug-zone')).toHaveCount(0);
    const idleFill = await affordances.first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(idleFill).toBe('rgba(255, 255, 255, 0.07)');
  });

  test('touch affordances can be opted out with ?hideTouchControls', async ({ page }) => {
    await gotoGame(page, '?hideTouchControls');
    await startGame(page);

    // Explicit opt-out => no visuals; touch INPUT is unaffected (always active).
    await expect(page.locator('.touch-control')).toHaveCount(0);
  });

  test('debug touch-zone overlays render with ?debugTouchZones=1', async ({ page }) => {
    await gotoGame(page, '?debugTouchZones=1');
    await startGame(page);

    // Debug flag => the five full-region hit-zone rectangles are drawn (the debug view
    // exists to inspect the real touch hit-areas).
    await expect(page.locator('.touch-control.touch-debug-zone')).toHaveCount(5);
    await expect(page.locator('.touch-control').first()).toBeVisible();
  });

  test('camera tray collapse does not disturb the touch affordances', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    // The camera tray (bottom-left, collapsible) overlaps the steering surface on
    // phones; folding/unfolding it must leave the five affordance pads intact — this
    // pins the suspected-overlap area from the regression report.
    const affordances = page.locator('.touch-control.touch-affordance');
    await expect(affordances).toHaveCount(5);
    await page.locator('#toggleCamera').tap();
    await expect(page.locator('#cameraControls')).toHaveClass(/collapsed/);
    await expect(affordances).toHaveCount(5);
    await page.locator('#toggleCamera').tap();
    await expect(page.locator('#cameraControls')).not.toHaveClass(/collapsed/);
    await expect(affordances).toHaveCount(5);
  });
});

// Regression for the start-menu "About Game" / "Close" buttons on mobile. These are
// plain click-bound <button>s shown while controls.ts's document-level touch handlers
// are already live (setupControls runs at module load, before any run), so before the
// systemic fix their synthesized click was suppressed and the buttons were dead. A
// real page.tap() routes through the genuine WebKit touch->click pipeline.
test.describe('mobile start-menu buttons', () => {
  test('About Game / Close open and dismiss the About panel via tap', async ({ page }) => {
    await gotoGame(page);
    // Still on the start screen (do NOT start the game): the About controls live here.
    const aboutPanel = page.locator('#aboutGamePanel');
    await expect(aboutPanel).toBeHidden();

    await page.locator('#aboutGameButton').tap();
    await expect(aboutPanel).toBeVisible();

    await page.locator('#closeAboutButton').tap();
    await expect(aboutPanel).toBeHidden();
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
    // skiing the whole course: backdate the run clock past the 18s minimum-valid-
    // time plausibility floor (src/score-limits.ts), then drive the real game-over
    // finish path. This builds #courseResult inside the (z-index 1000, full-screen)
    // game-over overlay.
    await page.evaluate(() => {
      const w = window as unknown as { startTime: number; showGameOver: (r: string) => void };
      w.startTime = performance.now() - 20000;
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
