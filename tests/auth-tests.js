// auth-tests.js
// Headless coverage for src/auth.js (the popup-only Google sign-in module).
//
// auth.js is an ES module that imports the Firebase SDK from a CDN, which Node
// can't resolve. Mirroring tests/verification/dom_smoke_test.js, we load the
// source under jsdom, strip the import/export lines, and inject mock Firebase
// functions (getAuth, GoogleAuthProvider, signInWithPopup, …) + a mock
// ScoresModule. We capture the onAuthStateChanged callback so we can drive auth
// state transitions deterministically, with no network and no real Google popup.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

// ---- jsdom environment with the auth UI markup auth.js expects ----
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="authUI" style="display:flex"><button id="loginBtn">Login with Google</button></div>
  <div id="profileUI" style="display:none">
    <img id="profileAvatar" src=""><span id="profileName"></span>
    <button id="logoutBtn">Logout</button>
  </div>
</body></html>`, { url: 'https://snowglider.ai/' });
const { window } = dom;
global.window = window;
global.document = window.document;
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

// ---- Mock Firebase SDK surface used by auth.js ----
let authStateCallback = null;     // the onAuthStateChanged listener auth.js registers
let nextPopupResult = null;       // controls how the next signInWithPopup resolves/rejects
const calls = { signInWithPopup: 0, signOut: 0, setPersistence: 0, logEvent: [] };

const authInstance = { __isAuth: true };
const mocks = {
  initializeApp: () => ({ __app: true }),
  getAuth: () => authInstance,
  getFirestore: () => ({ __firestore: true }),
  getAnalytics: () => ({ __analytics: true }),
  logEvent: (_a, name, params) => { calls.logEvent.push({ name, params }); },
  GoogleAuthProvider: class {
    constructor() { this.scopes = []; this.params = {}; }
    addScope(s) { this.scopes.push(s); }
    setCustomParameters(p) { this.params = p; }
  },
  signInWithPopup: () => {
    calls.signInWithPopup++;
    if (nextPopupResult && nextPopupResult.reject) {
      return Promise.reject(nextPopupResult.reject);
    }
    return Promise.resolve(nextPopupResult ? nextPopupResult.resolve : { user: { email: 'x@y.z' } });
  },
  firebaseSignOut: () => { calls.signOut++; return Promise.resolve(); },
  onAuthStateChanged: (_auth, cb) => { authStateCallback = cb; },
  setPersistence: () => { calls.setPersistence++; return Promise.resolve(); },
  browserLocalPersistence: { __persistence: 'local' },
  doc: () => ({ __doc: true }),
  setDoc: () => Promise.resolve(),
  serverTimestamp: () => ({ __ts: true }),
  ScoresModule: {
    initializeScores: () => {},
    setCurrentUser: () => {},
    updateUserBestTime: () => {},
    displayLeaderboard: () => {},
    recordScore: () => {},
    isValidScoreTime: time => typeof time === 'number' && Number.isFinite(time) && time >= 4
  }
};

// ---- Load src/auth.js with imports/exports stripped, mocks injected ----
function loadAuthModule() {
  // src/auth.ts is TypeScript (issue #84, Phase 3.8). Strip the types to runnable
  // JS first (esbuild-equivalent transpile via the TypeScript devDependency) so the
  // `new Function(...)` eval below — which can't parse `as` casts / annotations —
  // sees plain JavaScript. ESNext output keeps the import/export statements as-is,
  // so the existing import/export removal still works.
  const ts = require('typescript');
  const tsSource = fs.readFileSync(path.join(REPO, 'src', 'auth.ts'), 'utf8');
  let code = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  code = code.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, ''); // drop CDN + local imports
  code = code.replace(/export\s+default\s+[^;]+;/g, '');            // drop `export default AuthModule;`
  const argNames = Object.keys(mocks);
  const fn = new Function(
    'window', 'document', 'localStorage', 'console', 'alert', ...argNames,
    code + '\nreturn window.AuthModule;'
  );
  return fn(window, window.document, global.localStorage, console, window.alert,
    ...argNames.map(n => mocks[n]));
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
  const AuthModule = loadAuthModule();
  check('module exposes the expected public surface',
    !!AuthModule && ['initializeAuth', 'getCurrentUser', 'isUserSignedIn', 'signOut',
      'getAuthState', 'isFirebaseAvailable'].every(k => typeof AuthModule[k] === 'function'));

  AuthModule.initializeAuth(config);
  check('onAuthStateChanged listener was registered', typeof authStateCallback === 'function');
  check('auth persistence was set (browserLocalPersistence)', calls.setPersistence === 1);

  const avail = AuthModule.isFirebaseAvailable();
  // url is https + non-local host, so firestore/analytics initialize too.
  check('isFirebaseAvailable() reports auth/firestore/analytics up',
    avail.auth === true && avail.firestore === true && avail.analytics === true);

  // Dead-code removal: initializeAuth no longer rewrites storageBucket in place.
  check('storageBucket is left untouched (dead rewrite removed)',
    config.storageBucket === 'sn0wglider.firebasestorage.app');

  console.log('\n--- Sign-in (popup success) ---');
  const loginBtn = window.document.getElementById('loginBtn');
  const authUI = window.document.getElementById('authUI');
  const profileUI = window.document.getElementById('profileUI');

  nextPopupResult = { resolve: { user: { email: 'snow@glider.ai' } } };
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
  authStateCallback({ uid: 'u1', email: 'snow@glider.ai', displayName: 'Snow', photoURL: 'http://p/x.png' });
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
  authStateCallback(null); // Firebase reports signed-out
  check('signed-out: auth UI shown again, profile hidden',
    authUI.style.display === 'flex' && profileUI.style.display === 'none');
  check('signed-out: getCurrentUser() is null', AuthModule.getCurrentUser() === null);

  console.log('\n--- Sign-in via touch (game-page click-suppression scenario) ---');
  // On the game page, controls.js installs a document-level touchstart
  // preventDefault that suppresses this button's synthetic click — so sign-in must
  // also work from 'touchend'. Simulate a tap where only touchend reaches the button.
  nextPopupResult = { resolve: { user: { email: 'touch@glider.ai' } } };
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
  authStateCallback(null); // reset button state for the error tests below

  console.log('\n--- Sign-in error handling ---');
  // popup-closed-by-user: benign, no alert.
  alerts.length = 0;
  nextPopupResult = { reject: { code: 'auth/popup-closed-by-user', message: 'closed' } };
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('popup-closed-by-user: no alert, button re-enabled',
    alerts.length === 0 && loginBtn.disabled === false);

  // cancelled-popup-request: the new benign case — also no alert.
  alerts.length = 0;
  nextPopupResult = { reject: { code: 'auth/cancelled-popup-request', message: 'superseded' } };
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('cancelled-popup-request: treated as benign (no alert)',
    alerts.length === 0 && loginBtn.disabled === false);

  // popup-blocked: user-facing alert.
  alerts.length = 0;
  nextPopupResult = { reject: { code: 'auth/popup-blocked', message: 'blocked' } };
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('popup-blocked: shows an alert and re-enables the button',
    alerts.length === 1 && /popup/i.test(alerts[0]) && loginBtn.disabled === false);

  // unknown error: generic alert.
  alerts.length = 0;
  nextPopupResult = { reject: { code: 'auth/internal-error', message: 'boom' } };
  loginBtn.dispatchEvent(new window.Event('click'));
  await flush();
  check('unknown error: shows a generic alert', alerts.length === 1 && /boom/.test(alerts[0]));

  console.log(`\nAUTH TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Auth test harness crashed:', err); process.exit(1); });
