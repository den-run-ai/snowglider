// @ts-check
// offline-state-tests.js — headless coverage for src/offline/offline-state.ts
// (issue #358, PR 1). Verifies connectivity detection, standalone detection, the
// global-features combinator, and the online/offline subscription (including
// teardown-clean unsubscribe). Auto-discovered by tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ online: true });
  const state = await import('../src/offline/offline-state.ts');

  // --- isOnline / isOffline read window.navigator.onLine ---
  check('isOnline() true when navigator reports online', state.isOnline() === true);
  check('isOffline() false when online', state.isOffline() === false);
  env.setOnline(false);
  check('isOnline() false after setOnline(false)', state.isOnline() === false);
  check('isOffline() true when offline', state.isOffline() === true);
  env.setOnline(true);

  // --- globalFeaturesAvailable is a pure AND of online + firebase ---
  check('global features need firebase (online, no firebase)', state.globalFeaturesAvailable(false) === false);
  check('global features available (online + firebase)', state.globalFeaturesAvailable(true) === true);
  env.setOnline(false);
  check('global features unavailable offline even with firebase', state.globalFeaturesAvailable(true) === false);
  env.setOnline(true);

  // --- isStandalone: jsdom has no matchMedia / navigator.standalone ---
  check('isStandalone() false in a plain (non-installed) context', state.isStandalone() === false);

  // Simulate iOS standalone via navigator.standalone.
  Object.defineProperty(env.window.navigator, 'standalone', { configurable: true, get: () => true });
  check('isStandalone() true when navigator.standalone is set (iOS)', state.isStandalone() === true);
  Object.defineProperty(env.window.navigator, 'standalone', { configurable: true, get: () => false });

  // Simulate display-mode: standalone via matchMedia (cast: the src only reads .matches).
  env.window.matchMedia = /** @type {any} */ ((q) => ({ matches: q.includes('standalone'), media: q }));
  check('isStandalone() true when display-mode: standalone matches', state.isStandalone() === true);
  env.window.matchMedia = /** @type {any} */ (undefined);

  // --- watchConnectivity: fires on transitions, unsubscribe stops it ---
  /** @type {boolean[]} */
  const events = [];
  const unsubscribe = state.watchConnectivity((online) => events.push(online));
  env.window.dispatchEvent(new env.window.Event('offline'));
  env.window.dispatchEvent(new env.window.Event('online'));
  check('watchConnectivity received offline then online', events.length === 2 && events[0] === false && events[1] === true);

  unsubscribe();
  env.window.dispatchEvent(new env.window.Event('offline'));
  check('unsubscribe() stops further notifications', events.length === 2);

  // A throwing subscriber must not break the dispatch.
  let secondCalled = false;
  const unsubA = state.watchConnectivity(() => { throw new Error('boom'); });
  const unsubB = state.watchConnectivity(() => { secondCalled = true; });
  env.window.dispatchEvent(new env.window.Event('offline'));
  // Read through a function so CFA doesn't narrow `secondCalled` to its literal init.
  check('a throwing listener is isolated (others still fire)', Boolean(secondCalled));
  unsubA();
  unsubB();

  // --- Headless fallback paths: no window/navigator at all ---
  const savedWindow = globalThis.window;
  const savedNavigator = globalThis.navigator;
  try {
    // Deliberately remove the DOM globals to exercise the Node/headless path.
    globalThis.window = /** @type {any} */ (undefined);
    // navigator may be a read-only global in Node; try to shadow it, ignore if we can't.
    try { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined }); } catch { /* leave Node's navigator */ }
    check('isOnline() optimistic true with no navigator.onLine', state.isOnline() === true);
    check('isStandalone() false with no window/navigator', state.isStandalone() === false);
    const noop = state.watchConnectivity(() => {});
    check('watchConnectivity returns a no-op unsubscribe with no window', typeof noop === 'function');
    let unsubThrew = false;
    try { noop(); } catch { unsubThrew = true; }
    check('the no-op unsubscribe is safe to call', unsubThrew === false);
  } finally {
    globalThis.window = savedWindow;
    try { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: savedNavigator }); } catch { /* restore best-effort */ }
  }

  env.teardown();
  console.log(`\nOFFLINE-STATE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
