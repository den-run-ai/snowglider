// @ts-check
// Result-screen level choices must select the actual next run, while saving
// retains the completed run's tier. Exercise the real board and picker together.
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/' });
  const { createShowGameOver, readStoredBestTime } = await import('../src/ui/result-overlay.ts');
  const { closeOverlayFocus } = await import('../src/ui/accessibility.ts');
  const { CourseModule } = await import('../src/course.ts');
  const { localBestTimeKey, storeDifficulty, runTierNeedsRebuild } = await import('../src/difficulty.ts');
  const { runLaunchUrl } = await import('../src/game/run-transition.ts');
  const tiers = /** @type {const} */ (['bunny', 'blue', 'black', 'expert']);
  /** @type {import('../src/difficulty.ts').Difficulty} */
  let nextTier = 'expert';
  let selections = 0;
  /** @type {Array<{ time: number, tier: import('../src/difficulty.ts').Difficulty }>} */
  const saves = [];
  window.AuthModule = { getCurrentUser: () => /** @type {any} */ ({ uid: 'skier', isAnonymous: false }) };
  window.ScoresModule = {
    getLeaderboard: async () => [],
    saveScore: async (time, tier) => {
      saves.push({ time, tier });
      return { status: 'saved', localSaved: true, userId: 'skier' };
    },
  };
  CourseModule.onFinish = () => null;
  document.body.innerHTML = `
    <div id="leaderboard"></div>
    <div id="gameOverOverlay">
      <h1 id="gameOverMessage"></h1><p id="gameOverDetail"></p>
      <p id="bestTimeDisplay"></p>
      <div id="finishDifficultyPicker" role="radiogroup"></div>
      <button id="restartButton">Restart</button>
    </div>`;
  const state = { gameActive: true, bestTime: Infinity, startTime: 0, simElapsed: 40 };
  const overlay = document.getElementById('gameOverOverlay');
  const picker = document.getElementById('finishDifficultyPicker');
  const board = document.getElementById('leaderboard');
  const show = createShowGameOver({
    state,
    gameOverOverlay: overlay,
    gameOverDetail: document.getElementById('gameOverDetail'),
    restartButton: document.getElementById('restartButton'),
    bestTimeDisplay: document.getElementById('bestTimeDisplay'),
    finishDifficultyPicker: picker,
    getDifficulty: () => nextTier,
    onReplayDifficultyChange: tier => {
      selections++;
      nextTier = tier;
      storeDifficulty(tier);
      state.bestTime = readStoredBestTime(tier);
    },
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const selectedPicker = () => picker.querySelector('[aria-checked="true"]')?.getAttribute('data-difficulty');
  const selectedBoard = () => board.querySelector('[aria-pressed="true"]')?.getAttribute('data-leaderboard-tier');

  show('You reached the end of the slope!');
  for (const [index, tier] of tiers.entries()) {
    env.localStorage.setItem(localBestTimeKey(tier), String(50 + index));
    const previousSelections = selections;
    board.querySelector(`[data-leaderboard-tier="${tier}"]`).dispatchEvent(new window.Event('click'));
    assert.equal(nextTier, tier, `result leaderboard ${tier} must select the next run`);
    assert.equal(selectedPicker(), tier, 'the replay picker reflects the board selection');
    assert.equal(selectedBoard(), tier, 'the leaderboard reflects the same level');
    assert.equal(env.localStorage.getItem('snowgliderDifficulty'), tier);
    assert.equal(state.bestTime, 50 + index, 'the next run compares against its own best');
    assert.equal(selections, previousSelections + 1, 'one selection applies intent once');
    assert.equal(runTierNeedsRebuild(nextTier, 'expert', false), tier !== 'expert');
    assert.equal(new URL(runLaunchUrl(window.location.href, nextTier)).searchParams.get('play'), tier);
  }
  // Change the next level before saving. The completed Expert run stays Expert.
  board.querySelector('[data-leaderboard-tier="bunny"]').dispatchEvent(new window.Event('click'));
  document.getElementById('saveScoreButton').click();
  await flush();
  assert.deepEqual(saves, [{ time: 40, tier: 'expert' }]);
  assert.match(document.getElementById('saveScoreStatus').textContent, /Expert/);

  for (const tier of [...tiers].reverse()) {
    const previousSelections = selections;
    picker.querySelector(`[data-difficulty="${tier}"]`).dispatchEvent(new window.Event('click'));
    assert.equal(nextTier, tier, `lower replay picker ${tier} must select the next run`);
    assert.equal(selectedPicker(), tier);
    assert.equal(selectedBoard(), tier, 'the board follows the lower replay picker');
    assert.equal(selections, previousSelections + 1);
  }
  picker.querySelector('[aria-checked="true"]').dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'ArrowRight', bubbles: true,
  }));
  assert.equal(nextTier, 'blue', 'keyboard level choices share the replay path');
  assert.equal(selectedBoard(), 'blue');

  // Showing later results rebinds the board without accumulating callbacks or
  // letting an old picker selection override the tier just played.
  for (const playedTier of tiers) {
    const staleButton = board.querySelector('[data-leaderboard-tier="black"]');
    closeOverlayFocus(overlay, false);
    nextTier = playedTier;
    state.gameActive = true;
    const previousSelections = selections;
    show('You hit a rock!');
    assert.equal(selectedPicker(), playedTier);
    assert.equal(selectedBoard(), playedTier);
    assert.equal(selections, previousSelections, 'showing a result is not a user selection');
    staleButton.dispatchEvent(new window.Event('click'));
    assert.equal(nextTier, playedTier, 'disposed result buttons cannot change the next run');
    assert.equal(selections, previousSelections);
    const targetTier = playedTier === 'expert' ? 'bunny' : 'expert';
    board.querySelector(`[data-leaderboard-tier="${targetTier}"]`).dispatchEvent(new window.Event('click'));
    assert.equal(nextTier, targetTier);
    assert.equal(selectedPicker(), targetTier);
    assert.equal(selections, previousSelections + 1, 'reopened results have one live selection callback');
  }

  // A storage failure must not cancel the live selection or URL-carried rebuild.
  env.localStorage.setItem = () => { throw new Error('storage blocked'); };
  board.querySelector('[data-leaderboard-tier="black"]').dispatchEvent(new window.Event('click'));
  assert.equal(nextTier, 'black');
  assert.equal(selectedPicker(), 'black');
  assert.equal(new URL(runLaunchUrl(window.location.href, nextTier)).searchParams.get('play'), 'black');
  closeOverlayFocus(overlay, false);
  env.teardown();
  console.log('PASS: result selectors share all four replay levels and preserve completed saves');
})().catch(error => { console.error(error); process.exitCode = 1; });
