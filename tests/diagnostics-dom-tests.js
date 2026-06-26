// @ts-check
// diagnostics-dom-tests.js — jsdom coverage for the BROWSER-only paths of diagnostics.ts
// that the headless diagnostics-tests.js cannot reach: the init() browser branch, the dev
// overlay (create / paint / toggle / hide), the window.__snowgliderDiag bug-report API,
// dump()'s Blob download, and the global error / unhandledrejection capture.
//
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/diagnostics-dom-tests.js
//
// Mirrors tests/verification/dom_smoke_test.js: stand up a jsdom window/document, then
// import the REAL module and drive its DOM code directly (no browser, no WebGL).
const { JSDOM } = require('jsdom');

// ?debug in the URL so init() opens the overlay; jsdom's navigator.webdriver is false and
// isTestMode is unset, so the recorder treats this as normal play and stays active.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/?debug', pretendToBeVisual: true,
});
const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
// diagnostics.ts creates `new AbortController()` for its listeners; jsdom validates the
// resulting signal against ITS realm's AbortSignal, so alias the global to the window's
// (in a real browser they are the same object).
g.AbortController = window.AbortController;
// Blob download seam: jsdom has no URL.createObjectURL; stub it so dump()'s browser branch
// executes end-to-end, and silence the anchor's real navigation on click().
global.Blob = global.Blob || window.Blob;
window.URL.createObjectURL = () => 'blob:diag';
window.URL.revokeObjectURL = () => {};
global.URL = window.URL;
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = function (tag) {
  const el = origCreate(tag);
  if (tag === 'a') el.click = () => {}; // avoid jsdom "navigation not implemented"
  return el;
};

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const D = await import('../src/diagnostics.js');
  const events = [];
  D.Diag.init({ ...D.DEFAULT_CONFIG, healthSampleSec: 1 }, { report: (event, data) => events.push({ event, data }) });

  // --- init() browser branch + overlay creation (?debug) ----------------------
  check('init: ?debug creates the dev overlay', !!document.getElementById('diagOverlay'));
  check('init: exposes window.__snowgliderDiag bug-report API',
    !!window.__snowgliderDiag && typeof window.__snowgliderDiag.dump === 'function');

  // --- drive frames so the overlay paints, across MULTIPLE fps bands ----------
  // Mixed dt populates several FPS bands (>=50, 15-30, <15) so the band table + the
  // paint loop's branches are exercised; a late runaway flips health so paint renders
  // the reasons block too.
  let z = -15;
  const rec = (dt, speed) => { z -= speed * dt; D.Diag.record({ dt, speed, x: 0, z, technique: 'tuck', isInAir: false }); };
  for (let i = 0; i < 40; i++) rec(1 / 60, 8);   // >=50 band, healthy
  for (let i = 0; i < 20; i++) rec(1 / 20, 9);   // 15-30 band
  for (let i = 0; i < 20; i++) rec(0.1, 12);     // <15 band (clamped)
  check('overlay: repaints while recording (overlay still present)', !!document.getElementById('diagOverlay'));
  const painted = document.getElementById('diagOverlay').textContent;
  check('overlay: shows the fps / speed HUD text', /fps/.test(painted) && /spd/.test(painted));
  check('overlay: renders the speed-by-fps-band table', /by fps band/.test(painted));

  // Push it BAD so the paint reasons block + warn paths run.
  for (let i = 0; i < 10; i++) rec(1 / 60, 80); // runaway -> BAD
  check('overlay: a healthy heartbeat was emitted while playing',
    events.some((e) => e.event === 'session_health'));
  check('report: a runaway run emitted physics_anomaly', events.some((e) => e.event === 'physics_anomaly'));

  // --- window API: snapshot / dump (Blob branch) / overlay toggle / reset -----
  const snap = /** @type {any} */ (window.__snowgliderDiag.snapshot());
  check('api: snapshot() returns a health verdict', !!snap && !!snap.health);
  const dumped = /** @type {any} */ (window.__snowgliderDiag.dump()); // exercises the Blob/createObjectURL/anchor path
  check('api: dump() returns the same structured snapshot', !!dumped && !!dumped.summary);

  window.__snowgliderDiag.overlay(false);
  check('api: overlay(false) hides the overlay', !document.getElementById('diagOverlay'));
  window.__snowgliderDiag.overlay(true);
  check('api: overlay(true) re-creates the overlay', !!document.getElementById('diagOverlay'));

  // --- backtick hotkey toggles the overlay ------------------------------------
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '`' }));
  check('hotkey: backtick hides the overlay', !document.getElementById('diagOverlay'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '`' }));
  check('hotkey: backtick shows it again', !!document.getElementById('diagOverlay'));

  // --- global error + unhandledrejection capture ------------------------------
  events.length = 0;
  const errEvt = new window.Event('error');
  Object.assign(errEvt, { message: 'kaboom', filename: 'snowglider.ts', lineno: 42, error: new Error('kaboom') });
  window.dispatchEvent(errEvt);
  const clientErr = events.find((e) => e.event === 'client_error');
  check('error: window.onerror is captured and reported', !!clientErr && clientErr.data.message === 'kaboom');
  check('error: capture attaches physics context (health level)', !!clientErr && typeof clientErr.data.health === 'string');

  const rejEvt = new window.Event('unhandledrejection');
  Object.assign(rejEvt, { reason: new Error('promise blew up') });
  window.dispatchEvent(rejEvt);
  check('error: unhandledrejection is captured and reported',
    events.some((e) => e.event === 'unhandled_rejection' && /promise blew up/.test(String(e.data.message))));

  // a rejection whose reason is a bare string (no .message / .stack) is still captured.
  events.length = 0;
  window.dispatchEvent(Object.assign(new window.Event('unhandledrejection'), { reason: 'plain string reason' }));
  check('error: a non-Error rejection reason is still captured',
    events.some((e) => e.event === 'unhandled_rejection' && /plain string reason/.test(String(e.data.message))));

  // a bare error event (no message / filename / lineno / error) still reports via fallbacks.
  events.length = 0;
  window.dispatchEvent(new window.Event('error'));
  check('error: a bare error event reports with fallbacks (message "error", empty stack)',
    events.some((e) => e.event === 'client_error' && e.data.message === 'error' && e.data.stack === ''));

  // --- init() is idempotent: a second call must not double-install handlers ----
  D.Diag.init({ ...D.DEFAULT_CONFIG }, { report: (event, data) => events.push({ event, data }) });
  events.length = 0;
  window.dispatchEvent(Object.assign(new window.Event('error'), { message: 'once', error: new Error('once') }));
  check('init: error handlers are installed once (one report per error, not duplicated)',
    events.filter((e) => e.event === 'client_error').length === 1);

  // --- teardown(): removes the window listeners + overlay + __snowgliderDiag ----
  // (dispose-audit). After teardown the error capture is gone, the bug-report API is
  // deleted, and the overlay node is removed; a second call is a no-op.
  D.Diag.teardown();
  check('teardown: deletes window.__snowgliderDiag', window.__snowgliderDiag === undefined);
  check('teardown: removes the dev overlay node', !document.getElementById('diagOverlay'));
  events.length = 0;
  window.dispatchEvent(Object.assign(new window.Event('error'), { message: 'after', error: new Error('after') }));
  check('teardown: the error/unhandledrejection capture is removed (no report after teardown)',
    events.filter((e) => e.event === 'client_error').length === 0);
  let threw = false;
  try { D.Diag.teardown(); } catch { threw = true; }
  check('teardown: idempotent (a second call does not throw)', !threw);

  console.log(`\nDIAGNOSTICS DOM TESTS: ${fail === 0 ? 'OK ✅' : 'FAIL ❌'} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
