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
  <div id="authUI" style="display:flex">
    <button id="loginBtn">Login with Google</button>
    <button id="githubLoginBtn">Login with GitHub</button>
    <button id="appleLoginBtn">Sign in with Apple</button>
    <button id="guestLoginBtn">Play as Guest</button>
  </div>
  <div id="profileUI" style="display:none">
    <img id="profileAvatar" src=""><span id="profileName"></span>
    <button id="logoutBtn">Logout</button>
  </div>
</body></html>`, { url: 'https://snowglider.ai/' });
const { window } = dom;
global.window = window;
global.document = window.document;
// auth.ts dispatches `new CustomEvent('snowglider:auth-changed')` on window. Bind
// jsdom's CustomEvent on globalThis so the bare constructor builds an event from the
// SAME realm as window — otherwise Node's built-in CustomEvent is rejected by
// jsdom's window.dispatchEvent ("parameter 1 is not of type 'Event'").
global.CustomEvent = window.CustomEvent;
global.localStorage = (function () {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; }
  };
})();
window.localStorage = global.localStorage;

// Capture alert() calls instead of popping a dialog.
const alerts = [];
window.alert = (msg) => { alerts.push(String(msg)); };
global.alert = window.alert;

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

async function main() {
  console.log('--- AuthModule load & init ---');
  const { AuthModule, fb } = await loadAuthModule();
  check('module exposes the expected public surface',
    !!AuthModule && ['initializeAuth', 'getCurrentUser', 'isUserSignedIn', 'signOut',
      'getAuthState', 'isFirebaseAvailable'].every(k => typeof AuthModule[k] === 'function'));

  AuthModule.initializeAuth(config);
  check('onAuthStateChanged listener was registered', typeof fb.getAuthStateCallback() === 'function');
  check('auth persistence was set (browserLocalPersistence)', calls.setPersistence === 1);

  const avail = AuthModule.isFirebaseAvailable();
  // url is https + non-local host, so firestore/analytics initialize too.
  check('isFirebaseAvailable() reports auth/firestore/analytics up',
    avail.auth === true && avail.firestore === true && avail.analytics === true);

  // Dead-code removal: initializeAuth no longer rewrites storageBucket in place.
  check('storageBucket is left untouched (dead rewrite removed)',
    config.storageBucket === 'sn0wglider.firebasestorage.app');

  // PR #111: auth.ts broadcasts snowglider:auth-changed on login/logout so the
  // start-screen onboarding UI can refresh without hooking the internal listener.
  let authChangedEvents = 0;
  window.addEventListener('snowglider:auth-changed', () => { authChangedEvents++; });

  console.log('\n--- Sign-in (popup success) ---');
  const loginBtn = window.document.getElementById('loginBtn');
  const authUI = window.document.getElementById('authUI');
  const profileUI = window.document.getElementById('profileUI');

  fb.setNextPopupResult({ resolve: { user: { email: 'snow@glider.ai' } } });
  loginBtn.dispatchEvent(new window.Event('click'));
  check('click disables the button and shows "Signing In..."',
    loginBtn.disabled === true && /Signing In/.test(loginBtn.textContent));
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
  check('signed-in: getAuthState reflects the user',
    AuthModule.isUserSignedIn() === true && AuthModule.getAuthState().user.uid === 'u1');
  check('signed-in: login button reset to default label',
    loginBtn.disabled === false && /Login with Google/.test(loginBtn.textContent));

  console.log('\n--- Sign-out ---');
  const logoutBtn = window.document.getElementById('logoutBtn');
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
    alerts.length === 1 && /popup/i.test(alerts[0]) && loginBtn.disabled === false);

  // unknown error: generic alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/internal-error', message: 'boom' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('unknown error: shows a generic alert', alerts.length === 1 && /boom/.test(alerts[0]));

  console.log('\n--- GitHub & Apple provider sign-in ---');
  const githubBtn = window.document.getElementById('githubLoginBtn');
  const appleBtn = window.document.getElementById('appleLoginBtn');

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
  fb.setNextPopupResult({ resolve: { user: { email: 'apple@glider.ai' } } });
  const popupsBeforeApple = calls.signInWithPopup;
  appleBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('Apple button opens a popup', calls.signInWithPopup === popupsBeforeApple + 1);
  check("'login' analytics logged with ApplePopup method",
    calls.logEvent.some(e => e.name === 'login' && e.params && e.params.method === 'ApplePopup'));
  fb.emitAuthState(null);

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
  fb.emitAuthState({ uid: 'guest1', isAnonymous: true, email: null, displayName: null });
  check('anonymous guest: logged-in chrome shown (profile UI)',
    authUI.style.display === 'none' && profileUI.style.display === 'flex');
  check('anonymous guest: AuthModule still reports signed-in (for UI/onboarding)',
    AuthModule.isUserSignedIn() === true);
  AuthModule.recordScore(12.34); // guest finishes a run
  await flush();
  check('anonymous guest: recordScore writes NO leaderboard entry for the guest',
    fb.read('leaderboard', 'guest1') === undefined &&
    !calls.setDoc.some(c => c.path === 'leaderboard/guest1'));
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

  // Fallback: the provider account already exists -> linkWithPopup rejects with
  // credential-already-in-use -> fall back to a normal signInWithPopup.
  fb.setAuthCurrentUser({ uid: 'guest2', isAnonymous: true });
  fb.setNextLinkResult({ reject: { code: 'auth/credential-already-in-use', message: 'exists' } });
  fb.setNextPopupResult({ resolve: { user: { uid: 'existing1', email: 'existing@glider.ai', displayName: 'Existing' } } });
  const linksBefore2 = calls.linkWithPopup;
  const popupsBefore2 = calls.signInWithPopup;
  appleBtn.dispatchEvent(new window.Event('click'));
  await flush();
  await flush();
  check('guest upgrade fallback: link rejects -> signInWithPopup is used instead',
    calls.linkWithPopup === linksBefore2 + 1 && calls.signInWithPopup === popupsBefore2 + 1);
  fb.setAuthCurrentUser(null);
  fb.emitAuthState(null);
  fb.setNextPopupResult(null);
  fb.setNextLinkResult(null);

  console.log('\n--- syncUserData login backstop + id token + direct sign-out ---');
  // A valid local best present at sign-in must be backfilled by the delayed
  // syncUserData() login backstop — the durability path scores.ts relies on
  // (see scores.ts: "the on-login syncUserData reconciliation re-applies it").
  // Write through the injected global store auth.ts reads (jsdom's window.localStorage
  // is read-only, so the harness's window.localStorage = global alias did not take).
  localStorage.setItem('snowgliderBestTime', '17.5');
  fb.setNextPopupResult(null);
  fb.emitAuthState({ uid: 'sync1', email: 's@g.ai', displayName: 'Sync', photoURL: null });
  // syncUserData is scheduled 100ms after sign-in; wait past it with margin, then let
  // the setDoc -> updateUserBestTime -> updateLeaderboard promise chain settle.
  await new Promise(r => setTimeout(r, 250));
  await flush();
  await flush();
  await flush();
  check('syncUserData writes the user profile doc on sign-in',
    !!fb.read('users', 'sync1') && fb.read('users', 'sync1').displayName === 'Sync');
  check('syncUserData backfills a valid local best to the leaderboard',
    !!fb.read('leaderboard', 'sync1') && fb.read('leaderboard', 'sync1').time === 17.5);

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

  console.log(`\nAUTH TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Auth test harness crashed:', err); process.exit(1); });
