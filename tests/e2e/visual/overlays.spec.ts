import { test, expect, type Page } from '@playwright/test';

// Plan §1B-i — DOM-overlay visual snapshots (the reliable everyday tier). The
// start menu, auth panel, and About panel are real, stable HTML, so
// toHaveScreenshot on them is essentially deterministic (tight tolerance). The
// entire visual game bug history is *visual* (colour management, light rebalance,
// shadow artifacts, sky cycle) and unreachable by logic/invariant tests; these
// overlays are the low-flake foothold for guarding that surface.
//
// NOTE: this spec runs only via `npm run test:e2e:visual` (playwright.visual.config.ts),
// never in the default CI e2e job — baselines are environment-specific and must be
// regenerated on the CI image before wiring in. See the config header.

/** Load the start screen and wait for the menu + build badge to settle. */
async function gotoMenu(page: Page): Promise<void> {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#startGameButton')).toBeVisible();
  // start-menu.ts stamps #buildBadge after load; wait for it so it's masked
  // consistently rather than racing an empty-vs-filled badge.
  await expect(page.locator('#buildBadge')).not.toBeEmpty();
}

test.describe('visual: DOM overlays', () => {
  test('start menu', async ({ page }) => {
    await gotoMenu(page);
    // #buildBadge falls back to a wall-clock timestamp when no build-id meta is
    // present (start-menu.ts), so mask it — everything else in the menu is static.
    await expect(page.locator('#startGameContainer')).toHaveScreenshot('start-menu.png', {
      mask: [page.locator('#buildBadge')],
    });
  });

  test('auth sign-in panel', async ({ page }) => {
    await gotoMenu(page);
    // Local/offline mode shows the three provider buttons (Google/GitHub/Guest);
    // the profile chip stays hidden until signed in. Static SVG + text.
    await expect(page.locator('#authUI')).toBeVisible();
    await expect(page.locator('#authContainer')).toHaveScreenshot('auth-panel.png');
  });

  test('about panel', async ({ page }) => {
    await gotoMenu(page);
    await page.click('#aboutGameButton');
    await expect(page.locator('#aboutGamePanel')).toBeVisible();
    await expect(page.locator('#aboutGamePanel')).toHaveScreenshot('about-panel.png');
  });
});
