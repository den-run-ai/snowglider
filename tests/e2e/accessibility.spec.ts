import { test, expect } from './fixtures';
import { gotoGame, startGame, type GameWindow } from './helpers';

test('keyboard About and feedback contain focus and return it without starting a run', async ({ page }) => {
  await gotoGame(page);
  await expect(page.locator('#resetBtn')).toHaveJSProperty('inert', true);
  const about = page.getByRole('button', { name: 'About Game', exact: true });
  await about.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'About SnowGlider' })).toBeVisible();
  await expect(page.locator('#closeAboutButton')).toBeFocused();
  // Dialog isolation can make the auth container inert through its HUD column.
  // Check effective isolation and attempt real focus rather than pinning which
  // ancestor owns the inert attribute.
  await expect.poll(() => page.locator('#authContainer').evaluate((el) => (
    el.closest('[inert]') !== null
  ))).toBe(true);
  for (const selector of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) {
    await page.locator(selector).evaluate((el) => (el as HTMLElement).focus());
    await expect(page.locator('#closeAboutButton')).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(about).toBeFocused();
  await expect(about).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#startGameContainer')).toBeVisible();

  const feedback = page.getByRole('button', { name: /Feedback/ });
  await feedback.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: /Send Feedback/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your feedback' })).toBeFocused();
  await page.keyboard.type('wasd v');
  await expect(page.locator('#startGameContainer')).toBeVisible();
  await page.locator('#feedbackCancel').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('input[name="feedbackCategory"]').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(feedback).toBeFocused();
  await expect(page.locator('#startGameContainer')).not.toHaveJSProperty('inert', true);
});

test('camera disclosures, sound state, and results expose their keyboard contracts', async ({ page }) => {
  await gotoGame(page);
  await startGame(page);
  // This test owns DOM/keyboard contracts, not a timed downhill run. CI's
  // software-rendered mountain took ~14s per click under V8 coverage, exhausting
  // the total test budget despite correct states. Pause through the existing
  // state seam so assertions cannot race rendering or a natural crash/finish.
  // The separate gameplay/perf/real-player screenshot specs keep the loop live.
  await page.evaluate(() => new Promise<void>((resolve) => {
    (window as GameWindow).gameActive = false;
    requestAnimationFrame(() => resolve());
  }));
  const stats = page.getByRole('button', { name: 'Toggle game stats options' });
  await stats.click();
  await expect(stats).toHaveAttribute('aria-expanded', 'false');
  await stats.click();
  await expect(stats).toHaveAttribute('aria-expanded', 'true');
  const toggle = page.getByRole('button', { name: 'Toggle camera options' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#cameraControlsContent')).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: 'Orbit left (Q)', exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('slider', { name: 'Camera orbit angle' })).toBeVisible();
  await page.getByRole('button', { name: 'First Person', exact: true }).click();
  await expect(page.getByRole('button', { name: 'First Person', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: 'Camera orbit angle' })).toBeDisabled();
  const sound = page.getByRole('button', { name: 'Sound', exact: true });
  const wasPressed = await sound.getAttribute('aria-pressed');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', String(wasPressed !== 'true'));
  await sound.focus();
  await page.keyboard.down('w');
  expect(await page.evaluate(() => (window as GameWindow).getControls?.().up)).toBe(true);
  await page.keyboard.up('w');
  await page.keyboard.down('Space');
  expect(await page.evaluate(() => (window as GameWindow).getControls?.().jump)).toBe(false);
  await page.keyboard.up('Space');

  await page.evaluate(() => window.showGameOver?.('You hit a tree!'));
  await expect(page.getByRole('dialog', { name: 'Run ended' })).toBeVisible();
  await expect(page.locator('#restartButton')).toBeFocused();
  await expect(page.locator('#cameraControls')).toHaveJSProperty('inert', true);
  await expect(page.locator('#gameOverOverlay #authContainer')).toHaveCount(1);
  await expect(page.locator('#authContainer')).not.toHaveJSProperty('inert', true);
  await expect(page.locator('#gameAnnouncements')).toContainText('You hit a tree!');
  await expect(page.locator('#currentTime')).not.toHaveAttribute('aria-live');
  await page.keyboard.press('Escape');
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await page.locator('#restartButton').click();
  expect(await page.evaluate(() => {
    const restarted = (window as GameWindow).gameActive;
    (window as GameWindow).gameActive = false;
    return restarted;
  })).toBe(true);
  await expect(page.locator('#gameOverOverlay')).toBeHidden();
  await expect(page.locator('#gameCanvas')).toBeFocused();
  await expect(page.locator('#cameraControls')).not.toHaveJSProperty('inert', true);
  await expect(page.locator('#hudRight > #authContainer')).toHaveCount(1);
  await expect(page.locator('#gameAnnouncements')).toContainText('run started');
});

test('real-player release notice, About, and EZ mountain screenshots', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'real-player screenshot evidence uses Chromium');
  test.setTimeout(120_000);
  // Exercise the player branch, not automation's reduced scene. Reduced motion
  // is a real user preference that skips the intro without changing the world.
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoGame(page, '?eztrees=1');
  await expect(page.locator('.physics-era-notice')).toContainText('earlier records are retained');
  await testInfo.attach('physics-v3-start-screen', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'About Game', exact: true }).click();
  await testInfo.attach('about-screen', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await startGame(page);
  await page.waitForFunction(() => {
    const terrain = (window as Window & { terrainMesh?: { parent?: { children: Array<{ name: string; userData: Record<string, unknown> }> } } }).terrainMesh;
    return terrain?.parent?.children.some((child) => child.name === 'forestInstanced' && child.userData.forestPart === 'ezBranches');
  }, undefined, { timeout: 30_000 });
  await expect(page.locator('#gameCanvas canvas')).toBeVisible();
  await testInfo.attach('real-player-ez-mountain', { body: await page.screenshot(), contentType: 'image/png' });
});
