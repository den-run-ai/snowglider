import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, type GameWindow } from './helpers';

const difficulties = ['bunny', 'blue', 'black', 'expert'] as const;
const disclosures = ['#startHelpDetails', '#offlinePlayDetails'] as const;

async function activate(locator: Locator, touch: boolean): Promise<void> {
  if (touch) await locator.tap();
  else await locator.click();
}

async function resizeAndSettle(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.waitForFunction(({ width, height }) => (
    window.innerWidth === width && window.innerHeight === height
  ), viewport);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function expectReachable(page: Page, selector: string, minimumTarget = false): Promise<void> {
  const locator = page.locator(selector);
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${selector} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, `${selector} bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
  if (minimumTarget) {
    expect(box.width, `${selector} target width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${selector} target height`).toBeGreaterThanOrEqual(44);
  }
  const hit = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { reachable: !!target && el.contains(target), target: target?.outerHTML.slice(0, 250) };
  });
  expect(hit.reachable, `${selector} hit target is ${hit.target}`).toBe(true);
}

async function expectCoreMenu(page: Page): Promise<void> {
  // Bounding boxes + actual hit testing are intentional: toBeVisible alone passes
  // for the old clipped/offscreen menu, and click() would silently scroll it first.
  await expectReachable(page, '#startGameButton', true);
  for (const difficulty of difficulties) {
    await expectReachable(page, `#difficultyPicker [data-difficulty="${difficulty}"]`, true);
  }
  for (const disclosure of disclosures) {
    await expectReachable(page, `${disclosure} > summary`, true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'the document must not scroll horizontally').toBe(true);
  expect(await page.locator('.start-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'the start card must not clip horizontally').toBe(true);
  expect(await page.evaluate(() => window.scrollY), 'the backdrop must not scroll the document').toBe(0);
}

async function expectAccountSpace(page: Page): Promise<void> {
  const account = (await page.locator('#authContainer').boundingBox())!;
  const card = (await page.locator('.start-dialog').boundingBox())!;
  const overlapWidth = Math.min(account.x + account.width, card.x + card.width) - Math.max(account.x, card.x);
  const overlapHeight = Math.min(account.y + account.height, card.y + card.height) - Math.max(account.y, card.y);
  expect(overlapWidth <= 1 || overlapHeight <= 1, 'account controls must not overlap the start card').toBe(true);
}

test.beforeEach(async ({ page, isMobile }) => {
  if (!isMobile) await resizeAndSettle(page, { width: 1280, height: 720 });
  await gotoGame(page);
});

test('first-load difficulty, Start, offline play, and account controls are visible without scrolling', async ({ page, hasTouch }, testInfo) => {
  // Localhost deliberately disables Firestore. Exercise the production signed-out
  // hint through the same read-only auth seam and event used by the real module.
  await expect(page.locator('#loginBtn')).toBeEnabled();
  await page.evaluate(() => {
    window.AuthModule = {
      ...window.AuthModule,
      isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: false }),
      getAuthState: () => ({ user: null, isSignedIn: false }),
    };
    window.dispatchEvent(new Event('snowglider:auth-changed'));
  });
  await expect(page.locator('#startSignInHint')).toBeVisible();
  await expectCoreMenu(page);
  await expectAccountSpace(page);
  for (const provider of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) {
    await expectReachable(page, provider, true);
  }
  for (const difficulty of difficulties) {
    const option = page.locator(`#difficultyPicker [data-difficulty="${difficulty}"]`);
    await activate(option, hasTouch);
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#difficultyPicker [aria-checked="true"]')).toHaveCount(1);
    await expectCoreMenu(page);
    expect(await page.evaluate(() => (window as GameWindow).gameActive)).not.toBe(true);
  }
  if (testInfo.project.name === 'chromium') {
    // The device projects cover modern phones; these pin the smaller/shorter
    // screens that made Offline and even Start disappear below the fold.
    await activate(page.locator('#difficultyPicker [data-difficulty="blue"]'), hasTouch);
    await expect(page.locator('#startSignInHint')).toBeVisible();
    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      await resizeAndSettle(page, viewport);
      await expectCoreMenu(page);
      await expectAccountSpace(page);
      for (const provider of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) {
        await expectReachable(page, provider, true);
      }
    }
  }
});

test('help and offline disclosures work by touch and keyboard and return to a reachable menu', async ({ page, hasTouch }) => {
  for (const selector of disclosures) {
    const details = page.locator(selector);
    const summary = details.locator(':scope > summary');
    await expect(details).toHaveJSProperty('tagName', 'DETAILS');
    await expect(details).toHaveJSProperty('open', false);
    await expect(summary).toHaveClass(/menu-disclosure/);
    await expect(summary.locator('.panel-chevron[aria-hidden="true"]')).toHaveCount(1);
    await activate(summary, hasTouch);
    await expect(details).toHaveJSProperty('open', true);
    const content = selector === '#startHelpDetails'
      ? page.locator('#controlsGuide') : details.locator(':scope > :last-child');
    await expect(content).toBeVisible();
    await content.scrollIntoViewIfNeeded();
    if (selector === '#startHelpDetails') {
      await page.locator('#hopControlRow').scrollIntoViewIfNeeded();
      await expectReachable(page, '#hopControlRow');
    }
    expect(await page.locator('.start-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Detailed instructions may need the card's vertical scroll area, but the
    // primary action must stay available and scrolling must not move the page.
    await page.locator('#startGameButton').scrollIntoViewIfNeeded();
    await expectReachable(page, '#startGameButton', true);
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(details).toHaveJSProperty('open', false);
    await expect(summary).toBeFocused();
    await expectCoreMenu(page);
    await page.keyboard.press('Space');
    await expect(details).toHaveJSProperty('open', true);
    await page.keyboard.press('Space');
    await expect(details).toHaveJSProperty('open', false);
    await expectCoreMenu(page);
    expect(await page.evaluate(() => (window as GameWindow).gameActive)).not.toBe(true);
  }
});

test('connectivity badge belongs to the menu card and offline instructions remain discoverable', async ({ page, context, hasTouch }) => {
  await expect(page.locator('.start-dialog #offlineBadge')).toHaveCount(1);
  await expect(page.locator('#offlineBadge')).toBeHidden();
  await context.setOffline(true);
  await expect(page.locator('#offlineBadge')).toBeVisible();
  await expect(page.locator('#offlineBadge')).toContainText('local bests');
  await expectCoreMenu(page);
  await activate(page.locator('#offlinePlayDetails > summary'), hasTouch);
  await expect(page.locator('#offlinePlayDetails')).toContainText(/install/i);
  await expect(page.locator('#offlinePlayDetails')).toContainText(/offline/i);
  await page.locator('#startGameButton').scrollIntoViewIfNeeded();
  await expectReachable(page, '#startGameButton', true);
  await context.setOffline(false);
  await expect(page.locator('#offlineBadge')).toBeHidden();
});

test('About opens at its heading, Close stays reachable, and the menu state returns intact', async ({ page, hasTouch }) => {
  const about = page.locator('#aboutGameButton');
  await activate(about, hasTouch);
  await expect(page.locator('#aboutGamePanel')).toBeFocused();
  await expectReachable(page, '#aboutGameTitle');
  await expect(page.locator('.start-extras')).toBeHidden();
  await page.locator('#closeAboutButton').scrollIntoViewIfNeeded();
  await expectReachable(page, '#closeAboutButton', true);
  await activate(page.locator('#closeAboutButton'), hasTouch);
  await expect(about).toBeFocused();
  await expectCoreMenu(page);
  expect(await page.evaluate(() => (window as GameWindow).gameActive)).not.toBe(true);

  // Opening About from a scrolled help menu must preserve that native disclosure
  // state and return focus to the triggering button when Escape closes the panel.
  await activate(page.locator('#startHelpDetails > summary'), hasTouch);
  await about.scrollIntoViewIfNeeded();
  await activate(about, hasTouch);
  await expectReachable(page, '#aboutGameTitle');
  await page.keyboard.press('Escape');
  await expect(about).toBeFocused();
  await expect(page.locator('#startHelpDetails')).toHaveJSProperty('open', true);
  await expectReachable(page, '#aboutGameButton', true);
  expect(await page.evaluate(() => (window as GameWindow).gameActive)).not.toBe(true);
});

test('guest account controls remain reachable above the menu in both disclosure states', async ({ page }) => {
  // Use the production guest markup without signing into an external provider.
  // Provider behavior is covered separately; this pins the actual wrapped chip,
  // Logout, and optional upgrade buttons that consume the reserved account space.
  // Game readiness no longer waits for auth. Buttons enable when handlers attach,
  // before the initial auth callback finishes; wait for that callback's profile
  // label too, or its signed-out update can overwrite this guest fixture.
  await expect(page.locator('#loginBtn')).toBeEnabled();
  await expect(page.locator('#profileChip')).toHaveAttribute('aria-label', 'Signed-in account');
  await page.evaluate(() => {
    document.querySelector('#authContainer .local-mode-notice')?.remove();
    const profile = document.getElementById('profileUI')!;
    profile.style.display = 'flex';
    profile.classList.add('guest');
    document.getElementById('profileName')!.textContent = 'Guest';
    document.getElementById('profileChip')!.removeAttribute('disabled');
  });
  for (const expanded of [false, true]) {
    await page.evaluate((expanded) => {
      document.getElementById('authUI')!.style.display = expanded ? 'flex' : 'none';
      document.getElementById('profileUI')!.classList.toggle('expanded', expanded);
      document.getElementById('profileChip')!.setAttribute('aria-expanded', String(expanded));
    }, expanded);
    await expectCoreMenu(page);
    await expectAccountSpace(page);
    for (const selector of ['#profileChip', '#logoutBtn']) await expectReachable(page, selector, true);
    if (expanded) {
      for (const selector of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) {
        await expectReachable(page, selector, true);
      }
    }
  }
});
