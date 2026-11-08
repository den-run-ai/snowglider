// @ts-check
// result-overlay-tests.js
// Headless, c8-instrumented coverage for src/ui/result-overlay.ts — the game-over /
// finish overlay: score-time validation, the best-time readout, the leaderboard
// insertion, explicit account saving, analytics, and the course result panel.
//
// The browser suites show the overlay on the happy path but never exercise the
// invalid-finish-time branch, the analytics logEvent paths, the crash-effect hook, or
// the signed-in leaderboard insertion, so those sit uncovered on Codecov. We import the
// REAL module (its Audio/Course/Effects deps load headless) and drive showGameOver()
// across every branch under jsdom. Run via the register-ts-resolve loader so the
// module's `./*.js` sibling imports resolve to their `.ts` sources.

'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

// DOM + localStorage come from the shared mocks (tests/mocks/). setupDom must be
// async-imported, so it and the module under test are both loaded inside main();
// setupDom wires global.window/document/localStorage; `local` aliases localStorage
// for the readStoredBestTime scenarios. It is bound in main() before the first run.
let local;
/** @type {(root: HTMLElement, restore?: boolean) => void} */
let closeResultFocus = () => {};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const boardEntry = (userId, time, displayName = null) => ({
  userId, time, displayName, userRef: /** @type {any} */ ({}),
});

// Reset the overlay DOM for one showGameOver scenario; returns the injected deps.
function makeDeps(/** @type {{ bestTime?: number, startTime?: number, simElapsed?: number, onCrash?: (r: string) => void, getDifficulty?: () => import('../src/difficulty.ts').Difficulty }} */ { bestTime = Infinity, startTime, simElapsed, onCrash, getDifficulty } = {}) {
  const previousOverlay = document.getElementById('gameOverOverlay');
  if (previousOverlay) closeResultFocus(previousOverlay, false);
  document.body.innerHTML = `
    <div id="gameStatsContainer"><button id="toggleStats">▲</button></div>
    <div id="leaderboard" style="display:none"></div>
    <div id="gameOverOverlay" style="display:none">
      <h1 id="gameOverMessage">GAME OVER</h1>
      <p id="gameOverDetail"></p>
      <p id="bestTimeDisplay"></p>
      <button id="restartButton">Restart</button>
    </div>`;
  document.body.classList.add('game-active');
  return {
    state: { gameActive: true, bestTime, startTime: startTime ?? (performance.now() - 20000), simElapsed },
    gameOverOverlay: document.getElementById('gameOverOverlay'),
    gameOverDetail: document.getElementById('gameOverDetail'),
    restartButton: document.getElementById('restartButton'),
    bestTimeDisplay: document.getElementById('bestTimeDisplay'),
    onCrash,
    getDifficulty,
  };
}

const FINISH = 'You reached the end of the slope!';

async function main() {
  console.log('--- result-overlay.ts ---');
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  local = env.localStorage;
  env.window.HTMLCanvasElement.prototype.getContext = () => null;

  const mod = await import('../src/ui/result-overlay.ts');
  // Versioned competitive best-time keys (#403 review): assert against the
  // REAL key builders so the suite tracks the active ruleset namespace.
  const { localBestTimeKey: BTK, localBestMetaKey: BTMK, getDifficultyConfig } = await import('../src/difficulty.ts');
  const { closeOverlayFocus } = await import('../src/ui/accessibility.ts');
  const { getRunStamp } = await import('../src/run-context.ts');
  closeResultFocus = closeOverlayFocus;
  const { createShowGameOver, isValidScoreTime, readStoredBestTime } = mod;

  // End-of-run UI must clear an already visible start/loading toast without
  // tearing down audio, and tell the orchestrator to cancel a pending toast.
  {
    const { AudioModule } = await import('../src/audio.ts');
    const deps = makeDeps();
    let ended = 0;
    AudioModule.showMessage('Get Ready!', 100000);
    const sound = document.createElement('button');
    sound.id = 'audioControlBtn';
    document.body.appendChild(sound);
    createShowGameOver({ ...deps, onEndRun: () => { ended++; } })('You hit a tree!');
    check('result entry cancels pending run UI work', ended === 1);
    check('result entry removes visible run toasts immediately',
      ![...document.body.children].some(el => el.textContent === 'Get Ready!'));
    check('clearing result toasts preserves the sound control for replay',
      document.getElementById('audioControlBtn') === sound);
    AudioModule.clearMessages();
  }

  // --- isValidScoreTime: fallback computation + delegation to ScoresModule ---
  delete window.ScoresModule;
  check('isValidScoreTime fallback accepts a sane time', isValidScoreTime(20) === true);
  check('isValidScoreTime fallback rejects a sub-floor time', isValidScoreTime(1) === false);
  window.ScoresModule = { isValidScoreTime: (t) => t === 42 };
  check('isValidScoreTime delegates to ScoresModule', isValidScoreTime(42) === true && isValidScoreTime(20) === false);
  delete window.ScoresModule;

  // --- readStoredBestTime: empty / valid / invalid stored values ---
  local.clear();
  check('readStoredBestTime returns Infinity with no stored time', readStoredBestTime() === Infinity);
  local.clear(); local.setItem(BTK('blue'), '22.5');
  check('readStoredBestTime parses a valid stored time', readStoredBestTime() === 22.5);
  local.clear(); local.setItem(BTK('blue'), '0.1');
  check('readStoredBestTime drops an invalid stored time', readStoredBestTime() === Infinity && local.getItem(BTK('blue')) === null);

  // --- showGameOver: test override short-circuit ---
  let overrode = null;
  window._testShowGameOverOverride = (reason) => { overrode = reason; };
  createShowGameOver(makeDeps())('whatever');
  check('showGameOver honors _testShowGameOverOverride', overrode === 'whatever');
  delete window._testShowGameOverOverride;

  // --- Finish + valid time + new best, AuthModule.recordScore present, not signed in ---
  local.clear();
  let recorded = null;
  let leaderboardReads = 0;
  let recordedTier = null;
  let recordCalls = 0;
  const record = (time, tier) => { recorded = time; recordedTier = tier; recordCalls++; };
  window.AuthModule = {
    recordScore: record,
    getCurrentUser: () => null,
  };
  window.ScoresModule = { getLeaderboard: async () => { leaderboardReads++; return []; } };
  let analyticsEvents = [];
  window.firebaseModules = { logEvent: (name, params) => analyticsEvents.push([name, params]) };
  {
    const deps = makeDeps({ bestTime: Infinity });
    createShowGameOver(deps)(FINISH);
    check('finish records the score via AuthModule', typeof recorded === 'number');
    check('finish sets a new best time readout', /New Best Time/.test(deps.bestTimeDisplay.textContent));
    check('signed-out finish offers an explicit sign-in-and-save action',
      /sign in.*save this run/i.test(document.getElementById('saveScoreButton')?.textContent || '')
      && !!document.getElementById('saveScoreStatus') && !document.getElementById('loginPrompt'));
    await settle();
    check('signed-out finish explains the leaderboard without denied reads',
      leaderboardReads === 0 && /sign in/i.test(document.getElementById('leaderboard').textContent));
    // Ranked finish: recordScore (mocked here) owns the canonical `complete_run` event, so
    // the overlay must emit NO finish event itself — no duplicate `complete_run` and no
    // legacy `complete_game` (which used to double-count every finish in GA4).
    check('ranked finish emits no finish event from the overlay (recordScore owns complete_run)',
      !analyticsEvents.some(e => e[0] === 'complete_run' || e[0] === 'complete_game'));
    check('overlay is shown', deps.gameOverOverlay.style.display === 'flex');
  }


  // Replay stays outside growing results, and a subsequent result starts at its top.
  {
    const deps = makeDeps();
    const show = createShowGameOver(deps);
    show(FINISH);
    const content = document.getElementById('gameOverContent');
    const actions = document.getElementById('gameOverActions');
    check('restart is outside the scrollable results',
      deps.restartButton.parentElement === actions && !content.contains(deps.restartButton));
    check('result messages live in the scrollable region', content.contains(deps.gameOverDetail));
    check('successful finish has a success heading', document.getElementById('gameOverMessage').textContent === 'RUN COMPLETE');
    content.scrollTop = 400;
    show('You hit a tree!');
    check('new result resets previous scroll position', content.scrollTop === 0);
    check('crash restores the game over heading', document.getElementById('gameOverMessage').textContent === 'GAME OVER');
    check('repeated result does not duplicate layout regions',
      document.querySelectorAll('#gameOverContent').length === 1 && document.querySelectorAll('#gameOverActions').length === 1);
  }

  // --- Practice world (?seed=, #403 review): shows the time, records NOTHING ---
  {
    local.clear();
    recorded = null;
    const RC = await import('../src/run-context.ts');
    RC.setWorldContext(424242, true); // an explicit ?seed= world => practice
    const deps = makeDeps({ bestTime: Infinity });
    createShowGameOver(deps)(FINISH);
    check('practice finish does NOT submit to the leaderboard', recorded === null);
    check('practice finish writes NO local best',
      local.getItem(BTK('blue')) === null);
    check('practice finish does not claim a new best time',
      !/New Best Time/.test(deps.bestTimeDisplay.textContent));
    check('practice finish still shows the overlay/result',
      deps.gameOverOverlay.style.display === 'flex');
    // The WHOLE overlay reads as unranked on a practice world (Codex PR #407):
    // no sign-in-to-save prompt, no leaderboard render.
    check('practice finish shows no account-save controls or login prompt',
      !document.getElementById('saveScoreActions') && !document.getElementById('loginPrompt'));
    check('practice finish never renders or reads the leaderboard',
      document.getElementById('leaderboard').style.display === 'none' && leaderboardReads === 0);
    // The best-time line renders the practice time ALONE (Codex review PR #407):
    // the canonical best is a different world's record — and a new player would
    // otherwise see 'Best: Infinitys'.
    check('practice finish shows only the run time (no cross-world Best comparison)',
      /^Your Time: \d+\.\d{2}s$/.test(deps.bestTimeDisplay.textContent));
    // And the sync-status line must say nothing is saved (not the unranked-tier copy).
    const syncLine = document.getElementById('syncStatus');
    check('practice finish status copy says nothing is saved',
      !!syncLine && /nothing is saved/i.test(syncLine.textContent));
    RC.setRunSeed(null);
  }

  // --- Timing-compromised run (#403 review): shows the time, records NOTHING ---
  {
    local.clear();
    recorded = null;
    const deps = makeDeps({ bestTime: 40 });
    /** @type {any} */ (deps.state).timingCompromised = true;
    createShowGameOver(deps)(FINISH);
    check('compromised finish does NOT submit to the leaderboard', recorded === null);
    check('compromised finish writes NO local best', local.getItem(BTK('blue')) === null);
    check('compromised finish offers no account save or leaderboard',
      !document.getElementById('saveScoreActions') && document.getElementById('leaderboard').style.display === 'none');
    check('compromised finish does not claim a new best time',
      !/New Best Time/.test(deps.bestTimeDisplay.textContent));
    const syncLine = document.getElementById('syncStatus');
    check('compromised finish status copy says the run was not recorded',
      !!syncLine && /not recorded/i.test(syncLine.textContent));
    // The best-time line renders the compromised time ALONE (Codex review PR
    // #409): no 'Best: Infinitys' for a new player, no comparison against a
    // best this run was barred from touching.
    check('compromised finish shows only the run time (no Best comparison)',
      /^Your Time: \d+\.\d{2}s$/.test(deps.bestTimeDisplay.textContent));
  }

  // Every canonical tier routes a finish through the same score API. The score
  // layer owns analytics; the overlay and later Save retries must not double-count.
  /** @type {import('../src/difficulty.ts').Difficulty[]} */
  const tiers = ['bunny', 'blue', 'black', 'expert'];
  for (const tier of tiers) {
    local.clear();
    recorded = null;
    recordedTier = null;
    recordCalls = 0;
    analyticsEvents.length = 0;
    window.AuthModule = { recordScore: record, getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: Infinity, simElapsed: 40, getDifficulty: () => tier });
    createShowGameOver(deps)(FINISH);
    check(`${tier} finish records its exact time and own tier once`,
      recorded === 40 && recordedTier === tier && recordCalls === 1);
    check(`${tier} ranked finish does not duplicate score-layer analytics`,
      !analyticsEvents.some(event => event[0] === 'complete_run' || event[0] === 'complete_game'));
    check(`${tier} finish exposes the same sign-in/save status`,
      !!document.getElementById('saveScoreActions') && !!document.getElementById('saveScoreStatus')
      && !document.getElementById('syncStatus'));
  }

  // If the optional score bridge is missing, all tiers retain the local best and
  // its provenance, and the overlay emits exactly one canonical finish event.
  for (const tier of tiers) {
    local.clear();
    analyticsEvents.length = 0;
    window.AuthModule = { getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: Infinity, simElapsed: 40, getDifficulty: () => tier });
    createShowGameOver(deps)(FINISH);
    check(`${tier} fallback persists only that tier's local best`,
      local.getItem(BTK(tier)) === '40' && tiers.filter(other => other !== tier).every(other => local.getItem(BTK(other)) === null));
    const meta = JSON.parse(local.getItem(BTMK(tier)) || 'null');
    const stamp = getRunStamp();
    check(`${tier} fallback records the run provenance sidecar`,
      !!meta && meta.physicsVersion === stamp.physicsVersion && meta.seed === stamp.seed
      && meta.nonce === stamp.nonce && meta.practice === false);
    check(`${tier} fallback emits one complete_run with tier and physics context`,
      analyticsEvents.filter(event => event[0] === 'complete_run').length === 1
      && analyticsEvents.some(event => event[0] === 'complete_run' && event[1]?.difficulty === tier
        && typeof event[1]?.physics_version === 'number')
      && !analyticsEvents.some(event => event[0] === 'complete_game'));
  }

  // A faster finish in another tab must survive a stale in-memory best and the
  // no-auth/local fallback. A blocked read must preserve that unread value too.
  {
    local.clear();
    local.setItem(BTK('blue'), '17');
    window.AuthModule = { getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: 30, simElapsed: 20 });
    createShowGameOver(deps)(FINISH);
    check('fallback preserves a faster device best written after the run started',
      local.getItem(BTK('blue')) === '17' && deps.state.bestTime === 17
      && !/New Best Time/.test(deps.bestTimeDisplay.textContent));
    const read = local.getItem;
    try {
      local.getItem = key => {
        if (key === BTK('blue')) throw new Error('read blocked');
        return read.call(local, key);
      };
      createShowGameOver(makeDeps({ bestTime: 30, simElapsed: 20 }))(FINISH);
      check('fallback does not overwrite an unread faster record', read.call(local, BTK('blue')) === '17');
    } finally { local.getItem = read; }
  }

  // Fast tiers must not inherit Blue's floor. Use the active configuration so
  // this guard remains about routing rather than an obsolete hardcoded limit.
  for (const tier of /** @type {const} */ (['black', 'expert'])) {
    local.clear();
    const fastTime = getDifficultyConfig(tier).minScoreTime + 1;
    window.AuthModule = { getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: Infinity, simElapsed: fastTime, getDifficulty: () => tier });
    createShowGameOver(deps)(FINISH);
    check(`${tier} accepts its valid fast finish below Blue's floor`,
      fastTime < getDifficultyConfig('blue').minScoreTime
      && local.getItem(BTK(tier)) === String(fastTime) && /New Best Time/.test(deps.bestTimeDisplay.textContent));
  }

  // UI, score submission and the course panel must consume one simulation-clock
  // snapshot; elapsed wall time is only a compatibility fallback.
  {
    const { CourseModule } = await import('../src/course.js');
    const realOnFinish = CourseModule.onFinish;
    let courseTime = null;
    CourseModule.onFinish = time => { courseTime = time; return null; };
    window.AuthModule = { recordScore: record, getCurrentUser: () => null };
    try {
      const deps = makeDeps({ simElapsed: 34.56789, startTime: performance.now() - 1000, getDifficulty: () => 'expert' });
      createShowGameOver(deps)(FINISH);
      check('score and course panel receive the same simulation timestamp', recorded === 34.56789 && courseTime === recorded);
      check('result rounds that same timestamp only for display', deps.bestTimeDisplay.textContent.includes('34.57s'));
    } finally { CourseModule.onFinish = realOnFinish; }
  }

  // --- Finish + valid time, NOT a new best, signed in -> leaderboard insertion ---
  {
    window.AuthModule.getCurrentUser = () => /** @type {any} */ ({ uid: 'u1' });
    window.ScoresModule = { getLeaderboard: async () => [boardEntry('u1', 22, 'Ada')] };
    const deps = makeDeps({ bestTime: 1 }); // existing best (1s) faster than the ~20s finish
    createShowGameOver(deps)(FINISH);
    check('finish that is not a new best shows "Your Time"', /Your Time/.test(deps.bestTimeDisplay.textContent));
    await settle();
    check('signed-in finish mounts the shared board and displays retrieved rows',
      document.getElementById('leaderboard').parentNode === document.getElementById('gameOverContent')
      && document.getElementById('leaderboard').textContent.includes('22.00s')
      && document.getElementById('leaderboard').querySelectorAll('[data-leaderboard-tier]').length === 4);
  }

  // --- Finish-screen difficulty picker: kept directly above RESTART + synced to tier ---
  // The picker lets the player switch tier and replay without reloading; showGameOver
  // must (a) re-anchor it immediately above the restart button even after the
  // leaderboard/result panel get inserted, and (b) reflect the tier just played.
  {
    window.AuthModule.getCurrentUser = () => /** @type {any} */ ({ uid: 'u1' });
    const deps = makeDeps({ bestTime: 1, getDifficulty: () => 'blue' });
    // A stand-in picker element inserted ABOVE the restart button (as snowglider.ts does);
    // the later leaderboard insertion would otherwise leave it stranded above the board.
    const picker = document.createElement('div');
    picker.id = 'finishDifficultyPicker';
    deps.gameOverOverlay.insertBefore(picker, deps.restartButton);
    let syncedTier = null;
    deps.finishDifficultyPicker = picker;
    deps.setPickerTier = (t) => { syncedTier = t; };
    createShowGameOver(deps)(FINISH);
    check('finish picker is re-anchored directly above the restart button',
      picker.nextElementSibling === deps.restartButton && picker.parentNode === document.getElementById('gameOverActions'));
    check('finish picker is synced to the tier just played', syncedTier === 'blue');
  }

  // Reusing the same result DOM must replace each tier's rows, including when
  // returning to an already-parented Blue board after Black/Expert.
  {
    window.AuthModule.getCurrentUser = () => /** @type {any} */ ({ uid: 'u1' });
    window.ScoresModule = { getLeaderboard: async tier => [boardEntry('rival', 30, `${tier} rival`)] };
    const deps = makeDeps({ bestTime: 1, simElapsed: 40 });
    const lb = document.getElementById('leaderboard');
    for (const tier of /** @type {const} */ (['blue', 'black', 'expert', 'bunny', 'blue'])) {
      createShowGameOver({ ...deps, getDifficulty: () => tier })(FINISH);
      await settle();
      check(`${tier} replay replaces the existing board with its own rows and selected tab`,
        lb.style.display === 'block' && lb.parentNode === document.getElementById('gameOverContent')
        && lb.textContent.includes(`${tier} rival`)
        && lb.querySelector('[aria-pressed="true"]').getAttribute('data-leaderboard-tier') === tier);
    }
  }

  // Optional backend failures cannot stop the result or leave stale scores.
  {
    window.AuthModule = {
      getCurrentUser: () => /** @type {any} */ ({ uid: 'u1' }),
      isFirebaseAvailable: () => { throw new Error('status unavailable'); },
    };
    window.ScoresModule = { getLeaderboard: () => { throw new Error('leaderboard unavailable'); } };
    const deps = makeDeps();
    createShowGameOver(deps)(FINISH);
    await settle();
    const lb = document.getElementById('leaderboard');
    check('throwing Firebase status and board read preserve the completed run',
      deps.gameOverOverlay.style.display === 'flex' && /New Best Time/.test(deps.bestTimeDisplay.textContent));
    check('throwing board read exposes Retry without displaying stale rows',
      lb.style.display === 'block' && !lb.querySelector('table') && /couldn.t load/i.test(lb.textContent)
      && !!lb.querySelector('.leaderboard-action'));
  }
  {
    let rejectOld = (/** @type {unknown} */ _error) => {};
    window.AuthModule = { getCurrentUser: () => /** @type {any} */ ({ uid: 'u1' }) };
    window.ScoresModule = { getLeaderboard: () => new Promise((_, reject) => { rejectOld = reject; }) };
    const deps = makeDeps();
    const show = createShowGameOver(deps);
    show(FINISH);
    await settle(); // the first read is genuinely in flight
    window.ScoresModule.getLeaderboard = async () => [boardEntry('new', 25, 'Fresh result')];
    show(FINISH);
    await settle();
    rejectOld(new Error('previous leaderboard request failed'));
    await settle();
    const lb = document.getElementById('leaderboard');
    check('old leaderboard rejection cannot replace a newer result',
      lb.style.display === 'block' && lb.textContent.includes('Fresh result') && !lb.querySelector('.leaderboard-action'));
    window.ScoresModule.getLeaderboard = async () => { throw new Error('current leaderboard request failed'); };
    show(FINISH);
    await settle();
    check('current failed request preserves replay and replaces old rows with Retry',
      deps.gameOverOverlay.style.display === 'flex' && lb.style.display === 'block'
      && !lb.querySelector('table') && !lb.textContent.includes('Fresh result') && !!lb.querySelector('.leaderboard-action'));
  }

  // A missing score reader must replace previous contents with an honest status;
  // the old Auth.displayLeaderboard seam is no longer involved in rendering.
  {
    const deps = makeDeps({ bestTime: 1, getDifficulty: () => 'blue' });
    const lb = document.getElementById('leaderboard');
    window.AuthModule = { recordScore: record, getCurrentUser: () => /** @type {any} */ ({ uid: 'u1' }) };
    window.ScoresModule = { getLeaderboard: async () => [boardEntry('previous', 24, 'Previous rows')] };
    const show = createShowGameOver(deps);
    show(FINISH);
    await settle();
    check('working score reader populates the result board', lb.textContent.includes('Previous rows'));
    window.ScoresModule = {};
    show(FINISH);
    await settle();
    check('missing reader clears stale rows and exposes unavailable status',
      lb.style.display === 'block' && /unavailable/i.test(lb.textContent) && !lb.querySelector('table')
      && !lb.textContent.includes('Previous rows') && !!lb.querySelector('.leaderboard-action'));
  }

  // Authentication/connectivity changes refresh the mounted result board, while
  // closing the result removes those subscriptions and any pending save action.
  {
    /** @type {any} */ let user = null;
    let reads = 0;
    window.AuthModule = { recordScore: record, getCurrentUser: () => user };
    window.ScoresModule = { getLeaderboard: async () => { reads++; return [boardEntry('u1', 28, 'Connected rider')]; } };
    const deps = makeDeps({ simElapsed: 30 });
    createShowGameOver(deps)(FINISH);
    await settle();
    check('signed-out result never reads global times', reads === 0);
    user = { uid: 'u1' };
    window.dispatchEvent(new window.Event('snowglider:auth-changed'));
    await settle();
    const lb = document.getElementById('leaderboard');
    check('auth-changed refreshes the visible result board', reads === 1 && lb.textContent.includes('Connected rider'));
    env.setOnline(false);
    window.dispatchEvent(new window.Event('offline'));
    await settle();
    check('offline result replaces rows with offline status and skips reads',
      reads === 1 && /offline/i.test(lb.textContent) && !lb.querySelector('table'));
    env.setOnline(true);
    window.dispatchEvent(new window.Event('online'));
    await settle();
    check('reconnection reloads the result board', reads === 2 && lb.textContent.includes('Connected rider'));
    closeOverlayFocus(deps.gameOverOverlay, false);
    window.dispatchEvent(new window.Event('snowglider:auth-changed'));
    window.dispatchEvent(new window.Event('online'));
    await settle();
    check('closing results removes board refresh listeners', reads === 2);
  }

  // Saving after explicit sign-in retains the completed tier/time and calls only
  // saveScore. It must not replay recordScore or emit another finish event.
  {
    /** @type {any} */ let user = null;
    let openedSignIn = 0;
    /** @type {Array<{time: number, tier?: import('../src/difficulty.ts').Difficulty}>} */
    const saved = [];
    recordCalls = 0;
    analyticsEvents.length = 0;
    window.AuthModule = {
      recordScore: record,
      getCurrentUser: () => user,
      openSignIn: () => { openedSignIn++; },
    };
    window.ScoresModule = {
      getLeaderboard: async () => [],
      saveScore: async (time, tier) => {
        saved.push({ time, tier });
        return { status: 'saved', localSaved: true, userId: 'new-account' };
      },
    };
    const deps = makeDeps({ simElapsed: 32.125, getDifficulty: () => 'expert' });
    createShowGameOver(deps)(FINISH);
    document.getElementById('saveScoreButton').click();
    check('save action reveals sign-in without claiming a score early', openedSignIn === 1 && saved.length === 0);
    user = { uid: 'new-account' };
    window.dispatchEvent(new window.Event('snowglider:auth-changed'));
    await settle();
    check('post-sign-in save uses the completed Expert time', saved.length === 1 && saved[0].time === 32.125 && saved[0].tier === 'expert');
    check('confirmed save updates the visible status',
      /saved to leaderboard/i.test(document.getElementById('saveScoreButton').textContent)
      && /Expert/.test(document.getElementById('saveScoreStatus').textContent));
    check('explicit save never re-records the run or duplicates analytics',
      recordCalls === 1 && !analyticsEvents.some(event => event[0] === 'complete_run' || event[0] === 'complete_game'));
  }

  // --- Finish + valid time, no AuthModule.recordScore -> localStorage fallback best ---
  {
    delete window.AuthModule;
    local.clear();
    const deps = makeDeps({ bestTime: Infinity });
    createShowGameOver(deps)(FINISH);
    check('finish without recordScore persists a local best', typeof local.getItem(BTK('blue')) === 'string');
  }

  // --- Finish with an INVALID elapsed time -> warn branch, no score ---
  {
    recordCalls = 0;
    window.AuthModule = { recordScore: record, getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: 5, startTime: performance.now() - 1000 });
    createShowGameOver(deps)(FINISH);
    check('invalid finish time shows the existing best and records nothing',
      /Best Time/.test(deps.bestTimeDisplay.textContent) && recordCalls === 0 && !document.getElementById('saveScoreActions'));
  }
  {
    local.clear();
    const deps = makeDeps({ bestTime: Infinity, startTime: performance.now() - 1000 });
    createShowGameOver(deps)(FINISH);
    check('invalid finish time with no best shows "No best time yet"', /No best time yet/.test(deps.bestTimeDisplay.textContent));
  }

  // --- Failure (crash) reason: onCrash hook fires, game_over analytics, no score ---
  {
    delete window.AuthModule;
    analyticsEvents = [];
    let crashReason = null;
    const deps = makeDeps({ bestTime: 7, onCrash: (r) => { crashReason = r; } });
    createShowGameOver(deps)('BANG!!! You hit a tree!');
    check('crash fires the onCrash hook', crashReason === 'BANG!!! You hit a tree!');
    check('crash shows the existing best time', /Best Time: 7/.test(deps.bestTimeDisplay.textContent));
    check('crash logs a game_over analytics event', analyticsEvents.some(e => e[0] === 'game_over'));
  }

  // --- onCrash hook throwing is swallowed; getSignedInUser error path is swallowed ---
  {
    window.AuthModule = { getCurrentUser: () => { throw new Error('auth read boom'); } };
    window.firebaseModules = { logEvent: () => { throw new Error('analytics boom'); } };
    const deps = makeDeps({ bestTime: Infinity, onCrash: () => { throw new Error('crash effect boom'); } });
    createShowGameOver(deps)('You fell off the mountain!');
    check('crash with a throwing onCrash + analytics + auth read still shows the overlay',
      deps.gameOverOverlay.style.display === 'flex');
  }

  // --- Finish that removes a stale login prompt, survives a throwing analytics
  // logEvent, and a throwing CourseModule.onFinish (result-screen catch). ---
  {
    const { CourseModule } = await import('../src/course.js');
    const realOnFinish = CourseModule.onFinish;
    CourseModule.onFinish = () => { throw new Error('result panel boom'); };
    window.AuthModule = { recordScore: () => {}, getCurrentUser: () => null };
    window.firebaseModules = { logEvent: () => { throw new Error('analytics boom'); } };
    local.clear();
    const deps = makeDeps({ bestTime: Infinity });
    const stale = document.createElement('p');
    stale.id = 'loginPrompt';
    deps.gameOverOverlay.appendChild(stale); // removeLoginPrompt should drop this
    createShowGameOver(deps)(FINISH);
    check('finish drops a stale login prompt + survives analytics/onFinish throwing',
      deps.gameOverOverlay.style.display === 'flex' && !document.getElementById('loginPrompt')
      && document.querySelectorAll('#saveScoreActions').length === 1);
    CourseModule.onFinish = realOnFinish;
  }

  // The new save action must reveal the real provider controls inside the dialog
  // and retain their original user-gesture handler and placement after cleanup.
  {
    const { closeOverlayFocus } = await import('../src/ui/accessibility.ts');
    const deps = makeDeps();
    const account = document.createElement('div');
    account.id = 'authContainer';
    const authUI = document.createElement('div');
    authUI.id = 'authUI';
    authUI.style.display = 'none';
    const provider = document.createElement('button');
    provider.id = 'loginBtn';
    provider.textContent = 'Sign in with Google';
    let signIns = 0;
    provider.addEventListener('click', () => { signIns++; });
    authUI.appendChild(provider);
    account.appendChild(authUI);
    document.body.appendChild(account);
    window.AuthModule = { recordScore: () => {}, getCurrentUser: () => null };
    const show = createShowGameOver(deps);
    show(FINISH);
    check('result contains the real account controls inside its focus boundary',
      account.parentElement === document.getElementById('gameOverContent') && account.inert !== true);
    document.getElementById('saveScoreButton').click();
    check('save sign-in focuses the real provider button within the result dialog',
      authUI.style.display === 'flex' && document.activeElement === provider);
    provider.click();
    check('moving account controls preserves their existing sign-in handler', signIns === 1);
    show('You hit a tree!');
    check('re-showing a result keeps one account region', document.querySelectorAll('#authContainer').length === 1);
    closeOverlayFocus(deps.gameOverOverlay, false);
    check('restart/teardown cleanup restores account controls to their original parent', account.parentElement === document.body);
  }

  console.log(`\nRESULT-OVERLAY TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('result-overlay test crashed:', err);
  process.exit(1);
});
