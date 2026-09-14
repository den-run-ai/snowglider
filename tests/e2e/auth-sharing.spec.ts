import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, startGame, type GameWindow } from './helpers';

type MockUser = { uid: string; isAnonymous: boolean; displayName: string | null; email: string | null };
type FirebaseMock = {
  calls: { signInAnonymously: number; signOut: number };
  emitAuthState(user: MockUser | null): void;
  setAuthCurrentUser(user: MockUser | null): void;
  setNextPopupResult(result: { resolve?: unknown; reject?: unknown } | null): void;
  setNextLinkResult(result: { resolve?: unknown; reject?: unknown } | null): void;
};

async function activate(button: Locator, touch: boolean): Promise<void> {
  if (touch) await button.tap();
  else await button.click();
}

async function expectUsable(page: Page, selector: string): Promise<void> {
  const button = page.locator(selector);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.scrollIntoViewIfNeeded();
  const geometry = await button.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      width: box.width, height: box.height,
      left: box.left, right: box.right,
      unclipped: el.scrollWidth <= el.clientWidth + 1,
      reachable: !!hit && el.contains(hit),
    };
  });
  expect(geometry.width, `${selector} touch width`).toBeGreaterThanOrEqual(44);
  expect(geometry.height, `${selector} touch height`).toBeGreaterThanOrEqual(44);
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(geometry.unclipped, `${selector} label is not clipped`).toBe(true);
  expect(geometry.reachable, `${selector} receives taps`).toBe(true);
}

// Keep the production auth module, markup, event bindings and popup flow. Only
// replace the external Firebase SDK, so no real account login or score write is
// attempted. All CDN imports re-export ONE local mock instance for state control.
async function mockFirebase(page: Page, baseURL: string): Promise<void> {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `export * from ${JSON.stringify(`${baseURL}/tests/mocks/firebase.mjs`)};`,
  }));
}

test('Google, GitHub, guest upgrade and logout remain usable across menu and results', async ({ page, hasTouch, baseURL }, testInfo) => {
  await mockFirebase(page, baseURL!);
  await gotoGame(page);
  await page.waitForFunction(() => window.AuthModule?.isFirebaseAvailable?.().auth === true);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    fb.emitAuthState(null);
    fb.setNextPopupResult({ reject: { code: 'auth/popup-blocked', message: 'blocked' } });
  });
  for (const selector of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) await expectUsable(page, selector);

  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await activate(page.locator('#loginBtn'), hasTouch);
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/allow popups/i);
  await expect(page.locator('#loginBtn')).toBeEnabled();

  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    fb.setNextPopupResult({ reject: { code: 'auth/popup-closed-by-user', message: 'cancelled' } });
  });
  await activate(page.locator('#githubLoginBtn'), hasTouch);
  await expect(page.locator('#githubLoginBtn')).toBeEnabled();
  expect(dialogs).toHaveLength(1);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    fb.setNextPopupResult(null);
  });
  await activate(page.locator('#guestLoginBtn'), hasTouch);
  await expect.poll(() => page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    return (await import(/* @vite-ignore */ path) as FirebaseMock).calls.signInAnonymously;
  })).toBe(1);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    const user = { uid: 'guest-ui', isAnonymous: true, displayName: null, email: null };
    fb.setAuthCurrentUser(user);
    fb.emitAuthState(user);
  });
  await expect(page.locator('#authUI')).toBeHidden();
  await expectUsable(page, '#profileChip');
  await activate(page.locator('#profileChip'), hasTouch);
  await expect(page.locator('#profileChip')).toHaveAttribute('aria-expanded', 'true');
  for (const selector of ['#loginBtn', '#githubLoginBtn']) await expectUsable(page, selector);
  await testInfo.attach('guest-account-controls', {
    body: await page.locator('#authContainer').screenshot(), contentType: 'image/png',
  });
  await page.locator('#githubLoginBtn').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#profileChip')).toBeFocused();
  await expect(page.locator('#authUI')).toBeHidden();
  await activate(page.locator('#profileChip'), hasTouch);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    fb.setNextLinkResult({ resolve: { user: {
      uid: 'guest-ui', isAnonymous: false,
      displayName: 'Alexandra A Very Long Display Name', email: 'ui@example.invalid', photoURL: null,
    } } });
  });
  await activate(page.locator('#githubLoginBtn'), hasTouch);
  await expect(page.locator('#profileName')).toHaveText('Alexandra A Very Long Display Name');
  await expect(page.locator('#authUI')).toBeHidden();
  await expectUsable(page, '#logoutBtn');
  expect(await page.evaluate(() => window.AuthModule?.getAuthState?.().user?.uid)).toBe('guest-ui');

  await startGame(page);
  await page.evaluate(() => {
    (window as GameWindow).gameActive = false;
    window.showGameOver?.('You hit a tree!');
  });
  await expect(page.locator('#gameOverOverlay #authContainer')).toBeVisible();
  await expectUsable(page, '#logoutBtn');
  await activate(page.locator('#logoutBtn'), hasTouch);
  await expect.poll(() => page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    return (await import(/* @vite-ignore */ path) as FirebaseMock).calls.signOut;
  })).toBe(1);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(/* @vite-ignore */ path) as FirebaseMock;
    fb.setAuthCurrentUser(null);
    fb.emitAuthState(null);
  });
  for (const selector of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) await expectUsable(page, selector);
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
});

test('all social targets fit narrow results and native share fallback remains reachable', async ({ page, hasTouch }, testInfo) => {
  await gotoGame(page);
  await startGame(page);
  await page.evaluate(() => {
    // Set the live simulation clock through the existing test seam, then take
    // the REAL successful-finish path (panel placement, focus, account controls,
    // and scrolling included). No independently assembled result fixture.
    (window as unknown as Window & { simElapsed: number }).simElapsed = 30;
    window.showGameOver?.('You reached the end of the slope!');
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: () => Promise.reject(new Error('native sharing unavailable')),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('clipboard denied')) },
    });
    const w = window as Window & { __shareOpened?: string[] };
    w.__shareOpened = [];
    window.open = url => { w.__shareOpened!.push(String(url)); return null; };
  });
  await activate(page.locator('#shareResultBtn'), hasTouch);
  await expect(page.locator('#shareMenu')).toBeVisible();
  for (const platform of ['x', 'facebook', 'linkedin', 'whatsapp', 'reddit', 'telegram']) {
    await expectUsable(page, `#share-${platform}-btn`);
    await activate(page.locator(`#share-${platform}-btn`), hasTouch);
  }
  expect(await page.evaluate(() => (window as Window & { __shareOpened?: string[] }).__shareOpened)).toHaveLength(6);
  await testInfo.attach('expanded-result-sharing', {
    body: await page.locator('#courseResult').screenshot(), contentType: 'image/png',
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  });
  await expectUsable(page, '#shareCopyBtn');
  await activate(page.locator('#shareCopyBtn'), hasTouch);
  await expect(page.locator('#shareCopyBtn')).toHaveText(/Copied/);
  await page.locator('#shareCopyBtn').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shareResultBtn')).toBeFocused();
  await expect(page.locator('#shareMenu')).toBeHidden();
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await expectUsable(page, '#shareImageBtn');
});
