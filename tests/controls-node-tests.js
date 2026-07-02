// @ts-check
// controls-node-tests.js
// Headless, c8-instrumented coverage for src/controls.ts (keyboard + touch input).
//
// controls.ts uses no three.js and no Firebase — only the DOM — so the harness just
// sets up jsdom and `import`s the real `.ts` under the existing .js->.ts resolve hook;
// c8 then instruments it with correct source-mapped lines. The browser suite already
// exercises the keyboard path on desktop, so this run targets the gap: the mobile
// touch path (`setupTouchControls` / `setupButtonTouchHandlers`), which the desktop
// browser run can't reach.
//
// Two jsdom-specific tricks make the touch path testable:
//  - `window.orientation = 0` makes isMobileDevice() true, so setup builds the visual
//    controls + button handlers.
//  - jsdom has no TouchEvent, but the handlers only read `event.changedTouches`, so a
//    plain Event with a changedTouches array drives them faithfully.
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><html><body>
  <button id="resetBtn">Reset</button>
  <button id="cameraToggleBtn">Camera</button>
  <div id="gameOverOverlay" style="display:none"><button>Restart</button></div>
</body></html>`, { url: 'https://snowglider.ai/' });

const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
// controls.ts references these bare (globalThis): the game-over observer and the
// `new Event('resize')` that toggleTouchControls dispatches. (Node 22+ already
// provides a built-in global `navigator`, which isMobileDevice never reaches because
// window.orientation short-circuits it.)
g.MutationObserver = window.MutationObserver;
g.Event = window.Event;
// Mark the environment "mobile" so setupTouchControls enables the visual controls and
// the reset/camera/restart button touch handlers.
/** @type {any} */ (window).orientation = 0;

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) {
    pass++;
  } else {
    fail++;
  }
}
const flush = () => new Promise(r => setTimeout(r, 0));

function keydown(key) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
}
// A held-key auto-repeat keydown (event.repeat === true), as the OS/browser emit while
// a key is held down.
function keydownRepeat(key) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, repeat: true }));
}
function keyup(key) {
  document.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true }));
}
// jsdom lacks TouchEvent; the handlers only read event.changedTouches, so a plain
// Event carrying a changedTouches array exercises them exactly.
function dispatchTouch(type, target, points) {
  const event = /** @type {any} */ (new window.Event(type, { bubbles: true, cancelable: true }));
  event.changedTouches = points;
  target.dispatchEvent(event);
}

async function main() {
  const { Controls } = await import('../src/controls.ts');

  console.log('--- module surface ---');
  check('exposes the Controls API',
    !!Controls && ['setupControls', 'resetControls', 'getControls', 'isTouchDevice', 'toggleTouchControls', 'setJumpEnabled']
      .every(k => typeof Controls[k] === 'function'));

  const controls = Controls.setupControls();
  check('setupControls returns the shared control-state object',
    controls && ['left', 'right', 'up', 'down', 'jump'].every(k => controls[k] === false));
  check('isTouchDevice reports true when window.orientation is defined',
    Controls.isTouchDevice() === true);

  console.log('\n--- keyboard controls ---');
  keydown('ArrowLeft');
  check('ArrowLeft press sets left', controls.left === true);
  keyup('ArrowLeft');
  check('ArrowLeft release clears left', controls.left === false);
  keydown('d');
  check('"d" press sets right', controls.right === true);
  keyup('d');
  keydown('w');
  check('"w" press sets up', controls.up === true);
  keyup('w');
  keydown('s');
  check('"s" press sets down', controls.down === true);
  keyup('s');
  keydown(' ');
  check('Spacebar press sets jump', controls.jump === true);
  keyup(' ');
  check('Spacebar release clears jump', controls.jump === false);

  let cameraToggles = 0;
  window.toggleCameraView = () => { cameraToggles++; };
  keydown('v');
  // `V` is edge-triggered: each physical keypress must toggle the camera EXACTLY once.
  // controls.ts registers the keydown handler on `window` only, so the bubbling keydown
  // fires it a single time. (It used to be registered on BOTH window and document, which
  // fired toggleCameraView twice per press — the camera flipped and immediately flipped
  // back, so `V` looked dead. Regression guard: assert === 1, not >= 1.)
  check('"v" key invokes window.toggleCameraView exactly once', cameraToggles === 1);
  // Holding V emits OS/browser auto-repeat keydowns (event.repeat === true). The toggle
  // is edge-triggered, so a long press must NOT keep flipping the camera — the V branch
  // ignores repeats. Regression guard: a burst of repeat keydowns adds zero toggles.
  keydownRepeat('v');
  keydownRepeat('v');
  keydownRepeat('V');
  check('held "v" auto-repeat does not re-toggle the camera', cameraToggles === 1);

  console.log('\n--- touch controls (region mapping) ---');
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Left region is x:[0, W/3], y:[H/3, 2H/3]; its centre is (W/6, H/2).
  dispatchTouch('touchstart', document, [{ identifier: 1, clientX: W / 6, clientY: H / 2 }]);
  check('touch in the left region sets left', controls.left === true);
  dispatchTouch('touchend', document, [{ identifier: 1, clientX: W / 6, clientY: H / 2 }]);
  check('lifting the last touch resets all controls', controls.left === false);
  // Centre region (jump) is x:[W/3, 2W/3], y:[H/3, 2H/3]; centre is (W/2, H/2).
  dispatchTouch('touchstart', document, [{ identifier: 2, clientX: W / 2, clientY: H / 2 }]);
  check('touch in the centre region sets jump', controls.jump === true);
  dispatchTouch('touchend', document, [{ identifier: 2, clientX: W / 2, clientY: H / 2 }]);

  console.log('\n--- scrollable controls guide: touch passthrough (mobile) ---');
  // A touch that begins inside #controlsContent (the Ski Techniques scroller) must be
  // left to the browser: NOT preventDefaulted (so the panel scrolls natively) and NOT
  // read as ski steering — even when its coordinates fall in a control region.
  const guide = document.createElement('div');
  guide.id = 'controlsContent';
  const guideRow = document.createElement('div');
  guideRow.className = 'control-item';
  guide.appendChild(guideRow);
  document.body.appendChild(guide);
  controls.left = false;
  // Sanity: a normal document touch in the left region IS preventDefaulted.
  const gameEvt = /** @type {any} */ (new window.Event('touchstart', { bubbles: true, cancelable: true }));
  gameEvt.changedTouches = [{ identifier: 7, clientX: W / 6, clientY: H / 2 }];
  document.dispatchEvent(gameEvt);
  check('a normal game touch is preventDefaulted', gameEvt.defaultPrevented === true);
  dispatchTouch('touchend', document, [{ identifier: 7, clientX: W / 6, clientY: H / 2 }]);

  controls.left = false;
  // Same left-region coordinates, but the gesture starts on the scroller row.
  const point = [{ identifier: 8, clientX: W / 6, clientY: H / 2 }];
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    const evt = /** @type {any} */ (new window.Event(type, { bubbles: true, cancelable: true }));
    evt.changedTouches = point;
    guideRow.dispatchEvent(evt);
    check(`${type} inside #controlsContent is NOT preventDefaulted (native scroll)`,
      evt.defaultPrevented === false);
  }
  check('a drag inside #controlsContent is never read as ski steering', controls.left === false);
  document.body.removeChild(guide);

  console.log('\n--- interactive UI controls: touch passthrough (mobile) ---');
  // A tap on any interactive control (button/link/form field) drawn over the canvas
  // must be left to the browser: NOT preventDefaulted, so the synthesized click still
  // fires on mobile (else every click-bound UI button — Start/About/Close, the share
  // controls, the account chip — is silently dead), and NOT read as ski steering even
  // when the tap lands in a control region. Regression guard for the systemic fix that
  // retired the per-button workarounds.
  const uiBtn = document.createElement('button');
  uiBtn.id = 'aboutGameButton';
  uiBtn.textContent = 'About Game';
  document.body.appendChild(uiBtn);
  controls.left = false;
  // Left-region coordinates, but the gesture starts on the button.
  const btnPoint = [{ identifier: 9, clientX: W / 6, clientY: H / 2 }];
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    const evt = /** @type {any} */ (new window.Event(type, { bubbles: true, cancelable: true }));
    evt.changedTouches = btnPoint;
    uiBtn.dispatchEvent(evt);
    check(`${type} on a button is NOT preventDefaulted (synthesized click survives)`,
      evt.defaultPrevented === false);
  }
  check('a tap on a button is never read as ski steering', controls.left === false);
  // A nested element inside a button (e.g. an icon span) is still treated as the button.
  const icon = document.createElement('span');
  uiBtn.appendChild(icon);
  const nestedEvt = /** @type {any} */ (new window.Event('touchstart', { bubbles: true, cancelable: true }));
  nestedEvt.changedTouches = [{ identifier: 10, clientX: W / 6, clientY: H / 2 }];
  icon.dispatchEvent(nestedEvt);
  check('a touch on an element nested in a button is NOT preventDefaulted',
    nestedEvt.defaultPrevented === false);
  document.body.removeChild(uiBtn);

  console.log('\n--- visual touch controls (mobile) ---');
  check('mobile setup creates the 5 visual touch-control overlays',
    document.querySelectorAll('.touch-control').length === 5);
  check('toggleTouchControls(false) removes the visual controls and returns false',
    Controls.toggleTouchControls(false) === false &&
    document.querySelectorAll('.touch-control').length === 0);
  check('toggleTouchControls(true) recreates the visual controls and returns true',
    Controls.toggleTouchControls(true) === true &&
    document.querySelectorAll('.touch-control').length === 5);

  console.log('\n--- per-tier jump availability (setJumpEnabled, workstream A) ---');
  // On a no-jump tier (Bunny) the CENTER touch region must be excluded from
  // hit-testing and the visual jump indicator hidden — the touch surface must not
  // advertise a dead verb. Keyboard deliberately still writes `jump` (the kernel's
  // tuning.manualJump gate is the physics source of truth).
  Controls.setJumpEnabled(false);
  dispatchTouch('touchstart', document, [{ identifier: 11, clientX: W / 2, clientY: H / 2 }]);
  check('centre-region touch does NOT set jump while disabled', controls.jump === false);
  dispatchTouch('touchend', document, [{ identifier: 11, clientX: W / 2, clientY: H / 2 }]);
  const jumpIndicator = /** @type {HTMLElement|null} */ (document.querySelector('.touch-jump'));
  check('the touch-jump indicator is hidden while disabled',
    !!jumpIndicator && jumpIndicator.style.display === 'none');
  keydown(' ');
  check('keyboard Space still writes jump (kernel tuning gates the physics)', controls.jump === true);
  keyup(' ');
  // Disabling mid-hold must clear a latched jump so it can't carry across the toggle.
  keydown(' ');
  Controls.setJumpEnabled(false);
  check('disabling clears a latched jump press', controls.jump === false);
  keyup(' ');
  Controls.setJumpEnabled(true);
  dispatchTouch('touchstart', document, [{ identifier: 12, clientX: W / 2, clientY: H / 2 }]);
  check('re-enabling restores the centre jump region', controls.jump === true);
  dispatchTouch('touchend', document, [{ identifier: 12, clientX: W / 2, clientY: H / 2 }]);
  check('re-enabling un-hides the touch-jump indicator',
    !!jumpIndicator && jumpIndicator.style.display !== 'none');
  // Rebuilding the visual controls while disabled creates the indicator hidden.
  Controls.setJumpEnabled(false);
  Controls.toggleTouchControls(false);
  Controls.toggleTouchControls(true);
  const rebuilt = /** @type {HTMLElement|null} */ (document.querySelector('.touch-jump'));
  check('visual controls rebuilt while disabled keep the jump indicator hidden',
    !!rebuilt && rebuilt.style.display === 'none');
  Controls.setJumpEnabled(true);

  console.log('\n--- button touch handlers ---');
  let resetCalls = 0;
  window.resetSnowman = () => { resetCalls++; };
  dispatchTouch('touchstart', document.getElementById('resetBtn'), [{ identifier: 3, clientX: 0, clientY: 0 }]);
  check('resetBtn touchstart invokes window.resetSnowman', resetCalls === 1);

  const cameraTogglesBefore = cameraToggles;
  dispatchTouch('touchstart', document.getElementById('cameraToggleBtn'), [{ identifier: 4, clientX: 0, clientY: 0 }]);
  check('cameraToggleBtn touchstart invokes window.toggleCameraView',
    cameraToggles === cameraTogglesBefore + 1);

  console.log('\n--- restart button via game-over MutationObserver ---');
  let restarts = 0;
  window.restartGame = () => { restarts++; };
  // Simulate a successful finish: the course result panel (with a nested "Share
  // Result" button) is inserted before the restart button. The observer must bind
  // the touch->restart handler to the DIRECT-child restart button, not the nested
  // share button that comes first in depth-first document order.
  const overlay = document.getElementById('gameOverOverlay');
  const resultPanel = document.createElement('div');
  resultPanel.id = 'courseResult';
  resultPanel.innerHTML = '<button id="shareResultBtn">Share Result</button>';
  overlay.insertBefore(resultPanel, overlay.querySelector('button'));
  // The observer attaches a touch handler to the restart button when the overlay
  // becomes visible (style.display = 'flex').
  overlay.style.display = 'flex';
  await flush();
  await flush();
  const restartButton = document.querySelector('#gameOverOverlay > button');
  dispatchTouch('touchstart', restartButton, [{ identifier: 5, clientX: 0, clientY: 0 }]);
  check('restart button touchstart invokes window.restartGame', restarts === 1);
  // Touching the nested share button must NOT restart the game (regression guard:
  // the observer used to bind restart to the first descendant button).
  dispatchTouch('touchstart', document.getElementById('shareResultBtn'), [{ identifier: 6, clientX: 0, clientY: 0 }]);
  check('share button touchstart does NOT invoke window.restartGame', restarts === 1);

  console.log('\n--- resetControls ---');
  keydown('ArrowRight');
  const afterReset = Controls.resetControls();
  check('resetControls clears every control',
    ['left', 'right', 'up', 'down', 'jump'].every(k => afterReset[k] === false));
  check('getControls returns the same shared object', Controls.getControls() === controls);

  // --- teardown signal threading (disposeGame listener hygiene; Codex review #226) ---
  // setupControls(signal) must thread the AbortSignal into EVERY listener it registers
  // (keyboard, resize, touch) so disposeGame's single abort() removes them on HMR/unmount
  // — otherwise a remount stacks duplicate handlers (e.g. `V` toggling once per stale
  // keydown). Spy on addEventListener to confirm the signal reaches each listener class,
  // then abort to drop the duplicates this extra setup added (keeps the process clean).
  console.log('\n--- teardown signal threading ---');
  // jsdom validates that an addEventListener signal is its OWN realm's AbortSignal, so
  // use window.AbortController (in a real browser the global IS the window's — no mismatch).
  const ac = new window.AbortController();
  const seen = [];
  const realDocAdd = document.addEventListener;
  const realWinAdd = window.addEventListener;
  document.addEventListener = function (type, fn, opts) { seen.push({ type, opts }); return realDocAdd.call(this, type, fn, opts); };
  window.addEventListener = function (type, fn, opts) { seen.push({ type, opts }); return realWinAdd.call(this, type, fn, opts); };
  try {
    Controls.setupControls(ac.signal);
  } finally {
    document.addEventListener = realDocAdd;
    window.addEventListener = realWinAdd;
  }
  const withSignal = seen.filter(s => s.opts && s.opts.signal === ac.signal).map(s => s.type);
  check('setupControls(signal) threads the teardown signal into the keyboard listeners',
    withSignal.includes('keydown') && withSignal.includes('keyup'));
  check('setupControls(signal) threads the signal into the resize + touch listeners',
    withSignal.includes('resize') && withSignal.includes('touchstart'));
  check('an aborted signal removes the keyboard handler (no state mutation after abort)',
    (() => {
      // Verify removal end-to-end on an ISOLATED handler set: a fresh keydown handler
      // registered with this signal stops firing once aborted (the singleton's earlier
      // no-signal listeners are a separate set and intentionally untouched here).
      let hits = 0;
      window.addEventListener('keydown', () => { hits++; }, { signal: ac.signal });
      keydown('ArrowLeft');
      const firedWhileLive = hits;
      ac.abort();
      keydown('ArrowLeft');
      return firedWhileLive === 1 && hits === 1; // fired once live, not after abort
    })());

  // --- delayed overlay-observer abort guard (Codex review #226) ---
  // On mobile setupControls() runs before setupScene() creates #gameOverOverlay, so
  // setupButtonTouchHandlers arms a 1s delayed observe(). Aborting the teardown signal
  // during that window must cancel it — else a remounted overlay (HMR) gets the stale
  // observer and the old restart touch handler.
  console.log('\n--- delayed overlay observer abort guard ---');
  {
    const existing = document.getElementById('gameOverOverlay');
    if (existing) existing.remove(); // force the no-overlay-yet (delayed observe) branch
    let observeCalls = 0;
    const realObserve = window.MutationObserver.prototype.observe;
    window.MutationObserver.prototype.observe = function (...a) { observeCalls++; return realObserve.apply(this, /** @type {any} */ (a)); };
    const ac2 = new window.AbortController();
    try {
      Controls.setupControls(ac2.signal); // arms the 1s delayed observe (overlay absent)
      const observesBefore = observeCalls;
      ac2.abort();                        // tear down DURING the 1s delay window
      // A remount re-creates the overlay before the timeout would have fired.
      const remounted = document.createElement('div');
      remounted.id = 'gameOverOverlay';
      remounted.style.display = 'none';
      document.body.appendChild(remounted);
      await new Promise(r => setTimeout(r, 1100)); // wait past the 1000ms delayed observe
      check('aborting during the delay window cancels the pending overlay observe()',
        observeCalls === observesBefore);
    } finally {
      window.MutationObserver.prototype.observe = realObserve;
      ac2.abort();
    }
  }

  console.log(`\nCONTROLS TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
