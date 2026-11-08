// @ts-check
// start-menu-tests.js
// Headless, c8-instrumented coverage for src/ui/start-menu.ts (the start screen).
//
// start-menu.ts is a side-effect ES module: importing it runs an IIFE that registers
// the menu's DOM handlers and exposes window.SnowGliderStartMenu. Its UI modules
// need no live Firebase/CDN, so we set up jsdom and import the real `.ts`
// under the existing .js->.ts resolve hook — Node type-strips it and c8 instruments it
// with correct source-mapped lines. Run via the `test:start-menu` npm script.
//
// Focus: the deferred-start state machine that two prior bug fixes added —
//   080bb29 "Fix deferred start before game scripts load"
//   6429cfa "Preserve start gesture after deferred load"
// plus the build badge, about panel, and keyboard handlers; and the onboarding
// refresh added in PR #111 — the build-version footer (#buildBadge), the optional
// sign-in hint, the shared four-level leaderboard, and XSS-safe player names.
// Board browsing must never change the selected next run.
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><html><head>
  <meta name="build-id" content="2026-06-18 12:00">
</head><body>
  <div id="startGameContainer">
    <p id="startLoadingStatus"><span id="startLoadingText"></span></p>
    <button id="startSoundButton" aria-pressed="true">Sound on</button>
    <div id="difficultyPicker" role="radiogroup" aria-label="Difficulty tier"></div>
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
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
// start-menu.ts uses bare `instanceof HTMLMetaElement` / `HTMLButtonElement`, which
// resolve to globalThis; expose jsdom's DOM constructors there.
g.HTMLMetaElement = window.HTMLMetaElement;
g.HTMLButtonElement = window.HTMLButtonElement;
// The difficulty picker reads/writes the remembered tier via the bare `localStorage`
// global; expose jsdom's so persistence works under the test.
g.localStorage = window.localStorage;

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
  const { AudioModule } = await import('../src/audio.ts');
  const { setStartupStatus } = await import('../src/boot/startup-status.ts');

  console.log('--- module surface ---');
  check('exposes the SnowGliderStartMenu API',
    !!SM && ['startGame', 'showAbout', 'hideAbout', 'initializeStartMenu', 'startPendingGameIfReady']
      .every(k => typeof SM[k] === 'function'));

  // Wire up the handlers + build badge (DOMContentLoaded would do this in the browser).
  SM.initializeStartMenu();

  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('startGameButton'));
  const startContainer = document.getElementById('startGameContainer');
  const gameCanvas = document.getElementById('gameCanvas');
  const aboutPanel = document.getElementById('aboutGamePanel');
  const startMenu = document.getElementById('startMenu');
  const keyboardHint = document.getElementById('keyboardHint');

  console.log('\n--- silent welcome preferences and real startup status ---');
  const soundButton = document.getElementById('startSoundButton');
  let menuPlayback = 0;
  const originalStartAudio = AudioModule.startAudio;
  AudioModule.startAudio = () => { menuPlayback++; return true; };
  soundButton.click();
  check('welcome sound toggle persists mute and updates its accessible state',
    window.localStorage.getItem('snowgliderMuted') === 'true'
    && soundButton.getAttribute('aria-pressed') === 'false');
  SM.initializeStartMenu();
  SM.initializeStartMenu();
  soundButton.click();
  check('reinitializing the welcome menu does not duplicate sound listeners',
    window.localStorage.getItem('snowgliderMuted') === 'false'
    && soundButton.getAttribute('aria-pressed') === 'true');
  check('changing the welcome sound preference never starts playback', menuPlayback === 0);
  AudioModule.startAudio = originalStartAudio;
  setStartupStatus('warming');
  check('loading copy follows actual startup milestones',
    document.getElementById('startLoadingStatus').dataset.stage === 'warming'
    && /Warming/.test(document.getElementById('startLoadingText').textContent));
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new window.Event('visibilitychange'));
  check('decorative motion pauses while the page is hidden', document.body.classList.contains('onboarding-paused'));
  hidden = false;
  document.dispatchEvent(new window.Event('visibilitychange'));
  check('visible menu can resume its bounded animation', !document.body.classList.contains('onboarding-paused'));
  setStartupStatus('loading');

  console.log('\n--- offline badge (issue #358) ---');
  // The offline badge is mounted into #startGameContainer but stays hidden while the
  // harness reports online (navigator.onLine defaults true) — no visible change to the
  // online start screen.
  const offlineBadge = document.getElementById('offlineBadge');
  check('offline badge is mounted into the start container', !!offlineBadge && offlineBadge.parentElement === startContainer);
  check('offline badge carries the contract copy', !!offlineBadge && offlineBadge.textContent === 'Offline mode — local bests only');
  check('offline badge hidden while online', !!offlineBadge && offlineBadge.style.display === 'none');
  // An `offline` event reveals it; `online` hides it again (connectivity subscription).
  window.dispatchEvent(new window.Event('offline'));
  check('offline event reveals the badge', !!offlineBadge && offlineBadge.style.display === 'block');
  window.dispatchEvent(new window.Event('online'));
  check('online event hides the badge again', !!offlineBadge && offlineBadge.style.display === 'none');
  check('only one offline badge in the DOM', document.querySelectorAll('#offlineBadge').length === 1);

  console.log('\n--- build badge ---');
  // PR #111 moved the badge off the "Start Game" CTA into an unobtrusive footer.
  check('addBuildBadge renders the build id into the #buildBadge footer',
    document.getElementById('buildBadge').textContent === 'build 2026-06-18 12:00');
  check('addBuildBadge no longer injects a pill into the start button',
    !/build-badge/.test(btn.innerHTML));

  console.log('\n--- difficulty picker (●Bunny / ■Blue / ◆Black / ◆◆Expert) ---');
  const picker = document.getElementById('difficultyPicker');
  const options = picker.querySelectorAll('.difficulty-option');
  check('picker builds one option per tier (4)', options.length === 4);
  check('exposes getSelectedDifficulty', typeof SM.getSelectedDifficulty === 'function');
  check('default selection is blue (the classic game)',
    SM.getSelectedDifficulty() === 'blue');
  const blueOpt = picker.querySelector('[data-difficulty="blue"]');
  check('default blue option is marked selected + aria-checked',
    blueOpt.classList.contains('selected') && blueOpt.getAttribute('aria-checked') === 'true');
  check('options render the config labels (◆ Black present)',
    /◆ Black/.test(picker.textContent));

  const blackOpt = picker.querySelector('[data-difficulty="black"]');
  blackOpt.dispatchEvent(new window.Event('click'));
  check('clicking Black updates the live selection', SM.getSelectedDifficulty() === 'black');
  check('clicking Black persists to localStorage',
    window.localStorage.getItem('snowgliderDifficulty') === 'black');
  check('clicking Black moves the selected highlight (blue deselected)',
    blackOpt.classList.contains('selected') && !blueOpt.classList.contains('selected'));

  // Roving-tabindex arrow keys: only the selected option is tabbable, and arrows
  // move + select the prev/next tier so keyboard-only players can reach all four.
  window.localStorage.setItem('snowgliderDifficulty', 'blue');
  SM.buildDifficultyPicker();
  const tabbable = Array.from(picker.querySelectorAll('.difficulty-option'))
    .filter((el) => el.getAttribute('tabindex') === '0');
  check('only the selected option is tabbable (roving tabindex)',
    tabbable.length === 1 && tabbable[0].getAttribute('data-difficulty') === 'blue');
  picker.querySelector('[data-difficulty="blue"]')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  check('ArrowDown moves selection to the next tier (blue -> black)',
    SM.getSelectedDifficulty() === 'black'
    && picker.querySelector('[data-difficulty="black"]').getAttribute('tabindex') === '0');
  picker.querySelector('[data-difficulty="black"]')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  check('ArrowUp moves selection back (black -> blue)',
    SM.getSelectedDifficulty() === 'blue');

  // Rebuilding the picker pre-selects the remembered tier.
  window.localStorage.setItem('snowgliderDifficulty', 'black');
  SM.buildDifficultyPicker();
  check('rebuilt picker pre-selects the remembered tier (black)',
    SM.getSelectedDifficulty() === 'black'
    && document.querySelector('[data-difficulty="black"]').classList.contains('selected'));
  // Reset to blue so the rest of the suite runs from the default.
  window.localStorage.setItem('snowgliderDifficulty', 'blue');
  SM.buildDifficultyPicker();

  console.log('\n--- deferred start before game scripts load (080bb29) ---');
  delete window.initializeGameWithAudio; // game scripts not ready yet
  const { Sfx } = await import('../src/sfx.ts');
  const originalPlay = AudioModule.playPreloadedAudio;
  const originalUnlock = Sfx.unlock;
  const audioCalls = [];
  AudioModule.playPreloadedAudio = () => { audioCalls.push('music'); return true; };
  Sfx.unlock = () => { audioCalls.push('sfx'); };
  btn.dispatchEvent(new window.Event('click'));
  check('early Start unlocks music and SFX synchronously in the original click',
    audioCalls.join(',') === 'music,sfx' && typeof window.initializeGameWithAudio !== 'function');
  AudioModule.playPreloadedAudio = originalPlay;
  Sfx.unlock = originalUnlock;
  const deferred = SM.startGame();
  check('startGame defers (returns false) when game scripts are not ready',
    deferred === false);
  check('deferred start marks the button waiting (disabled + aria-busy)',
    btn.disabled === true && btn.getAttribute('aria-busy') === 'true');
  check('deferred start does NOT hide the start container',
    startContainer.style.display !== 'none');

  console.log('\n--- game scripts arrive: honor the queued start ---');
  window.initializeGameWithAudio = () => { launches++; };
  setStartupStatus('warming');
  check('an available initializer cannot bypass unfinished scene warmup',
    SM.startPendingGameIfReady() === false && launches === 0);
  setStartupStatus('ready');
  window.dispatchEvent(new window.Event('snowglider:game-scripts-ready'));
  check('game-scripts-ready clears the pending wait and re-enables the button',
    btn.disabled === false && !btn.hasAttribute('aria-busy'));
  check('game-scripts-ready completes the queued start without a second click',
    launches === 1 && startContainer.style.display === 'none');
  startContainer.style.display = 'flex';

  console.log('\n--- successful start when ready ---');
  launches = 0;
  const started = SM.startGame();
  check('startGame starts (returns true) when ready', started === true);
  check('successful start hides the container and shows the canvas',
    startContainer.style.display === 'none' && gameCanvas.style.display === 'block');
  check('successful start invokes initializeGameWithAudio once', launches === 1);
  SM.startGame();
  check('repeated start after the menu closes cannot launch twice', launches === 1);

  console.log('\n--- about panel show/hide ---');
  SM.showAbout();
  check('showAbout shows the about panel and hides the menu/hint',
    aboutPanel.style.display === 'block' &&
    startMenu.style.display === 'none' &&
    keyboardHint.style.display === 'none');
  check('showAbout also hides the difficulty picker', picker.style.display === 'none');
  SM.hideAbout();
  check('hideAbout restores the menu and hides the about panel',
    aboutPanel.style.display === 'none' && startMenu.style.display === '');
  check('hideAbout restores the difficulty picker', picker.style.display === '');

  console.log('\n--- keyboard: Enter starts when the start screen is visible ---');
  startContainer.style.display = 'flex'; // start screen visible again
  aboutPanel.style.display = 'none';
  launches = 0;
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  check('Enter starts the game when the start screen is visible', launches === 1);

  // Enter/Space focused on a difficulty option must NOT start the run (it should
  // only select the tier) — the global shortcut excludes picker controls.
  launches = 0;
  document.querySelector('[data-difficulty="black"]')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('Enter on a focused difficulty option does NOT start the run', launches === 0);

  // Enter on the PWA install chip must NOT also start the run (Codex #360): a keyboard
  // user pressing Enter on Install would otherwise both install AND launch the game.
  launches = 0;
  const installChip = document.createElement('div');
  installChip.id = 'installPrompt';
  const installBtn2 = document.createElement('button');
  installChip.appendChild(installBtn2);
  startContainer.appendChild(installChip);
  installBtn2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('Enter on the install chip does NOT start the run', launches === 0);
  startContainer.removeChild(installChip);

  console.log('\n--- keyboard: Escape closes the about panel ---');
  SM.showAbout();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Escape closes the about panel (via closeAboutButton)',
    aboutPanel.style.display === 'none');

  console.log('\n--- start button click runs the audio-unlock + start flow ---');
  startContainer.style.display = 'flex';
  aboutPanel.style.display = 'none';
  launches = 0;
  SM.initializeStartMenu();
  SM.initializeStartMenu();
  btn.dispatchEvent(new window.Event('click'));
  check('start is synchronous within the click gesture after repeated menu initialization', launches === 1);
  await flush();
  await flush();
  check('clicking Start runs the start flow (after async audio unlock)',
    launches === 1 && startContainer.style.display === 'none');

  console.log('\n--- onboarding: sign-in and the shared four-level leaderboard ---');
  const refresh = SM.refreshStartAccountUI;
  const lb = document.getElementById('startLeaderboard');
  const hint = document.getElementById('startSignInHint');
  check('exposes refreshStartAccountUI', typeof refresh === 'function');

  function setAccount({ firebase, authState, getLeaderboard = undefined, getLeaderboardResult = undefined }) {
    window.AuthModule = {
      isFirebaseAvailable: () => firebase,
      getAuthState: () => authState
    };
    window.ScoresModule = { getLeaderboard, getLeaderboardResult };
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
  const boardText = () => lb.querySelector('.leaderboard-body')?.textContent || '';

  // Signed-out players can inspect the four levels and their device best, but
  // cannot issue Firestore reads or see a misleading empty leaderboard.
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
  check('signed out: all four leaderboard levels remain available with a sign-in explanation',
    lb.style.display === 'block' && lb.querySelectorAll('[data-leaderboard-tier]').length === 4
    && /sign in/i.test(boardText()) && !lb.querySelector('table'));
  check('signed out: getLeaderboard is NOT called (Firestore rules deny it)', leaderboardReads === 0);

  // Connectivity changes update the existing panel without pretending the
  // leaderboard is empty or reading it while offline, even for a signed-in user.
  let online = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  online = false;
  window.dispatchEvent(new window.Event('offline'));
  await settle();
  check('going offline hides the online sign-in hint', hint.style.display === 'none');
  check('going offline preserves the board with an explicit offline state',
    lb.style.display === 'block' && /offline/i.test(boardText()) && leaderboardReads === 0);
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me' }, isSignedIn: true },
    getLeaderboard: () => { leaderboardReads++; return []; }
  });
  refresh();
  await settle();
  check('signed-in offline players also skip leaderboard reads',
    leaderboardReads === 0 && /offline/i.test(boardText()));
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: null, isSignedIn: false },
    getLeaderboard: () => []
  });
  online = true;
  window.dispatchEvent(new window.Event('online'));
  await settle();
  check('back online restores the sign-in hint and signed-out status',
    hint.style.display === 'block' && /sign in/i.test(boardText()));

  // Authentication may be available before Firestore. Sign-in is still useful,
  // but an unavailable read must be distinct from a confirmed empty board.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: false },
    authState: { user: null, isSignedIn: false },
    getLeaderboardResult: async () => ({ status: 'unavailable', scores: [] })
  });
  refresh();
  await settle();
  check('available authentication remains discoverable before Firestore is ready',
    hint.style.display === 'block' && /sign in/i.test(boardText()));
  setAccount({
    firebase: { auth: true, firestore: false },
    authState: { user: { uid: 'u1' }, isSignedIn: true },
    getLeaderboardResult: async () => ({ status: 'unavailable', scores: [] })
  });
  refresh();
  await settle();
  check('unavailable leaderboard shows Retry without claiming there are no times',
    lb.style.display === 'block' && /couldn.t load/i.test(boardText())
    && /retry/i.test(lb.querySelector('.leaderboard-action')?.textContent || '')
    && !/no .*times yet/i.test(boardText()));

  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'u1', displayName: 'Ada' }, isSignedIn: true },
    getLeaderboardResult: async () => ({ status: 'ready', scores: [] })
  });
  refresh();
  await settle();
  check('signed in: sign-in hint hidden', hint.style.display === 'none');
  check('a confirmed empty board stays visible with the selected level in its empty state',
    lb.style.display === 'block' && /no .*Blue times yet/i.test(boardText()) && !lb.querySelector('table'));

  // Start and result screens share the same top-ten limit and formatting.
  resetAccountDom();
  const many = Array.from({ length: 12 }, (_, i) => ({ userId: 'p' + i, time: 20 + i }));
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Me' }, isSignedIn: true },
    getLeaderboard: () => many
  });
  refresh();
  await settle();
  check('populated leaderboard is shown', lb.style.display === 'block');
  check('leaderboard renders at most ten rows plus a header', lb.querySelectorAll('table tr').length === 11);
  check('leaderboard formats times to two decimals', lb.textContent.includes('20.00s'));

  // All four tiers are ranked. Browsing another board must never change the
  // difficulty picker, persisted choice, or launch a game.
  resetAccountDom();
  window.localStorage.setItem('snowgliderDifficulty', 'bunny');
  SM.buildDifficultyPicker();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: null, isSignedIn: false },
    getLeaderboard: () => []
  });
  refresh();
  await settle();
  check('Bunny players have the same sign-in/save path as Blue players',
    hint.style.display === 'block' && /sign in/i.test(boardText()));
  const viewedTiers = [];
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me' }, isSignedIn: true },
    getLeaderboard: tier => { viewedTiers.push(tier); return many; }
  });
  refresh();
  await settle();
  const launchesBeforeBrowsing = launches;
  for (const tier of ['bunny', 'blue', 'black', 'expert']) {
    /** @type {HTMLButtonElement} */ (lb.querySelector(`[data-leaderboard-tier="${tier}"]`)).click();
    await settle();
    check(`${tier} leaderboard fetches and marks its own selected tab`,
      viewedTiers.at(-1) === tier && !!lb.querySelector('table')
      && lb.querySelector(`[data-leaderboard-tier="${tier}"]`).getAttribute('aria-pressed') === 'true');
  }
  check('browsing all leaderboards leaves the next run and saved preference unchanged',
    SM.getSelectedDifficulty() === 'bunny' && window.localStorage.getItem('snowgliderDifficulty') === 'bunny'
    && launches === launchesBeforeBrowsing);
  window.dispatchEvent(new window.Event('snowglider:account-bests-changed'));
  await settle();
  check('restored account bests preserve the board being browsed',
    viewedTiers.at(-1) === 'expert'
    && lb.querySelector('[data-leaderboard-tier="expert"]').getAttribute('aria-pressed') === 'true');
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await settle();
  check('auth refresh preserves the viewed tier independently of the next run',
    viewedTiers.at(-1) === 'expert' && SM.getSelectedDifficulty() === 'bunny');
  window.localStorage.setItem('snowgliderDifficulty', 'blue');
  SM.buildDifficultyPicker();

  // Own rows prefer the active profile name and retain an explicit identity marker.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Ada Lovelace' }, isSignedIn: true },
    getLeaderboard: () => [
      { userId: 'other', time: 20.3 },
      { userId: 'me', time: 21.5, displayName: 'Older public name' }
    ]
  });
  refresh();
  await settle();
  check('current user row gets the current-user-score class', !!lb.querySelector('tr.current-user-score'));
  check('own row displays the current profile name and the you marker',
    lb.querySelector('tr.current-user-score').textContent.includes('Ada Lovelace (you)'));

  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: null }, isSignedIn: true },
    getLeaderboard: () => [
      { userId: 'rival', time: 20.1, displayName: 'Rival' },
      { userId: 'legacy', time: 21.2 },
      { userId: 'me', time: 22.3 }
    ]
  });
  refresh();
  await settle();
  check('other players render their denormalized display name', lb.textContent.includes('Rival'));
  check('unnamed opponents use Skier instead of invented identities',
    lb.textContent.includes('Skier') && !lb.textContent.includes('Player 2'));
  check('an unnamed own row still identifies the signed-in player',
    lb.querySelector('tr.current-user-score').textContent.includes('You (you)'));

  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: null }, isSignedIn: true },
    getLeaderboard: () => [{ userId: 'me', time: 23, displayName: 'Saved public name' }]
  });
  refresh();
  await settle();
  check('own row falls back to its denormalized name when the profile has no name',
    lb.querySelector('tr.current-user-score').textContent.includes('Saved public name (you)'));

  // Both own and other players' score names remain text, never live HTML.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: '<img src=z onerror=alert(3)>' }, isSignedIn: true },
    getLeaderboard: () => [
      { userId: 'me', time: 20.9, displayName: '<img src=x onerror=alert(1)>' },
      { userId: 'evil', time: 21.1, displayName: '<img src=y onerror=alert(2)>' }
    ]
  });
  refresh();
  await settle();
  check('own malicious profile name is escaped with no live image',
    lb.querySelector('img') === null && lb.textContent.includes('<img src=z onerror=alert(3)> (you)'));
  check('another player\'s malicious denormalized name is also text',
    lb.textContent.includes('<img src=y onerror=alert(2)>') && lb.innerHTML.includes('&lt;img src=y'));

  // Read failures preserve the view with a working retry and no stale rows.
  resetAccountDom();
  let attempts = 0;
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me' }, isSignedIn: true },
    getLeaderboard: () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('network unavailable')) : [{ userId: 'me', time: 24 }];
    }
  });
  refresh();
  await settle();
  check('read rejection shows a retry instead of hiding the board or showing empty rows',
    lb.style.display === 'block' && /couldn.t load/i.test(boardText()) && !lb.querySelector('table'));
  /** @type {HTMLButtonElement} */ (lb.querySelector('.leaderboard-action')).click();
  await settle();
  check('Retry reads again and replaces the error with fresh times',
    attempts === 2 && boardText().includes('24.00s'));

  resetAccountDom();
  window.AuthModule = {
    isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: false }),
    getAuthState: () => ({ user: /** @type {any} */ ({ uid: 'me' }), isSignedIn: true })
  };
  window.ScoresModule = {};
  refresh();
  await settle();
  check('missing leaderboard reader leaves a visible unavailable state and Retry',
    lb.style.display === 'block' && /unavailable/i.test(boardText())
    && !!lb.querySelector('.leaderboard-action') && !lb.querySelector('table'));

  // An already-started read cannot repopulate private rows after logout.
  resetAccountDom();
  /** @type {(rows: any) => void} */ let resolveSlow;
  const slow = new Promise(res => { resolveSlow = res; });
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me' }, isSignedIn: true },
    getLeaderboard: () => slow
  });
  refresh();
  await settle();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: null, isSignedIn: false },
    getLeaderboard: () => []
  });
  refresh();
  await settle();
  check('logout replaces the in-flight view with sign-in status',
    /sign in/i.test(boardText()) && !lb.querySelector('table'));
  resolveSlow([{ userId: 'me', time: 25, displayName: 'Stale private result' }]);
  await settle();
  check('stale signed-in completion cannot overwrite the logged-out view',
    /sign in/i.test(boardText()) && !lb.querySelector('table') && !lb.textContent.includes('Stale private result'));

  // The auth event alone must refresh the account UI without a reload.
  resetAccountDom();
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'me', displayName: 'Signed In' }, isSignedIn: true },
    getLeaderboard: () => [{ userId: 'me', time: 27.25 }]
  });
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await settle();
  check('auth-changed refreshes the leaderboard without a manual call',
    lb.style.display === 'block' && lb.textContent.includes('27.25s'));

  // Anonymous Firebase accounts cannot read registered-player leaderboards.
  leaderboardReads = 0;
  setAccount({
    firebase: { auth: true, firestore: true },
    authState: { user: { uid: 'guest', isAnonymous: true }, isSignedIn: true },
    getLeaderboard: () => { leaderboardReads++; return []; }
  });
  window.dispatchEvent(new window.Event('snowglider:auth-changed'));
  await settle();
  check('anonymous auth shows sign-in status and never reads registered-player scores',
    leaderboardReads === 0 && /sign in/i.test(boardText()) && !lb.querySelector('table'));

  resetAccountDom();
  window.AuthModule = undefined;
  window.ScoresModule = undefined;
  refresh();
  await settle();
  check('no auth/scores modules: online sign-in hint is hidden', hint.style.display === 'none');
  check('no backend modules: local board remains visible without fabricated remote times',
    lb.style.display === 'block' && /sign in/i.test(boardText()) && !lb.querySelector('table'));

  // Re-initializing the menu must tear down the prior connectivity watcher (rather
  // than stack a second one) and must not duplicate the offline badge. After a
  // re-init, a single `offline` event should still flip the badge exactly once.
  console.log('\n--- offline badge re-init/teardown (issue #358) ---');
  const badgeBefore = document.getElementById('offlineBadge');
  if (badgeBefore) badgeBefore.style.display = 'none';
  SM.initializeStartMenu();
  check('re-init does not duplicate the offline badge', document.querySelectorAll('#offlineBadge').length === 1);
  const badgeAfter = document.getElementById('offlineBadge');
  window.dispatchEvent(new window.Event('offline'));
  check('after re-init the badge still reveals on offline', !!badgeAfter && badgeAfter.style.display === 'block');
  window.dispatchEvent(new window.Event('online'));
  check('after re-init the badge still hides on online', !!badgeAfter && badgeAfter.style.display === 'none');

  console.log('\n--- startup failure recovery ---');
  startContainer.style.display = 'flex';
  setStartupStatus('error', new Error('Error creating WebGL context.'));
  check('background failure preserves the welcome screen without a modal',
    document.getElementById('fatalErrorOverlay') === null
    && startContainer.style.display !== 'none'
    && btn.textContent === 'Loading help');
  const launchesBeforeFailure = launches;
  check('failed startup exposes recovery without starting a run', SM.startGame() === false && launches === launchesBeforeFailure);
  check('explicit start after failure provides a reload action', !!document.getElementById('fatalErrorReloadBtn'));
  const { resetFatalErrorOverlay } = await import('../src/ui/fatal-error-overlay.ts');
  resetFatalErrorOverlay();
  setStartupStatus('loading');
  delete window.initializeGameWithAudio;
  SM.startGame();
  let stoppedMusic = false;
  let stoppedEffects = false;
  const originalEnableSound = AudioModule.enableSound;
  const originalSfxTeardown = Sfx.teardown;
  AudioModule.enableSound = (enable) => { stoppedMusic = !enable; };
  Sfx.teardown = () => { stoppedEffects = true; };
  setStartupStatus('error', new Error('Failed to fetch game module'));
  check('failure after an early Play clears pending wait and shows recovery',
    !btn.disabled && !btn.hasAttribute('aria-busy') && !!document.getElementById('fatalErrorReloadBtn'));
  check('failed early Play stops both music and the procedural wind bed', stoppedMusic && stoppedEffects);
  AudioModule.enableSound = originalEnableSound;
  Sfx.teardown = originalSfxTeardown;
  resetFatalErrorOverlay();

  console.log(`\nSTART MENU TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
