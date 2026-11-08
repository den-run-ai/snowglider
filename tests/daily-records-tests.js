// @ts-check
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/' });
  const daily = await import('../src/daily-challenge.ts');
  const records = await import('../src/daily-records.ts');
  const session = await import('../src/daily-session.ts');
  const rc = await import('../src/run-context.ts');
  const { localBestTimeKey } = await import('../src/difficulty.ts');
  const { buildResultShareData } = await import('../src/share.ts');
  const { runLaunchUrl } = await import('../src/game/run-transition.ts');
  const { renderDailyMountainMenu, buildDailyResultSummary, regularMountainUrl } = await import('../src/ui/daily-mountain.ts');
  const challenge = daily.createDailyChallenge('2026-11-08', 'blue');
  const otherDay = daily.createDailyChallenge('2026-11-07', 'blue');
  const otherTier = daily.createDailyChallenge('2026-11-08', 'black');
  const url = daily.buildDailyChallengeUrl(challenge, 'https://snowglider.ai/', 26000);
  const now = new Date('2026-11-08T12:00:00Z');
  session.configureDailySession('', now);
  assert.deepEqual(rc.getRunStamp(), { seed: rc.CANONICAL_WORLD_SEED, practice: false, nonce: 0, physicsVersion: rc.PHYSICS_VERSION });
  session.configureDailySession('?seed=123', now);
  assert.deepEqual(rc.getRunStamp(), { seed: 123, practice: true, nonce: 0, physicsVersion: rc.PHYSICS_VERSION });
  session.configureDailySession('?daily=broken', now);
  assert.equal(rc.getRunStamp().practice, true, 'an invalid invitation cannot fall back into ranked play');
  session.configureDailySession(new URL(url).search.replace('pv=4', 'pv=999'), now);
  assert.equal(rc.getRunStamp().practice, true, 'unsupported rules cannot fall back into ranked play');
  session.configureDailySession(new URL(url).search, now);
  assert.equal(rc.getRunStamp().seed, challenge.seed);
  assert.equal(rc.getRunStamp().practice, true);
  rc.rewindRunStreams(0);
  const stamp = rc.getRunStamp();
  localStorage.setItem(localBestTimeKey('blue'), '21');
  assert.deepEqual(records.recordDailyBest(challenge, stamp, 'blue', 25), {
    status: 'saved', previousMs: null, bestMs: 25000,
  });
  assert.equal(records.readDailyBest(challenge), 25000);
  assert.equal(records.readDailyBest(otherDay), null);
  assert.equal(records.readDailyBest(otherTier), null);
  assert.equal(localStorage.getItem(localBestTimeKey('blue')), '21', 'daily results do not overwrite regular bests');
  assert.equal(records.recordDailyBest(challenge, stamp, 'blue', 27).status, 'unchanged');
  assert.equal(records.readDailyBest(challenge), 25000, 'slower runs preserve the faster result');
  assert.equal(records.recordDailyBest(challenge, stamp, 'blue', 24).previousMs, 25000);

  const invalidStamps = [
    { ...stamp, seed: rc.CANONICAL_WORLD_SEED }, { ...stamp, nonce: 1 },
    { ...stamp, practice: false }, { ...stamp, physicsVersion: stamp.physicsVersion - 1 },
  ];
  for (const invalid of invalidStamps) {
    assert.equal(records.recordDailyBest(challenge, invalid, 'blue', 23).status, 'ineligible');
  }
  assert.equal(records.recordDailyBest(challenge, stamp, 'black', 23).status, 'ineligible');
  assert.equal(records.recordDailyBest(challenge, stamp, 'blue', 23, true).status, 'ineligible');
  for (const time of [NaN, Infinity, 0, -1, 14.99, 601]) {
    assert.equal(records.recordDailyBest(challenge, stamp, 'blue', time).status, 'ineligible');
  }
  assert.equal(records.readDailyBest(challenge), 24000);
  localStorage.setItem(records.dailyBestKey(challenge), JSON.stringify({ challengeId: otherDay.id, seed: challenge.seed, physicsVersion: 4, timeMs: 20000 }));
  assert.equal(records.readDailyBest(challenge), null, 'stored identity must match its namespace');
  localStorage.setItem(records.dailyBestKey(challenge), '{broken');
  assert.equal(records.readDailyBest(challenge), null);
  records.recordDailyBest(challenge, stamp, 'blue', 24);

  // The gameplay streams rewind exactly, while ordinary world's nonce policy
  // is unchanged. No renderer/frame-rate/cosmetic draws enter this identity.
  const draw = () => [rc.gameplayRandom('physics'), rc.gameplayRandom('avalanche'), rc.gameplayRandom('hazards')];
  rc.rewindRunStreams(0);
  const first = draw();
  for (let i = 0; i < 100; i++) rc.cosmeticRandom('snowParticles');
  rc.rewindRunStreams(0);
  assert.deepEqual(draw(), first);

  const shared = buildResultShareData(24, true, 'http://localhost:8080/?debug&seed=7', {
    difficulty: 'blue', dailyChallenge: challenge, dailyEligible: true,
  });
  const invitation = daily.parseDailyChallenge(new URL(shared.url).search, now);
  assert.equal(new URL(shared.url).origin, 'https://snowglider.ai');
  assert.equal(invitation.kind, 'daily');
  if (invitation.kind === 'daily') {
    assert.equal(invitation.challenge.id, challenge.id);
    assert.equal(invitation.targetMs, 24000);
  }
  assert.match(shared.text, /Can you beat my run/);
  const unrankedShare = buildResultShareData(24, false, null, { dailyChallenge: challenge, dailyEligible: false });
  assert.equal(new URL(unrankedShare.url).searchParams.has('beat'), false, 'compromised finish cannot advertise a target');
  assert.equal(new URL(buildResultShareData(NaN, false, null, { dailyChallenge: challenge, dailyEligible: true }).url).searchParams.has('beat'), false);
  assert.equal(new URL(runLaunchUrl(url, 'black')).searchParams.get('beat'), null, 'level changes clear the incomparable friend target');
  assert.equal(new URL(runLaunchUrl(url, 'blue')).searchParams.get('beat'), '26000');

  env.window.history.replaceState({}, '', '/?seed=123');
  assert.equal(session.getDailyChallenge()?.id, challenge.id, 'an active scene keeps the identity captured before world construction');
  const summary = buildDailyResultSummary(24, { status: 'saved', previousMs: 25000, bestMs: 24000 }, true);
  assert.match(summary?.textContent ?? '', /2.00s faster than your friend/);
  const noCompare = buildDailyResultSummary(24, { status: 'ineligible', previousMs: null, bestMs: null }, true);
  assert.doesNotMatch(noCompare?.textContent ?? '', /faster/);

  document.body.innerHTML = '<section id="dailyMountain"></section>';
  env.window.history.replaceState({}, '', url);
  renderDailyMountainMenu('blue');
  assert.match(document.getElementById('dailyMountain')?.textContent ?? '', /Friend’s shared target: 26.00s/);
  assert.match(document.getElementById('dailyMountain')?.textContent ?? '', /Daily bests stay on this device/);
  env.window.history.replaceState({}, '', '/?daily=2026-11-08&level=blue&cv=1&pv=1');
  renderDailyMountainMenu('blue');
  assert.match(document.getElementById('dailyMountain')?.textContent ?? '', /unavailable/);

  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  assert.equal(records.readDailyBest(challenge), null);
  assert.equal(records.recordDailyBest(challenge, stamp, 'blue', 23).status, 'unavailable');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  session.clearDailySession();
  assert.equal(session.getDailyChallenge(), null);
  rc.setRunSeed(null);
  env.teardown();

  // Full-page daily invitations capture their scope before auth is ready. A
  // returning account must not mount/fetch an ordinary board or relabel a device
  // best as this daily's record. A regular exit gets a fresh menu, as navigation
  // does; arbitrary practice links keep their existing ordinary-menu behavior.
  const dailyHref = daily.buildDailyChallengeUrl(daily.createDailyChallenge('2020-01-01', 'blue'));
  const scenarios = [
    { name: 'daily', href: dailyHref, hideOrdinary: true },
    { name: 'invalid', href: 'https://snowglider.ai/?daily=broken', hideOrdinary: true },
    { name: 'unsupported', href: dailyHref.replace('pv=4', 'pv=999'), hideOrdinary: true },
    { name: 'regular-exit', href: regularMountainUrl(dailyHref, 'blue'), hideOrdinary: false },
    { name: 'practice', href: 'https://snowglider.ai/?seed=123', hideOrdinary: false },
  ];
  for (const scenario of scenarios) {
    const menuEnv = setupDom({ url: scenario.href, html: `<!doctype html><body>
      <p id="startSignInHint" style="display:block">Save your times to your account.</p>
      <details id="leaderboardsDetails" open>
        <summary>Leaderboards</summary><div id="startLeaderboard">Stale ordinary results</div>
      </details>
    </body>` });
    // Let jsdom's DOMContentLoaded finish before importing the side-effect menu.
    // These scenarios exercise its real account refresh without game startup.
    await new Promise(resolve => setTimeout(resolve, 0));
    menuEnv.localStorage.setItem(localBestTimeKey('blue'), '19');
    let signedIn = false;
    let boardReads = 0;
    let accountBestReads = 0;
    const returningUser = /** @type {import('firebase/auth').User} */ ({ uid: 'returning-skier', isAnonymous: false });
    menuEnv.window.AuthModule = {
      isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: false }),
      getCurrentUser: () => signedIn ? returningUser : null,
    };
    menuEnv.window.ScoresModule = {
      getLocalBestForUser: () => { accountBestReads++; return 19; },
      getLeaderboard: async () => { boardReads++; return []; },
    };
    await import(`../src/ui/start-menu.ts?daily-account-scope=${scenario.name}`);
    const menu = menuEnv.window.SnowGliderStartMenu;
    const details = menuEnv.document.getElementById('leaderboardsDetails');
    const hint = menuEnv.document.getElementById('startSignInHint');
    const board = menuEnv.document.getElementById('startLeaderboard');
    menu.refreshStartAccountUI();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (scenario.hideOrdinary) {
      assert.equal(details.style.display, 'none', `${scenario.name}: ordinary disclosure stays hidden`);
      assert.equal(hint.style.display, 'none', `${scenario.name}: no canonical save invitation`);
      assert.equal(board.style.display, 'none');
      assert.equal(board.childElementCount, 0, 'the ordinary panel was not mounted');
      assert.equal(board.textContent, '', 'stale ordinary results are cleared');
    } else {
      assert.notEqual(details.style.display, 'none', `${scenario.name}: ordinary disclosure remains available`);
      assert.equal(hint.style.display, 'block', `${scenario.name}: account saving is still discoverable`);
      assert.equal(board.querySelectorAll('[data-leaderboard-tier]').length, 4);
      assert.match(board.textContent, /Device best: 19.00s/);
    }
    signedIn = true;
    menuEnv.window.dispatchEvent(new menuEnv.window.Event('snowglider:auth-changed'));
    menuEnv.window.dispatchEvent(new menuEnv.window.Event('snowglider:account-bests-changed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    if (scenario.hideOrdinary) {
      assert.equal(boardReads, 0, `${scenario.name}: restored auth never reads canonical boards`);
      assert.equal(accountBestReads, 0, `${scenario.name}: canonical account bests stay out of the daily view`);
      assert.equal(board.childElementCount, 0);
      assert.equal(details.style.display, 'none');
      assert.equal(hint.style.display, 'none');
      // A URL edit is not a scene change; the captured invitation remains daily
      // until the Regular mountain link loads a fresh document.
      menuEnv.window.history.replaceState({}, '', '/');
      menu.refreshStartAccountUI();
      assert.equal(details.style.display, 'none');
      assert.equal(boardReads, 0);
    } else {
      assert.ok(boardReads > 0, `${scenario.name}: ordinary boards still load for signed-in players`);
      assert.ok(accountBestReads > 0);
      assert.match(board.textContent, /Account best: 19.00s/);
    }
    menuEnv.teardown();
  }
  console.log('Daily records: isolated identity, eligibility, slower races, denied storage, repeatable streams, sharing, target comparison, transitions and teardown passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
