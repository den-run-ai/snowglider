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

  // Error transport contains bounded aggregate fields; free-form error text stays
  // only in the explicit local dump and cannot leak account details to GA4.
  events.length = 0;
  const privateText = 'person@example.invalid token=do-not-upload';
  D.Diag.reportError(new TypeError(privateText), 'animation_loop');
  const caughtErr = events.find((e) => e.event === 'client_error');
  check('caught error: reports type and recovery source', !!caughtErr &&
    caughtErr.data.error_type === 'TypeError' && caughtErr.data.error_source === 'animation_loop');
  check('caught error: attaches the current run context', !!caughtErr &&
    caughtErr.data.frames === 90 && caughtErr.data.health === 'bad');
  check('caught error: excludes message and stack from transport', !!caughtErr &&
    !('message' in caughtErr.data) && !('stack' in caughtErr.data) && !('source' in caughtErr.data) &&
    !JSON.stringify(caughtErr.data).includes(privateText));
  check('caught error: local diagnostic dump preserves debugging text',
    D.Diag.dump().errors.some(n => n.message === privateText));
  check('public feedback snapshot excludes raw error text',
    !JSON.stringify(D.Diag.snapshot()).includes(privateText));
  D.Diag.reportError(new TypeError('another copy'), 'animation_loop');
  check('caught error: repeated failures at the same site are sent once', events.length === 1);
  D.Diag.reset();
  D.Diag.reportError(new TypeError('after restart'), 'animation_loop');
  check('caught error: restarting cannot reset the upload budget', events.length === 1);

  D.Diag.init(undefined, { report: () => { throw new Error('analytics offline'); } });
  let reportThrew = false;
  try { D.Diag.reportError(new RangeError('caught'), 'animation_loop'); } catch { reportThrew = true; }
  check('caught error: a broken transport cannot interrupt recovery', !reportThrew);
  D.Diag.init(undefined, { report: (event, data) => events.push({ event, data }) });

  events.length = 0;
  const errEvt = new window.Event('error');
  Object.assign(errEvt, { message: privateText, filename: 'https://example.invalid/?token=secret',
    lineno: 42, colno: 7, error: new ReferenceError(privateText) });
  window.dispatchEvent(errEvt);
  check('global error: captures a safe source position', events.length === 1 &&
    events[0].data.error_source === 'window_error' && events[0].data.line === 42 && events[0].data.column === 7);
  check('global error: excludes message, stack and filename URLs',
    !JSON.stringify(events).includes(privateText) && !JSON.stringify(events).includes('token=secret'));

  const hostile = new Proxy({}, { get() { throw new Error('hostile error getter'); } });
  window.dispatchEvent(Object.assign(new window.Event('unhandledrejection'), { reason: hostile }));
  check('rejection: hostile fields still produce one safe error report',
    events.some(e => e.event === 'unhandled_rejection' && e.data.error_type === 'Error'));
  window.dispatchEvent(Object.assign(new window.Event('unhandledrejection'), { reason: privateText }));
  check('rejection: raw string failures are retained only locally',
    D.Diag.dump().errors.some(n => n.message === privateText) &&
    !JSON.stringify(events).includes(privateText));

  // Re-init removes handlers before installing the new pair.
  D.Diag.init({ ...D.DEFAULT_CONFIG }, { report: (event, data) => events.push({ event, data }) });
  events.length = 0;
  window.dispatchEvent(Object.assign(new window.Event('error'), { message: 'once',
    lineno: 99, error: new Error('once') }));
  check('init: error handlers are installed once', events.length === 1);

  let reportReady = false;
  D.Diag.init(undefined, { report: (event, data) => events.push({ event, data }),
    reportReady: () => reportReady });
  events.length = 0;
  D.Diag.reportError(new SyntaxError('before Firebase'), 'animation_loop');
  check('startup: unavailable transport does not consume the error budget', events.length === 0);
  reportReady = true;
  D.Diag.reportError(new SyntaxError('after Firebase'), 'animation_loop');
  D.Diag.reportError(new SyntaxError('repeated after Firebase'), 'animation_loop');
  check('startup: the same error delivers once after transport readiness', events.length === 1);

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
  events.length = 0;
  D.Diag.reportError(new Error('after teardown'), 'animation_loop');
  check('caught error: disabled after teardown', events.length === 0);
  window.isTestMode = true;
  D.Diag.init(undefined, { report: (event, data) => events.push({ event, data }) });
  D.Diag.reportError(new Error('automated'), 'animation_loop');
  check('caught error: respects the automation gate', events.length === 0);
  D.Diag.teardown();

  console.log(`\nDIAGNOSTICS DOM TESTS: ${fail === 0 ? 'OK ✅' : 'FAIL ❌'} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
