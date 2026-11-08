// @ts-check
// auth-tests.js
// Headless, c8-instrumented coverage for src/auth.ts (popup-only Google sign-in).
//
// auth.ts imports the Firebase SDK from gstatic CDN URLs, which Node can't resolve.
// The resolve hook in tests/loaders/register-firebase-mock.mjs redirects those CDN
// imports to the in-memory mock (tests/mocks/firebase.mjs), so we `import` the real
// `.ts` under jsdom and c8 instruments it with correct source-mapped lines. The mock
// captures the onAuthStateChanged listener and lets us drive sign-in/out and every
// signInWithPopup error branch deterministically — no network, no real Google popup.
// auth.ts's `import ScoresModule from "./scores.js"` resolves to the real
// src/scores.ts (via the .js->.ts hook), which is backed by the same Firebase mock.
// Run via the `test:auth` npm script, which wires in that loader.
const { JSDOM } = require('jsdom');

// ---- jsdom environment with the auth UI markup auth.js expects ----
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="authContainer"><div id="authUI" style="display:flex">
    <button id="loginBtn" disabled aria-busy="true">Sign in with Google</button>
    <button id="githubLoginBtn">Sign in with GitHub</button>
    <!-- appleLoginBtn is icon-style (svg + .provider-label) to exercise the
         label-span branch of setButtonLabel/resetAuthButtons. -->
    <button id="appleLoginBtn"><svg class="provider-icon"></svg><span class="provider-label">Apple</span></button>
    <button id="guestLoginBtn">Play as Guest</button>
  </div>
  <div id="profileUI" style="display:none">
    <button id="profileChip"><span id="profileAvatar" class="avatar"></span><span id="profileName"></span></button>
    <button id="logoutBtn">Logout</button>
  </div>
</div></body></html>`, { url: 'https://snowglider.ai/' });
const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
// auth.ts dispatches `new CustomEvent('snowglider:auth-changed')` on window. Bind
// jsdom's CustomEvent on globalThis so the bare constructor builds an event from the
// SAME realm as window — otherwise Node's built-in CustomEvent is rejected by
// jsdom's window.dispatchEvent ("parameter 1 is not of type 'Event'").
g.CustomEvent = window.CustomEvent;
g.localStorage = (function () {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; }
  };
})();
g.window.localStorage = g.localStorage;

// Capture alert() calls instead of popping a dialog.
const alerts = [];
window.alert = (msg) => { alerts.push(String(msg)); };
g.alert = window.alert;

// ---- Load the REAL src/auth.ts with the Firebase SDK mocked via the resolve hook ----
// Bound from the shared Firebase mock once imported. The auth control surface (the
// captured onAuthStateChanged listener and the next popup result) is driven through
// fb.getAuthStateCallback()/emitAuthState()/setNextPopupResult().
let calls;
async function loadAuthModule() {
  const fb = await import('./mocks/firebase.mjs');
  calls = fb.calls;
  // Importing the real module (rather than eval'ing it) is what makes it c8-visible;
  // its CDN Firebase imports resolve to `fb`, and `./scores.js` resolves to the real
  // src/scores.ts (also backed by `fb`).
  const authModule = await import('../src/auth.ts');
  return { AuthModule: authModule.default, fb };
}

const config = {
  apiKey: 'k', authDomain: 'sn0wglider.firebaseapp.com', projectId: 'sn0wglider',
  storageBucket: 'sn0wglider.firebasestorage.app', appId: '1', measurementId: 'G-X'
};

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const flush = () => new Promise(r => setTimeout(r, 0)); // let queued promise callbacks run

// Versioned competitive best-time key builders (#403 review), bound in main().
// LB/LB_BUNNY and F_BUNNY are the ACTIVE (version-namespaced) remote board
// collections / users-doc field the sync paths write, resolved from the seams so
// a PHYSICS_VERSION bump keeps these assertions on the live schema.
let BTK, BTMK, LB, LB_BUNNY, F_BUNNY;
async function main() {
  const Difficulty = await import('../src/difficulty.ts');
  ({ localBestTimeKey: BTK, localBestMetaKey: BTMK } = Difficulty);
  LB = Difficulty.leaderboardCollectionName('blue');
  LB_BUNNY = Difficulty.leaderboardCollectionName('bunny');
  F_BUNNY = Difficulty.userBestTimeField('bunny');

  console.log('--- AuthModule load & init ---');
  const { AuthModule, fb } = await loadAuthModule();
  check('module exposes the expected public surface',
    !!AuthModule && ['initializeAuth', 'getCurrentUser', 'isUserSignedIn', 'signOut',
      'getAuthState', 'isFirebaseAvailable', 'openSignIn', 'saveScore'].every(k => typeof AuthModule[k] === 'function'));

  AuthModule.initializeAuth(config);
  check('auth initialization releases the loading state after wiring providers',
    !window.document.getElementById('loginBtn').hasAttribute('disabled')
    && !window.document.getElementById('loginBtn').hasAttribute('aria-busy'));
  check('onAuthStateChanged listener was registered', typeof fb.getAuthStateCallback() === 'function');
  check('auth persistence was set (browserLocalPersistence)', calls.setPersistence === 1);

  const avail = AuthModule.isFirebaseAvailable();
  // url is https + non-local host, so firestore/analytics initialize too.
  check('isFirebaseAvailable() reports auth/firestore/analytics up',
    avail.auth === true && avail.firestore === true && avail.analytics === true);

  // Dead-code removal: initializeAuth no longer rewrites storageBucket in place.
  check('storageBucket is left untouched (dead rewrite removed)',
    config.storageBucket === 'sn0wglider.firebasestorage.app');

  // PR #211: with Analytics up, initializeAuth publishes window.firebaseModules.logEvent on
  // the main page (previously only auth.html did), so the game's logEvent callers AND the
  // diagnostics telemetry sink actually deliver instead of silently no-oping. Verify the
  // seam exists and routes to the real Analytics logEvent.
  check('window.firebaseModules.logEvent is published once Analytics is up',
    !!global.window.firebaseModules && typeof global.window.firebaseModules.logEvent === 'function');
  const logsBefore = calls.logEvent.length;
  global.window.firebaseModules.logEvent('physics_anomaly', { runawayFrames: 1 });
  check('window.firebaseModules.logEvent routes to the real Analytics instance',
    calls.logEvent.length === logsBefore + 1 &&
    calls.logEvent[calls.logEvent.length - 1].name === 'physics_anomaly');

  // PR #111: auth.ts broadcasts snowglider:auth-changed on login/logout so the
  // start-screen onboarding UI can refresh without hooking the internal listener.
  let authChangedEvents = 0;
  window.addEventListener('snowglider:auth-changed', () => { authChangedEvents++; });

  console.log('\n--- Sign-in (popup success) ---');
  const loginBtn = /** @type {HTMLButtonElement} */ (window.document.getElementById('loginBtn'));
  const authUI = /** @type {HTMLDivElement} */ (window.document.getElementById('authUI'));
  const profileUI = /** @type {HTMLDivElement} */ (window.document.getElementById('profileUI'));

  fb.setNextPopupResult({ resolve: { user: { email: 'snow@glider.ai' } } });
  loginBtn.dispatchEvent(new window.Event('click'));
  check('click disables the button and shows "Signing In..."',
    loginBtn.disabled === true && /Signing In/.test(loginBtn.textContent));
  check('sign-in exposes its pending state to assistive technology', loginBtn.getAttribute('aria-busy') === 'true');
  check('signInWithPopup was invoked once', calls.signInWithPopup === 1);

  // A second click while in-flight must NOT open a second popup (disabled guard).
  loginBtn.dispatchEvent(new window.Event('click'));
  check('repeat click while in-flight does not open a second popup', calls.signInWithPopup === 1);

  await flush();
  check("'login' analytics event logged with GooglePopup method",
    calls.logEvent.some(e => e.name === 'login' && e.params && e.params.method === 'GooglePopup'));

  // Firebase now reports the signed-in user via the captured callback.
  const changedBeforeSignIn = authChangedEvents;
  fb.emitAuthState({ uid: 'u1', email: 'snow@glider.ai', displayName: 'Snow', photoURL: 'http://p/x.png' });
  check('signed-in: dispatches snowglider:auth-changed for read-only consumers',
    authChangedEvents === changedBeforeSignIn + 1);
  check('signed-in: profile UI shown, auth UI hidden',
    authUI.style.display === 'none' && profileUI.style.display === 'flex');
  check('signed-in: profile name populated',
    window.document.getElementById('profileName').textContent === 'Snow');
  check('signed-in: avatar uses the provider photo when present',
    /url\("?http:\/\/p\/x\.png"?\)/.test(window.document.getElementById('profileAvatar').style.backgroundImage));
  check('signed-in: getAuthState reflects the user',
    AuthModule.isUserSignedIn() === true && AuthModule.getAuthState().user.uid === 'u1');
  check('signed-in: login button reset to default label',
    loginBtn.disabled === false && /Sign in with Google/.test(loginBtn.textContent));

  // A user with no photo gets a generated avatar: initials on a deterministic color.
  fb.emitAuthState({ uid: 'u2', email: 'jane.doe@x.io', displayName: 'Jane Doe', photoURL: null });
  check('signed-in (no photo): avatar shows initials + generated color',
    window.document.getElementById('profileAvatar').textContent === 'JD' &&
    /rgb\(/.test(window.document.getElementById('profileAvatar').style.backgroundColor));
  fb.emitAuthState({ uid: 'u1', email: 'snow@glider.ai', displayName: 'Snow', photoURL: 'http://p/x.png' });

  console.log('\n--- Sign-out ---');
  const logoutBtn = /** @type {HTMLButtonElement} */ (window.document.getElementById('logoutBtn'));
  logoutBtn.dispatchEvent(new window.Event('click'));
  check('firebaseSignOut was invoked', calls.signOut === 1);
  await flush();
  const changedBeforeSignOut = authChangedEvents;
  fb.emitAuthState(null); // Firebase reports signed-out
  check('signed-out: dispatches snowglider:auth-changed for read-only consumers',
    authChangedEvents === changedBeforeSignOut + 1);
  check('signed-out: auth UI shown again, profile hidden',
    authUI.style.display === 'flex' && profileUI.style.display === 'none');
  check('signed-out: getCurrentUser() is null', AuthModule.getCurrentUser() === null);

  console.log('\n--- Sign-out via touch (mobile tap) ---');
  // The logout button previously bound only a touchstart handler that called
  // preventDefault() and nothing else — which suppressed the synthesized click AND
  // never signed out, so logout was dead on mobile. It must now sign out from
  // 'touchend' (the tap-complete gesture) too, and not double-fire with the click.
  fb.emitAuthState({ uid: 'u1', email: 'snow@glider.ai', displayName: 'Snow' });
  await flush();
  const signOutsBeforeTouch = calls.signOut;
  const logoutTouch = new window.Event('touchend', { cancelable: true });
  logoutBtn.dispatchEvent(logoutTouch);
  check('logout touchend signs out even when the click is suppressed',
    calls.signOut === signOutsBeforeTouch + 1 && logoutBtn.disabled === true);
  check('logout touchend is preventDefaulted (suppresses the duplicate click)',
    logoutTouch.defaultPrevented === true);
  // A trailing synthetic click (before the async sign-out settles) must not sign out twice.
  logoutBtn.dispatchEvent(new window.Event('click'));
  check('trailing click after logout touchend does not sign out twice',
    calls.signOut === signOutsBeforeTouch + 1);
  await flush();
  fb.emitAuthState(null);

  console.log('\n--- Sign-out failure surfaces an alert + re-enables the button ---');
  fb.emitAuthState({ uid: 'u1', email: 'snow@glider.ai', displayName: 'Snow' });
  await flush();
  alerts.length = 0;
  fb.setNextSignOutError(new Error('network down'));
  logoutBtn.dispatchEvent(new window.Event('click'));
  await flush();
  await flush();
  check('sign-out failure explains how to retry', alerts.some(a => /sign you out.*try again/i.test(a)));
  check('sign-out failure re-enables the logout button',
    logoutBtn.disabled === false && logoutBtn.textContent === 'Logout');
  fb.emitAuthState(null);

  console.log('\n--- Sign-in via touch (game-page click-suppression scenario) ---');
  // On the game page, controls.js installs a document-level touchstart
  // preventDefault that suppresses this button's synthetic click — so sign-in must
  // also work from 'touchend'. Simulate a tap where only touchend reaches the button.
  fb.setNextPopupResult({ resolve: { user: { email: 'touch@glider.ai' } } });
  const popupsBefore = calls.signInWithPopup;
  const tEnd = new window.Event('touchend', { cancelable: true });
  loginBtn.dispatchEvent(tEnd);
  check('touchend triggers sign-in even when the click is suppressed',
    calls.signInWithPopup === popupsBefore + 1 && loginBtn.disabled === true);
  check('handleSignIn preventDefaults the touchend (suppresses the duplicate click)',
    tEnd.defaultPrevented === true);
  // A trailing synthetic click (if the browser still emits one) must not open a 2nd popup.
  loginBtn.dispatchEvent(new window.Event('click'));
  check('trailing click after touchend does not open a second popup',
    calls.signInWithPopup === popupsBefore + 1);
  await flush();
  fb.emitAuthState(null); // reset button state for the error tests below

  console.log('\n--- Sign-in error handling ---');
  // popup-closed-by-user: benign, no alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/popup-closed-by-user', message: 'closed' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('popup-closed-by-user: no alert, button re-enabled',
    alerts.length === 0 && loginBtn.disabled === false);

  // cancelled-popup-request: the new benign case — also no alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/cancelled-popup-request', message: 'superseded' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('cancelled-popup-request: treated as benign (no alert)',
    alerts.length === 0 && loginBtn.disabled === false);

  // popup-blocked: user-facing alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/popup-blocked', message: 'blocked' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('popup-blocked: shows an alert and re-enables the button',
    alerts.length === 1 && /sign-in window/i.test(alerts[0]) && loginBtn.disabled === false);

  // A credential conflict needs a different recovery action from a network error:
  // tell the player to use their existing sign-in option and release every button.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: {
    code: 'auth/account-exists-with-different-credential', message: 'provider conflict details'
  } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('credential conflict explains how to continue without raw provider details',
    alerts.length === 1 && /linked to another sign-in option.*Use that option/.test(alerts[0])
    && !/provider conflict details/.test(alerts[0]));
  check('credential conflict releases every provider and guest button for retry',
    Array.from(authUI.querySelectorAll('button')).every(button =>
      !button.disabled && !button.hasAttribute('aria-busy') && !button.classList.contains('signing-in')));

  // unknown error: generic alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/internal-error', message: 'boom' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('unknown error: shows recovery guidance without raw service details',
    alerts.length === 1 && /Try again/.test(alerts[0]) && !/boom/.test(alerts[0]));

  // Promise rejection values are not guaranteed FirebaseError objects. Give
  // recovery guidance and release controls even when no message/code exists.
  for (const reason of ['network failed', null, undefined, { code: 42, message: { invalid: true } }]) {
    alerts.length = 0;
    fb.setNextPopupResult({ reject: reason });
    loginBtn.dispatchEvent(new window.Event('click'));
    await flush();
    check('malformed rejection produces a useful message and releases sign-in controls',
      alerts.length === 1 && /Try again/.test(alerts[0]) && loginBtn.disabled === false);
  }

  console.log('\n--- GitHub & Apple provider sign-in ---');
  const githubBtn = /** @type {HTMLButtonElement} */ (window.document.getElementById('githubLoginBtn'));
  const appleBtn = /** @type {HTMLButtonElement} */ (window.document.getElementById('appleLoginBtn'));

  // GitHub: a federated popup logged with method 'GitHubPopup'.
  fb.setNextPopupResult({ resolve: { user: { email: 'gh@glider.ai' } } });
  const popupsBeforeGh = calls.signInWithPopup;
  githubBtn.dispatchEvent(new window.Event('click'));
  check('GitHub button opens a popup and shows "Signing In..."',
    calls.signInWithPopup === popupsBeforeGh + 1 &&
    githubBtn.disabled === true && /Signing In/.test(githubBtn.textContent));
  check('starting one sign-in disables the other provider buttons too (no competing popups)',
    loginBtn.disabled === true && appleBtn.disabled === true);
  await flush();
  check("'login' analytics logged with GitHubPopup method",
    calls.logEvent.some(e => e.name === 'login' && e.params && e.params.method === 'GitHubPopup'));
  fb.emitAuthState(null); // settle to signed-out, re-enable buttons

  // Apple: OAuthProvider('apple.com') popup logged with method 'ApplePopup'.
  // appleBtn is icon-style, so its busy/reset must go through the .provider-label
  // span (not textContent) to avoid wiping the inline SVG icon.
  fb.setNextPopupResult({ resolve: { user: { email: 'apple@glider.ai' } } });
  const popupsBeforeApple = calls.signInWithPopup;
  appleBtn.dispatchEvent(new window.Event('click'));
  check('icon button busy keeps its label (icon preserved; no "Signing In..." text clobber)',
    appleBtn.classList.contains('signing-in') &&
    appleBtn.querySelector('.provider-label').textContent === 'Apple');
  await flush();
  check('Apple button opens a popup', calls.signInWithPopup === popupsBeforeApple + 1);
  check("'login' analytics logged with ApplePopup method",
    calls.logEvent.some(e => e.name === 'login' && e.params && e.params.method === 'ApplePopup'));
  appleBtn.querySelector('.provider-label').textContent = 'XXX'; // mangle to prove reset rewrites it
  fb.emitAuthState(null);
  check('icon button reset rewrites the short label via .provider-label',
    appleBtn.querySelector('.provider-label').textContent === 'Apple' && appleBtn.disabled === false);

  console.log('\n--- Anonymous "play as guest" ---');
  const guestBtn = window.document.getElementById('guestLoginBtn');
  fb.setNextPopupResult(null);
  const anonBefore = calls.signInAnonymously;
  const popupsBeforeGuest = calls.signInWithPopup;
  guestBtn.dispatchEvent(new window.Event('click'));
  check('guest button calls signInAnonymously and opens no popup',
    calls.signInAnonymously === anonBefore + 1 && calls.signInWithPopup === popupsBeforeGuest);
  await flush();
  check("'login' analytics logged with Anonymous method",
    calls.logEvent.some(e => e.name === 'login' && e.params && e.params.method === 'Anonymous'));

  // Firebase reports the anonymous user. The guest is kept OFF the leaderboard:
  // recordScore must not write a Firestore identity even though logged-in chrome shows.
  localStorage.clear();
  const profileChip = window.document.getElementById('profileChip');
  const profileAvatar = window.document.getElementById('profileAvatar');
  fb.emitAuthState({ uid: 'guest1', isAnonymous: true, email: null, displayName: null });
  // For a guest the login options are FOLDED behind the avatar chip (not cluttering
  // the panel), but must stay reachable: the chip is in "guest" mode and the avatar
  // shows generated content (a glyph, since a guest has no name).
  check('anonymous guest: login options folded behind the chip',
    authUI.style.display === 'none' && profileUI.style.display === 'flex' &&
    profileUI.classList.contains('guest') &&
    window.document.getElementById('profileName').textContent === 'Guest');
  check('anonymous guest: avatar has a generated glyph + background color',
    profileAvatar.textContent.length > 0 && /rgb\(/.test(profileAvatar.style.backgroundColor));
  check('guest chip exposes its name, target, and collapsed state',
    profileChip.getAttribute('aria-label') === 'Sign-in options for Guest'
    && profileChip.getAttribute('aria-controls') === 'authUI'
    && profileChip.getAttribute('aria-expanded') === 'false'
    && !profileChip.hasAttribute('disabled'));
  // Clicking the chip unfolds #authUI so the guest can pick a provider to upgrade.
  profileChip.dispatchEvent(new window.Event('click'));
  check('anonymous guest: clicking the chip reveals the provider buttons for upgrade',
    authUI.style.display === 'flex' && profileUI.classList.contains('expanded'));
  check('guest chip expanded state follows the visible options', profileChip.getAttribute('aria-expanded') === 'true');
  window.document.getElementById('authContainer').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape folds the guest provider controls and restores chip focus',
    authUI.style.display === 'none' && window.document.activeElement === profileChip);
  const authContainer = window.document.getElementById('authContainer');
  authContainer.classList.add('collapsed');
  authContainer.hidden = true;
  authContainer.setAttribute('inert', '');
  authContainer.setAttribute('aria-hidden', 'true');
  AuthModule.openSignIn();
  check('result-screen sign-in reveals controls and focuses the first provider without a popup',
    authUI.style.display === 'flex' && profileChip.getAttribute('aria-expanded') === 'true'
    && !authContainer.hidden && !authContainer.classList.contains('collapsed')
    && !authContainer.hasAttribute('aria-hidden') && window.document.activeElement === loginBtn);
  check('anonymous guest: AuthModule still reports signed-in (for UI/onboarding)',
    AuthModule.isUserSignedIn() === true);
  AuthModule.recordScore(22.34); // guest finishes a run (valid time; only the guest guard should block it)
  await flush();
  check('anonymous guest: recordScore writes NO leaderboard entry for the guest',
    fb.read(LB, 'guest1') === undefined &&
    !calls.setDoc.some(c => c.path === `${LB}/guest1`));
  localStorage.clear(); // isolate from the backstop test below
  fb.emitAuthState(null);

  console.log('\n--- Guest upgrade (link in place) ---');
  // A signed-in anonymous guest upgrading via a provider LINKS (keeps the uid)
  // rather than opening a fresh signInWithPopup, so their progress carries over.
  fb.setAuthCurrentUser({ uid: 'guest1', isAnonymous: true });
  fb.setNextLinkResult({ resolve: { user: { uid: 'guest1', isAnonymous: false, email: 'gh@glider.ai', displayName: 'GH' } } });
  const linksBefore = calls.linkWithPopup;
  const popupsBeforeUpgrade = calls.signInWithPopup;
  githubBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('guest upgrade: uses linkWithPopup (keeps uid), not signInWithPopup',
    calls.linkWithPopup === linksBefore + 1 && calls.signInWithPopup === popupsBeforeUpgrade);
  check('guest upgrade: applies the now-named user directly (uid preserved, no longer anonymous)',
    !!AuthModule.getAuthState().user && AuthModule.getAuthState().user.uid === 'guest1' &&
    AuthModule.getAuthState().user.isAnonymous === false);
  await new Promise(r => setTimeout(r, 120)); // drain the upgrade's syncUserData timer while localStorage is clear
  await flush();
  fb.setAuthCurrentUser(null);
  fb.emitAuthState(null);

  // A reusable collision credential signs into the existing account without a
  // second popup; mobile transient user activation has expired at this point.
  fb.setAuthCurrentUser({ uid: 'guest2', isAnonymous: true });
  fb.setNextLinkResult({ reject: { code: 'auth/credential-already-in-use', message: 'exists',
    credential: { providerId: 'apple.com', signInMethod: 'apple.com', idToken: 'test-token' } } });
  fb.setNextPopupResult({ resolve: { user: { uid: 'existing1', email: 'existing@glider.ai', displayName: 'Existing' } } });
  const linksBefore2 = calls.linkWithPopup;
  const popupsBefore2 = calls.signInWithPopup;
  const credentialsBefore = calls.signInWithCredential;
  appleBtn.dispatchEvent(new window.Event('click'));
  await flush(); await flush();
  check('guest collision uses signInWithCredential without opening a second popup',
    calls.linkWithPopup === linksBefore2 + 1 && calls.signInWithPopup === popupsBefore2
    && calls.signInWithCredential === credentialsBefore + 1);
  fb.setAuthCurrentUser(null);
  fb.emitAuthState(null);

  // Some providers omit the credential. Retry from a new tap instead of an async
  // popup; do not repeatedly try to link the already-existing provider account.
  fb.setAuthCurrentUser({ uid: 'guest-no-credential', isAnonymous: true });
  fb.setNextLinkResult({ reject: { code: 'auth/email-already-in-use', message: 'exists' } });
  const missingCredentialPopups = calls.signInWithPopup;
  const missingCredentialLinks = calls.linkWithPopup;
  alerts.length = 0;
  githubBtn.dispatchEvent(new window.Event('click'));
  await flush(); await flush();
  check('missing collision credential releases controls and asks for a fresh provider tap',
    calls.signInWithPopup === missingCredentialPopups && !githubBtn.disabled
    && alerts.length === 1 && /Choose GitHub again/.test(alerts[0]));
  githubBtn.dispatchEvent(new window.Event('click'));
  check('the fresh retry opens one popup synchronously and does not link again',
    calls.signInWithPopup === missingCredentialPopups + 1 && calls.linkWithPopup === missingCredentialLinks + 1);
  await flush();
  fb.setAuthCurrentUser(null);
  fb.emitAuthState(null);
  fb.setNextPopupResult(null);
  fb.setNextLinkResult(null);

  // Offline sign-in keeps the completed run in place and never opens a popup.
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
  alerts.length = 0;
  const offlinePopups = calls.signInWithPopup;
  loginBtn.dispatchEvent(new window.Event('click'));
  check('offline sign-in explains the next step without starting authentication',
    calls.signInWithPopup === offlinePopups && !loginBtn.disabled && alerts.length === 1 && /offline/.test(alerts[0]));
  const offlineGuests = calls.signInAnonymously;
  guestBtn.dispatchEvent(new window.Event('click'));
  check('offline guest play avoids creating a network-dependent anonymous account',
    calls.signInAnonymously === offlineGuests && !guestBtn.hasAttribute('disabled'));
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });

  // A late guest-link completion must not put its old account back after the
  // observer has already moved to another account.
  const oldGuest = { uid: 'old-guest-race', isAnonymous: true };
  fb.setAuthCurrentUser(oldGuest);
  fb.emitAuthState(oldGuest);
  let resolveOldLink = /** @type {(value: unknown) => void} */ (() => {});
  const pendingLink = new Promise(resolve => { resolveOldLink = resolve; });
  fb.setNextLinkResult({ resolve: pendingLink });
  githubBtn.dispatchEvent(new window.Event('click'));
  fb.emitAuthState({ uid: 'replacement-user', displayName: 'Replacement', isAnonymous: false });
  resolveOldLink({ user: { uid: oldGuest.uid, isAnonymous: false, displayName: 'Too late' } });
  await flush(); await flush();
  check('a late guest upgrade never replaces a newer signed-in account',
    AuthModule.getCurrentUser()?.uid === 'replacement-user'
    && window.document.getElementById('profileName').textContent === 'Replacement');
  fb.setAuthCurrentUser(null);
  fb.emitAuthState(null);
  fb.setNextLinkResult(null);

  console.log('\n--- account-owned login restore and account-switch isolation ---');
  const { default: Scores } = await import('../src/scores.ts');
  const store = await import('../src/offline/offline-store.ts');
  const RCa = await import('../src/run-context.ts');
  const stampCompatible = (key) => localStorage.setItem(`${key}_meta`,
    JSON.stringify({ seed: RCa.getRunStamp().seed, nonce: 0, physicsVersion: RCa.PHYSICS_VERSION }));
  // Another player owns the faster device-wide time. Signing in must restore
  // only the selected account's times, across every ranked level.
  localStorage.setItem(BTK('blue'), '19.5');
  stampCompatible(BTK('blue'));
  const ownedTimes = { bunny: 40, blue: 21.5, black: 12.5, expert: 11.5 };
  for (const cfg of Difficulty.DIFFICULTIES) Scores.rememberAccountBest('sync1', ownedTimes[cfg.id], cfg.id);
  fb.emitAuthState({ uid: 'sync1', email: 's@g.ai', displayName: 'Sync', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  await flush(); await flush();
  check('syncUserData writes the user profile without private provider email',
    fb.read('users', 'sync1')?.displayName === 'Sync' && !Object.hasOwn(fb.read('users', 'sync1'), 'email'));
  for (const cfg of Difficulty.DIFFICULTIES) {
    check(`sign-in restores the account-owned ${cfg.label} best`,
      fb.read(Difficulty.leaderboardCollectionName(cfg.id), 'sync1')?.time === ownedTimes[cfg.id]);
  }
  fb.emitAuthState({ uid: 'other-account', email: 'other@g.ai', displayName: 'Other', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  await flush();
  check('a different account never inherits the device-wide or previous account best',
    !fb.read(LB, 'other-account') && !store.getPendingSync('other-account', 'blue', localStorage)
    && localStorage.getItem(BTK('blue')) === '19.5');

  // A new device has no owned cache to backfill. Read every current-version
  // users-doc best on sign-in without turning it into a shared device record.
  const restoredAccountIds = [];
  window.addEventListener('snowglider:account-bests-changed', event => {
    restoredAccountIds.push(/** @type {CustomEvent<{userId: string}>} */ (event).detail.userId);
  });
  const remoteTimes = { bunny: 36, blue: 18.5, black: 12, expert: 10.5 };
  const remoteFields = Object.fromEntries(Difficulty.DIFFICULTIES.map(cfg => [
    Difficulty.userBestTimeField(cfg.id), remoteTimes[cfg.id]
  ]));
  fb.seed('users', 'new-device', { ...remoteFields, bestTime: 15.25 });
  fb.emitAuthState({ uid: 'new-device', displayName: 'New device', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  for (const cfg of Difficulty.DIFFICULTIES) {
    check(`a new device restores the remote ${cfg.label} account best`,
      Scores.getLocalBestForUser(cfg.id, 'new-device') === remoteTimes[cfg.id]);
  }
  check('remote account restore notifies the view once and preserves the shared device best',
    restoredAccountIds.length === 1 && restoredAccountIds[0] === 'new-device'
    && localStorage.getItem(BTK('blue')) === '19.5'
    && localStorage.getItem(BTK('black')) === null);

  const invalidRemoteTimes = { bunny: 14.9, blue: '20', black: 9.9, expert: Infinity };
  fb.seed('users', 'invalid-remote', Object.fromEntries(Difficulty.DIFFICULTIES.flatMap(cfg => [
    [Difficulty.userBestTimeField(cfg.id), invalidRemoteTimes[cfg.id]],
    [Difficulty.legacyUserBestTimeField(cfg.id), ownedTimes[cfg.id]]
  ])));
  fb.emitAuthState({ uid: 'invalid-remote', displayName: 'Invalid remote', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  check('remote restore rejects invalid times and never reads older physics-version fields',
    Difficulty.DIFFICULTIES.every(cfg => Scores.getLocalBestForUser(cfg.id, 'invalid-remote') === null)
    && restoredAccountIds.length === 1);

  fb.seed('users', 'stale-read', remoteFields);
  fb.seed('users', 'current-read', { [Difficulty.userBestTimeField('blue')]: 27 });
  const staleRead = fb.setPendingRead('users/stale-read');
  fb.emitAuthState({ uid: 'stale-read', displayName: 'Old read', photoURL: null });
  await new Promise(r => setTimeout(r, 120));
  fb.emitAuthState({ uid: 'current-read', displayName: 'Current read', photoURL: null });
  staleRead.resolve();
  await new Promise(r => setTimeout(r, 160));
  check('an account switch discards the old remote read before caching or notifying',
    Difficulty.DIFFICULTIES.every(cfg => Scores.getLocalBestForUser(cfg.id, 'stale-read') === null)
    && !restoredAccountIds.includes('stale-read')
    && Scores.getLocalBestForUser('blue', 'current-read') === 27
    && restoredAccountIds.includes('current-read'));

  fb.seed('users', 'failed-read', remoteFields);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
  const failedRead = fb.setPendingRead('users/failed-read');
  fb.emitAuthState({ uid: 'failed-read', displayName: 'Failed read', photoURL: null });
  await new Promise(r => setTimeout(r, 120));
  failedRead.reject({ code: 'unavailable' });
  await flush();
  check('a failed remote best read does not disable profile or scoring services',
    fb.read('users', 'failed-read')?.displayName === 'Failed read' && AuthModule.isFirebaseAvailable().firestore);
  check('the first offline read leaves an uncached new account with no pending uploads',
    Difficulty.DIFFICULTIES.every(cfg => Scores.getLocalBestForUser(cfg.id, 'failed-read') === null)
    && !store.getPendingSync('failed-read', 'blue', localStorage));
  const readCountBeforeReconnect = calls.getDoc.filter(path => path === 'users/failed-read').length;
  const writesBeforeReconnect = calls.setDoc.length;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  window.dispatchEvent(new window.Event('online'));
  await flush(); await flush();
  check('reconnect restores all remote account bests without requiring a queued score',
    Difficulty.DIFFICULTIES.every(cfg => Scores.getLocalBestForUser(cfg.id, 'failed-read') === remoteTimes[cfg.id])
    && restoredAccountIds.includes('failed-read'));
  check('reconnect reads account bests once and never repeats the profile write',
    calls.getDoc.filter(path => path === 'users/failed-read').length === readCountBeforeReconnect + 1
    && calls.setDoc.length === writesBeforeReconnect);

  // The reconnect handler must use the same account epoch as sign-in restores.
  fb.emitAuthState({ uid: 'stale-reconnect', displayName: 'Old reconnect', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  fb.seed('users', 'stale-reconnect', remoteFields);
  fb.seed('users', 'current-reconnect', { [Difficulty.userBestTimeField('blue')]: 29 });
  const staleReconnect = fb.setPendingRead('users/stale-reconnect');
  window.dispatchEvent(new window.Event('online'));
  fb.emitAuthState({ uid: 'current-reconnect', displayName: 'Current reconnect', photoURL: null });
  staleReconnect.resolve();
  await new Promise(r => setTimeout(r, 160));
  check('switching accounts discards a late reconnect response before caching or notifying',
    Difficulty.DIFFICULTIES.every(cfg => Scores.getLocalBestForUser(cfg.id, 'stale-reconnect') === null)
    && !restoredAccountIds.includes('stale-reconnect')
    && Scores.getLocalBestForUser('blue', 'current-reconnect') === 29);

  // Reading blocked storage cannot prevent the account profile from loading.
  const origGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = () => { throw new Error('storage blocked'); };
  try {
    fb.emitAuthState({ uid: 'blockedfs1', email: 'b@g.ai', displayName: 'Blocked', photoURL: null });
    await new Promise(r => setTimeout(r, 160));
    await flush();
  } finally { localStorage.getItem = origGetItem; }
  check('blocked local storage cannot abort sign-in/profile sync',
    fb.read('users', 'blockedfs1')?.displayName === 'Blocked');

  // A profile failure cannot drop the selected account's stored result.
  localStorage.removeItem('snowgliderPendingSync');
  Scores.rememberAccountBest('syncfail1', 20.5, 'blue');
  const displayLeaderboardBeforeFailure = Scores.displayLeaderboard;
  let directLeaderboardRenders = 0;
  Scores.displayLeaderboard = () => { directLeaderboardRenders++; };
  const authChangesBeforeFailure = authChangedEvents;
  fb.setNextSetDocError('users/syncfail1', { code: 'unavailable' });
  try {
    fb.emitAuthState({ uid: 'syncfail1', email: 'f@g.ai', displayName: 'Fail', photoURL: null });
    await new Promise(r => setTimeout(r, 160));
    await flush(); await flush();
  } finally { Scores.displayLeaderboard = displayLeaderboardBeforeFailure; }
  check('profile failure keeps the account best either synced or queued',
    fb.read(LB, 'syncfail1')?.time === 20.5 || store.getPendingSync('syncfail1', 'blue', localStorage)?.time === 20.5);
  check('profile failure notifies the view without resetting its leaderboard level to Blue',
    directLeaderboardRenders === 0 && authChangedEvents >= authChangesBeforeFailure + 2);

  // Local mode deliberately has no Firestore; account restore still queues its
  // owned result. Moving back to a remote host restores the normal service.
  dom.reconfigure({ url: 'https://localhost/' });
  AuthModule.initializeAuth(config);
  Scores.rememberAccountBest('nullfs1', 21, 'blue');
  fb.emitAuthState({ uid: 'nullfs1', email: 'n@g.ai', displayName: 'NullFS', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  await flush();
  check('account restore queues owned scores while Firestore is unavailable',
    store.getPendingSync('nullfs1', 'blue', localStorage)?.time === 21);
  dom.reconfigure({ url: 'https://snowglider.ai/' });
  AuthModule.initializeAuth(config);
  fb.emitAuthState({ uid: 'guestX', email: null, displayName: null, photoURL: null, isAnonymous: true });
  await new Promise(r => setTimeout(r, 160));
  check('an anonymous guest does not queue the device-wide best',
    store.getPendingSync('guestX', 'blue', localStorage) === null);
  const guestReadCount = calls.getDoc.length;
  window.dispatchEvent(new window.Event('online'));
  await flush();
  check('reconnect never requests account bests for an anonymous guest', calls.getDoc.length === guestReadCount);

  // Superseding an account before its delayed restore starts cancels that work.
  Scores.rememberAccountBest('stale-delay', 22, 'blue');
  Scores.rememberAccountBest('current-delay', 23, 'blue');
  fb.emitAuthState({ uid: 'stale-delay', displayName: 'Old', isAnonymous: false });
  fb.emitAuthState({ uid: 'current-delay', displayName: 'Current', isAnonymous: false });
  await new Promise(r => setTimeout(r, 160));
  await flush();
  check('an account switch cancels the previous delayed profile and score restore',
    !fb.read('users', 'stale-delay') && !fb.read(LB, 'stale-delay')
    && fb.read(LB, 'current-delay')?.time === 23);

  // A queued profile request may settle after switching accounts. Its failure
  // must not disable the current account's scoring connection.
  const staleProfile = fb.setPendingWrite('users/stale-profile');
  fb.emitAuthState({ uid: 'stale-profile', displayName: 'Old profile', isAnonymous: false });
  await new Promise(r => setTimeout(r, 120));
  fb.emitAuthState({ uid: 'current-profile', displayName: 'Current profile', isAnonymous: false });
  staleProfile.reject({ code: 'permission-denied' });
  await new Promise(r => setTimeout(r, 160));
  await flush();
  check('a stale profile failure cannot disable the active account Firestore',
    AuthModule.isFirebaseAvailable().firestore && fb.read('users', 'current-profile')?.displayName === 'Current profile');

  // getUserIdToken delegates to the signed-in user's getIdToken (with forceRefresh).
  fb.emitAuthState({ uid: 'tok1', email: 't@g.ai', displayName: 'Tok', photoURL: null,
    getIdToken: (force) => Promise.resolve(`token-${force}`) });
  check('getUserIdToken resolves the signed-in user id token',
    (await AuthModule.getUserIdToken(true)) === 'token-true');

  // Direct AuthModule.signOut() delegates to firebaseSignOut while auth is available.
  const signOutsBefore = calls.signOut;
  await AuthModule.signOut();
  check('AuthModule.signOut() delegates to firebaseSignOut', calls.signOut === signOutsBefore + 1);

  // After sign-out, getUserIdToken resolves null rather than rejecting.
  fb.emitAuthState(null);
  check('getUserIdToken resolves null when no user is signed in',
    (await AuthModule.getUserIdToken()) === null);

  console.log('\n--- Guest fold guard: no #profileChip keeps upgrade reachable ---');
  // On a page without #profileChip (e.g. auth.html), the guest UI must NOT fold the
  // provider buttons — there'd be no way to unfold them, leaving upgrade unreachable.
  const chip = window.document.getElementById('profileChip');
  chip.remove();
  fb.emitAuthState({ uid: 'guestNoChip', isAnonymous: true, email: null, displayName: null });
  check('guest without a chip: provider buttons stay visible (not folded)',
    authUI.style.display === 'flex' && profileUI.classList.contains('guest') === false);
  fb.emitAuthState(null);

  // Analytics is optional: a transport exception after successful sign-in cannot
  // masquerade as a failed login or stop an in-place guest upgrade from updating UI.
  const alertsBeforeTelemetryFailure = alerts.length;
  fb.emitAuthState({ uid: 'guestTelemetry', isAnonymous: true });
  fb.setAuthCurrentUser({ uid: 'guestTelemetry', isAnonymous: true });
  fb.setNextLinkResult({ resolve: { user: { uid: 'upgradedTelemetry', isAnonymous: false,
    displayName: 'Upgrade', email: 'upgrade@example.invalid' } } });
  fb.setNextLogEventError(new Error('analytics unavailable'));
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush(); await flush();
  check('telemetry failure cannot block successful guest upgrade UI',
    AuthModule.getCurrentUser()?.uid === 'upgradedTelemetry');
  check('telemetry failure cannot create a false sign-in error alert',
    alerts.length === alertsBeforeTelemetryFailure);
  fb.emitAuthState(null);
  fb.setAuthCurrentUser(null);
  fb.setNextLogEventError(new Error('analytics unavailable'));
  window.document.getElementById('guestLoginBtn').dispatchEvent(new window.Event('click'));
  await flush(); await flush();
  check('telemetry failure cannot turn successful guest sign-in into an alert',
    alerts.length === alertsBeforeTelemetryFailure);

  // Repeated startup reuses the same controls. Wiring must remain idempotent and
  // old observers must be detached, including a failure that clears the session.
  const oldObserver = fb.getAuthStateCallback();
  const unsubscribesBefore = calls.authUnsubscribe;
  fb.setNextGetAuthError(new Error('auth unavailable'));
  AuthModule.initializeAuth(config);
  const partialAvailability = AuthModule.isFirebaseAvailable();
  check('reinitialization detaches the previous auth observer', calls.authUnsubscribe === unsubscribesBefore + 1);
  oldObserver?.({ uid: 'stale-observer', displayName: 'Stale' });
  check('a stale observer cannot restore a user after failed initialization', AuthModule.getCurrentUser() === null);
  check('analytics remains available when authentication initialization fails',
    partialAvailability.auth === false && partialAvailability.analytics === true);

  // Both the provider and Guest entry points must explain that local play remains
  // available, without trying an unavailable SDK or leaving controls busy.
  for (const id of ['loginBtn', 'guestLoginBtn']) {
    const popupsBeforeUnavailable = calls.signInWithPopup;
    const guestsBeforeUnavailable = calls.signInAnonymously;
    alerts.length = 0;
    window.document.getElementById(id).dispatchEvent(new window.Event('click'));
    check(`${id} explains how to keep playing when sign-in is unavailable`,
      alerts.length === 1 && /Sign-in is unavailable/.test(alerts[0])
      && /start a run without signing in/.test(alerts[0]));
    check(`${id} does not call the sign-in SDK while auth is unavailable`,
      calls.signInWithPopup === popupsBeforeUnavailable && calls.signInAnonymously === guestsBeforeUnavailable);
    check(`${id} leaves all provider and guest buttons ready to retry`,
      Array.from(window.document.getElementById('authUI').querySelectorAll('button')).every(button =>
        !button.disabled && !button.hasAttribute('aria-busy') && !button.classList.contains('signing-in')));
  }

  // Preview/LAN deployments must not initialize the production Analytics SDK,
  // while the existing authentication and Firestore behavior remains available.
  const analyticsInitializations = calls.getAnalytics;
  dom.reconfigure({ url: 'https://preview.local/' });
  AuthModule.initializeAuth(config);
  const previewAvailability = AuthModule.isFirebaseAvailable();
  check('preview host does not initialize Analytics or collect automatic SDK events',
    calls.getAnalytics === analyticsInitializations && previewAvailability.analytics === false);
  check('preview host retains Auth and Firestore availability',
    previewAvailability.auth === true && previewAvailability.firestore === true);
  const previewEvents = calls.logEvent.length;
  window.firebaseModules.logEvent('game_start');
  check('an existing analytics wrapper becomes inert on non-production hosts',
    calls.logEvent.length === previewEvents);

  dom.reconfigure({ url: 'https://www.snowglider.ai/' });
  AuthModule.initializeAuth(config);
  check('public www host initializes Analytics',
    calls.getAnalytics === analyticsInitializations + 1 && AuthModule.isFirebaseAvailable().analytics === true);

  fb.emitAuthState({ uid: 'reinitialized-online', displayName: 'Online again', photoURL: null });
  await new Promise(r => setTimeout(r, 160));
  const readsAfterReinitializing = calls.getDoc.length;
  const writesAfterReinitializing = calls.setDoc.length;
  window.dispatchEvent(new window.Event('online'));
  await flush(); await flush();
  check('reinitializing auth keeps exactly one account-restore online listener',
    calls.getDoc.length === readsAfterReinitializing + 1 && calls.setDoc.length === writesAfterReinitializing);

  console.log(`\nAUTH TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Auth test harness crashed:', err); process.exit(1); });
