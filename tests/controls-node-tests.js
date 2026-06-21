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
global.window = window;
global.document = window.document;
// controls.ts references these bare (globalThis): the game-over observer and the
// `new Event('resize')` that toggleTouchControls dispatches. (Node 22+ already
// provides a built-in global `navigator`, which isMobileDevice never reaches because
// window.orientation short-circuits it.)
global.MutationObserver = window.MutationObserver;
global.Event = window.Event;
// Mark the environment "mobile" so setupTouchControls enables the visual controls and
// the reset/camera/restart button touch handlers.
window.orientation = 0;

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
function keyup(key) {
  document.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true }));
}
// jsdom lacks TouchEvent; the handlers only read event.changedTouches, so a plain
// Event carrying a changedTouches array exercises them exactly.
function dispatchTouch(type, target, points) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.changedTouches = points;
  target.dispatchEvent(event);
}

async function main() {
  const { Controls } = await import('../src/controls.ts');

  console.log('--- module surface ---');
  check('exposes the Controls API',
    !!Controls && ['setupControls', 'resetControls', 'getControls', 'isTouchDevice', 'toggleTouchControls']
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
  // controls.ts registers the keydown handler on BOTH window and document ("for
  // better coverage"), so a bubbling keydown legitimately fires it on each.
  check('"v" key invokes window.toggleCameraView', cameraToggles >= 1);

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
  const gameEvt = new window.Event('touchstart', { bubbles: true, cancelable: true });
  gameEvt.changedTouches = [{ identifier: 7, clientX: W / 6, clientY: H / 2 }];
  document.dispatchEvent(gameEvt);
  check('a normal game touch is preventDefaulted', gameEvt.defaultPrevented === true);
  dispatchTouch('touchend', document, [{ identifier: 7, clientX: W / 6, clientY: H / 2 }]);

  controls.left = false;
  // Same left-region coordinates, but the gesture starts on the scroller row.
  const point = [{ identifier: 8, clientX: W / 6, clientY: H / 2 }];
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    const evt = new window.Event(type, { bubbles: true, cancelable: true });
    evt.changedTouches = point;
    guideRow.dispatchEvent(evt);
    check(`${type} inside #controlsContent is NOT preventDefaulted (native scroll)`,
      evt.defaultPrevented === false);
  }
  check('a drag inside #controlsContent is never read as ski steering', controls.left === false);
  document.body.removeChild(guide);

  console.log('\n--- visual touch controls (mobile) ---');
  check('mobile setup creates the 5 visual touch-control overlays',
    document.querySelectorAll('.touch-control').length === 5);
  check('toggleTouchControls(false) removes the visual controls and returns false',
    Controls.toggleTouchControls(false) === false &&
    document.querySelectorAll('.touch-control').length === 0);
  check('toggleTouchControls(true) recreates the visual controls and returns true',
    Controls.toggleTouchControls(true) === true &&
    document.querySelectorAll('.touch-control').length === 5);

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

  console.log(`\nCONTROLS TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
