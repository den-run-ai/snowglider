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
        <span>Camera: Auto</span>
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
    <button id="cameraToggleBtn">Camera: Auto</button>`;
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
  // Cycle order out of the camera manager: follow -> orbit -> firstPerson -> cameraman -> drone -> auto.
  const { toggleCameraView } = createLifecycle(makeDeps(['follow', 'orbit', 'firstPerson', 'cameraman', 'drone', 'auto']));

  const mode1 = toggleCameraView();
  check('toggle returns the new camera mode', mode1 === 'follow');
  check('camera (V) row badge stays "V"',
    document.querySelector('#cameraViewControl .key-badge').textContent === 'V');
  check('camera row label updates (follow => "Camera: Follow")',
    rowText('#cameraViewControl') === 'V Camera: Follow');
  check('camera-toggle button text updates too',
    document.getElementById('cameraToggleBtn').textContent === 'Camera: Follow');
  check('Hop turn (last) row is NOT rewritten by the camera toggle',
    lastRowText() === hopBefore &&
    lastRowText() === 'Space+←/→ Hop turn — quick pivot on steeps');

  // Cycle through the remaining modes and confirm each friendly label renders.
  check('second toggle => Orbit 360°',
    toggleCameraView() === 'orbit' && rowText('#cameraViewControl') === 'V Camera: Orbit 360°');
  check('third toggle => First Person',
    toggleCameraView() === 'firstPerson' && rowText('#cameraViewControl') === 'V Camera: First Person');
  check('fourth toggle => Cameraman',
    toggleCameraView() === 'cameraman' && rowText('#cameraViewControl') === 'V Camera: Cameraman');
  check('fifth toggle => Drone',
    toggleCameraView() === 'drone' && rowText('#cameraViewControl') === 'V Camera: Drone');
  check('sixth toggle wraps back to Auto',
    toggleCameraView() === 'auto' && rowText('#cameraViewControl') === 'V Camera: Auto');
  check('Hop turn row still untouched after cycling all modes',
    lastRowText() === 'Space+←/→ Hop turn — quick pivot on steeps');

  // Missing-DOM branch: toggleCameraView must not throw when the rows/button are gone.
  document.body.innerHTML = '';
  let threw = false;
  try { createLifecycle(makeDeps(['firstPerson'])).toggleCameraView(); }
  catch { threw = true; }
  check('toggleCameraView is a no-op (no throw) when the controls DOM is absent', !threw);

  // --- Camera control tray + global input handlers (initCameraControls) ---
  // Drives the real tray build + the window-level wheel / keyboard / drag listeners,
  // covering the codex-review gate: those only steer the camera while state.gameActive.
  console.log('\n--- initCameraControls: tray + gated input ---');
  {
    // A recording camera stub with every method the tray/input calls.
    const calls = [];
    const cam = /** @type {any} */ ({
      mode: 'auto',
      orbitYaw: 0,
      toggleCameraMode() { this.mode = 'follow'; return this.mode; },
      setMode(m) { this.mode = m; calls.push(['setMode', m]); return m; },
      cycleMode() { return this.mode; },
      initialize() {},
      orbit(dy) { calls.push(['orbit', dy]); },
      adjustZoom(f) { calls.push(['adjustZoom', f]); return 1; },
      setOrbitYaw(a) { calls.push(['setOrbitYaw', a]); },
      recenter() { calls.push(['recenter']); },
    });
    const state = { gameActive: false };
    const controller = new dom.window.AbortController();
    document.body.innerHTML = `
      <div id="controlsContent"><div class="control-item" id="cameraViewControl"><span class="key-badge">V</span><span>Camera: Auto</span></div></div>
      <button id="resetBtn">Reset</button>`;
    const deps = /** @type {any} */ ({
      state, cameraManager: cam,
      snowman: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      gameOverOverlay: document.createElement('div'),
      restartButton: document.createElement('button'),
      player: { pos: { x: 0, y: 0, z: 0 } },
      startLoop() {}, resetLoopState() {}, signal: controller.signal,
    });
    createLifecycle(deps).initLifecycleUI();

    check('tray is built with the six mode chips',
      document.querySelectorAll('#cameraControls [data-cam-mode]').length === 6);
    check('orbit slider is present (0–360)',
      !!document.getElementById('cameraOrbitSlider'));

    // Foldable header (matches the Game Controls / Game Stats HUD panels): a titled
    // header + ▲/▼ toggle wrapping a collapsible content region that holds every widget.
    const camTray = document.getElementById('cameraControls');
    const camToggle = document.getElementById('toggleCamera');
    check('tray has a collapsible header with a title + toggle button',
      !!document.getElementById('cameraControlsHeader') && !!camToggle &&
      !!document.querySelector('#cameraControlsHeader h3'));
    check('the six mode chips live inside the collapsible content wrapper',
      document.querySelectorAll('#cameraControlsContent [data-cam-mode]').length === 6);
    // Clicking the toggle folds the tray (collapsed class + ▼) and unfolds it (▲).
    camToggle.click();
    check('toggle folds the camera tray',
      camTray.classList.contains('collapsed') && camToggle.textContent === '▼');
    camToggle.click();
    check('toggle unfolds the camera tray',
      !camTray.classList.contains('collapsed') && camToggle.textContent === '▲');

    // Helper to dispatch a window event with extra props (jsdom lacks WheelEvent).
    // `target` is read-only and set to `window` by dispatch; the handlers treat a
    // window target as "not over a UI panel", which is what we want here.
    const fireWindow = (type, props) => {
      const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
      for (const [k, v] of Object.entries(props)) Object.defineProperty(ev, k, { value: v, configurable: true });
      window.dispatchEvent(ev);
      return ev;
    };

    // gameActive === false: the global wheel/key handlers must stay INERT.
    const wheelOff = fireWindow('wheel', { deltaY: 100 });
    fireWindow('keydown', { key: 'q' });
    check('wheel does not zoom while the run is inactive', !calls.some(c => c[0] === 'adjustZoom'));
    check('wheel does not preventDefault while inactive (menu scroll preserved)', wheelOff.defaultPrevented === false);
    check('Q key does not orbit while the run is inactive', !calls.some(c => c[0] === 'orbit'));

    // Now activate the run: the same inputs steer the camera.
    state.gameActive = true;
    const wheelOn = fireWindow('wheel', { deltaY: 100 });
    fireWindow('keydown', { key: 'q' });
    check('wheel zooms once the run is active', calls.some(c => c[0] === 'adjustZoom'));
    check('wheel preventDefault fires during gameplay', wheelOn.defaultPrevented === true);
    check('Q key orbits during gameplay', calls.some(c => c[0] === 'orbit'));

    // Tray chips: clicking a mode chip selects it; the orbit slider drives setOrbitYaw.
    const chip = (mode) => /** @type {HTMLButtonElement} */ (document.querySelector(`#cameraControls [data-cam-mode="${mode}"]`));
    chip('orbit').click();
    check('mode chip click selects the mode', calls.some(c => c[0] === 'setMode' && c[1] === 'orbit'));
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('cameraOrbitSlider'));
    slider.value = '90';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    check('orbit slider drives setOrbitYaw', calls.some(c => c[0] === 'setOrbitYaw'));

    // First person disables the orbit/zoom widgets (they only affect third-person).
    chip('firstPerson').click(); // sets the stub's mode to 'firstPerson'
    check('first-person disables the orbit slider', slider.disabled === true);

    // ...and the keyboard orbit/zoom hotkeys must be ignored in first person too, so
    // they can't silently mutate the hidden third-person rig (codex review, PR #306).
    const orbitsBefore = calls.filter(c => c[0] === 'orbit').length;
    const zoomsBefore = calls.filter(c => c[0] === 'adjustZoom').length;
    fireWindow('keydown', { key: 'q' });
    fireWindow('keydown', { key: '+' });
    check('Q / + hotkeys are ignored while in first person',
      calls.filter(c => c[0] === 'orbit').length === orbitsBefore &&
      calls.filter(c => c[0] === 'adjustZoom').length === zoomsBefore);

    controller.abort(); // remove the window listeners this section installed
  }

  // --- Regression (codex review, PR #306): tray stacks BELOW the game-over overlay ---
  // The tray must never paint over — or stay clickable above — the finish/game-over
  // modal. Its z-index (styles/main.css) has to stay below the overlay's, which
  // scene-setup.ts sets inline. Parse both from source so a future bump to either
  // value that breaks the ordering fails here.
  console.log('\n--- camera tray z-index stays below the game-over overlay ---');
  {
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '../styles/main.css'), 'utf8');
    const sceneSrc = fs.readFileSync(path.join(__dirname, '../src/game/scene-setup.ts'), 'utf8');
    const trayZ = Number((css.match(/#cameraControls\s*\{[^}]*?z-index:\s*(\d+)/) || [])[1]);
    const overlayZ = Number((sceneSrc.match(/gameOverOverlay\.style\.zIndex\s*=\s*['"](\d+)['"]/) || [])[1]);
    check('parsed #cameraControls z-index from main.css', Number.isFinite(trayZ));
    check('parsed #gameOverOverlay z-index from scene-setup.ts', Number.isFinite(overlayZ));
    check('camera tray z-index is below the game-over overlay', trayZ < overlayZ);
  }

  console.log(`\nLIFECYCLE TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('lifecycle test crashed:', err);
  process.exit(1);
});
