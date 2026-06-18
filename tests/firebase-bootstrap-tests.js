// firebase-bootstrap-tests.js
// Headless coverage for the auth bootstrap fallback/recovery path.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

function loadBrowserScript(window, relativePath) {
  const code = fs.readFileSync(path.join(REPO, relativePath), 'utf8');
  window.eval(code);
}

async function main() {
  console.log('--- Firebase bootstrap late-auth recovery ---');

  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="authContainer">
      <div id="authUI" style="display:flex"><button id="loginBtn">Login with Google</button></div>
      <div id="profileUI" style="display:none"></div>
    </div>
  </body></html>`, {
    url: 'https://snowglider.ai/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.console = console;

  loadBrowserScript(window, 'src/boot/local-auth.js');
  loadBrowserScript(window, 'src/boot/firebase-bootstrap.js');

  await window.SnowGliderFirebase.waitForAuthModule();
  window.SnowGliderFirebase.initializeAuthModule();

  const authContainer = window.document.getElementById('authContainer');
  const authUI = window.document.getElementById('authUI');
  const profileUI = window.document.getElementById('profileUI');
  check('local fallback appends a local-mode notice',
    !!authContainer.querySelector('.local-mode-notice'));
  check('local fallback hides real auth UI',
    authUI.style.display === 'none' && profileUI.style.display === 'none');

  let realInitCalls = 0;
  window.AuthModule = {
    initializeAuth: () => { realInitCalls++; },
    isFirebaseAvailable: () => ({ auth: true, firestore: true, analytics: true })
  };

  const authScript = window.document.getElementById('authScript');
  authScript.dispatchEvent(new window.Event('load'));

  check('late real auth load removes stale local-mode notice',
    !authContainer.querySelector('.local-mode-notice'));
  check('late real auth load resets signed-out auth UI',
    authUI.style.display === 'flex' && profileUI.style.display === 'none');
  check('late real auth module is initialized',
    realInitCalls === 1);

  console.log(`\nFIREBASE BOOTSTRAP TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error('Firebase bootstrap test crashed:', error);
  process.exit(1);
});
