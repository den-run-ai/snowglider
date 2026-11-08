import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, mockFirebase, startGame, type GameWindow } from './helpers';

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

test('Google, GitHub, guest upgrade and logout remain usable across menu and results', async ({ page, hasTouch, baseURL }, testInfo) => {
  await mockFirebase(page, baseURL);
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
  expect(dialogs[0]).toMatch(/allow pop-ups/i);
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
  await page.addInitScript(() => localStorage.setItem('snowgliderDifficulty', 'expert'));
  await gotoGame(page);
  await startGame(page);
  await page.evaluate(async () => {
    const coursePath = '/src/course.ts';
    const { CourseModule } = await import(/* @vite-ignore */ coursePath) as typeof import('../../src/course.js');
    CourseModule.addAirScore(125);
    // Set the live simulation clock through the existing test seam, then take
    // the REAL successful-finish path (panel placement, focus, account controls,
    // and scrolling included). No independently assembled result fixture.
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: () => Promise.reject(new Error('native sharing unavailable')),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('clipboard denied')) },
    });
    (window as unknown as Window & { simElapsed: number }).simElapsed = 30;
    window.showGameOver?.('You reached the end of the slope!');
    // Record any deferred start toast that tries to appear after results. Keep
    // observing beyond the orchestrator's 1.5s delay while exercising the menu.
    const w = window as Window & { __resultToastCheck?: Promise<boolean>; __shareOpened?: string[] };
    let staleToast = [...document.body.children].some(el => el.textContent === 'Get Ready!');
    const observer = new MutationObserver(() => {
      staleToast ||= [...document.body.children].some(el => el.textContent === 'Get Ready!');
    });
    observer.observe(document.body, { childList: true });
    w.__resultToastCheck = new Promise(resolve => setTimeout(() => {
      observer.disconnect();
      resolve(staleToast);
    }, 1700));
    w.__shareOpened = [];
    window.open = url => { w.__shareOpened!.push(String(url)); return null; };
  });
  await page.locator('#courseResult > div').first().scrollIntoViewIfNeeded();
  await expect(page.locator('#audioControlBtn')).toBeHidden();
  await testInfo.attach('result-heading-viewport', {
    body: await page.screenshot(), contentType: 'image/png',
  });
  await activate(page.locator('#shareResultBtn'), hasTouch);
  await expect(page.locator('#shareMenu')).toBeVisible();
  await expect(page.locator('#courseResult')).not.toContainText(/Infinity|NaN/);
  await expect(page.locator('#resultDifficulty')).toContainText('Expert');
  await expect(page.locator('#resultAirScore')).toContainText('125');
  // If software rendering made this run ineligible, the course card must
  // agree with the overlay's explicit "not recorded" status.
  if (await page.locator('#syncStatus').filter({ hasText: /not recorded/i }).count()) {
    await expect(page.locator('#courseResult')).not.toContainText(/First descent|New record|Silver run|Bronze run/);
  }
  for (const platform of ['x', 'facebook', 'linkedin', 'whatsapp', 'reddit', 'telegram']) {
    await expectUsable(page, `#share-${platform}-btn`);
    await activate(page.locator(`#share-${platform}-btn`), hasTouch);
  }
  expect(await page.evaluate(() => (window as Window & { __shareOpened?: string[] }).__shareOpened)).toHaveLength(6);
  await page.locator('#shareMenu').scrollIntoViewIfNeeded();
  await testInfo.attach('expanded-result-sharing-viewport', {
    body: await page.screenshot(), contentType: 'image/png',
  });
  await page.evaluate(() => {
    const w = window as Window & { __shareCopied?: string[] };
    w.__shareCopied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => {
      w.__shareCopied!.push(text);
      return Promise.resolve();
    } } });
  });
  await expectUsable(page, '#shareCopyBtn');
  await expect(page.locator('#shareCopyBtn')).toHaveText('🔗 Copy result + link');
  await activate(page.locator('#shareCopyBtn'), hasTouch);
  await expect(page.locator('#shareCopyBtn')).toHaveText(/Copied/);
  const copied = await page.evaluate(() => (window as Window & { __shareCopied?: string[] }).__shareCopied);
  expect(copied).toHaveLength(1);
  expect(copied![0]).toContain('Expert');
  expect(copied![0]).toContain('30.00s');
  expect(copied![0]).toContain('Air score: 125');
  expect(copied![0]).toContain('https://snowglider.ai/');
  await page.locator('#shareCopyBtn').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shareResultBtn')).toBeFocused();
  await expect(page.locator('#shareMenu')).toBeHidden();
  await expect(page.locator('#gameOverOverlay')).toBeVisible();
  await expectUsable(page, '#shareImageBtn');
  await expect(page.locator('#shareImageBtn')).toHaveText(hasTouch ? '📸 Share run image' : '📸 Download run image');
  expect(await page.evaluate(() => (window as Window & { __resultToastCheck?: Promise<boolean> }).__resultToastCheck),
    'no delayed Get Ready toast appears over results').toBe(false);
});


type NativeShareProbe = {
  calls: Array<{
    text: string;
    url: string;
    files: Array<{ name: string; type: string; size: number }>;
    userActivation: boolean | null;
  }>;
  copies: string[];
  cancel: boolean;
};

test('native sharing attaches a prepared PNG only with confirmed file support', async ({ page, hasTouch, baseURL }) => {
  test.skip(!hasTouch, 'The native sheet is the mobile sharing path.');
  await mockFirebase(page, baseURL);
  await page.addInitScript(() => {
    localStorage.setItem('snowgliderDifficulty', 'black');
    const w = window as unknown as Window & { __nativeShareProbe: NativeShareProbe };
    w.__nativeShareProbe = { calls: [], copies: [], cancel: false };
    Object.defineProperty(navigator, 'share', { configurable: true, value: (data: ShareData) => {
      w.__nativeShareProbe.calls.push({
        text: data.text ?? '',
        url: data.url ?? '',
        files: (data.files ?? []).map(file => ({ name: file.name, type: file.type, size: file.size })),
        userActivation: navigator.userActivation?.isActive ?? null,
      });
      return w.__nativeShareProbe.cancel
        ? Promise.reject(new DOMException('Share cancelled', 'AbortError')) : Promise.resolve();
    } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => { w.__nativeShareProbe.copies.push(text); return Promise.resolve(); },
    } });
  });
  await gotoGame(page, '?intro=off');
  await startGame(page);
  await page.evaluate(async () => {
    const coursePath = '/src/course.ts';
    const { CourseModule } = await import(/* @vite-ignore */ coursePath) as typeof import('../../src/course.js');
    CourseModule.addAirScore(125);
    (window as unknown as Window & { simElapsed: number }).simElapsed = 30;
    window.showGameOver?.('You reached the end of the slope!');
  });
  const primary = page.locator('#shareResultBtn');
  const image = page.locator('#shareImageBtn');
  await expect(image).toBeEnabled(); // exercise a ready PNG, not the cold-text fallback
  await expect(image).toHaveText('📸 Share run image');
  let downloads = 0;
  page.on('download', () => { downloads++; });
  const probe = () => page.evaluate(() => (window as unknown as Window & { __nativeShareProbe: NativeShareProbe }).__nativeShareProbe);

  // Some older native implementations ignore unknown `files` rather than
  // rejecting. Without canShare, the primary action must share text explicitly.
  await activate(primary, hasTouch);
  await expect.poll(async () => (await probe()).calls.length).toBe(1);
  expect((await probe()).calls[0]!.files).toHaveLength(0);
  expect((await probe()).calls[0]!.url).toBe('https://snowglider.ai/');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await activate(primary, hasTouch);
  await expect.poll(async () => (await probe()).calls.length).toBe(2);
  expect((await probe()).calls[1]!.files).toHaveLength(0);

  // Once PNG support is confirmed, the same original tap must reach native
  // sharing with the real composed File and the completed run's exact context.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: ShareData) =>
      data.files?.length === 1 && data.files[0]?.type === 'image/png',
    });
  });
  await activate(primary, hasTouch);
  await expect.poll(async () => (await probe()).calls.length).toBe(3);
  const successful = (await probe()).calls[2]!;
  expect(successful.files).toHaveLength(1);
  expect(successful.files[0]).toMatchObject({ name: 'snowglider-run.png', type: 'image/png' });
  expect(successful.files[0]!.size).toBeGreaterThan(0);
  expect(successful.text).toContain('Black');
  expect(successful.text).toContain('30.00s');
  expect(successful.text).toContain('Air score: 125');
  expect(successful.text).toContain('https://snowglider.ai/');
  // Engines without UserActivation cannot expose this observation; engines that
  // do must still have the tap's activation when share() is invoked.
  if (successful.userActivation !== null) expect(successful.userActivation).toBe(true);

  await page.evaluate(() => { (window as unknown as Window & { __nativeShareProbe: NativeShareProbe }).__nativeShareProbe.cancel = true; });
  await activate(image, hasTouch);
  await expect.poll(async () => (await probe()).calls.length).toBe(4);
  await expect(image).toBeEnabled();
  expect((await probe()).copies).toHaveLength(0);
  expect(downloads, 'cancelled native image share must not download automatically').toBe(0);
  await expect(page.locator('#shareMenu')).toBeHidden();

  // Explicitly asking for an image still works without file-share support, and
  // reports only that the browser download started, not that a file was saved.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  });
  const downloaded = page.waitForEvent('download');
  await activate(image, hasTouch);
  expect((await downloaded).suggestedFilename()).toBe('snowglider-run.png');
  await expect(image).toHaveText('✅ Download started');
  expect((await probe()).calls).toHaveLength(4);
});
