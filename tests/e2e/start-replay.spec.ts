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

async function startPreparedTier(page: Page, hasTouch: boolean, difficulty: string): Promise<void> {
  const start = page.locator('#startGameButton');
  await expect(page.locator('#startGameContainer')).toBeVisible();
  await expect(page.locator('#startLoadingStatus')).toHaveAttribute('data-stage', 'ready');
  await expect(start).toHaveText('Start run');
  await expect(start).toBeEnabled();
  await expect(page.locator(`#difficultyPicker [data-difficulty="${difficulty}"]`))
    .toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as GameWindow).gameActive),
    "a rebuilt course cannot start silently without this document's Start gesture").toBe(false);
  expect(new URL(page.url()).searchParams.has('play')).toBe(false);
  await page.evaluate(async () => {
    const audioPath = '/src/audio.ts';
    const sfxPath = '/src/sfx.ts';
    const { AudioModule } = await import(audioPath) as typeof import('../../src/audio.js');
    const { Sfx } = await import(sfxPath) as typeof import('../../src/sfx.js');
    if (AudioModule.getStatus().playing) throw new Error('Music started before the Start gesture');
    const calls: { kind: string; active: boolean }[] = [];
    (window as Window & { audioGestureCalls?: typeof calls }).audioGestureCalls = calls;
    const startAudio = AudioModule.startAudio.bind(AudioModule);
    const unlock = Sfx.unlock.bind(Sfx);
    const enableSound = AudioModule.enableSound.bind(AudioModule);
    AudioModule.startAudio = () => {
      calls.push({ kind: 'music', active: navigator.userActivation.isActive });
      return startAudio();
    };
    AudioModule.enableSound = (enabled: boolean) => {
      if (enabled) calls.push({ kind: 'music', active: navigator.userActivation.isActive });
      enableSound(enabled);
    };
    Sfx.unlock = () => {
      calls.push({ kind: 'sfx', active: navigator.userActivation.isActive });
      unlock();
    };
  });
  await activate(start, hasTouch);
  await waitForRun(page);
  await expectAudioGesture(page);
}

async function expectAudioGesture(page: Page): Promise<void> {
  const calls = await page.evaluate(() => (
    window as Window & { audioGestureCalls?: { kind: string; active: boolean }[] }
  ).audioGestureCalls!.splice(0));
  expect(calls.some(call => call.kind === 'music')).toBe(true);
  expect(calls.some(call => call.kind === 'sfx')).toBe(true);
  expect(calls.every(call => call.active), 'both audio systems unlock in the Start gesture').toBe(true);
}

async function showResult(page: Page, difficulty: string): Promise<void> {
  await page.evaluate(() => window.showGameOver?.('Tree Collision'));
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await expect(page.locator(`#finishDifficultyPicker [data-difficulty="${difficulty}"]`))
    .toHaveAttribute('aria-checked', 'true');
}

test.describe('start and replay audio gestures', () => {
  test('tier changes prepare a matching scene and wait for Start while same-tier replay is immediate', async ({ page, hasTouch }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let navigations = 0;
    page.on('domcontentloaded', () => { navigations++; });
    await gotoGame(page, '?intro=off');
    // No webdriver override: browser tests must exercise the player tier rebuild.
    await activate(page.locator('#difficultyPicker [data-difficulty="bunny"]'), hasTouch);
    await activate(page.locator('#startGameButton'), hasTouch);
    await startPreparedTier(page, hasTouch, 'bunny');
    expect(navigations).toBe(2);
    await showResult(page, 'bunny');

    await activate(page.locator('#restartButton'), hasTouch);
    await waitForRun(page);
    await expect(page.locator('#gameOverOverlay')).toBeHidden();
    expect(navigations, 'same-tier replay reuses the existing scene').toBe(2);
    await expectAudioGesture(page);
    await showResult(page, 'bunny');

    await activate(page.locator('#finishDifficultyPicker [data-difficulty="black"]'), hasTouch);
    await activate(page.locator('#restartButton'), hasTouch);
    await startPreparedTier(page, hasTouch, 'black');
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
    await startPreparedTier(page, hasTouch, 'expert');
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
