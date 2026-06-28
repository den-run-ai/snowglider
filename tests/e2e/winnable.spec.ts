import { test, expect } from '@playwright/test';
import { gotoGame, startGame, getPos } from './helpers';

// Tier-2 winnability gate (companion to tests/verification/winnability_harness.js).
//
// The Node harness asserts the invariant against a constant-speed POINT model vs. the
// real AvalancheSystem. This spec is the higher-fidelity half: it drives the REAL game
// — real physics descent AND the live avalanche together, which no other test does — to
// prove a full-speed line actually reaches the finish in the shipped build. It guards
// the player-reported "it got harder / I can't finish anymore" regression class: a
// physics/balance tweak that drops top speed below the escape boundary would hang the
// run short of the finish and trip the poll timeout here.
//
// Hazards are cleared (mirroring the reset spec) so the only thing under test is whether
// terrain + physics + the avalanche let a clean, full-speed line reach the bottom — not
// whether a random tree happens to sit on the fall line. Holding ArrowUp keeps the
// snowman at top speed, the line the harness models as FULL_SPEED.
test.describe('Winnability (integrated)', () => {
  test('a clean full-speed line reaches the finish and outruns the avalanche', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const start = await getPos(page);
    expect(start, 'run did not publish a player position').not.toBeNull();

    // Remove the random hazards in place (same live refs the physics reads each frame),
    // exactly as the reset spec does, so the descent is deterministic and survivable.
    await page.evaluate(() => {
      const w = window as unknown as { treePositions?: unknown[]; rockPositions?: unknown[] };
      if (Array.isArray(w.treePositions)) w.treePositions.length = 0;
      if (Array.isArray(w.rockPositions)) w.rockPositions.length = 0;
    });

    // Hold forward from the top and don't let go (the player's own winning advice):
    // keep speed up so the line clears the slide that fires ~80 units in.
    await page.keyboard.down('ArrowUp');
    try {
      // Assert ONLY that the finish (z < -195, course.ts FINISH_Z) is reached — no
      // wall-clock time, so balance tuning within the winnable envelope can't flake it.
      await expect
        .poll(async () => (await getPos(page))?.z ?? 0, { timeout: 30_000 })
        .toBeLessThan(-195);
    } finally {
      await page.keyboard.up('ArrowUp');
    }
  });
});
