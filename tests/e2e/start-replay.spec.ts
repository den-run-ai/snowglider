import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, type GameWindow } from './helpers';

async function activate(control: Locator, hasTouch: boolean): Promise<void> {
  if (hasTouch) await control.tap();
  else await control.click();
}

async function waitForRun(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as GameWindow).gameActive === true);
  await expect(page.locator('#startGameContainer')).toBeHidden();
  await expect(page.locator('#audioControlBtn')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('play')).toBe(false);
}

async function showResult(page: Page, difficulty: string): Promise<void> {
  await page.evaluate(() => window.showGameOver?.('Tree Collision'));
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await expect(page.locator(`#finishDifficultyPicker [data-difficulty="${difficulty}"]`))
    .toHaveAttribute('aria-checked', 'true');
}

test.describe('one-click start and replay', () => {
  test('first tier change and result replay use the correct scene without another Start', async ({ page, hasTouch }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let navigations = 0;
    page.on('domcontentloaded', () => { navigations++; });
    await gotoGame(page, '?intro=off');
    // No webdriver override: browser tests must exercise the player tier rebuild.
    await activate(page.locator('#difficultyPicker [data-difficulty="bunny"]'), hasTouch);
    await activate(page.locator('#startGameButton'), hasTouch);
    await waitForRun(page);
    expect(navigations).toBe(2);
    await showResult(page, 'bunny');

    await activate(page.locator('#restartButton'), hasTouch);
    await waitForRun(page);
    await expect(page.locator('#gameOverOverlay')).toBeHidden();
    expect(navigations, 'same-tier replay reuses the existing scene').toBe(2);
    await showResult(page, 'bunny');

    await activate(page.locator('#finishDifficultyPicker [data-difficulty="black"]'), hasTouch);
    await activate(page.locator('#restartButton'), hasTouch);
    await waitForRun(page);
    expect(navigations, 'one new scene rebuild for the next tier').toBe(3);
    // Read the actual terrain-line module: Black must have its winding scene,
    // not just a new result label on the previous Bunny mountain.
    expect(await page.evaluate(async () => {
      const modulePath = '/src/course-line.ts';
      const line = await import(modulePath) as typeof import('../../src/course-line.js');
      return line.getActiveCourseLine()?.controlsX.some(x => Math.abs(x) > 0) ?? false;
    })).toBe(true);
    await showResult(page, 'black');
    expect(errors).toEqual([]);
  });

  test('blocked storage preserves a requested tier and refreshing cannot replay stale intent', async ({ page, hasTouch }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    await gotoGame(page, '?intro=off&seed=123');
    await activate(page.locator('#difficultyPicker [data-difficulty="expert"]'), hasTouch);
    await activate(page.locator('#startGameButton'), hasTouch);
    await waitForRun(page);
    expect(new URL(page.url()).searchParams.get('seed')).toBe('123');
    await showResult(page, 'expert');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.initializeGameWithAudio === 'function');
    await expect(page.locator('#startGameContainer')).toBeVisible();
    expect(await page.evaluate(() => (window as GameWindow).gameActive)).toBe(false);
  });

  test('a Start before scripts arrive completes once when they become ready', async ({ page, hasTouch }) => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/src\/snowglider\.(?:js|ts)(?:\?|$)/, async route => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto('/index.html?intro=off', { waitUntil: 'domcontentloaded' });
      await activate(page.locator('#startGameButton'), hasTouch);
      await expect(page.locator('#startGameButton')).toBeDisabled();
      await expect(page.locator('#startGameButton')).toHaveAttribute('aria-busy', 'true');
      release();
      await waitForRun(page);
      expect(await page.evaluate(() => window.initializeGameWithAudio?.())).toBe(false);
      await expect(page.locator('#fatalErrorOverlay')).toHaveCount(0);
    } finally {
      release();
    }
  });
});
