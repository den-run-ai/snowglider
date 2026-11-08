import { test, expect } from '@playwright/test';
import { buildDailyChallengeUrl, createDailyChallenge } from '../../src/daily-challenge.ts';
import { dailyBestKey } from '../../src/daily-records.ts';
import { localBestTimeKey, localBestMetaKey, localGhostKey, localBestSplitsKey } from '../../src/difficulty.ts';
import { CANONICAL_WORLD_SEED, PHYSICS_VERSION } from '../../src/run-context.ts';
import { gotoGame, mockFirebase, startGame, getPos, waitForDownhillTravel } from './helpers';

type DailyWindow = Window & { gameActive?: boolean; simElapsed?: number; __dailyCopied?: string };

// This spec is included only by playwright.pwa.config.ts, whose preview server
// serves dist built by test:pwa. Source imports above run in the test process;
// every browser action below uses the actual bundled game and its public seams.
test('the production guest daily saves an isolated best, shares its invitation and survives replay/reload', async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await mockFirebase(page, baseURL);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { (window as DailyWindow).__dailyCopied = text; return Promise.resolve(); } },
    });
  });

  // A past UTC day avoids midnight races while exercising the same versioned
  // friend invitation that remains playable after its featured day.
  const challenge = createDailyChallenge('2020-01-01', 'blue');
  const query = new URL(buildDailyChallengeUrl(challenge, 'https://snowglider.ai/', 26_000)).search;
  const dailyKey = dailyBestKey(challenge);
  const ghostKey = localGhostKey('blue');
  const canonicalStamp = { seed: CANONICAL_WORLD_SEED, practice: false, nonce: 42, physicsVersion: PHYSICS_VERSION };
  const canonicalRecords: [string, string][] = [
    [localBestTimeKey('blue'), '19'],
    [localBestMetaKey('blue'), JSON.stringify(canonicalStamp)],
    [ghostKey, JSON.stringify([{ t: 0, x: 0, y: 0, z: -15, rot: 0 }, { t: 19, x: 0, y: 0, z: -195, rot: 0 }])],
    [`${ghostKey}_meta`, JSON.stringify(canonicalStamp)],
    [localBestSplitsKey('blue'), JSON.stringify([4, 9, 14, 19])],
  ];
  const canonicalKeys = canonicalRecords.map(([key]) => key);

  await gotoGame(page, `${query}&intro=off`);
  await expect(page.locator('#startLoadingStatus')).toHaveAttribute('data-stage', 'ready');
  await expect(page.locator('#startGameButton')).toHaveText('Start daily run');
  await expect(page.locator('#dailyMountain')).toContainText('Daily bests stay on this device');
  await expect(page.locator('#leaderboardsDetails')).toBeHidden();
  await expect(page.locator('#startSignInHint')).toBeHidden();
  await expect(page.locator('#startLeaderboard [data-leaderboard-tier]')).toHaveCount(0);
  expect(await page.locator('script[type="module"][src^="/assets/"]').count(), 'the page loads the production bundle').toBeGreaterThan(0);
  expect(await page.evaluate(() => window.AuthModule?.getCurrentUser?.() ?? null)).toBeNull();
  await page.evaluate(records => {
    for (const [key, value] of records) localStorage.setItem(key, value);
  }, canonicalRecords);

  await startGame(page);
  const expectedStamp = { seed: challenge.seed, practice: true, nonce: 0, physicsVersion: challenge.physicsVersion };
  expect(await page.evaluate(() => window.__snowgliderGetRunStamp!())).toEqual(expectedStamp);
  const start = await getPos(page);
  expect(start).not.toBeNull();
  await waitForDownhillTravel(page, start!.z, 1);

  // Script only the finish boundary; this checks built result/persistence wiring,
  // not a winning physics trajectory or sustained device performance.
  await page.evaluate(() => {
    window.resetSnowman!();
    (window as DailyWindow).simElapsed = 24.5;
    window.showGameOver!('You reached the end of the slope!');
  });
  await expect(page.locator('#dailyRunResult')).toContainText('1.50s faster');
  await expect(page.locator('#syncStatus')).toContainText('Daily best saved on this device');
  await expect(page.locator('#saveScoreButton')).toHaveCount(0);
  const expectedBest = { challengeId: challenge.id, seed: challenge.seed, physicsVersion: challenge.physicsVersion, timeMs: 24_500 };
  expect(await page.evaluate(key => {
    const record: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return record;
  }, dailyKey)).toEqual(expectedBest);
  expect(await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), canonicalKeys)).toEqual(canonicalRecords);

  await page.locator('#shareResultBtn').click();
  await page.locator('#shareCopyBtn').click();
  const expectedInvitation = buildDailyChallengeUrl(challenge, 'https://snowglider.ai/', 24_500);
  await expect.poll(() => page.evaluate(() => (window as DailyWindow).__dailyCopied ?? '')).toContain(expectedInvitation);
  const copied = await page.evaluate(() => (window as DailyWindow).__dailyCopied!);
  expect(copied).toContain('Can you beat my run?');
  expect(copied.split('\n').at(-1)).toBe(expectedInvitation);
  expect(copied).not.toContain('intro=');

  await page.locator('#restartButton').click();
  await expect(page.locator('#gameOverOverlay')).toBeHidden();
  await page.waitForFunction(() => (window as DailyWindow).gameActive === true);
  expect(await page.evaluate(() => window.__snowgliderGetRunStamp!())).toEqual(expectedStamp);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.initializeGameWithAudio === 'function');
  await expect(page.locator('#startLoadingStatus')).toHaveAttribute('data-stage', 'ready');
  await expect(page.locator('#startGameButton')).toHaveText('Start daily run');
  await expect(page.locator('#dailyMountain')).toContainText('Device best: 24.50s');
  await expect(page.locator('#dailyMountain')).toContainText('Friend’s shared target: 26.00s');
  await expect(page.locator('#leaderboardsDetails')).toBeHidden();
  await expect(page.locator('#startSignInHint')).toBeHidden();
  await expect(page.locator('#startLeaderboard [data-leaderboard-tier]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__snowgliderGetRunStamp!())).toEqual(expectedStamp);
  expect(await page.evaluate(key => {
    const record: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return record;
  }, dailyKey)).toEqual(expectedBest);
  expect(await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), canonicalKeys)).toEqual(canonicalRecords);
  await page.locator('#dailyMountain a', { hasText: 'Regular mountain' }).click();
  await expect(page.locator('#startLoadingStatus')).toHaveAttribute('data-stage', 'ready');
  await expect(page.locator('#leaderboardsDetails')).toBeVisible();
  await expect(page.locator('#startSignInHint')).toBeVisible();
  await expect(page.locator('#startLeaderboard [data-leaderboard-tier]')).toHaveCount(4);
  expect(await page.evaluate(() => window.__snowgliderGetRunStamp!().practice)).toBe(false);
  expect(pageErrors).toEqual([]);
});
