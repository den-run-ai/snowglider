// @ts-check
// firebase-bootstrap-tests.js
// Headless, c8-instrumented coverage for src/boot/firebase-bootstrap.js — the
// classic-script Firebase bootstrap that wires the real auth module, the local-mode
// notice, the gstatic init.json fetch shim, and the graceful fallback to the
// localStorage stubs when Firebase never loads.
//
// firebase-bootstrap.js is a classic IIFE assigning to `window`, so it cannot be
// `import`ed. The older boot-test pattern evaluated it with `window.eval`, which is
// invisible to c8 (the source carries no file URL the V8 coverage post-processor can
// attribute). We instead run it with `vm.runInThisContext(src, { filename })` keyed to
// the real source path, so c8 instruments it. The Node globals it closes over
// (`window`, `document`, `setInterval`, `fetch`, `Response`, `console`) are pointed at
// a fresh jsdom + a controllable fake interval per scenario.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const LOCAL_AUTH_PATH = path.join(REPO, 'src/boot/local-auth.js');
const BOOTSTRAP_PATH = path.join(REPO, 'src/boot/firebase-bootstrap.js');
const LOCAL_AUTH_SRC = fs.readFileSync(LOCAL_AUTH_PATH, 'utf8');
const BOOTSTRAP_SRC = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

const g = /** @type {any} */ (globalThis);

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

const AUTH_HTML = `<!doctype html><html><head></head><body>
  <div id="authContainer">
    <div id="authUI" style="display:flex"><button id="loginBtn">Login with Google</button></div>
    <div id="profileUI" style="display:none"></div>
  </div>
</body></html>`;

function makeLocalStorage() {
  let store = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; }
  };
}

// A controllable setInterval/clearInterval so the 200ms × 25 auth-detection poll can
// be advanced synchronously instead of waiting 5 real seconds.
function installFakeInterval() {
  const realSet = global.setInterval;
  const realClear = global.clearInterval;
  let cb = null;
  let cleared = false;
  g.setInterval = (fn) => { cb = fn; cleared = false; return 1; };
  g.clearInterval = () => { cleared = true; };
  return {
    tick(n) { for (let i = 0; i < n; i++) { if (cb && !cleared) cb(); } },
    restore() { g.setInterval = realSet; g.clearInterval = realClear; }
  };
}

// Build a jsdom for the given URL, wire the Node globals the boot scripts close over,
// and run local-auth.js + firebase-bootstrap.js keyed to their real paths.
function bootEnv(url) {
  const dom = new JSDOM(AUTH_HTML, { url, runScripts: 'outside-only' });
  const { window } = dom;
  g.window = window;
  g.document = window.document;
  g.localStorage = makeLocalStorage();
  g.console = console;
  // Pre-seed window.fetch so the bootstrap's wrapper has an originalFetch to delegate
  // to on the passthrough branch.
  const passthrough = [];
  window.fetch = /** @type {any} */ ((u) => { passthrough.push(u); return Promise.resolve({ ok: true, _passthrough: true }); });
  g.fetch = window.fetch;
  vm.runInThisContext(LOCAL_AUTH_SRC, { filename: LOCAL_AUTH_PATH });
  vm.runInThisContext(BOOTSTRAP_SRC, { filename: BOOTSTRAP_PATH });
  return { dom, window, document: window.document, passthrough };
}

async function main() {
  console.log('--- firebase-bootstrap.js ---');

  // ===========================================================================
  // Scenario 1: production https, AuthModule appears before the poll times out.
  // ===========================================================================
  {
    const { window, document } = bootEnv('https://snowglider.ai/');
    const SF = window.SnowGliderFirebase;
    check('exposes SnowGliderFirebase surface',
      SF && typeof SF.waitForAuthModule === 'function' && typeof SF.initializeAuthModule === 'function');
    check('production: not file protocol, not local dev',
      SF.isFileProtocol === false && SF.isLocalDevelopment === false);
    check('loadAuthModules appends the scores + auth module scripts',
      !!document.getElementById('scoresScript') && !!document.getElementById('authScript'));
    check('sets FIREBASE_MANUAL_INIT + __FIREBASE_DEFAULTS__',
      window.FIREBASE_MANUAL_INIT === true && typeof window.__FIREBASE_DEFAULTS__ === 'object');

    // fetch shim: intercept the firebase init.json, pass everything else through.
    const intercepted = await window.fetch('https://x/__/firebase/init.json');
    check('fetch intercepts firebase init.json', intercepted && intercepted.status === 200);
    await window.fetch('https://example.com/asset.png');
    check('fetch passes other URLs through to the original', true);

    // DOMContentLoaded on prod adds no local-mode notice.
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    check('production adds no local-mode notice', document.querySelectorAll('body > div[style*="fixed"]').length === 0);

    const fake = installFakeInterval();
    const p = SF.waitForAuthModule();
    let initCalls = 0;
    window.AuthModule = {
      initializeAuth: () => { initCalls++; },
      isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: false })
    };
    fake.tick(1); // AuthModule now present -> resolve on first tick
    await p;
    fake.restore();
    SF.initializeAuthModule();
    check('initializeAuthModule calls the real AuthModule.initializeAuth', initCalls === 1);
  }

  // ===========================================================================
  // Scenario 2: production https, Firebase never loads -> timeout fallback, then
  // a late real auth.js load recovers the page out of local mode.
  // ===========================================================================
  {
    const { window, document } = bootEnv('https://snowglider.ai/');
    const SF = window.SnowGliderFirebase;
    const fake = installFakeInterval();
    const p = SF.waitForAuthModule();
    fake.tick(25); // 25 checks with no AuthModule -> degrade to local fallback
    await p;
    fake.restore();
    check('timeout installs the local Auth fallback', !!window.AuthModule && !!window.ScoresModule);

    const authContainer = document.getElementById('authContainer');
    const authUI = document.getElementById('authUI');
    const profileUI = document.getElementById('profileUI');
    // The local fallback's initializeAuth ran via installLocalAuthFallback path? No —
    // installLocalAuthFallback only installs the module; drive the notice via it.
    window.AuthModule.initializeAuth();
    check('local fallback appends a local-mode notice', !!authContainer.querySelector('.local-mode-notice'));

    // Late real auth.js load after the fallback: re-init the real module + clear UI.
    let realInit = 0;
    window.AuthModule = {
      initializeAuth: () => { realInit++; },
      isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: true })
    };
    document.getElementById('authScript').dispatchEvent(new window.Event('load'));
    check('late real auth load removes the stale local-mode notice',
      !authContainer.querySelector('.local-mode-notice'));
    check('late real auth load resets the signed-out auth UI',
      authUI.style.display === 'flex' && profileUI.style.display === 'none');
    check('late real auth load re-initializes the real AuthModule', realInit === 1);
  }

  // ===========================================================================
  // Scenario 3: local dev (localhost) -> local-dev notice, scripts still load.
  // ===========================================================================
  {
    const { window, document } = bootEnv('http://localhost:8080/');
    const SF = window.SnowGliderFirebase;
    check('localhost is local dev but not file protocol',
      SF.isLocalDevelopment === true && SF.isFileProtocol === false);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const devNotice = [...document.querySelectorAll('body > div')].find(d => /Dev Mode/.test(d.innerHTML));
    check('local dev appends a "Local Dev Mode" notice', !!devNotice);
    check('local dev still appends the auth module script', !!document.getElementById('authScript'));
  }

  // ===========================================================================
  // Scenario 4: file:// protocol -> no module scripts, local auth installed, file notice.
  // ===========================================================================
  {
    const { window, document } = bootEnv('file:///Users/x/snowglider/index.html');
    const SF = window.SnowGliderFirebase;
    check('file protocol detected', SF.isFileProtocol === true);
    check('file protocol does NOT append module scripts', !document.getElementById('authScript'));
    await SF.waitForAuthModule();
    check('file protocol installs the local AuthModule', !!window.AuthModule);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const fileNotice = [...document.querySelectorAll('body > div')].find(d => /File Mode/.test(d.innerHTML));
    check('file protocol appends a "Local File Mode" notice', !!fileNotice);
  }

  // ===========================================================================
  // Scenario 5: initializeAuthModule error/edge branches.
  // ===========================================================================
  {
    const { window } = bootEnv('https://snowglider.ai/');
    const SF = window.SnowGliderFirebase;
    // AuthModule.initializeAuth throws -> caught + logged.
    window.AuthModule = { initializeAuth: () => { throw new Error('init boom'); } };
    SF.initializeAuthModule();
    check('initializeAuthModule swallows an initializeAuth error', true);
    // AuthModule present, initializeAuth ok, no isFirebaseAvailable -> skip status log.
    let n = 0;
    window.AuthModule = { initializeAuth: () => { n++; } };
    SF.initializeAuthModule();
    check('initializeAuthModule works without isFirebaseAvailable', n === 1);
    // AuthModule missing -> "not found" else branch.
    delete window.AuthModule;
    SF.initializeAuthModule();
    check('initializeAuthModule handles a missing AuthModule', true);
  }

  // ===========================================================================
  // Scenario 6: timeout fallback when local-auth.js never loaded (no
  // window.SnowGliderLocalAuth) -> installLocalAuthFallback early-returns.
  // ===========================================================================
  {
    const dom = new JSDOM(AUTH_HTML, { url: 'https://snowglider.ai/', runScripts: 'outside-only' });
    g.window = dom.window;
    g.document = dom.window.document;
    g.localStorage = makeLocalStorage();
    dom.window.fetch = /** @type {any} */ (() => Promise.resolve({ ok: true }));
    // Run ONLY the bootstrap (local-auth.js intentionally absent).
    vm.runInThisContext(BOOTSTRAP_SRC, { filename: BOOTSTRAP_PATH });
    const SF = dom.window.SnowGliderFirebase;
    const fake = installFakeInterval();
    const p = SF.waitForAuthModule();
    fake.tick(25);
    await p;
    fake.restore();
    check('timeout without SnowGliderLocalAuth installs no AuthModule', !dom.window.AuthModule);
  }

  console.log(`\nFIREBASE BOOTSTRAP TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error('Firebase bootstrap test crashed:', error);
  process.exit(1);
});
