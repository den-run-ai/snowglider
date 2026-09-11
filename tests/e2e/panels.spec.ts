import { type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { gotoGame, startGame } from './helpers';

const panels = [
  { container: '#controlsInfo', header: '#controlsHeader', toggle: '#toggleControls', content: 'controlsContent' },
  { container: '#gameStatsContainer', header: '#gameStatsHeader', toggle: '#toggleStats', content: 'gameStatsContent' },
  { container: '#cameraControls', header: '#cameraControlsHeader', toggle: '#toggleCamera', content: 'cameraControlsContent' },
] as const;

async function openPausedGame(page: Page, playerScene = false): Promise<void> {
  if (playerScene) {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
  }
  await gotoGame(page, playerScene ? '?eztrees=1' : '');
  if (playerScene) {
    // The fixed right column establishes its own stacking context. A provider
    // can be painted yet sit underneath the start overlay and never receive a tap.
    for (const selector of ['#loginBtn', '#githubLoginBtn', '#guestLoginBtn']) {
      await expect(page.locator(selector)).toBeVisible();
      await expectHitTarget(page, selector);
    }
  }
  await startGame(page);
  // These are UI contracts, not timed skiing. Pause through the existing seam so
  // software rendering cannot finish/crash the run halfway through a touch test.
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.gameActive = false;
    requestAnimationFrame(() => resolve());
  }));
  if (playerScene) {
    await page.waitForFunction(() => {
      const terrain = (window as Window & {
        terrainMesh?: { parent?: { children: Array<{ userData: Record<string, unknown> }> } };
      }).terrainMesh;
      return terrain?.parent?.children.some((child) => child.userData.forestPart === 'ezBranches');
    });
  }
}

async function activate(button: Locator, touch: boolean): Promise<void> {
  if (touch) await button.tap();
  else await button.click();
}

async function setExpanded(page: Page, toggle: string, expanded: boolean, touch: boolean): Promise<void> {
  const button = page.locator(toggle);
  if (await button.getAttribute('aria-expanded') !== String(expanded)) await activate(button, touch);
  await expect(button).toHaveAttribute('aria-expanded', String(expanded));
}

async function resizeAndSettle(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  // The protocol viewport updates before Android's layout viewport necessarily
  // does. Compact-to-compact rotations keep aria-expanded unchanged, so checking
  // panel state alone cannot wait for the resize event or its layout update.
  await page.waitForFunction(({ width, height }) => (
    window.innerWidth === width && window.innerHeight === height
  ), viewport);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function expectInsideViewport(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, `${selector} has visible geometry`).not.toBeNull();
  expect(box!.x, `${selector} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${selector} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${selector} right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height, `${selector} bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectNoOverlap(page: Page, first: string, second: string): Promise<void> {
  const a = await page.locator(first).boundingBox();
  const b = await page.locator(second).boundingBox();
  expect(a, `${first} is present`).not.toBeNull();
  expect(b, `${second} is present`).not.toBeNull();
  const width = Math.min(a!.x + a!.width, b!.x + b!.width) - Math.max(a!.x, b!.x);
  const height = Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y);
  expect(width <= 1 || height <= 1, `${first} overlaps ${second}`).toBe(true);
}

async function expectHitTarget(page: Page, selector: string): Promise<void> {
  const target = await page.locator(selector).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      reachable: hit !== null && el.contains(hit),
      center,
      hit: hit?.outerHTML.slice(0, 500) ?? null,
    };
  });
  expect(target.reachable,
    `${selector} is reachable at ${JSON.stringify(target.center)}; actual hit: ${target.hit}`).toBe(true);
}

async function expectHudLayout(page: Page): Promise<void> {
  for (const selector of [
    '#courseHud', '#controlsInfo', '#authContainer', '#gameStatsContainer',
    '#cameraControls', '#resetBtn', '#cameraToggleBtn', '#audioControlBtn',
  ]) await expectInsideViewport(page, selector);
  await expectNoOverlap(page, '#courseHud', '#controlsInfo');
  await expectNoOverlap(page, '#authContainer', '#gameStatsContainer');
  await expectNoOverlap(page, '#controlsInfo', '#gameStatsContainer');
  await expectNoOverlap(page, '#cameraControls', '#controlsInfo');
  await expectNoOverlap(page, '#cameraControls', '#gameStatsContainer');
  for (const selector of ['#resetBtn', '#cameraToggleBtn', '#audioControlBtn']) {
    await expectNoOverlap(page, '#cameraControls', selector);
    expect(await page.locator(selector).evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe('none');
    await expectHitTarget(page, selector);
  }
  await expectNoOverlap(page, '#resetBtn', '#cameraToggleBtn');
  await expectNoOverlap(page, '#cameraToggleBtn', '#audioControlBtn');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('responsive panel layout has one consistent disclosure and no HUD collisions', async ({ page, hasTouch }, testInfo) => {
  test.setTimeout(120_000);
  await openPausedGame(page, true);
  const { width, height } = page.viewportSize()!;
  const compact = width <= 600 || height <= 500;
  // Desktop defaults expose all three bodies at once. Checking only individual
  // expansions would miss a camera/controls collision in this initial layout.
  await expectHudLayout(page);
  const headerStyles = [];
  const collapsedWidths = new Map<string, number>();
  for (const panel of panels) {
    const toggle = page.locator(panel.toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', String(!compact));
    await expect(toggle).toHaveClass(/panel-disclosure/);
    await expect(toggle.locator('.panel-chevron')).toHaveCount(1);
    const box = await toggle.boundingBox();
    expect(box!.width, `${panel.toggle} target width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${panel.toggle} target height`).toBeGreaterThanOrEqual(44);
    // The old mobile ::after swipe arrow sat inside an unrelated blue triangle
    // button. Check the rendered pseudo content, not merely a class name.
    for (const target of [toggle, page.locator(panel.header)]) {
      for (const pseudo of ['::before', '::after']) {
        expect(await target.evaluate((el, pseudo) => getComputedStyle(el, pseudo).content, pseudo))
          .toMatch(/^(none|normal|"")$/);
      }
    }
    expect(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const chevron = await toggle.locator('.panel-chevron').boundingBox();
    expect(Math.abs(chevron!.x + chevron!.width / 2 - box!.x - box!.width / 2)).toBeLessThan(3);
    expect(Math.abs(chevron!.y + chevron!.height / 2 - box!.y - box!.height / 2)).toBeLessThan(3);
    headerStyles.push(await page.locator(panel.header).evaluate((el) => {
      const style = getComputedStyle(el);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, minHeight: style.minHeight };
    }));
    await setExpanded(page, panel.toggle, false, hasTouch);
    await expect(page.locator(`#${panel.content}`)).toBeHidden();
    collapsedWidths.set(panel.container, (await page.locator(panel.container).boundingBox())!.width);
  }
  expect(headerStyles[1]).toEqual(headerStyles[0]);
  expect(headerStyles[2]).toEqual(headerStyles[0]);
  await expectHudLayout(page);
  await testInfo.attach('hud-collapsed', { body: await page.screenshot(), contentType: 'image/png' });

  // Exercise each expanded panel, including short landscape scroll containers.
  for (const panel of panels) {
    await setExpanded(page, panel.toggle, true, hasTouch);
    await expectHudLayout(page);
    expect((await page.locator(panel.container).boundingBox())!.width,
      `${panel.container} should shed its unused tray width when collapsed`)
      .toBeGreaterThan(collapsedWidths.get(panel.container)! + 8);
    const content = page.locator(`#${panel.content}`);
    await expect(content).toHaveJSProperty('inert', false);
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${panel.content} clips horizontally`).toBe(true);
    if (panel.container === '#cameraControls') {
      await testInfo.attach('hud-camera-expanded', { body: await page.screenshot(), contentType: 'image/png' });
    }
    // A short landscape viewport may scroll the body, but its final instruction,
    // statistic, or zoom row must remain reachable without moving the header.
    await content.locator(':scope > :last-child').scrollIntoViewIfNeeded();
    const scroll = await content.evaluate((el) => ({
      height: el.clientHeight, total: el.scrollHeight, top: el.scrollTop,
    }));
    if (scroll.total > scroll.height + 1) expect(scroll.top).toBeGreaterThan(0);
    await expectHudLayout(page);
    await setExpanded(page, panel.toggle, false, hasTouch);
    await expect(content).toBeHidden();
  }

  if (testInfo.project.name === 'chromium') {
    // Tablet width moves course progress into the left column while keeping the
    // desktop expanded defaults. Pin that intermediate breakpoint without
    // duplicating the complete interaction suite in another browser project.
    for (const viewport of [{ width: 768, height: 768 }, { width: 640, height: 540 }]) {
      await resizeAndSettle(page, viewport);
      for (const panel of panels) await setExpanded(page, panel.toggle, true, hasTouch);
      await expectHudLayout(page);
    }
    await testInfo.attach('hud-tablet-expanded', { body: await page.screenshot(), contentType: 'image/png' });

    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      await resizeAndSettle(page, viewport);
      for (const panel of panels) {
        await expect(page.locator(panel.toggle)).toHaveAttribute('aria-expanded', 'false');
      }
      await expectHudLayout(page);
      for (const panel of panels) {
        await setExpanded(page, panel.toggle, true, hasTouch);
        await expectHudLayout(page);
        const content = page.locator(`#${panel.content}`);
        expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          `${panel.content} clips at ${viewport.width}×${viewport.height}`).toBe(true);
        await content.locator(':scope > :last-child').scrollIntoViewIfNeeded();
        await expectHudLayout(page);
        await setExpanded(page, panel.toggle, false, hasTouch);
      }
    }
  }
});

test('all disclosures work by touch or keyboard and collapsed contents cannot receive focus', async ({ page, hasTouch }) => {
  await openPausedGame(page);
  for (const panel of panels) {
    const toggle = page.locator(panel.toggle);
    const content = page.locator(`#${panel.content}`);
    await expect(toggle).toHaveAttribute('aria-controls', panel.content);
    await setExpanded(page, panel.toggle, false, hasTouch);
    await expect(content).toHaveJSProperty('inert', true);
    await expect(content).toBeHidden();
    await activate(toggle, hasTouch);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(content).toHaveJSProperty('inert', false);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(content).toHaveJSProperty('inert', true);
    expect(await content.evaluate((el) => {
      const control = el.querySelector<HTMLElement>('button, a[href], input, [tabindex="0"]');
      control?.focus();
      return !el.contains(document.activeElement);
    })).toBe(true);
  }
  await setExpanded(page, '#toggleCamera', true, hasTouch);
  const modes = [
    ['auto', 'Auto'], ['follow', 'Follow'], ['orbit', 'Orbit 360°'],
    ['firstPerson', 'First Person'], ['cameraman', 'Cameraman'], ['drone', 'Drone'],
  ];
  await expect(page.locator('[data-cam-mode]')).toHaveCount(modes.length);
  for (const [mode, label] of modes) {
    const button = page.locator(`[data-cam-mode="${mode}"]`);
    await button.scrollIntoViewIfNeeded();
    await expectInsideViewport(page, `[data-cam-mode="${mode}"]`);
    await activate(button, hasTouch);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-cam-mode][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#cameraModeSummary')).toHaveText(label);
    await expect(page.locator('#cameraToggleBtn')).toHaveAccessibleName(`Next camera view (V). Current: ${label}`);
  }
  await setExpanded(page, '#toggleCamera', false, hasTouch);
  await activate(page.locator('#cameraToggleBtn'), hasTouch);
  await expect(page.locator('#cameraModeSummary')).toHaveText('Auto');
  await expect(page.locator('#toggleCamera')).toHaveAttribute('aria-expanded', 'false');
});

test('compact panels share space and preserve an open panel through resize and rotation', async ({ page, hasTouch }) => {
  await openPausedGame(page);
  const initial = page.viewportSize()!;
  if (initial.width > 600 && initial.height > 500) {
    await resizeAndSettle(page, { width: 390, height: 844 });
  }
  for (const panel of panels) {
    await expect(page.locator(panel.toggle)).toHaveAttribute('aria-expanded', 'false');
    await activate(page.locator(panel.toggle), hasTouch);
    await expect(page.locator(panel.toggle)).toHaveAttribute('aria-expanded', 'true');
    for (const other of panels.filter((other) => other !== panel)) {
      await expect(page.locator(other.toggle)).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(`#${other.content}`)).toHaveJSProperty('inert', true);
    }
  }
  const compact = page.viewportSize()!;
  await resizeAndSettle(page, { width: compact.width, height: compact.height - 40 });
  await expect(page.locator('#toggleCamera')).toHaveAttribute('aria-expanded', 'true');
  await expectHudLayout(page);
  await resizeAndSettle(page, { width: compact.height, height: compact.width });
  await expect(page.locator('#toggleCamera')).toHaveAttribute('aria-expanded', 'true');
  await expectHudLayout(page);
  await setExpanded(page, '#toggleCamera', false, hasTouch);
  await expectHudLayout(page);
});

test('expanded guest account leaves Stats scrollable above the camera on narrow phones', async ({ page, hasTouch }) => {
  await openPausedGame(page);
  await resizeAndSettle(page, { width: 320, height: 568 });
  await setExpanded(page, '#toggleCamera', true, hasTouch);
  await activate(page.locator('[data-cam-mode="cameraman"]'), hasTouch);
  await setExpanded(page, '#toggleCamera', false, hasTouch);

  // Exercise the production guest account geometry without authenticating to a
  // live provider. The guest chip and Logout wrap in this narrow right column.
  await page.evaluate(() => {
    document.querySelector('#authContainer .local-mode-notice')?.remove();
    const profile = document.getElementById('profileUI')!;
    profile.style.display = 'flex';
    profile.classList.add('guest');
    document.getElementById('profileName')!.textContent = 'Guest';
    document.getElementById('profileChip')!.removeAttribute('disabled');
  });

  await setExpanded(page, '#toggleStats', true, hasTouch);
  for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
    await resizeAndSettle(page, viewport);
    for (const expanded of [false, true]) {
      await page.evaluate((expanded) => {
        document.getElementById('authUI')!.style.display = expanded ? 'flex' : 'none';
        document.getElementById('profileUI')!.classList.toggle('expanded', expanded);
        document.getElementById('profileChip')!.setAttribute('aria-expanded', String(expanded));
      }, expanded);
      await expectHudLayout(page);
      await expectHitTarget(page, '#toggleCamera');
      await expectHitTarget(page, '#profileChip');
      await expectHitTarget(page, '#logoutBtn');
      const content = page.locator('#gameStatsContent');
      const lastStat = content.locator(':scope > :last-child');
      await lastStat.scrollIntoViewIfNeeded();
      const visibleBody = (await content.boundingBox())!;
      const finalRow = (await lastStat.boundingBox())!;
      expect(finalRow.y).toBeGreaterThanOrEqual(visibleBody.y - 1);
      expect(finalRow.y + finalRow.height).toBeLessThanOrEqual(visibleBody.y + visibleBody.height + 1);
      await expectHudLayout(page);
    }
  }
});
