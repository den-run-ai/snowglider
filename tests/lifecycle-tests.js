// @ts-check
// Headless, c8-instrumented coverage for src/game/lifecycle.ts `toggleCameraView`.
//
// Regression guard for the camera-row update bug: the in-game camera label used to
// be found via `#controlsContent .control-item:last-child`. Once the Ski Techniques
// rows were appended after the camera (V) row, the last child became the Hop turn
// row, so toggling the camera rewrote the WRONG row. The fix targets the camera row
// by a stable id (`#cameraViewControl`). This test drives the real toggleCameraView
// and asserts it updates the V row (both ternary branches) and never the Hop row.
//
// Run via the register-ts-resolve loader so lifecycle.ts's `./*.js` sibling imports
// resolve to their `.ts` sources.
const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
const g = /** @type {any} */ (globalThis);
g.window = dom.window;
g.document = dom.window.document;
const { document } = dom.window;

// Mirror the in-game Game Controls widget: the camera (V) row is NOT the last child —
// the Ski Techniques rows (ending in Hop turn) follow it, exactly like index.html.
function buildControlsDom() {
  document.body.innerHTML = `
    <div id="controlsContent">
      <div class="control-item" id="cameraViewControl">
        <span class="key-badge">V</span>
        <span>Toggle Camera View</span>
      </div>
      <div class="control-item">
        <span class="key-badge">↓/S</span>
        <span>Snowplow / pizza — tips together to brake &amp; stop</span>
      </div>
      <div class="control-item">
        <span class="key-badge">Space+←/→</span>
        <span>Hop turn — quick pivot on steeps</span>
      </div>
    </div>
    <button id="cameraToggleBtn">Toggle Chase View</button>`;
}

function makeDeps(toggleModes) {
  let i = 0;
  return /** @type {any} */ ({
    state: {},
    cameraManager: {
      toggleCameraMode: () => toggleModes[i++ % toggleModes.length],
      initialize: () => {}
    },
    snowman: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    gameOverOverlay: document.createElement('div'),
    restartButton: document.createElement('button'),
    player: { pos: { x: 0, y: 0, z: 0 } },
    startLoop: () => {},
    resetLoopState: () => {}
  });
}

function rowText(id) {
  return document.querySelector(id)?.textContent.replace(/\s+/g, ' ').trim();
}
function lastRowText() {
  return document.querySelector('#controlsContent .control-item:last-child')
    ?.textContent.replace(/\s+/g, ' ').trim();
}

async function main() {
  console.log('--- lifecycle.ts toggleCameraView ---');
  const { createLifecycle } = await import('../src/game/lifecycle.ts');

  buildControlsDom();
  const hopBefore = lastRowText();
  // First toggle => first-person ('thirdPerson' is the OTHER mode), so label = "Chase".
  const { toggleCameraView } = createLifecycle(makeDeps(['firstPerson', 'thirdPerson']));

  const mode1 = toggleCameraView();
  check('toggle returns the new camera mode', mode1 === 'firstPerson');
  check('camera (V) row badge stays "V"',
    document.querySelector('#cameraViewControl .key-badge').textContent === 'V');
  check('camera row label updates (firstPerson => "Toggle Chase View")',
    rowText('#cameraViewControl') === 'V Toggle Chase View');
  check('camera-toggle button text updates too',
    document.getElementById('cameraToggleBtn').textContent === 'Toggle Chase View');
  check('Hop turn (last) row is NOT rewritten by the camera toggle',
    lastRowText() === hopBefore &&
    lastRowText() === 'Space+←/→ Hop turn — quick pivot on steeps');

  // Second toggle => thirdPerson, exercising the other ternary branch ("Normal").
  const mode2 = toggleCameraView();
  check('second toggle flips the mode', mode2 === 'thirdPerson');
  check('camera row label updates (thirdPerson => "Toggle Normal View")',
    rowText('#cameraViewControl') === 'V Toggle Normal View');
  check('Hop turn row still untouched after the second toggle',
    lastRowText() === 'Space+←/→ Hop turn — quick pivot on steeps');

  // Missing-DOM branch: toggleCameraView must not throw when the rows/button are gone.
  document.body.innerHTML = '';
  let threw = false;
  try { createLifecycle(makeDeps(['firstPerson'])).toggleCameraView(); }
  catch { threw = true; }
  check('toggleCameraView is a no-op (no throw) when the controls DOM is absent', !threw);

  console.log(`\nLIFECYCLE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('lifecycle test crashed:', err);
  process.exit(1);
});
