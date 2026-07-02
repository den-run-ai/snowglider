import { expect, type Page } from '@playwright/test';

// Shared helpers for the Playwright E2E specs. These lean on the live game/test
// handles the orchestrator re-publishes on `window` (see src/snowglider.ts
// `publishGameGlobals` and docs/ARCHITECTURE.md §3) — the same seams the in-page
// browser suites drive — so the specs observe real game state rather than guessing
// from pixels.

/** The subset of orchestrator `window.*` handles the specs read. */
type GameWindow = Window & {
  initializeGameWithAudio?: () => void;
  gameActive?: boolean;
  pos?: { x: number; y: number; z: number };
  getControls?: () => Record<string, boolean>;
};

/** Load the game page and wait until the deferred orchestrator has wired up start.
 *  `query` lets a spec opt into URL-flagged variants (e.g. '?eztrees=1'). */
export async function gotoGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/index.html${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#startGameButton')).toBeVisible();
  // The orchestrator (snowglider.ts) is a deferred dynamic import; the Start button
  // only does something once it has published initializeGameWithAudio.
  await page.waitForFunction(
    () => typeof (window as GameWindow).initializeGameWithAudio === 'function',
  );
}

/** Click Start and wait for a live run (game loop active, menu dismissed). */
export async function startGame(page: Page): Promise<void> {
  await page.click('#startGameButton');
  await page.waitForFunction(() => (window as GameWindow).gameActive === true);
  await expect(page.locator('#startGameContainer')).toBeHidden();
}

/** Current snowman position, or null if the run hasn't published it yet. */
export function getPos(page: Page): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate(() => {
    const p = (window as GameWindow).pos;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  });
}

/** Live shared controls state (left/right/up/down/jump), or null if unavailable. */
export function getControls(page: Page): Promise<Record<string, boolean> | null> {
  return page.evaluate(() => {
    const fn = (window as GameWindow).getControls;
    return fn ? fn() : null;
  });
}

/** Block until the snowman has travelled at least `minDelta` units along z from `z0`. */
export function waitForDownhillTravel(page: Page, z0: number, minDelta: number): Promise<unknown> {
  return page.waitForFunction(
    ([startZ, delta]) => {
      const p = (window as GameWindow).pos;
      return !!p && Math.abs(p.z - startZ) > delta;
    },
    [z0, minDelta] as const,
  );
}
