import { test, expect } from '@playwright/test';

// Plan §1B-ii — one canonical RENDERED frame (the explicitly-flaky tier). Unlike
// the DOM-overlay tier (overlays.spec.ts), this screenshots the live WebGL canvas,
// so it is subject to GPU/driver anti-aliasing non-determinism — hence a GENEROUS
// maxDiffPixelRatio and a single engine. It is double-gated: it runs only via the
// opt-in visual config AND only when VISUAL_CANVAS=1, because committable baselines
// require the canonical CI image (software-GL renders differ from a dev GPU) and
// the repo's no-PNG-in-tree rule means baselines are gitignored per-environment.
//
// Determinism controls (plan §1B-ii):
//  - Math.random is seeded via addInitScript BEFORE any page script runs, so the
//    procedural terrain/tree layout (per-vertex Math.random noise) is reproducible.
//  - reduced-motion freezes the sky cycle to midday (scene-setup.ts / src/sky.ts).
//  - fixed viewport + deviceScaleFactor:1 (set in playwright.visual.config.ts).
//  - a fixed number of rAF ticks advances the run to a stable, repeatable frame.

const SEED = 0x5eed; // any fixed value; only needs to be stable run-to-run.

test.describe('visual: canonical rendered frame @flaky', () => {
  test.skip(!process.env.VISUAL_CANVAS, 'canvas visual baseline tier; set VISUAL_CANVAS=1 to run');

  test('seeded mountain renders to a stable frame', async ({ page }) => {
    // Seed Math.random with a deterministic mulberry32 PRNG before the game's
    // modules build the (otherwise random) terrain + tree field. Must be an init
    // script so it is installed before main.ts runs.
    await page.addInitScript((seed: number) => {
      let a = seed >>> 0;
      Math.random = () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }, SEED);

    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#startGameButton')).toBeVisible();
    await page.waitForFunction(
      () => typeof (window as unknown as { initializeGameWithAudio?: () => void }).initializeGameWithAudio === 'function',
    );
    await page.click('#startGameButton');
    await page.waitForFunction(() => (window as unknown as { gameActive?: boolean }).gameActive === true);

    // Advance a fixed number of frames so the captured frame is repeatable.
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    }

    // Loose tolerance: the live framebuffer diff absorbs sub-pixel AA differences
    // but still fails on a real rendering regression (colour management, lighting
    // rebalance, shadow artifacts) which touches a large fraction of pixels.
    await expect(page.locator('#gameCanvas')).toHaveScreenshot('canonical-frame.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
