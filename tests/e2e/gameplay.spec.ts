import { test, expect } from './fixtures';
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
    expect(before, 'run did not publish a player position').not.toBeNull();

    // Hold left: the shared controls state must flip immediately...
    await page.keyboard.down('ArrowLeft');
    expect((await getControls(page))?.left).toBe(true);

    // ...and holding it must shift the snowman's x meaningfully vs. no input. Poll
    // for that movement instead of a fixed wait so the test stays deterministic
    // under variable CI load (the poll doubles as the assertion).
    await expect
      .poll(async () => {
        const p = await getPos(page);
        return p ? Math.abs(p.x - before!.x) : 0;
      })
      .toBeGreaterThan(1);

    await page.keyboard.up('ArrowLeft');
    expect((await getControls(page))?.left).toBe(false);
  });

  test('finish results scroll while replay stays visible on phones and short screens', async ({ page }, testInfo) => {
    await gotoGame(page, '?eztrees=1&intro=off');
    await startGame(page);
    await page.evaluate(() => {
      const w = window as unknown as { simElapsed: number; showGameOver: (r: string) => void };
      w.simElapsed = 20;
      w.showGameOver('You reached the end of the slope!');
    });
    await expect(page.locator('#gameOverOverlay')).toBeVisible();
    await expect(page.locator('#courseResult')).toBeVisible();

    // A newly installed PWA version is another asynchronous result-screen child.
    // Use the real mounting seam: it must join the scroll area, never push replay away.
    await page.evaluate(async () => {
      const modulePath = '/src/pwa/update-ui.ts';
      const ui = await import(modulePath) as typeof import('../../src/pwa/update-ui.js');
      ui.showUpdatePrompt(() => {});
    });
    await expect(page.locator('#gameOverContent #swUpdateBanner')).toHaveCount(1);

    await page.waitForFunction(() => {
      const terrain = (window as Window & {
        terrainMesh?: { parent?: { children: Array<{ userData: Record<string, unknown> }> } };
      }).terrainMesh;
      return terrain?.parent?.children.some(child => child.userData.forestPart === 'ezBranches');
    });

    // Verify bounds BEFORE a click can auto-scroll a hidden restart into view.
    // Include the reported iPhone dimensions, a smaller phone and short landscape.
    for (const viewport of [{ width: 428, height: 750 }, { width: 320, height: 568 }, { width: 820, height: 360 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, viewport);
      const layout = await page.evaluate(() => {
        const overlay = document.getElementById('gameOverOverlay')!;
        const content = document.getElementById('gameOverContent')!;
        const restart = document.getElementById('restartButton')!;
        const picker = document.getElementById('finishDifficultyPicker')!;
        content.scrollTop = 0;
        const button = restart.getBoundingClientRect();
        const choices = picker.getBoundingClientRect();
        const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
        return {
          restartVisible: button.top >= 0 && button.bottom <= innerHeight && button.left >= 0 && button.right <= innerWidth,
          pickerVisible: choices.top >= 0 && choices.bottom <= innerHeight,
          hit: hit === restart || restart.contains(hit),
          outerScroll: overlay.scrollHeight - overlay.clientHeight,
          overflow: content.scrollHeight > content.clientHeight,
          restartTop: button.top,
        };
      });
      expect(layout.restartVisible, JSON.stringify(viewport)).toBe(true);
      expect(layout.pickerVisible, JSON.stringify(viewport)).toBe(true);
      expect(layout.hit, 'restart is directly hit-testable without scrolling').toBe(true);
      expect(layout.outerScroll).toBeLessThanOrEqual(1);
      expect(layout.overflow, 'long results scroll inside their own region').toBe(true);
      await testInfo.attach(`finish-replay-${viewport.width}x${viewport.height}`, {
        body: await page.screenshot(), contentType: 'image/png',
      });
      await page.evaluate(() => { document.getElementById('gameOverContent')!.scrollTop = 10000; });
      expect((await page.locator('#restartButton').boundingBox())!.y).toBeCloseTo(layout.restartTop, 0);
    }

    // Expanded sharing may add content but cannot displace the replay footer.
    await page.click('#shareResultBtn');
    await expect(page.locator('#shareMenu')).toBeVisible();
    const button = await page.locator('#restartButton').boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(360);
    await page.click('#restartButton');
    await expect(page.locator('#gameOverOverlay')).toBeHidden();
  });

  test('reset returns the snowman to the start', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const start = await getPos(page);
    expect(start, 'run did not publish a player position').not.toBeNull();

    // Remove the random hazards before skiing. The snowman coasts an unseeded,
    // randomly-generated tree/rock field with no input, so it can crash
    // mid-coast; the resulting game-over overlay (full-screen, z-index 1000) then
    // covers #resetBtn and the click retries until the test times out (the
    // observed CI flake). Clearing the live collision arrays in place (they are
    // the same refs the physics reads each frame — snowglider.ts publishes
    // window.treePositions/rockPositions = the stepPlayer args) keeps the run
    // live so we exercise the *real*, hit-tested Reset button click below — a
    // forced/dispatched click would instead mask a genuinely covered/unusable
    // button. Done here rather than in a shared helper to keep the hazard removal
    // scoped to the one spec that needs a guaranteed-survivable coast.
    await page.evaluate(() => {
      const w = window as unknown as { treePositions?: unknown[]; rockPositions?: unknown[] };
      if (Array.isArray(w.treePositions)) w.treePositions.length = 0;
      if (Array.isArray(w.rockPositions)) w.rockPositions.length = 0;
    });

    // Ski some distance downhill, then hit the on-screen Reset button.
    await waitForDownhillTravel(page, start!.z, 10);
    await page.click('#resetBtn');

    // Reset republishes the start position; poll for it instead of a fixed wait so
    // the test doesn't race the reset handler / next frame under variable CI load.
    await expect
      .poll(async () => {
        const p = await getPos(page);
        return p ? Math.abs(p.z - start!.z) : Infinity;
      })
      .toBeLessThan(5);
  });
});
