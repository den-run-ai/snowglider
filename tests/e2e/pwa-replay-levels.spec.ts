import { test, expect, type Page } from '@playwright/test';
import { gotoGame, mockFirebase, type GameWindow } from './helpers';

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

type ReplayWindow = GameWindow & { simElapsed?: number };

async function startPreparedRun(page: Page, label: string): Promise<void> {
  await expect(page.locator('#startLoadingStatus')).toHaveAttribute('data-stage', 'ready');
  // Pause only after this document's scene/warmup is ready. Run real callbacks
  // on a controlled clock so software-rendering stalls cannot hide the ranked
  // result controls that this test needs to exercise.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
  await page.locator('#startGameButton').tap();
  await page.clock.runFor(50);
  expect(await page.evaluate(() => (window as ReplayWindow).gameActive)).toBe(true);
  expect(await page.evaluate(() => (window as ReplayWindow).simElapsed ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('#startGameContainer')).toBeHidden();
  await expect(page.locator('#levelValue')).toContainText(label);
}

// This runs against dist, including the real service worker and hashed chunks.
// It imports no source modules in the browser: selection, navigation, scene
// startup and HUD must all agree in the actual production module graph.
test('production touch replay changes all four levels through either result selector', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let navigations = 0;
  page.on('domcontentloaded', () => { navigations++; });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await mockFirebase(page, baseURL);
  await gotoGame(page, '?intro=off');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expect(await page.locator('script[type="module"][src^="/assets/"]').count()).toBeGreaterThan(0);
  await startPreparedRun(page, 'Blue');

  for (const [tier, label, selector] of [
    ['bunny', 'Bunny', '#finishDifficultyPicker [data-difficulty="bunny"]'],
    ['black', 'Black', '#leaderboard [data-leaderboard-tier="black"]'],
    ['expert', 'Expert', '#finishDifficultyPicker [data-difficulty="expert"]'],
    ['blue', 'Blue', '#leaderboard [data-leaderboard-tier="blue"]'],
  ] as const) {
    // End a real started run, without depending on random crash locations.
    await page.evaluate(() => window.showGameOver!('Tree Collision'));
    await expect(page.locator('#gameOverOverlay')).toBeVisible();
    await page.locator(selector).tap();
    await expect(page.locator(`#finishDifficultyPicker [data-difficulty="${tier}"]`))
      .toHaveAttribute('aria-checked', 'true');
    await expect(page.locator(`#leaderboard [data-leaderboard-tier="${tier}"]`))
      .toHaveAttribute('aria-pressed', 'true');
    const previousNavigations = navigations;
    // The old run is inactive. Let the new document boot and warm up normally;
    // startPreparedRun pauses again before its first playable frame.
    await page.clock.resume();
    await page.locator('#restartButton').tap();
    await expect(page.locator('#startGameContainer')).toBeVisible();
    await expect(page.locator(`#difficultyPicker [data-difficulty="${tier}"]`))
      .toHaveAttribute('aria-checked', 'true');
    await startPreparedRun(page, label);
    expect(navigations, 'changing level rebuilds exactly once without a manual reload')
      .toBe(previousNavigations + 1);
    expect(new URL(page.url()).searchParams.has('play')).toBe(false);
  }

  await page.evaluate(() => window.showGameOver!('Tree Collision'));
  const previousNavigations = navigations;
  await page.locator('#restartButton').tap();
  await page.clock.runFor(50);
  await expect(page.locator('#gameOverOverlay')).toBeHidden();
  expect(await page.evaluate(() => (window as ReplayWindow).gameActive)).toBe(true);
  expect(await page.evaluate(() => (window as ReplayWindow).simElapsed ?? 0)).toBeGreaterThan(0);
  await expect(page.locator('#levelValue')).toContainText('Blue');
  expect(navigations, 'same-level replay remains immediate').toBe(previousNavigations);
  expect(errors).toEqual([]);
});
