// @ts-check
// pwa-sw-config-tests.js — headless coverage for src/pwa/sw-config.ts (issue #358,
// PR 3): the pure service-worker policy predicates that decide WHEN the SW registers
// and WHICH routes it must never touch. This is where the load-bearing "never hijack
// ?test= / deployed tests / src / node_modules / auth.html" guarantees are tested (the
// worker's live fetch routing can't run under jsdom). Auto-discovered by
// tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

async function main() {
  const c = await import('../src/pwa/sw-config.ts');

  const https = (pathname, search = '') => ({ protocol: 'https:', hostname: 'snowglider.ai', pathname, search });
  const localhost = (pathname, search = '') => ({ protocol: 'http:', hostname: 'localhost', pathname, search });

  // --- shouldRegisterServiceWorker ---
  check('registers on https root', c.shouldRegisterServiceWorker(https('/', '')) === true);
  check('registers on http://localhost (dev)', c.shouldRegisterServiceWorker(localhost('/', '')) === true);
  check('registers on http://127.0.0.1 (dev)', c.shouldRegisterServiceWorker({ protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '' }) === true);
  check('does NOT register on plain-http non-local host', c.shouldRegisterServiceWorker({ protocol: 'http:', hostname: 'example.com', pathname: '/', search: '' }) === false);
  check('does NOT register on file://', c.shouldRegisterServiceWorker({ protocol: 'file:', hostname: '', pathname: '/index.html', search: '' }) === false);
  check('does NOT register on auth.html', c.shouldRegisterServiceWorker(https('/auth.html', '')) === false);
  check('does NOT register under ?test=', c.shouldRegisterServiceWorker(https('/', '?test=unified')) === false);
  check('does NOT register under ?no-sw=1', c.shouldRegisterServiceWorker(https('/', '?no-sw=1')) === false);
  check('does NOT register under ?sw=reset', c.shouldRegisterServiceWorker(https('/', '?sw=reset')) === false);

  // --- isSecureContextForSw ---
  check('https is a secure context', c.isSecureContextForSw({ protocol: 'https:', hostname: 'snowglider.ai' }) === true);
  check('http localhost is secure', c.isSecureContextForSw({ protocol: 'http:', hostname: 'localhost' }) === true);
  check('http remote is NOT secure', c.isSecureContextForSw({ protocol: 'http:', hostname: 'evil.test' }) === false);

  // --- reset / disabled detection ---
  check('isSwResetRequest true for ?sw=reset', c.isSwResetRequest('?sw=reset') === true);
  check('isSwResetRequest false for ?sw=on', c.isSwResetRequest('?sw=on') === false);
  check('isSwResetRequest false for empty', c.isSwResetRequest('') === false);
  check('isSwDisabledRequest true for ?no-sw=1', c.isSwDisabledRequest('?no-sw=1') === true);
  check('isSwDisabledRequest true for bare ?no-sw', c.isSwDisabledRequest('?no-sw') === true);
  check('isSwDisabledRequest false otherwise', c.isSwDisabledRequest('?foo=1') === false);

  // --- isBypassedPath (subresource/navigation passthrough) ---
  check('bypass /auth.html', c.isBypassedPath('/auth.html') === true);
  check('bypass /tests/...', c.isBypassedPath('/tests/browser-tests.js') === true);
  check('bypass /src/...', c.isBypassedPath('/src/main.js') === true);
  check('bypass /node_modules/...', c.isBypassedPath('/node_modules/three/build/three.module.min.js') === true);
  check('do NOT bypass the app root', c.isBypassedPath('/') === false);
  check('do NOT bypass /assets/...', c.isBypassedPath('/assets/index-abc.js') === false);

  // --- shouldServeAppShell (the query-aware navigation gate) ---
  check('serve app shell for a normal navigation', c.shouldServeAppShell({ pathname: '/', search: '' }) === true);
  check('serve app shell for a deep in-app path', c.shouldServeAppShell({ pathname: '/some/route', search: '' }) === true);
  check('do NOT serve shell for /?test= (test suite navigation)', c.shouldServeAppShell({ pathname: '/', search: '?test=unified' }) === false);
  check('do NOT serve shell for /auth.html', c.shouldServeAppShell({ pathname: '/auth.html', search: '' }) === false);
  check('do NOT serve shell for /tests/...', c.shouldServeAppShell({ pathname: '/tests/x.html', search: '' }) === false);
  check('do NOT serve shell for /src/...', c.shouldServeAppShell({ pathname: '/src/main.js', search: '' }) === false);
  check('do NOT serve shell under ?no-sw', c.shouldServeAppShell({ pathname: '/', search: '?no-sw=1' }) === false);
  check('do NOT serve shell under ?sw=reset', c.shouldServeAppShell({ pathname: '/', search: '?sw=reset' }) === false);

  // --- isAutomationSearch mirrors the codebase automation gate ---
  check('isAutomationSearch true for ?test=', c.isAutomationSearch('?test=camera') === true);
  check('isAutomationSearch false otherwise', c.isAutomationSearch('?difficulty=black') === false);

  // --- forbidden-precache list is the contract the build guard enforces ---
  check('forbidden list covers src/tests/node_modules/auth/mp3/map', ['/src/', '/tests/', '/node_modules/', 'auth.html', '.mp3', '.map'].every((s) => c.FORBIDDEN_PRECACHE_SUBSTRINGS.includes(s)));

  console.log(`\nPWA SW-CONFIG TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
