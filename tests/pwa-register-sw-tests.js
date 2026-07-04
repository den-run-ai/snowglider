// @ts-check
// pwa-register-sw-tests.js — headless coverage for src/pwa/register-sw.ts (issue
// #358, PR 3): the registration gating, the ?sw=reset escape hatch, and the safe
// update flow. Driven with a fake `win` (+ navigator.serviceWorker / global caches
// mocks) so no real SW is needed. Auto-discovered by tests/run-node-suite.js.
'use strict';

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * A listenable fake ServiceWorker with a controllable state.
 * @returns {any}
 */
function fakeWorker() {
  const listeners = {};
  return {
    state: 'installing',
    postMessage() { this._posted = true; },
    addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    _fire(type) { (listeners[type] || []).forEach((cb) => cb()); },
  };
}

/** @returns {any} */
function makeFakeWin(opts = {}) {
  const {
    protocol = 'https:', hostname = 'snowglider.ai', pathname = '/', search = '',
    hasSW = true, readyState = 'complete', controller = null, registrations = [],
  } = opts;
  const winListeners = {};
  const swListeners = {};
  const reg = { installing: null, waiting: null, _found: [], addEventListener(t, cb) { (reg._found ||= []); if (t === 'updatefound') reg._found.push(cb); } };
  let registered = null;
  const serviceWorker = {
    controller,
    register(url) { registered = url; return Promise.resolve(reg); },
    getRegistrations() { return Promise.resolve(registrations); },
    addEventListener(t, cb) { (swListeners[t] ||= []).push(cb); },
    _fire(t) { (swListeners[t] || []).forEach((cb) => cb()); },
  };
  const win = {
    location: {
      protocol, hostname, pathname, search,
      href: `${protocol}//${hostname}${pathname}${search}`,
      replace() { this._replaced = true; }, reload() { this._reloaded = true; },
    },
    navigator: hasSW ? { serviceWorker } : {},
    document: { readyState },
    addEventListener(t, cb) { (winListeners[t] ||= []).push(cb); },
    _fire(t) { (winListeners[t] || []).forEach((cb) => cb()); },
  };
  return { win, reg, serviceWorker, get registered() { return registered; } };
}

/** Install a global caches mock; returns the deleted-keys log. */
function installCachesMock(keys) {
  const deleted = [];
  globalThis.caches = /** @type {any} */ ({
    keys: () => Promise.resolve(keys.slice()),
    delete: (k) => { deleted.push(k); return Promise.resolve(true); },
  });
  return deleted;
}

async function main() {
  const rs = await import('../src/pwa/register-sw.ts');

  // --- Gating: unsupported / test / auth / reset / secure ---
  check('no register when serviceWorker unsupported', rs.initServiceWorker({}, makeFakeWin({ hasSW: false }).win) === false);
  check('no register under ?test=', rs.initServiceWorker({}, makeFakeWin({ search: '?test=unified' }).win) === false);
  check('no register on auth.html', rs.initServiceWorker({}, makeFakeWin({ pathname: '/auth.html' }).win) === false);
  check('no register under ?no-sw=1', rs.initServiceWorker({}, makeFakeWin({ search: '?no-sw=1' }).win) === false);

  // --- Happy path: registers /sw.js on a complete https document ---
  const h = makeFakeWin({ readyState: 'complete' });
  check('registers on https root (returns true)', rs.initServiceWorker({}, h.win) === true);
  await flush();
  check('called navigator.serviceWorker.register with /sw.js', h.registered === '/sw.js');

  // Registers after `load` when the document is still loading.
  const loading = makeFakeWin({ readyState: 'loading' });
  rs.initServiceWorker({}, loading.win);
  check('does not register before load when document still loading', loading.registered === null);
  loading.win._fire('load');
  await flush();
  check('registers once the load event fires', loading.registered === '/sw.js');

  // --- ?sw=reset: does NOT register; unregisters + clears caches + reloads ---
  const resetReg = { unregister() { this._unregistered = true; return Promise.resolve(true); } };
  const r = makeFakeWin({ search: '?sw=reset', registrations: [resetReg] });
  const deleted = installCachesMock(['snowglider-audio', 'workbox-precache-v2', 'unrelated-cache']);
  check('?sw=reset does not register', rs.initServiceWorker({}, r.win) === false);
  await flush(); await flush();
  check('reset unregistered the existing SW', resetReg._unregistered === true);
  check('reset deleted our caches (snowglider-* + workbox-*)', deleted.includes('snowglider-audio') && deleted.includes('workbox-precache-v2'));
  check('reset left unrelated caches alone', !deleted.includes('unrelated-cache'));
  check('reset reloaded from the network', r.win.location._replaced === true);

  // resetServiceWorker is safe with no serviceWorker + no caches.
  delete globalThis.caches;
  let resetThrew = false;
  try { await rs.resetServiceWorker(makeFakeWin({ hasSW: false }).win); } catch { resetThrew = true; }
  check('resetServiceWorker is safe without SW/caches', resetThrew === false);

  // --- Update flow: an installed worker with an existing controller notifies ---
  const u = makeFakeWin({ controller: {} });
  /** @type {any} */
  let applyFn = null;
  rs.wireUpdateFlow(u.reg, u.win, (apply) => { applyFn = apply; });
  const worker = fakeWorker();
  u.reg.installing = worker;
  u.reg._found.forEach((cb) => cb()); // updatefound
  worker.state = 'installed';
  worker._fire('statechange');
  check('update flow surfaced an apply() callback', typeof applyFn === 'function');
  applyFn();
  check('apply() posted SKIP_WAITING to the waiting worker', worker._posted === true);
  // controllerchange after activation reloads.
  u.serviceWorker._fire('controllerchange');
  check('controllerchange reloaded the page', u.win.location._reloaded === true);

  // First install (no existing controller) does NOT notify — not an update.
  const first = makeFakeWin({ controller: null });
  let firstNotified = false;
  rs.wireUpdateFlow(first.reg, first.win, () => { firstNotified = true; });
  const w2 = fakeWorker();
  first.reg.installing = w2;
  first.reg._found.forEach((cb) => cb());
  w2.state = 'installed';
  w2._fire('statechange');
  check('first install does NOT show an update prompt', firstNotified === false);

  console.log(`\nPWA REGISTER-SW TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
