import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, mockFirebase, startGame } from './helpers';

type DailyGame = Window & { gameActive?: boolean; simElapsed?: number; __dailyCopied?: string };
const date = new Date().toISOString().slice(0, 10);
const dailyQuery = `?daily=${date}&level=blue&cv=1&pv=4&beat=26000`;

async function stamp(page: Page) {
  return page.evaluate(() => window.__snowgliderGetRunStamp!());
}

test('a guest can open the same daily mountain, compare, share and retry', async ({ page, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockFirebase(page, baseURL);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => { (window as DailyGame).__dailyCopied = text; return Promise.resolve(); },
    } });
  });
  await gotoGame(page, `${dailyQuery}&eztrees=1&intro=off`);
  await expect(page.locator('#startGameButton')).toHaveText('Start daily run');
  await expect(page.locator('#difficultyPicker [data-difficulty="blue"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#dailyMountain')).toContainText('Friend’s shared target: 26.00s');
  await page.waitForFunction(() => window.terrainMesh?.parent?.children.some(child => child.userData.forestPart === 'ezBranches'));
  await testInfo.attach('daily-welcome-real-forest', { body: await page.screenshot(), contentType: 'image/png' });
  await startGame(page);
  const firstStamp = await stamp(page);
  expect(firstStamp.practice).toBe(true);
  expect(firstStamp.nonce).toBe(0);
  await page.evaluate(async () => {
    const difficultyPath = '/src/difficulty.ts';
    const d = await import(difficultyPath) as typeof import('../../src/difficulty.js');
    localStorage.setItem(d.localBestTimeKey('blue'), '19');
    window.resetSnowman!();
    (window as DailyGame).simElapsed = 24.5;
    window.showGameOver!('You reached the end of the slope!');
  });
  await expect(page.locator('#dailyRunResult')).toContainText('1.50s faster');
  await expect(page.locator('#syncStatus')).toContainText('Daily best saved on this device');
  await expect(page.locator('#bestTimeDisplay')).toContainText('Daily best: 24.50s');
  await expect(page.locator('#saveScoreButton')).toHaveCount(0);
  await expect(page.locator('#restartButton')).toBeInViewport();
  await testInfo.attach('daily-finish-real-forest', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('#shareResultBtn').click();
  await page.locator('#shareCopyBtn').click();
  await expect.poll(() => page.evaluate(() => (window as DailyGame).__dailyCopied ?? '')).toContain('beat=24500');
  const copied = await page.evaluate(() => (window as DailyGame).__dailyCopied!);
  expect(copied).toContain('Can you beat my run?');
  expect(copied).toContain(`https://snowglider.ai/?daily=${date}&level=blue&cv=1&pv=4&beat=24500`);
  expect(copied).not.toContain('eztrees');
  expect(await page.evaluate(async () => {
    const path = '/src/difficulty.ts';
    const d = await import(path) as typeof import('../../src/difficulty.js');
    return localStorage.getItem(d.localBestTimeKey('blue'));
  })).toBe('19');
  await page.locator('#restartButton').click();
  await expect(page.locator('#gameOverOverlay')).toBeHidden();
  expect(await stamp(page)).toEqual(firstStamp);
  expect(errors).toEqual([]);
});

test('daily level changes rebuild the intended course and clear a different level’s target', async ({ page, baseURL }) => {
  await mockFirebase(page, baseURL);
  await gotoGame(page, `${dailyQuery}&intro=off`);
  const previous = await stamp(page);
  await page.locator('#difficultyPicker [data-difficulty="black"]').click();
  await page.locator('#startGameButton').click();
  await page.waitForURL(url => url.searchParams.get('level') === 'black');
  await expect(page.locator('#difficultyPicker [data-difficulty="black"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#startGameButton')).toHaveText('Start daily run');
  expect(new URL(page.url()).searchParams.has('beat')).toBe(false);
  expect(new URL(page.url()).searchParams.get('daily')).toBe(date);
  const current = await stamp(page);
  expect(current.seed).not.toBe(previous.seed);
  expect(current.practice).toBe(true);
  expect(current.nonce).toBe(0);
});

test('old or malformed daily invitations cannot silently enter ranked play', async ({ page, baseURL }) => {
  await mockFirebase(page, baseURL);
  for (const query of [dailyQuery.replace('pv=4', 'pv=999'), `${dailyQuery}&seed=123`]) {
    await gotoGame(page, query);
    await expect(page.locator('#startGameButton')).toBeDisabled();
    await expect(page.locator('#dailyMountain')).toContainText('unavailable');
    expect((await stamp(page)).practice).toBe(true);
    const regular = page.locator('#dailyMountain a', { hasText: 'Regular mountain' });
    const href = await regular.getAttribute('href');
    expect(new URL(href!).searchParams.get('daily')).toBe(null);
    expect(new URL(href!).searchParams.get('seed')).toBe(null);
  }
  await page.locator('#dailyMountain a', { hasText: 'Regular mountain' }).click();
  await expect(page.locator('#startGameButton')).toBeEnabled();
  expect((await stamp(page)).practice).toBe(false);
});
