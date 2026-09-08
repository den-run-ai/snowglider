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
  <div id="authUI" style="display:flex">
    <button id="loginBtn">Login with Google</button>
    <button id="githubLoginBtn">Login with GitHub</button>
    <!-- appleLoginBtn is icon-style (svg + .provider-label) to exercise the
         label-span branch of setButtonLabel/resetAuthButtons. -->
    <button id="appleLoginBtn"><svg class="provider-icon"></svg><span class="provider-label">Apple</span></button>
    <button id="guestLoginBtn">Play as Guest</button>
  </div>
  <div id="profileUI" style="display:none">
    <button id="profileChip"><span id="profileAvatar" class="avatar"></span><span id="profileName"></span></button>
    <button id="logoutBtn">Logout</button>
  </div>
</body></html>`, { url: 'https://snowglider.ai/' });
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
let BTK, BTMK;
async function main() {
  ({ localBestTimeKey: BTK, localBestMetaKey: BTMK } = await import('../src/difficulty.ts'));

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
    loginBtn.disabled === false && /Login with Google/.test(loginBtn.textContent));

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
  check('sign-out failure alerts the user', alerts.some(a => /network down/.test(a)));
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
    alerts.length === 1 && /popup/i.test(alerts[0]) && loginBtn.disabled === false);

  // unknown error: generic alert.
  alerts.length = 0;
  fb.setNextPopupResult({ reject: { code: 'auth/internal-error', message: 'boom' } });
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('unknown error: shows a generic alert', alerts.length === 1 && /boom/.test(alerts[0]));

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
  // Clicking the chip unfolds #authUI so the guest can pick a provider to upgrade.
  profileChip.dispatchEvent(new window.Event('click'));
  check('anonymous guest: clicking the chip reveals the provider buttons for upgrade',
    authUI.style.display === 'flex' && profileUI.classList.contains('expanded'));
  check('anonymous guest: AuthModule still reports signed-in (for UI/onboarding)',
    AuthModule.isUserSignedIn() === true);
  AuthModule.recordScore(22.34); // guest finishes a run (valid time; only the guest guard should block it)
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
  // Backfill now requires a compatible provenance stamp on the best (Codex review
  // PR #407): stamp fixtures with the CURRENT run stamp so they read as same-world.
  const RCa = await import('../src/run-context.ts');
  const stampCompatible = (key) => localStorage.setItem(`${key}_meta`,
    JSON.stringify({ seed: RCa.getRunStamp().seed, nonce: 0, physicsVersion: RCa.PHYSICS_VERSION }));
  localStorage.setItem(BTK('blue'), '19.5');
  stampCompatible(BTK('blue'));
  // An unranked tier's local best must NOT be published to the global board on sign-in.
  localStorage.setItem(BTK('bunny'), '40');
  stampCompatible(BTK('bunny'));
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
    !!fb.read('leaderboard', 'sync1') && fb.read('leaderboard', 'sync1').time === 19.5);
  check('syncUserData does NOT backfill an unranked tier best to the global board',
    !fb.read('leaderboard_bunny', 'sync1') && !fb.read('users', 'sync1').bestTimeBunny);

  // PROVENANCE GATE (Codex review PR #407): an UNSTAMPED (legacy/other-world) local
  // best is kept local — neither backfilled to the board nor queued for retry.
  localStorage.setItem(BTK('blue'), '19.2');
  localStorage.removeItem(`${BTK('blue')}_meta`);
  localStorage.removeItem('snowgliderPendingSync');
  fb.emitAuthState({ uid: 'unstamped1', email: 'u@g.ai', displayName: 'Unstamped', photoURL: null });
  await new Promise(r => setTimeout(r, 250));
  await flush(); await flush(); await flush();
  {
    const storeEarly = await import('../src/offline/offline-store.ts');
    check('an unstamped legacy local best is NOT backfilled on sign-in (kept local)',
      !fb.read('leaderboard', 'unstamped1') &&
      !storeEarly.getPendingSync('unstamped1', 'blue', localStorage));
    check('the unstamped legacy best itself is preserved locally',
      localStorage.getItem(BTK('blue')) === '19.2');
  }

  // --- Codex #362: score backfill is DECOUPLED from profile persistence ---
  // Invariant: a real signed-in user with a ranked local best must confirm-or-queue the
  // sync regardless of profile-write success, Firestore readiness, or account switches.
  const store = await import('../src/offline/offline-store.ts');

  // (A2) Blocked/private storage: reading a local best throws. The throw-safe backfill must
  // degrade gracefully, NOT abort the sign-in/profile sync (Codex #362). Firestore is still
  // available here (the sync1 profile write above succeeded), so the profile doc must still
  // be written. Scope the throw to the best-time keys so the rest of the sign-in flow works.
  const origGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (k) => {
    if (String(k).startsWith('snowgliderBestTime')) throw new Error('storage blocked');
    return origGetItem(k);
  };
  try {
    fb.emitAuthState({ uid: 'blockedfs1', email: 'b@g.ai', displayName: 'Blocked', photoURL: null });
    await new Promise(r => setTimeout(r, 250));
    await flush(); await flush(); await flush();
  } finally {
    localStorage.getItem = origGetItem;
  }
  check('sign-in sync survives storage that throws — profile still written (Codex #362)',
    !!fb.read('users', 'blockedfs1') && fb.read('users', 'blockedfs1').displayName === 'Blocked');

  // (B) A failed PROFILE write on sign-in never DROPS the local best: because backfill is
  // decoupled from the profile write, the best is either synced (backfill's own write went
  // through) OR queued (it didn't) — never lost. Assert the confirm-OR-queue invariant
  // directly so it's race-independent.
  localStorage.removeItem('snowgliderPendingSync');
  localStorage.setItem(BTK('blue'), '20.5'); // a fresh local-only best (ranked Blue)
  stampCompatible(BTK('blue'));
  fb.setNextSetDocError('users/syncfail1', { code: 'unavailable' }); // a user-doc write fails
  fb.emitAuthState({ uid: 'syncfail1', email: 'f@g.ai', displayName: 'Fail', photoURL: null });
  await new Promise(r => setTimeout(r, 250)); // past the 100ms syncUserData timer
  await flush(); await flush(); await flush();
  check('a failed sign-in write never drops the local best — synced OR queued (Codex #362)',
    fb.read('leaderboard', 'syncfail1')?.time === 20.5 ||
    store.getPendingSync('syncfail1', 'blue', localStorage)?.time === 20.5);

  // (C) A real user signing in while Firestore is NULL must STILL queue local bests —
  // handleSignedInUser now always calls syncUserData, and backfill runs even without a live
  // Firestore. First drive Firestore to null via a failed profile write for a user with NO
  // local best (so nothing is queued for them), then sign in a user who does have one.
  localStorage.removeItem(BTK('blue'));
  localStorage.removeItem('snowgliderPendingSync');
  fb.setNextSetDocError('users/nullfs0', { code: 'unavailable' }); // profile write fails -> Firestore nulled
  fb.emitAuthState({ uid: 'nullfs0', email: 'z@g.ai', displayName: 'Z', photoURL: null });
  await new Promise(r => setTimeout(r, 250));
  await flush(); await flush(); await flush();
  localStorage.setItem(BTK('blue'), '21'); // a fresh local ranked best
  stampCompatible(BTK('blue'));
  fb.emitAuthState({ uid: 'nullfs1', email: 'n@g.ai', displayName: 'NoFs', photoURL: null });
  await new Promise(r => setTimeout(r, 250));
  await flush(); await flush(); await flush();
  check('a real sign-in with Firestore null still queues the local best (Codex #362)',
    store.getPendingSync('nullfs1', 'blue', localStorage)?.time === 21);

  // (D) An anonymous guest sign-in never routes a local best to the global leaderboard.
  localStorage.setItem(BTK('blue'), '22');
  fb.emitAuthState({ uid: 'guestX', email: null, displayName: null, photoURL: null, isAnonymous: true });
  await new Promise(r => setTimeout(r, 250));
  await flush(); await flush(); await flush();
  check('an anonymous guest sign-in does not queue a local best (Codex #362)',
    store.getPendingSync('guestX', 'blue', localStorage) === null);

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

  console.log(`\nAUTH TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Auth test harness crashed:', err); process.exit(1); });
