import { test, expect } from '@playwright/test';
import { gotoGame, startGame, getPos, getControls, waitForDownhillTravel } from './helpers';

// Step 2 — real user-flow E2E. These drive the actual game through the menu and
// the keyboard and observe emergent behavior (the snowman skiing the fall line,
// steering, the live run timer), rather than poking the in-page unit suites.
// Runs on chromium + webkit.
test.describe('gameplay flow', () => {
  test('start -> ski downhill -> the run timer advances', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const start = await getPos(page);
    expect(start, 'run did not publish a player position').not.toBeNull();

    // The snowman skis the fall line under gravity with no input; it should travel.
    await waitForDownhillTravel(page, start!.z, 5);

    // The HUD run timer is counting up from zero.
    await expect
      .poll(async () => {
        const txt = (await page.locator('#currentTime').textContent()) || '0';
        return parseFloat(txt.replace('s', ''));
      })
      .toBeGreaterThan(0);
  });

  test('arrow keys steer the snowman (input -> controls -> lateral movement)', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const before = await getPos(page);

    // Hold left: the shared controls state must flip immediately...
    await page.keyboard.down('ArrowLeft');
    expect((await getControls(page))?.left).toBe(true);

    // ...and holding it should shift the snowman's x meaningfully vs. no input.
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowLeft');
    expect((await getControls(page))?.left).toBe(false);

    const after = await getPos(page);
    expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(1);
  });

  test('reset returns the snowman to the start', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const start = await getPos(page);

    // Ski some distance downhill, then hit the on-screen Reset button.
    await waitForDownhillTravel(page, start!.z, 10);
    await page.click('#resetBtn');
    await page.waitForTimeout(200);

    const afterReset = await getPos(page);
    expect(Math.abs(afterReset!.z - start!.z)).toBeLessThan(5);
  });
});
