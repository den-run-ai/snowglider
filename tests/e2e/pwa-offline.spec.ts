import { test, expect, type Page } from '@playwright/test';
import { startGame, waitForDownhillTravel, getPos } from './helpers';

// PWA / offline acceptance (issue #358, PR 5). Runs against the PRODUCTION build via
// `vite preview` (see playwright.pwa.config.ts) — the ONLY place the real service
// worker (dist/sw.js) exists. Proves the offline contract end-to-end:
//   1. after one online load, the game launches + plays OFFLINE;
//   2. the SW never registers under ?test= (the deployed browser suites stay on the
//      network path);
//   3. the ?sw=reset escape hatch unregisters the SW + clears our caches.
//
// Chromium only (see the config): the most reliable SW + offline emulation in
// Playwright. These specs are matched by testMatch: /pwa-.*\.spec\.ts/.

/** Wait until a service worker is active (registered + activated) for this page. */
async function waitForServiceWorkerActive(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg && !!reg.active;
    },
    undefined,
    { timeout: 30_000 },
  );
}

test.describe('PWA offline mode', () => {
  test('after one online load, the game launches and plays offline', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // 1) First online load registers the service worker.
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#startGameButton')).toBeVisible();
    await waitForServiceWorkerActive(page);

    // 2) Reload online so this page is CONTROLLED by the worker (clients.claim + reload).
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    });

    // 3) Go offline and reload — the app shell must come from the cache.
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#startGameButton')).toBeVisible();
    // The deferred orchestrator must still wire up start from cached chunks.
    await page.waitForFunction(
      () => typeof (window as Window & { initializeGameWithAudio?: unknown }).initializeGameWithAudio === 'function',
      undefined,
      { timeout: 30_000 },
    );

    // 4) Core gameplay works offline: start a run and confirm the sim advances.
    await startGame(page);
    const start = await getPos(page);
    expect(start, 'run should publish a position offline').not.toBeNull();
    await waitForDownhillTravel(page, start!.z, 2);

    await page.context().setOffline(false);
    expect(pageErrors, `unexpected page errors offline:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('does not register the service worker under ?test=', async ({ page }) => {
    // A fresh context: navigating straight to a ?test= route must NOT register the SW
    // (main.ts gates registration off), so the deployed in-page suites keep the real
    // network path and can never be served a stale cached shell.
    await page.goto('/?test=smoke', { waitUntil: 'load' });
    // isTestMode is assigned by setupScene(), which can finish AFTER the `load` event (the
    // auth wait / deferred orchestrator import), so WAIT for it rather than reading it once —
    // both to avoid a flaky assertion and so the registration check below reflects a fully
    // initialized test page (Codex #363).
    await page.waitForFunction(
      () => (window as Window & { isTestMode?: boolean }).isTestMode === true,
      undefined,
      { timeout: 30_000 },
    );
    // Even after full test-mode init, main.ts must NOT have registered the SW under ?test=.
    const registrations = await page.evaluate(() =>
      navigator.serviceWorker.getRegistrations().then((r) => r.length),
    );
    expect(registrations, 'SW must not register on a ?test= route').toBe(0);
  });

  test('an already-installed worker still bypasses ?test= (never serves it the cached shell)', async ({ page }) => {
    // The production hazard the fresh-context test above can't see (Codex #363): an origin
    // that ALREADY has SnowGlider's SW installed from a normal '/' visit, then loads a
    // ?test= route. If the worker's navigation fallback regressed and served the cached app
    // shell for /?test=..., the deployed in-page suites would silently run against a stale
    // shell instead of the network. Prove the bypass holds WITH an active, controlling worker.
    await page.goto('/', { waitUntil: 'load' });
    await waitForServiceWorkerActive(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    });

    // Go offline. Baseline: a normal '/' navigation IS served the cached shell (so we know
    // the worker is genuinely active + serving, not simply absent).
    await page.context().setOffline(true);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#startGameButton')).toBeVisible();

    // The real assertion: a ?test= navigation is NOT served from cache. The worker must let
    // it hit the network — which is down — so the navigation FAILS. If the fallback wrongly
    // served the cached shell for ?test=, this goto would instead succeed.
    const testNavFailed = await page
      .goto('/?test=smoke', { waitUntil: 'domcontentloaded' })
      .then(() => false)
      .catch(() => true);
    expect(testNavFailed, 'offline ?test= must NOT be served the cached shell — the worker must bypass it').toBe(true);

    await page.context().setOffline(false);
  });

  test('?sw=reset unregisters the worker and clears our caches', async ({ page }) => {
    // Register the SW first.
    await page.goto('/', { waitUntil: 'load' });
    await waitForServiceWorkerActive(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    });

    // Seed a sentinel cache under our prefix so we can prove the reset cleared it.
    await page.evaluate(async () => {
      const c = await caches.open('snowglider-sentinel');
      await c.put('/__sentinel__', new Response('x'));
    });
    expect(await page.evaluate(() => caches.has('snowglider-sentinel'))).toBe(true);

    // Trigger the escape hatch. resetServiceWorker unregisters, clears our caches, and
    // replaces the URL back to a clean '/'.
    await page.goto('/?sw=reset', { waitUntil: 'load' });
    await page.waitForURL((url) => !url.search.includes('sw=reset'), { timeout: 30_000 });

    // Our sentinel cache is gone (the reset deleted every snowglider-*/workbox-* cache).
    await expect
      .poll(() => page.evaluate(() => caches.has('snowglider-sentinel')), { timeout: 15_000 })
      .toBe(false);
  });
});
