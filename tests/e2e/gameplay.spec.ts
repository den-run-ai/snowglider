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
