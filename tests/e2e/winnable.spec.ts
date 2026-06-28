import { test, expect } from '@playwright/test';
import { gotoGame, startGame, getPos } from './helpers';

// Tier-2 finishability smoke for the SHIPPED game build (companion to the deterministic
// Node gate in tests/verification/winnability_harness.js).
//
// Scope: prove the real DOM + game loop + course let a clean, hazard-cleared line reach
// the finish (z < -195). It does NOT assert the avalanche-escape (winnability) property:
// the live avalanche advances on the variable render delta (wall-clock dependent), so a
// real-browser "outrun the slide" outcome is inherently non-deterministic and would
// flake. That property is gated deterministically, at fixed dt, in the Node harness
// (G2/G3) — which is also what gates deploy (it runs inside `npm test`). Here we disable
// the avalanche to isolate terrain + physics + course finishing, the same way the reset
// spec clears the random tree/rock field to isolate the thing it tests.
test.describe('Winnability (integrated)', () => {
  test('a clean line reaches the finish (real game build, avalanche isolated)', async ({ page }) => {
    await gotoGame(page);
    await startGame(page);

    const start = await getPos(page);
    expect(start, 'run did not publish a player position').not.toBeNull();

    await page.evaluate(() => {
      const w = window as unknown as {
        treePositions?: unknown[];
        rockPositions?: unknown[];
        avalanche?: { trigger?: (...a: unknown[]) => void };
      };
      // Remove the random hazards in place (same live refs the physics reads each frame),
      // exactly as the reset spec does, so a no-steer coast can't crash mid-descent.
      if (Array.isArray(w.treePositions)) w.treePositions.length = 0;
      if (Array.isArray(w.rockPositions)) w.rockPositions.length = 0;
      // Disable the avalanche for this finishability check: neuter trigger() so the slide
      // never activates (and so checkBurial stays false). The escape/burial behaviour is
      // covered deterministically by the Node winnability harness, not here.
      if (w.avalanche) w.avalanche.trigger = () => {};
    });

    // Hold forward from the top and don't let go (the player's own winning advice).
    await page.keyboard.down('ArrowUp');
    try {
      // Assert ONLY that the finish (z < -195, course.ts FINISH_Z) is reached — no
      // wall-clock time, so balance tuning within the winnable envelope can't flake it.
      // A clean line finishes in ~26 s of game time; 60 s leaves ample slack for startup
      // and CI load. A drag/gradient/course-length regression that stalls the descent
      // short of the finish trips this.
      await expect
        .poll(async () => (await getPos(page))?.z ?? 0, { timeout: 60_000 })
        .toBeLessThan(-195);
    } finally {
      await page.keyboard.up('ArrowUp');
    }
  });
});
