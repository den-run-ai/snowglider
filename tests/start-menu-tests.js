// start-menu-tests.js
// Headless, c8-instrumented coverage for src/ui/start-menu.ts (the start screen).
//
// start-menu.ts is a side-effect ES module: importing it runs an IIFE that registers
// the menu's DOM handlers and exposes window.SnowGliderStartMenu. It imports only
// `../audio.js` (no Firebase/CDN), so we just set up jsdom and `import` the real `.ts`
// under the existing .js->.ts resolve hook — Node type-strips it and c8 instruments it
// with correct source-mapped lines. Run via the `test:start-menu` npm script.
//
// Focus: the deferred-start state machine that two prior bug fixes added —
//   080bb29 "Fix deferred start before game scripts load"
//   6429cfa "Preserve start gesture after deferred load"
// plus the build badge, about panel, and keyboard handlers; and the onboarding
// refresh added in PR #111 — the build-version footer (#buildBadge), the optional
// sign-in hint, the Global Top Times preview, and the XSS-safe name escaping
// (refreshStartAccountUI + escapeHtml).
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><html><head>
  <meta name="build-id" content="2026-06-18 12:00">
</head><body>
  <div id="startGameContainer">
    <div id="startMenu">
      <button id="startGameButton">Start Game</button>
      <button id="aboutGameButton">About</button>
    </div>
    <div id="controlsGuide"></div>
    <div id="startLeaderboard" style="display:none"></div>
    <p id="startSignInHint" style="display:none"></p>
    <div id="keyboardHint"></div>
    <div id="aboutGamePanel" style="display:none">
      <button id="closeAboutButton">Close</button>
    </div>
    <div id="buildBadge"></div>
  </div>
  <canvas id="gameCanvas" style="display:none"></canvas>
</body></html>`, { url: 'https://snowglider.ai/' });

const { window } = dom;
global.window = window;
global.document = window.document;
// start-menu.ts uses bare `instanceof HTMLMetaElement` / `HTMLButtonElement`, which
// resolve to globalThis; expose jsdom's DOM constructors there.
global.HTMLMetaElement = window.HTMLMetaElement;
global.HTMLButtonElement = window.HTMLButtonElement;

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) {
    pass++;
  } else {
    fail++;
  }
}
const flush = () => new Promise(r => setTimeout(r, 0));

// Count game launches; start-menu calls window.initializeGameWithAudio() when ready.
let launches = 0;

async function main() {
  // Importing the module runs the IIFE, which exposes window.SnowGliderStartMenu and
  // registers the DOMContentLoaded + game-scripts-ready listeners.
  await import('../src/ui/start-menu.ts');
  const SM = window.SnowGliderStartMenu;

  console.log('--- module surface ---');
  check('exposes the SnowGliderStartMenu API',
    !!SM && ['startGame', 'showAbout', 'hideAbout', 'initializeStartMenu', 'startPendingGameIfReady']
      .every(k => typeof SM[k] === 'function'));

  // Wire up the handlers + build badge (DOMContentLoaded would do this in the browser).
  SM.initializeStartMenu();

  const btn = document.getElementById('startGameButton');
  const startContainer = document.getElementById('startGameContainer');
  const gameCanvas = document.getElementById('gameCanvas');
  const aboutPanel = document.getElementById('aboutGamePanel');
  const startMenu = document.getElementById('startMenu');
  const keyboardHint = document.getElementById('keyboardHint');

  console.log('\n--- build badge ---');
  // PR #111 moved the badge off the "Start Game" CTA into an unobtrusive footer.
  check('addBuildBadge renders the build id into the #buildBadge footer',
    document.getElementById('buildBadge').textContent === 'build 2026-06-18 12:00');
  check('addBuildBadge no longer injects a pill into the start button',
    !/build-badge/.test(btn.innerHTML));

  console.log('\n--- deferred start before game scripts load (080bb29) ---');
  delete window.initializeGameWithAudio; // game scripts not ready yet
  const deferred = SM.startGame();
  check('startGame defers (returns false) when game scripts are not ready',
    deferred === false);
  check('deferred start marks the button waiting (disabled + aria-busy)',
    btn.disabled === true && btn.getAttribute('aria-busy') === 'true');
  check('deferred start does NOT hide the start container',
    startContainer.style.display !== 'none');

  console.log('\n--- game scripts arrive: preserve start gesture (6429cfa) ---');
  window.initializeGameWithAudio = () => { launches++; };
  window.dispatchEvent(new window.Event('snowglider:game-scripts-ready'));
  check('game-scripts-ready clears the pending wait and re-enables the button',
    btn.disabled === false && !btn.hasAttribute('aria-busy'));
  check('game-scripts-ready does NOT auto-start; it waits for a fresh gesture',
    launches === 0 && startContainer.style.display !== 'none');

  console.log('\n--- successful start when ready ---');
  launches = 0;
  const started = SM.startGame();
  check('startGame starts (returns true) when ready', started === true);
  check('successful start hides the container and shows the canvas',
    startContainer.style.display === 'none' && gameCanvas.style.display === 'block');
  check('successful start invokes initializeGameWithAudio once', launches === 1);

  console.log('\n--- about panel show/hide ---');
  SM.showAbout();
  check('showAbout shows the about panel and hides the menu/hint',
    aboutPanel.style.display === 'block' &&
    startMenu.style.display === 'none' &&
    keyboardHint.style.display === 'none');
  SM.hideAbout();
  check('hideAbout restores the menu and hides the about panel',
    aboutPanel.style.display === 'none' && startMenu.style.display === 'flex');

  console.log('\n--- keyboard: Enter starts when the start screen is visible ---');
  startContainer.style.display = 'flex'; // start screen visible again
  aboutPanel.style.display = 'none';
  launches = 0;
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  check('Enter starts the game when the start screen is visible', launches === 1);

  console.log('\n--- keyboard: Escape closes the about panel ---');
  SM.showAbout();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Escape closes the about panel (via closeAboutButton)',
    aboutPanel.style.display === 'none');

  console.log('\n--- start button click runs the audio-unlock + start flow ---');
  startContainer.style.display = 'flex';
  aboutPanel.style.display = 'none';
  launches = 0;
  btn.dispatchEvent(new window.Event('click'));
  await flush();
  await flush();
  check('clicking Start runs the start flow (after async audio unlock)',
    launches === 1 && startContainer.style.display === 'none');

  console.log('\n--- onboarding: optional sign-in hint + Global Top Times (refreshStartAccountUI) ---');
  const refresh = SM.refreshStartAccountUI;
  const lb = document.getElementById('startLeaderboard');
  const hint = document.getElementById('startSignInHint');
  check('exposes refreshStartAccountUI', typeof refresh === 'function');

  function setAccount({ firebase, authState, getLeaderboard }) {
    window.AuthModule = {
      isFirebaseAvailable: () => firebase,
      getAuthState: () => authState
    };
    window.ScoresModule = getLeaderboard ? { getLeaderboard } : {};
  }
  function resetAccountDom() {
    lb.style.display = 'none';
    lb.innerHTML = '';
    hint.style.display = 'none';
    hint.innerHTML = '';
  }
  async function settle() {
    await flush();
    await flush();
    await flush();
  }

  // Signed out (real auth present): show the hint, hide the leaderboard. The
  // Firestore rules deny leaderboard reads for signed-out users, so we must not
  // even attempt the read — no false "No times yet", no permission error.
  resetAccountDom();
  let leaderboardReads = 0;
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: null, isSignedIn: false },
    getLeaderboard: () => { leaderboardReads++; return []; }
  });
  refresh();
  await settle();
  check('signed out: sign-in hint shown', hint.style.display === 'block');
  check('signed out: leaderboard hidden', lb.style.display === 'none');
  check('signed out: getLeaderboard is NOT called (Firestore rules deny it)',
    leaderboardReads === 0);

  // Signed in, empty leaderboard -> preview hidden (an empty [] is indistinguishable
  // from a swallowed read error, so we never claim "No times yet"), hint hidden.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'u1', displayName: 'Ada' }, isSignedIn: true },
    getLeaderboard: () => []
  });
  refresh();
  await settle();
  check('signed in: sign-in hint hidden', hint.style.display === 'none');
  check('signed in + empty/unavailable leaderboard: preview hidden (no false empty state)',
    lb.style.display === 'none');

  // Signed in, populated leaderboard -> top-5 table with 2-decimal times.
  resetAccountDom();
  const many = Array.from({ length: 7 }, (_, i) => ({ userId: 'p' + i, time: 10 + i }));
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Me' }, isSignedIn: true },
    getLeaderboard: () => many
  });
  refresh();
  await settle();
  check('populated leaderboard is shown', lb.style.display === 'block');
  check('leaderboard renders at most the top 5 rows (+1 header)',
    lb.querySelectorAll('table tr').length === 6);
  check('leaderboard formats times to 2 decimals', lb.innerHTML.includes('10.00s'));

  // Current user is highlighted and shown by display name.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Ada Lovelace' }, isSignedIn: true },
    getLeaderboard: () => [{ userId: 'other', time: 12.3 }, { userId: 'me', time: 13.5 }]
  });
  refresh();
  await settle();
  check('current user row gets the current-user-score class',
    !!lb.querySelector('tr.current-user-score'));
  check('current user shown by display name', lb.innerHTML.includes('Ada Lovelace'));

  // XSS: a malicious display name is HTML-escaped (escapeHtml), not injected live.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: '<img src=x onerror=alert(1)>' }, isSignedIn: true },
    getLeaderboard: () => [{ userId: 'me', time: 9.9 }]
  });
  refresh();
  await settle();
  check('malicious display name is escaped (no live <img> injected)',
    lb.querySelector('img') === null && lb.innerHTML.includes('&lt;img'));

  // getLeaderboard rejection is swallowed and hides the board.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Me' }, isSignedIn: true },
    getLeaderboard: () => Promise.reject(new Error('offline'))
  });
  lb.style.display = 'block';
  refresh();
  await settle();
  check('getLeaderboard rejection hides the leaderboard', lb.style.display === 'none');

  // ScoresModule present but without getLeaderboard (defensive) -> board hidden.
  resetAccountDom();
  window.AuthModule = {
    isFirebaseAvailable: () => ({ auth: true, firestore: true }),
    getAuthState: () => ({ user: { uid: 'me' }, isSignedIn: true })
  };
  window.ScoresModule = {};
  lb.style.display = 'block';
  refresh();
  await settle();
  check('ScoresModule without getLeaderboard hides the leaderboard',
    lb.style.display === 'none');

  // Stale-read guard: a signed-in getLeaderboard() still in flight when the player
  // logs out must NOT re-show the board after the logout refresh has hidden it.
  resetAccountDom();
  let resolveSlow;
  const slow = new Promise((res) => { resolveSlow = res; });
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Me' }, isSignedIn: true },
    getLeaderboard: () => slow
  });
  refresh(); // signed-in read starts, in flight (unresolved)
  // Player logs out before it resolves; the newer refresh hides the board.
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: null, isSignedIn: false },
    getLeaderboard: () => []
  });
  refresh();
  await settle();
  check('logout hides the board while the prior signed-in read is still in flight',
    lb.style.display === 'none');
  resolveSlow([{ userId: 'me', time: 5.0 }]); // the stale signed-in read finally resolves
  await settle();
  check('stale in-flight leaderboard read is discarded after logout (board stays hidden)',
    lb.style.display === 'none');

  // The start menu re-renders when auth.ts broadcasts snowglider:auth-changed
  // (login/logout), so signing in from the start screen isn't stale until reload.
  // Here we change account state but do NOT call refresh() directly — the wired
  // listener must do it in response to the event.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Signed In' }, isSignedIn: true },
    getLeaderboard: () => [{ userId: 'me', time: 7.25 }]
  });
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await settle();
  check('snowglider:auth-changed re-renders the account UI without a manual refresh',
    lb.style.display === 'block' && lb.innerHTML.includes('7.25s'));

  // No AuthModule/ScoresModule at all (file:// / offline) -> everything hidden.
  resetAccountDom();
  window.AuthModule = undefined;
  window.ScoresModule = undefined;
  refresh();
  await settle();
  check('no auth/scores modules: sign-in hint hidden', hint.style.display === 'none');
  check('no auth/scores modules: leaderboard hidden', lb.style.display === 'none');

  console.log(`\nSTART MENU TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
