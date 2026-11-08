import type { Page } from '@playwright/test';
import type { Firestore } from 'firebase/firestore';
import type { Analytics } from 'firebase/analytics';
import { test, expect } from './fixtures';
import { gotoGame, mockFirebase, startGame } from './helpers';

type FirebaseMock = {
  getFirestore(): Firestore;
  getAnalytics(): Analytics;
  logEvent(analytics: Analytics, name: string, params?: Record<string, unknown>): void;
  doc(db: Firestore, collection: string, id: string): unknown;
  getDoc(ref: unknown): Promise<{ data(): Record<string, unknown> | undefined }>;
  seed(collection: string, id: string, value: Record<string, unknown>): void;
  setAuthCurrentUser(user: unknown): void;
  emitAuthState(user: unknown): void;
  setNextPopupResult(result: unknown): void;
  calls: { signInWithPopup: number; logEvent: { name: string; params?: Record<string, unknown> }[] };
};
type LiveGame = Window & { gameActive?: boolean; simElapsed?: number };

// Keep the shipped auth/scoring/UI modules. Only the external Firebase SDK is
// mocked; localhost normally disables Firestore, so attach that mock explicitly.
async function connectMockScores(page: Page): Promise<void> {
  await page.waitForFunction(() => window.AuthModule?.isFirebaseAvailable?.().auth === true);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(path) as FirebaseMock;
    window.AuthModule.isFirebaseAvailable = () => ({ auth: true, firestore: true, analytics: true });
    window.ScoresModule.initializeScores!(fb.getFirestore(), fb.getAnalytics());
    // Production hosts publish this SDK seam from auth.ts; localhost correctly
    // skips Analytics initialization, so explicitly inject the same mock sink.
    window.firebaseModules = { logEvent: (name, params) => fb.logEvent(fb.getAnalytics(), name, params) };
  });
}

test('all four leaderboard tabs preserve the next run and survive account/connectivity refresh', async ({ page, context, baseURL }) => {
  await mockFirebase(page, baseURL);
  await gotoGame(page, '?intro=off');
  await connectMockScores(page);
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const difficultyPath = '/src/difficulty.ts';
    const fb = await import(path) as FirebaseMock;
    const d = await import(difficultyPath) as typeof import('../../src/difficulty.js');
    const user = { uid: 'board-reader', isAnonymous: false, displayName: 'Board Reader', email: null, photoURL: null };
    fb.setAuthCurrentUser(user);
    fb.emitAuthState(user);
    for (const [tier, time] of [['bunny', 31], ['blue', 24], ['black', 12], ['expert', 11]] as const) {
      fb.seed(d.leaderboardCollectionName(tier), 'other-player', {
        user: fb.doc(fb.getFirestore(), 'users', 'other-player'), time, displayName: `${tier} leader`,
      });
    }
    window.SnowGliderStartMenu!.refreshStartAccountUI!();
  });
  await page.locator('#leaderboardsDetails > summary').click();
  const panel = page.locator('#startLeaderboard');
  for (const [tier, time] of [['bunny', '31.00s'], ['blue', '24.00s'], ['black', '12.00s'], ['expert', '11.00s']] as const) {
    await panel.locator(`[data-leaderboard-tier="${tier}"]`).click();
    await expect(panel.locator('tbody')).toContainText(time);
    await expect(panel.locator('tbody')).toContainText(`${tier} leader`);
    await expect(page.locator('#difficultyPicker [data-difficulty="blue"]')).toHaveAttribute('aria-checked', 'true');
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('snowglider:account-bests-changed')));
  await expect(panel.locator('[data-leaderboard-tier="expert"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('tbody')).toContainText('11.00s');
  await context.setOffline(true);
  await expect(panel).toContainText('You’re offline');
  await context.setOffline(false);
  await expect(panel.locator('tbody')).toContainText('11.00s');
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(path) as FirebaseMock;
    fb.setAuthCurrentUser(null);
    fb.emitAuthState(null);
  });
  await expect(panel).toContainText('Sign in');
  await expect(panel.locator('tbody')).toHaveCount(0);
});

test('a guest can save the completed Expert run after sign-in and replay with visible live stats', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Install before navigation so the real loop and every startup timer share
  // one clock. Let startup run normally until the HUD fixture is inactive.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.addInitScript(() => localStorage.setItem('snowgliderDifficulty', 'expert'));
  await mockFirebase(page, baseURL);
  await gotoGame(page, '?intro=off');
  await connectMockScores(page);
  await startGame(page);
  await page.evaluate(async () => {
    const hudPath = '/src/ui/hud.ts';
    const coursePath = '/src/course.ts';
    const hud = await import(hudPath) as typeof import('../../src/ui/hud.js');
    const { CourseModule } = await import(coursePath) as typeof import('../../src/course.js');
    CourseModule.addAirScore(150);
    hud.updateTimerDisplay(true, 12.34, CourseModule.getAirScore());
    document.getElementById('gameStatsContainer')!.classList.add('collapsed');
    (window as LiveGame).gameActive = false;
  });
  await expect(page.locator('#currentTime')).toBeVisible();
  await expect(page.locator('#currentTime')).toHaveText('12.3s');
  await expect(page.locator('#airScoreValue')).toBeVisible();
  await expect(page.locator('#airScoreValue')).toHaveText('150');
  await expect(page.locator('#gameStatsContent')).toBeHidden();
  // This is an eligible-save/provider-flow check, not a renderer speed test.
  // CI's software-GPU work and remote browser roundtrips can take seconds and
  // correctly invalidate a ranked run. Advance actual RAF/physics callbacks on
  // a controlled clock instead; never clear or bypass the slowdown guard.
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.evaluate(() => window.restartGame!());
  await page.clock.runFor(50);
  expect(await page.evaluate(() => (window as LiveGame).gameActive)).toBe(true);
  expect(await page.evaluate(() => (window as LiveGame).simElapsed),
    'the eligible attempt must have real playable frames before its scripted finish').toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as LiveGame).simElapsed = 25;
    window.showGameOver!('You reached the end of the slope!');
  });
  // The run has ended; real user gestures and provider callbacks use normal time.
  await page.clock.resume();
  const completed = await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    return (await import(path) as FirebaseMock).calls.logEvent.filter(event => event.name === 'complete_run');
  });
  expect(completed).toHaveLength(1);
  expect(completed[0]?.params).toMatchObject({
    difficulty: 'expert', time: 25, timing_compromised: 'false', score_eligible: 'true',
  });
  const save = page.locator('#saveScoreButton');
  await expect(save).toHaveText('Sign in & save this run');
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.locator('#gameOverOverlay #authUI')).toBeVisible();
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(path) as FirebaseMock;
    fb.setNextPopupResult({ resolve: { user: {
      uid: 'finish-owner', isAnonymous: false, displayName: 'Finish Owner', email: null, photoURL: null,
    } } });
  });
  await page.locator('#gameOverOverlay #loginBtn').click();
  await expect.poll(() => page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    return (await import(path) as FirebaseMock).calls.signInWithPopup;
  })).toBe(1);
  // The mock exposes popup resolution and the SDK auth observer separately.
  await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const fb = await import(path) as FirebaseMock;
    const user = { uid: 'finish-owner', isAnonymous: false, displayName: 'Finish Owner', email: null, photoURL: null };
    fb.setAuthCurrentUser(user);
    fb.emitAuthState(user);
  });
  await expect(save).toHaveText('Saved to leaderboard ✓');
  await expect(page.locator('#saveScoreStatus')).toContainText('Expert');
  const saved = await page.evaluate(async () => {
    const path = '/tests/mocks/firebase.mjs';
    const difficultyPath = '/src/difficulty.ts';
    const fb = await import(path) as FirebaseMock;
    const d = await import(difficultyPath) as typeof import('../../src/difficulty.js');
    const profile = await fb.getDoc(fb.doc(fb.getFirestore(), 'users', 'finish-owner'));
    const board = await fb.getDoc(fb.doc(fb.getFirestore(), d.leaderboardCollectionName('expert'), 'finish-owner'));
    return { profile: profile.data()?.[d.userBestTimeField('expert')], board: board.data()?.time,
      completions: fb.calls.logEvent.filter(event => event.name === 'complete_run').length };
  });
  expect(saved).toEqual({ profile: 25, board: 25, completions: 1 });
  const replay = page.locator('#restartButton');
  await expect(replay).toBeInViewport();
  await replay.click();
  await expect(page.locator('#gameOverOverlay')).toBeHidden();
  await expect(page.locator('#currentTime')).toBeVisible();
  await expect(page.locator('#airScoreValue')).toHaveText('0');
  expect(errors).toEqual([]);
});
