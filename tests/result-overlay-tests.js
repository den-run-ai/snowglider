// @ts-check
// result-overlay-tests.js
// Headless, c8-instrumented coverage for src/ui/result-overlay.ts — the game-over /
// finish overlay: score-time validation, the best-time readout, the leaderboard
// insertion, the login prompt, analytics, and the course result panel.
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

// Reset the overlay DOM for one showGameOver scenario; returns the injected deps.
function makeDeps(/** @type {{ bestTime?: number, startTime?: number, onCrash?: (r: string) => void, getDifficulty?: () => ('bunny'|'blue'|'black') }} */ { bestTime = Infinity, startTime, onCrash, getDifficulty } = {}) {
  document.body.innerHTML = `
    <div id="gameStatsContainer"><button id="toggleStats">▲</button></div>
    <div id="leaderboard" style="display:none"></div>
    <div id="gameOverOverlay" style="display:none">
      <p id="gameOverDetail"></p>
      <p id="bestTimeDisplay"></p>
      <button id="restartButton">Restart</button>
    </div>`;
  document.body.classList.add('game-active');
  return {
    state: { gameActive: true, bestTime, startTime: startTime ?? (performance.now() - 20000) },
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

  const mod = await import('../src/ui/result-overlay.ts');
  // Versioned competitive best-time keys (#403 review): assert against the
  // REAL key builders so the suite tracks the active ruleset namespace.
  const { localBestTimeKey: BTK, localBestMetaKey: BTMK } = await import('../src/difficulty.ts');
  const { createShowGameOver, isValidScoreTime, readStoredBestTime } = mod;

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
  let leaderboardShown = 0;
  window.AuthModule = {
    recordScore: (t) => { recorded = t; },
    getCurrentUser: () => null,
    displayLeaderboard: () => { leaderboardShown++; },
  };
  let analyticsEvents = [];
  window.firebaseModules = { logEvent: (name, params) => analyticsEvents.push([name, params]) };
  {
    const deps = makeDeps({ bestTime: Infinity });
    createShowGameOver(deps)(FINISH);
    check('finish records the score via AuthModule', typeof recorded === 'number');
    check('finish sets a new best time readout', /New Best Time/.test(deps.bestTimeDisplay.textContent));
    check('finish (not signed in) inserts the login prompt', !!document.getElementById('loginPrompt'));
    // Ranked finish: recordScore (mocked here) owns the canonical `complete_run` event, so
    // the overlay must emit NO finish event itself — no duplicate `complete_run` and no
    // legacy `complete_game` (which used to double-count every finish in GA4).
    check('ranked finish emits no finish event from the overlay (recordScore owns complete_run)',
      !analyticsEvents.some(e => e[0] === 'complete_run' || e[0] === 'complete_game'));
    check('overlay is shown', deps.gameOverOverlay.style.display === 'flex');
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
    check('practice finish shows no login prompt', !document.getElementById('loginPrompt'));
    check('practice finish never renders the leaderboard', leaderboardShown === 0);
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

  // --- Unranked tier (D3): finish records NO Firestore score, keeps the per-tier local best ---
  {
    local.clear();
    recorded = null;
    analyticsEvents.length = 0;
    window.AuthModule.getCurrentUser = () => null;
    // ~30s finish — a realistic, plausible Bunny time (Bunny plays slower; its floor is 28s).
    const deps = makeDeps({ bestTime: Infinity, startTime: performance.now() - 30000, getDifficulty: () => 'bunny' });
    createShowGameOver(deps)(FINISH);
    check('unranked tier does NOT submit a score via AuthModule', recorded === null);
    // recordScore never runs for an unranked tier, so the overlay must emit the canonical
    // finish event itself — otherwise unranked runs are dropped from analytics entirely.
    check('unranked finish still emits the canonical complete_run event',
      analyticsEvents.some(e => e[0] === 'complete_run'));
    check('unranked tier still saves the per-tier local best',
      typeof local.getItem(BTK('bunny')) === 'string'
      && local.getItem(BTK('blue')) === null);
    // The fallback write carries the same run-provenance stamp every other
    // local-best path writes (#400; Codex review PR #407).
    check('unranked local best is stamped with the sidecar provenance meta',
      typeof local.getItem(BTMK('bunny')) === 'string');
    check('unranked tier omits the sign-in-to-save login prompt',
      !document.getElementById('loginPrompt'));
  }

  // --- Fast Black finish below Blue's 18s floor is valid for its own (13s) tier floor ---
  {
    local.clear();
    recorded = null;
    window.AuthModule.getCurrentUser = () => null;
    // ~15s finish: under Blue's 18s floor, but above Black's 13s floor.
    const deps = makeDeps({ bestTime: Infinity, startTime: performance.now() - 15000, getDifficulty: () => 'black' });
    createShowGameOver(deps)(FINISH);
    check('fast Black finish (15s < Blue floor) is treated as a valid finish, saves its local best',
      typeof local.getItem(BTK('black')) === 'string'
      && /New Best Time/.test(deps.bestTimeDisplay.textContent));
  }

  // --- Finish + valid time, NOT a new best, signed in -> leaderboard insertion ---
  {
    leaderboardShown = 0;
    window.AuthModule.getCurrentUser = () => /** @type {any} */ ({ uid: 'u1' });
    const deps = makeDeps({ bestTime: 1 }); // existing best (1s) faster than the ~20s finish
    createShowGameOver(deps)(FINISH);
    check('finish that is not a new best shows "Your Time"', /Your Time/.test(deps.bestTimeDisplay.textContent));
    check('signed-in finish inserts + displays the leaderboard',
      document.getElementById('leaderboard').parentNode === deps.gameOverOverlay && leaderboardShown === 1);
  }

  // --- Finish-screen difficulty picker: kept directly above RESTART + synced to tier ---
  // The picker lets the player switch tier and replay without reloading; showGameOver
  // must (a) re-anchor it immediately above the restart button even after the
  // leaderboard/result panel get inserted, and (b) reflect the tier just played.
  {
    leaderboardShown = 0;
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
      picker.nextElementSibling === deps.restartButton && picker.parentNode === deps.gameOverOverlay);
    check('finish picker is synced to the tier just played', syncedTier === 'blue');
  }

  // --- Leaderboard visibility tracks the tier across mid-session switches (Codex #255) ---
  // The finish picker lets a signed-in player swap tiers between runs on the SAME overlay.
  // Ranked Blue shows the board; unranked Bunny/Black must hide it; returning to Blue must
  // re-show it — the element stays parented, so display must be re-set, not only on first
  // insert (the Blue → Black → Blue round-trip is the regression Codex flagged).
  {
    window.AuthModule.getCurrentUser = () => /** @type {any} */ ({ uid: 'u1' });
    const blueDeps = makeDeps({ bestTime: 1, getDifficulty: () => 'blue' });
    const lb = document.getElementById('leaderboard');
    // Reuse the SAME overlay DOM across all three finishes (no makeDeps reset between them);
    // the casts pin the literal tier to the Difficulty union for typecheck:tests.
    const blackDeps = { ...blueDeps, getDifficulty: /** @type {() => 'black'} */ (() => 'black') };

    createShowGameOver(blueDeps)(FINISH);
    check('ranked Blue finish shows the leaderboard',
      lb.style.display === 'block' && lb.parentNode === blueDeps.gameOverOverlay);

    createShowGameOver(blackDeps)(FINISH);
    check('unranked Black replay hides the stale leaderboard', lb.style.display === 'none');

    createShowGameOver(blueDeps)(FINISH);
    check('returning to ranked Blue re-shows the already-parented leaderboard',
      lb.style.display === 'block');
  }

  // --- Missing AuthModule.displayLeaderboard hides the board instead of showing stale content ---
  // displayLeaderboard is the call that refreshes the board's CONTENTS; the overlay itself only
  // re-shows the element. A future AuthModule seam lacking the method used to silently no-op
  // (`?.`), leaving the just-shown board displaying a STALE leaderboard from a prior finish. The
  // hardened path fails loudly (console.error) and hides the board instead.
  {
    const rankedDeps = makeDeps({ bestTime: 1, getDifficulty: () => 'blue' });
    const lb = document.getElementById('leaderboard'); // after makeDeps rebuilds the DOM
    // A normal ranked finish (working seam) leaves the board shown (block)...
    window.AuthModule = {
      recordScore: () => {},
      getCurrentUser: () => /** @type {any} */ ({ uid: 'u1' }),
      displayLeaderboard: () => {},
    };
    createShowGameOver(rankedDeps)(FINISH);
    check('ranked finish with a working seam shows the board', lb.style.display === 'block');

    // ...a subsequent ranked finish whose AuthModule LACKS displayLeaderboard must hide the
    // board and log, not leave the stale board visible.
    const origError = console.error;
    let logged = 0;
    console.error = () => { logged++; };
    window.AuthModule = {
      recordScore: () => {},
      getCurrentUser: () => /** @type {any} */ ({ uid: 'u1' }),
      // displayLeaderboard intentionally absent
    };
    try {
      createShowGameOver(rankedDeps)(FINISH);
    } finally {
      console.error = origError;
    }
    check('missing displayLeaderboard hides the board (no stale display)', lb.style.display === 'none');
    check('missing displayLeaderboard logs an error', logged === 1);
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
    window.AuthModule = { recordScore: () => { throw new Error('should not be called'); }, getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: 5, startTime: performance.now() - 1000 }); // ~1s < MIN 18
    createShowGameOver(deps)(FINISH);
    check('invalid finish time shows the existing best, records nothing', /Best Time/.test(deps.bestTimeDisplay.textContent));
  }
  {
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
    window.AuthModule = { recordScore: () => {}, getCurrentUser: () => null, displayLeaderboard: () => {} };
    window.firebaseModules = { logEvent: () => { throw new Error('analytics boom'); } };
    local.clear();
    const deps = makeDeps({ bestTime: Infinity });
    const stale = document.createElement('p');
    stale.id = 'loginPrompt';
    deps.gameOverOverlay.appendChild(stale); // removeLoginPrompt should drop this
    createShowGameOver(deps)(FINISH);
    check('finish drops a stale login prompt + survives analytics/onFinish throwing',
      deps.gameOverOverlay.style.display === 'flex');
    CourseModule.onFinish = realOnFinish;
  }

  console.log(`\nRESULT-OVERLAY TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('result-overlay test crashed:', err);
  process.exit(1);
});
