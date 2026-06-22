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

const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
global.window = dom.window;
global.document = dom.window.document;
let store = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
  clear: () => { store = {}; }
};
const { window } = dom;
const { document } = window;

// Reset the overlay DOM for one showGameOver scenario; returns the injected deps.
function makeDeps({ bestTime = Infinity, startTime, onCrash } = {}) {
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
    state: { gameActive: true, bestTime, startTime: startTime ?? (performance.now() - 10000) },
    gameOverOverlay: document.getElementById('gameOverOverlay'),
    gameOverDetail: document.getElementById('gameOverDetail'),
    restartButton: document.getElementById('restartButton'),
    bestTimeDisplay: document.getElementById('bestTimeDisplay'),
    onCrash,
  };
}

const FINISH = 'You reached the end of the slope!';

async function main() {
  console.log('--- result-overlay.ts ---');
  const mod = await import('../src/ui/result-overlay.ts');
  const { createShowGameOver, isValidScoreTime, readStoredBestTime } = mod;

  // --- isValidScoreTime: fallback computation + delegation to ScoresModule ---
  delete window.ScoresModule;
  check('isValidScoreTime fallback accepts a sane time', isValidScoreTime(10) === true);
  check('isValidScoreTime fallback rejects a tiny time', isValidScoreTime(1) === false);
  window.ScoresModule = { isValidScoreTime: (t) => t === 42 };
  check('isValidScoreTime delegates to ScoresModule', isValidScoreTime(42) === true && isValidScoreTime(10) === false);
  delete window.ScoresModule;

  // --- readStoredBestTime: empty / valid / invalid stored values ---
  store = {};
  check('readStoredBestTime returns Infinity with no stored time', readStoredBestTime() === Infinity);
  store = { snowgliderBestTime: '12.5' };
  check('readStoredBestTime parses a valid stored time', readStoredBestTime() === 12.5);
  store = { snowgliderBestTime: '0.1' };
  check('readStoredBestTime drops an invalid stored time', readStoredBestTime() === Infinity && store.snowgliderBestTime === undefined);

  // --- showGameOver: test override short-circuit ---
  let overrode = null;
  window._testShowGameOverOverride = (reason) => { overrode = reason; };
  createShowGameOver(makeDeps())('whatever');
  check('showGameOver honors _testShowGameOverOverride', overrode === 'whatever');
  delete window._testShowGameOverOverride;

  // --- Finish + valid time + new best, AuthModule.recordScore present, not signed in ---
  store = {};
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
    check('finish logs a complete_game analytics event', analyticsEvents.some(e => e[0] === 'complete_game'));
    check('overlay is shown', deps.gameOverOverlay.style.display === 'flex');
  }

  // --- Finish + valid time, NOT a new best, signed in -> leaderboard insertion ---
  {
    leaderboardShown = 0;
    window.AuthModule.getCurrentUser = () => ({ uid: 'u1' });
    const deps = makeDeps({ bestTime: 1 }); // existing best (1s) faster than the ~10s finish
    createShowGameOver(deps)(FINISH);
    check('finish that is not a new best shows "Your Time"', /Your Time/.test(deps.bestTimeDisplay.textContent));
    check('signed-in finish inserts + displays the leaderboard',
      document.getElementById('leaderboard').parentNode === deps.gameOverOverlay && leaderboardShown === 1);
  }

  // --- Finish + valid time, no AuthModule.recordScore -> localStorage fallback best ---
  {
    delete window.AuthModule;
    store = {};
    const deps = makeDeps({ bestTime: Infinity });
    createShowGameOver(deps)(FINISH);
    check('finish without recordScore persists a local best', typeof store.snowgliderBestTime === 'string');
  }

  // --- Finish with an INVALID elapsed time -> warn branch, no score ---
  {
    window.AuthModule = { recordScore: () => { throw new Error('should not be called'); }, getCurrentUser: () => null };
    const deps = makeDeps({ bestTime: 5, startTime: performance.now() - 1000 }); // ~1s < MIN 4
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
    store = {};
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
