// @ts-check
// Shared boards, finished-run ownership, stale reads, and always-visible live stats.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const { mountLeaderboardPanel } = await import('../src/ui/leaderboard-panel.ts');
  const { createResultSaveControls } = await import('../src/ui/result-save.ts');
  const { updateTimerDisplay, formatStatTime } = await import('../src/ui/hud.ts');
  const { CourseModule } = await import('../src/course.ts');
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  /** @type {any} */ let user = null;
  let opens = 0;
  window.AuthModule = { getCurrentUser: () => user, openSignIn: () => { opens++; } };
  const host = document.createElement('div');
  document.body.append(host);
  let reads = 0;
  window.ScoresModule = { getLeaderboardResult: async () => { reads++; return { status: 'ready', scores: [] }; } };
  const board = mountLeaderboardPanel(host, 'blue');
  await flush();
  assert.equal(reads, 0, 'signed-out views never make denied reads');
  assert.equal(host.querySelectorAll('[data-leaderboard-tier]').length, 4);
  assert.match(host.textContent, /Sign in/);
  host.querySelector('button.leaderboard-action').dispatchEvent(new window.Event('click'));
  assert.equal(opens, 1);
  env.setOnline(false);
  board.refresh();
  assert.match(host.textContent, /offline/);
  assert.equal(reads, 0);
  env.setOnline(true);
  user = { uid: 'a', isAnonymous: false };
  board.refresh();
  await flush();
  assert.match(host.textContent, /No .*Blue times yet/);

  // A delayed Blue request must not overwrite a newer Expert board.
  /** @type {(v: any) => void} */ let resolveBlue;
  const blue = new Promise(resolve => { resolveBlue = resolve; });
  window.ScoresModule.getLeaderboardResult = async tier => tier === 'blue' ? blue : {
    status: 'ready', scores: [/** @type {any} */ ({ userId: 'rival', time: 12.5, displayName: '<img src=x onerror=alert(1)>' })],
  };
  board.setTier('blue');
  await flush();
  host.querySelector('[data-leaderboard-tier="expert"]').dispatchEvent(new window.Event('click'));
  await flush();
  resolveBlue({ status: 'ready', scores: [{ userId: 'old', time: 25, displayName: 'stale blue' }] });
  await flush();
  assert.match(host.textContent, /12\.50s/);
  assert.doesNotMatch(host.textContent, /stale blue/);
  assert.equal(host.querySelector('img'), null, 'untrusted player names render only as text');
  assert.equal(host.querySelector('[aria-pressed="true"]').getAttribute('data-leaderboard-tier'), 'expert');
  assert.equal(env.localStorage.getItem('snowgliderDifficulty'), null, 'browsing a board never changes the next run');
  window.ScoresModule.getLeaderboardResult = async () => ({ status: 'unavailable', scores: [] });
  board.refresh();
  await flush();
  assert.match(host.textContent, /Couldn’t load/);
  assert.doesNotMatch(host.textContent, /No .*times yet/);
  board.dispose();
  host.remove();

  // An unsigned finish is claimed only by clicking the explicit save action.
  user = null;
  let saves = 0;
  let refreshes = 0;
  window.ScoresModule = { saveScore: async (time, tier) => {
    assert.equal(time, 25);
    assert.equal(tier, 'black');
    saves++;
    return { status: 'saved', localSaved: true, userId: user.uid };
  } };
  let controls = createResultSaveControls({ time: 25, tier: 'black', initialSave: undefined, onSaved: () => { refreshes++; } });
  document.body.append(controls.element);
  user = { uid: 'a', isAnonymous: false };
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await flush();
  assert.equal(saves, 0, 'plain auth restore does not claim a guest finish');
  user = null;
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  controls.element.querySelector('button').click();
  user = { uid: 'a', isAnonymous: false };
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await flush();
  assert.equal(saves, 1, 'sign in and save retains the exact finished time and level');
  assert.equal(refreshes, 1);
  assert.match(controls.element.textContent, /Saved to leaderboard/);
  user = { uid: 'b', isAnonymous: false };
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  assert.equal(controls.element.querySelector('button').disabled, true);
  assert.match(controls.element.textContent, /original account/);
  assert.equal(saves, 1, 'the same run cannot be transferred to a second account');
  controls.dispose();
  controls.element.remove();

  // A slower, older sync cannot mark a newer finish saved; teardown rejects late writes.
  user = { uid: 'a', isAnonymous: false };
  controls = createResultSaveControls({ time: 25, tier: 'black', initialSave: Promise.resolve({ status: 'queued', localSaved: true, userId: 'a' }) });
  document.body.append(controls.element);
  await flush();
  window.dispatchEvent(new window.CustomEvent('snowglider:score-synced', { detail: { userId: 'a', tier: 'black', time: 30 } }));
  assert.match(controls.element.textContent, /Queued/);
  window.dispatchEvent(new window.CustomEvent('snowglider:score-synced', { detail: { userId: 'a', tier: 'black', time: 25 } }));
  assert.match(controls.element.textContent, /Saved to leaderboard/);
  controls.dispose();
  controls.element.remove();
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  assert.equal(saves, 1, 'teardown removes auth/save listeners');

  // Exercise the shipped markup: the timer and score are outside collapsed details.
  document.body.innerHTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const details = document.getElementById('gameStatsContent');
  assert.equal(details.contains(document.getElementById('currentTime')), false);
  assert.equal(details.contains(document.getElementById('airScoreValue')), false);
  document.getElementById('gameStatsContainer').classList.add('collapsed');
  updateTimerDisplay(true, 12.34, 150);
  assert.equal(document.getElementById('currentTime').textContent, '12.3s');
  assert.equal(document.getElementById('airScoreValue').textContent, '150');
  updateTimerDisplay(false, 99, 999);
  assert.equal(document.getElementById('currentTime').textContent, '12.3s', 'completed timer freezes');
  updateTimerDisplay(true, 0, 0);
  assert.equal(document.getElementById('airScoreValue').textContent, '0', 'replay clears banked points');
  assert.equal(formatStatTime(NaN), '--');
  CourseModule.addAirScore(10);
  CourseModule.addAirScore(Infinity);
  assert.equal(CourseModule.getAirScore(), 10, 'non-finite score inputs cannot poison live or final points');
  CourseModule.reset();
  assert.equal(CourseModule.getAirScore(), 0);
  env.teardown();
  console.log('PASS: shared boards, save ownership, stale completion and live HUD regressions');
})().catch(error => { console.error(error); process.exitCode = 1; });
