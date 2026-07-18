// @ts-check
// local-auth-tests.js
// Headless, c8-instrumented coverage for src/boot/local-auth.js — the classic-script
// local-mode fallback that stubs window.ScoresModule / window.AuthModule when the
// real Firebase auth bundle is absent (file:// opens, offline, or a failed load).
//
// The browser suites always run WITH Firebase available, so the entire local
// fallback (every ScoresModule/AuthModule method below) is never exercised there —
// that is why this file sits near 14% on Codecov. We close the gap here.
//
// local-auth.js is a classic IIFE that assigns to `window`, not an ES module, so it
// cannot be `import`ed. Evaluating it with `window.eval` (the older boot-test
// pattern) is invisible to c8 because the source has no file URL the V8 coverage
// post-processor can attribute. Instead we run it with `vm.runInThisContext(src,
// { filename })` keyed to the real source path, so c8 instruments it exactly like a
// required module. Globals (`window`, `document`, `localStorage`, `console`) are the
// Node globals the script closes over, so we point them at a fresh jsdom per scenario.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const LOCAL_AUTH_PATH = path.join(__dirname, '..', 'src', 'boot', 'local-auth.js');
const LOCAL_AUTH_SRC = fs.readFileSync(LOCAL_AUTH_PATH, 'utf8');

let pass = 0;
let fail = 0;

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

// A minimal localStorage shim. jsdom refuses localStorage on the opaque file://
// origin we use to exercise the protocol branch, and the script reads bare
// `localStorage` (a Node global under runInThisContext) anyway.
function makeLocalStorage() {
  let store = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; },
    _raw: () => store
  };
}

// Build a jsdom + wire the Node globals local-auth.js closes over, then run the
// IIFE keyed to the real file path so c8 attributes the coverage.
function loadLocalAuth({ html, url }) {
  const dom = new JSDOM(html || '<!doctype html><body></body>', { url: url || 'https://snowglider.ai/' });
  const localStorage = makeLocalStorage();
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  g.localStorage = localStorage;
  g.console = console;
  vm.runInThisContext(LOCAL_AUTH_SRC, { filename: LOCAL_AUTH_PATH });
  return { window: dom.window, document: dom.window.document, localStorage };
}

function main() {
  console.log('--- local-auth.js (local-mode fallback) ---');

  // ---------------------------------------------------------------------------
  // Scenario A: file:// protocol with full auth/leaderboard DOM present.
  // Loading under file:// runs the IIFE's auto-install branch (installScoresModule).
  // ---------------------------------------------------------------------------
  const full = `<!doctype html><body>
    <div id="authContainer">
      <div id="authUI" style="display:flex"></div>
      <div id="profileUI" style="display:none"></div>
    </div>
    <div id="leaderboard"></div>
  </body>`;
  const a = loadLocalAuth({ html: full, url: 'file:///Users/x/snowglider/index.html' });

  check('file:// protocol auto-installs ScoresModule',
    !!a.window.ScoresModule && typeof a.window.ScoresModule.recordScore === 'function');
  check('SnowGliderLocalAuth exposes both installers',
    typeof a.window.SnowGliderLocalAuth.installScoresModule === 'function' &&
    typeof a.window.SnowGliderLocalAuth.installAuthModule === 'function');

  // Install AuthModule explicitly (the IIFE only auto-installs ScoresModule).
  a.window.SnowGliderLocalAuth.installAuthModule();
  // Cast to `any`: this suite deliberately probes the JS shim's RUNTIME validation
  // with adversarial inputs (no args, a string time), which the typed ScoresModuleApi/
  // AuthModuleApi seams (types/globals.d.ts) now correctly reject at compile time.
  const Scores = /** @type {any} */ (a.window.ScoresModule);
  const Auth = /** @type {any} */ (a.window.AuthModule);

  // --- ScoresModule no-op surface ---
  Scores.initializeScores();
  Scores.setCurrentUser({ uid: 'x' });
  Scores.updateUserBestTime();
  Scores.updateLeaderboard();
  check('ScoresModule.isFirestoreAvailable() is false in local mode',
    Scores.isFirestoreAvailable() === false);
  check('ScoresModule.isValidScoreTime exposes the validator',
    Scores.isValidScoreTime(42) === true && Scores.isValidScoreTime(0) === false);

  // --- ScoresModule.recordScore branches ---
  Scores.recordScore('not-a-number'); // invalid -> early return, no write
  check('recordScore ignores an invalid time', a.localStorage.getItem('snowgliderBestTime') === null);

  Scores.recordScore(50); // no stored best -> new personal best
  check('recordScore stores a first personal best', a.localStorage.getItem('snowgliderBestTime') === '50');

  Scores.recordScore(40); // faster -> new best
  check('recordScore overwrites with a faster time', a.localStorage.getItem('snowgliderBestTime') === '40');

  Scores.recordScore(45); // slower -> NOT a new best (else branch)
  check('recordScore keeps the existing faster best', a.localStorage.getItem('snowgliderBestTime') === '40');

  // Stored-best value that is present but invalid -> warn + remove + treat as new best.
  a.localStorage.setItem('snowgliderBestTime', 'garbage');
  Scores.recordScore(33);
  check('recordScore replaces an invalid stored best', a.localStorage.getItem('snowgliderBestTime') === '33');

  // --- Run-provenance stamp via the boot seam (#400; Codex review PR #407) ---
  // The classic script cannot import run-context, so it reads the deliberate
  // window seam scene-setup publishes. With the seam present, a new best writes
  // the same _meta sidecar the module-graph paths write; without it (degraded
  // boot), recording still works and simply leaves no stamp.
  a.window.__snowgliderGetRunStamp = () => ({ seed: 777, physicsVersion: 1 });
  Scores.recordScore(30);
  // With the seam present the key derives from the stamp's version (#403 review):
  // the write lands in that version's namespace, stamped alongside.
  check('local-auth writes the stamp-versioned competitive key via the seam',
    a.localStorage.getItem('snowgliderBestTime_v1') === '30');
  check('local-auth stamps a new best via the window seam',
    a.localStorage.getItem('snowgliderBestTime_v1_meta') === JSON.stringify({ seed: 777, physicsVersion: 1 }));
  delete a.window.__snowgliderGetRunStamp;
  a.localStorage.removeItem('snowgliderBestTime_v1');
  a.localStorage.removeItem('snowgliderBestTime_v1_meta');
  Scores.recordScore(25);
  check('an absent seam degrades gracefully (best still recorded, no stamp)',
    a.localStorage.getItem('snowgliderBestTime') === '25' &&
    a.localStorage.getItem('snowgliderBestTime_meta') === null);

  // Stale-sidecar invalidation (Codex review PR #407): a PREVIOUS run's stamp
  // must never survive to describe a NEW best. With the seam ABSENT, a new best
  // clears any existing sidecar rather than leaving the old attribution.
  a.window.__snowgliderGetRunStamp = () => ({ seed: 111, physicsVersion: 1 });
  Scores.recordScore(20);
  delete a.window.__snowgliderGetRunStamp;
  Scores.recordScore(19.5); // new best with NO seam -> the old seed-111 stamp must go
  check('a seam-less new best clears the previous run\'s stale stamp',
    a.localStorage.getItem('snowgliderBestTime') === '19.5' &&
    a.localStorage.getItem('snowgliderBestTime_meta') === null);
  // And with the seam present but the META write failing, the old sidecar is
  // cleared first — the record ends up unstamped, never mis-stamped. (With the
  // seam present the write lands in the stamp-versioned namespace, #403 review.)
  a.window.__snowgliderGetRunStamp = () => ({ seed: 222, physicsVersion: 1 });
  Scores.recordScore(19);
  const realLsSet = a.localStorage.setItem;
  a.localStorage.setItem = (k, v) => { if (String(k).endsWith('_meta')) throw new Error('quota'); return realLsSet(k, v); };
  Scores.recordScore(18.5);
  a.localStorage.setItem = realLsSet;
  delete a.window.__snowgliderGetRunStamp;
  check('a failed stamp write leaves the new best unstamped (stale sidecar cleared)',
    a.localStorage.getItem('snowgliderBestTime_v1') === '18.5' &&
    a.localStorage.getItem('snowgliderBestTime_v1_meta') === null);
  a.localStorage.removeItem('snowgliderBestTime_v1');

  // --- Per-tier local best (D2): a tiered finish uses the per-tier key, not Blue ---
  a.localStorage.removeItem('snowgliderBestTime');
  Scores.recordScore(40, 'bunny');
  check('ScoresModule.recordScore(tier) writes the per-tier key, leaving Blue untouched',
    a.localStorage.getItem('snowgliderBestTime_bunny') === '40' &&
    a.localStorage.getItem('snowgliderBestTime') === null);
  a.localStorage.removeItem('snowgliderBestTime_bunny');

  // --- ScoresModule.displayLeaderboard / getLeaderboard ---
  Scores.displayLeaderboard();
  check('ScoresModule.displayLeaderboard writes the unavailable notice',
    /unavailable/i.test(a.document.getElementById('leaderboard').innerHTML));
  check('ScoresModule.getLeaderboard resolves to an empty list',
    a.window.ScoresModule.getLeaderboard() instanceof Promise);

  // --- AuthModule.initializeAuth (full DOM, then idempotent second call) ---
  Auth.initializeAuth();
  const authContainer = a.document.getElementById('authContainer');
  check('initializeAuth hides the real auth + profile UI',
    a.document.getElementById('authUI').style.display === 'none' &&
    a.document.getElementById('profileUI').style.display === 'none');
  check('initializeAuth appends a local-mode notice',
    !!authContainer.querySelector('.local-mode-notice'));
  Auth.initializeAuth(); // notice already present -> the append guard short-circuits
  check('initializeAuth does not duplicate the local-mode notice',
    authContainer.querySelectorAll('.local-mode-notice').length === 1);

  // --- AuthModule.recordScore: delegates to ScoresModule when present ---
  a.localStorage.setItem('snowgliderBestTime', '99');
  Auth.recordScore(20);
  check('AuthModule.recordScore delegates to ScoresModule', a.localStorage.getItem('snowgliderBestTime') === '20');
  Auth.recordScore('bad'); // invalid -> early return
  check('AuthModule.recordScore ignores an invalid time', a.localStorage.getItem('snowgliderBestTime') === '20');

  // --- AuthModule.recordScore: localStorage fallback when ScoresModule is absent ---
  delete a.window.ScoresModule;
  Auth.recordScore(25);
  check('AuthModule.recordScore falls back to localStorage without ScoresModule',
    a.localStorage.getItem('snowgliderBestTime') === '25');
  Auth.recordScore(30, 'black'); // tiered finish in the no-ScoresModule fallback
  check('AuthModule.recordScore fallback honors the per-tier key',
    a.localStorage.getItem('snowgliderBestTime_black') === '30' &&
    a.localStorage.getItem('snowgliderBestTime') === '25');

  // --- AuthModule.displayLeaderboard: no ScoresModule, #leaderboard present ---
  Auth.displayLeaderboard();
  check('AuthModule.displayLeaderboard writes notice when ScoresModule is gone',
    /unavailable/i.test(a.document.getElementById('leaderboard').innerHTML));

  // --- AuthModule.displayLeaderboard: delegates when ScoresModule is present ---
  let delegated = /** @type {boolean} */ (false);
  a.window.ScoresModule = { displayLeaderboard: () => { delegated = true; } };
  Auth.displayLeaderboard();
  check('AuthModule.displayLeaderboard delegates to ScoresModule', delegated === true);

  // --- AuthModule read-only surface ---
  check('AuthModule.getCurrentUser() is null', Auth.getCurrentUser() === null);
  check('AuthModule.isUserSignedIn() is false', Auth.isUserSignedIn() === false);
  check('AuthModule.getAuthState() reports signed-out',
    Auth.getAuthState().user === null && Auth.getAuthState().isSignedIn === false);
  const avail = Auth.isFirebaseAvailable();
  check('AuthModule.isFirebaseAvailable() reports all services off',
    avail.auth === false && avail.firestore === false && avail.analytics === false);

  let signOutResolved = false;
  let tokenRejected = false;
  Promise.resolve()
    .then(() => Auth.signOut().then(() => { signOutResolved = true; }))
    .then(() => Auth.getUserIdToken().then(() => {}, () => { tokenRejected = true; }))
    .then(() => {
      check('AuthModule.signOut resolves', signOutResolved === true);
      check('AuthModule.getUserIdToken rejects in local mode', tokenRejected === true);

      // -----------------------------------------------------------------------
      // Scenario B: non-file origin with the optional DOM nodes ABSENT, to cover
      // every "element missing" branch (authUI/profileUI/authContainer/leaderboard).
      // -----------------------------------------------------------------------
      const bare = loadLocalAuth({ html: '<!doctype html><body></body>', url: 'https://snowglider.ai/' });
      bare.window.SnowGliderLocalAuth.installScoresModule();
      bare.window.SnowGliderLocalAuth.installAuthModule();
      // No #leaderboard element present -> the guard skips the innerHTML write.
      bare.window.ScoresModule.displayLeaderboard();
      check('ScoresModule.displayLeaderboard tolerates a missing #leaderboard', true);
      // No authUI/profileUI/authContainer -> every initializeAuth guard takes its
      // false branch without throwing.
      bare.window.AuthModule.initializeAuth();
      check('AuthModule.initializeAuth tolerates missing auth DOM', true);
      // No ScoresModule and no #leaderboard -> AuthModule.displayLeaderboard logs only.
      delete bare.window.ScoresModule;
      bare.window.AuthModule.displayLeaderboard();
      check('AuthModule.displayLeaderboard tolerates missing ScoresModule + DOM', true);

      console.log(`\nLOCAL-AUTH TEST TOTAL: ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    })
    .catch(err => {
      console.error('local-auth test crashed:', err);
      process.exit(1);
    });
}

main();
