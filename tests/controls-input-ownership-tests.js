// @ts-check
// Exercise the real input handlers: keyboard aliases, focus loss, and teardown.
// A release lost outside the tab must not resume a turn/brake when the user returns.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<!doctype html><body><button id="cameraToggleBtn">View</button><div id="gameOverOverlay"></div></body>', {
    url: 'https://snowglider.ai/',
  });
  const { window } = dom;
  const g = /** @type {any} */ (globalThis);
  g.window = window;
  g.document = window.document;
  g.MutationObserver = window.MutationObserver;
  Object.defineProperty(window, 'orientation', { value: 0, configurable: true });
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  const ac = new window.AbortController();
  const { Controls } = await import('../src/controls.ts');
  const controls = Controls.setupControls(ac.signal);
  const key = (type, text, code = '', repeat = false) => document.dispatchEvent(
    new window.KeyboardEvent(type, { key: text, code, repeat, bubbles: true }),
  );
  const touch = (type, id, x = window.innerWidth * 5 / 6, target = /** @type {EventTarget} */ (document)) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'changedTouches', { value: [
      { identifier: id, clientX: x, clientY: window.innerHeight / 2 },
    ] });
    target.dispatchEvent(event);
  };
  const allReleased = () => assert.ok(Object.values(controls).every(value => value === false));
  try {
    for (const [name, letter, code, arrow] of [
      ['left', 'a', 'KeyA', 'ArrowLeft'], ['right', 'd', 'KeyD', 'ArrowRight'],
      ['up', 'w', 'KeyW', 'ArrowUp'], ['down', 's', 'KeyS', 'ArrowDown'],
    ]) {
      key('keydown', letter, code);
      key('keydown', arrow, arrow);
      key('keyup', arrow, arrow);
      assert.equal(controls[name], true, `releasing ${arrow} must preserve held ${letter}`);
      key('keyup', letter, code);
      assert.equal(controls[name], false, 'last physical alias releases the action');
    }
    key('keydown', 'w', 'KeyW');
    key('keydown', 'W', 'KeyW', true);
    key('keyup', 'ц', 'KeyW'); // layout/modifier changed while the physical key was held
    allReleased();
    key('keydown', 'a'); // legacy/synthetic events with no code remain supported
    key('keydown', 'A', '', true);
    key('keyup', 'A');
    allReleased();
    console.log('PASS: physical aliases, repeats and changed key text release independently');

    key('keydown', 'w', 'KeyW');
    key('keydown', ' ', 'Space');
    key('keydown', ' '); // independent legacy/synthetic ownership must clear too
    Controls.setJumpEnabled(false);
    assert.equal(controls.jump, false);
    assert.equal(controls.up, true, 'disabling jump preserves other held controls');
    for (const code of ['Space', '']) {
      key('keydown', ' ', code, true);
      assert.equal(controls.jump, false, 'a Space repeat cannot revive a disabled hold');
    }
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    assert.equal(controls.jump, false, 'another keydown cannot revive a cleared jump');
    key('keyup', 'w', 'KeyW');
    assert.equal(controls.jump, false, 'another keyup cannot revive a cleared jump');
    Controls.setJumpEnabled(true);
    for (const code of ['Space', '']) {
      key('keydown', ' ', code, true);
      assert.equal(controls.jump, false, 'a stale Space repeat cannot carry across re-enabling');
    }
    key('keyup', 'ArrowLeft', 'ArrowLeft');
    allReleased(); // re-enabling cannot recover either stale Space owner
    key('keyup', ' ', 'Space');
    key('keyup', ' ');
    allReleased();
    key('keydown', ' ', 'Space');
    assert.equal(controls.jump, true, 'a fresh Space press works after re-enabling');
    key('keyup', ' ', 'Space');
    allReleased();
    Controls.setJumpEnabled(false);
    key('keydown', ' ', 'Space');
    assert.equal(controls.jump, true, 'fresh Space still reaches the kernel on a no-jump tier');
    key('keydown', ' ', 'Space', true);
    assert.equal(controls.jump, true, 'a repeat preserves a fresh owned press');
    key('keyup', ' ', 'Space');
    Controls.setJumpEnabled(true);
    allReleased();
    console.log('PASS: disabling jump clears every physical owner without releasing other controls');

    touch('touchmove', 39);
    allReleased(); // only touchstart may acquire a new gesture
    touch('touchstart', 39);
    assert.equal(controls.right, true);
    touch('touchmove', 39, window.innerWidth / 6);
    assert.equal(controls.left, true, 'an owned gesture can still drag between regions');
    assert.equal(controls.right, false, 'dragging releases the previous region');
    Controls.resetControls();
    touch('touchmove', 39);
    allReleased(); // restart/reset cancels the old gesture until the finger lifts
    touch('touchend', 39);
    touch('touchstart', 39);
    assert.equal(controls.right, true, 'a fresh touch works after cancellation');
    touch('touchcancel', 39);
    touch('touchmove', 39);
    allReleased();
    console.log('PASS: only a fresh touchstart acquires control; reset/cancel cannot revive stale touches');

    const pad = /** @type {HTMLElement} */ (document.querySelector('.touch-right'));
    const idleColor = pad.style.backgroundColor;
    for (const loseFocus of [
      () => window.dispatchEvent(new window.Event('blur')),
      () => { visibility = 'hidden'; document.dispatchEvent(new window.Event('visibilitychange')); },
    ]) {
      key('keydown', 's', 'KeyS');
      touch('touchstart', 40);
      assert.equal(controls.down, true);
      assert.equal(controls.right, true);
      assert.notEqual(pad.style.backgroundColor, idleColor);
      loseFocus();
      allReleased();
      assert.equal(pad.style.backgroundColor, idleColor, 'lost focus clears the painted touch hold');
      visibility = 'visible';
      document.dispatchEvent(new window.Event('visibilitychange'));
      touch('touchmove', 40);
      allReleased(); // the old finger cannot revive steering after returning
      key('keydown', 's', 'KeyS', true);
      allReleased(); // an OS repeat cannot reacquire ownership cleared on focus loss
      key('keyup', 's', 'KeyS');
      touch('touchend', 40);
      allReleased(); // stale releases cannot resurrect the other input source
      key('keydown', 'a', 'KeyA');
      document.dispatchEvent(new window.Event('visibilitychange'));
      assert.equal(controls.left, true, 'visible-only notification preserves live input');
      key('keyup', 'a', 'KeyA');
    }
    console.log('PASS: blur/hidden clear keyboard, touch ownership and visual state; visible preserves input');

    let cameraToggles = 0;
    window.toggleCameraView = () => { cameraToggles++; };
    const cameraButton = document.getElementById('cameraToggleBtn');
    touch('touchstart', 42, 0, cameraButton);
    assert.equal(cameraToggles, 1, 'camera touch invokes the live handler once');
    ac.abort();
    touch('touchstart', 43, 0, cameraButton);
    assert.equal(cameraToggles, 1, 'abort removes the camera button touch handler');
    controls.left = true; // sentinel: removed blur/hidden listeners must not clear this
    window.dispatchEvent(new window.Event('blur'));
    visibility = 'hidden';
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(controls.left, true);
    key('keydown', 'w', 'KeyW');
    touch('touchstart', 41);
    assert.equal(controls.up, false);
    assert.equal(controls.right, false);
    console.log('PASS: abort removes keyboard, touch and focus-loss handlers');
    const remount = new window.AbortController();
    try {
      Controls.setupControls(remount.signal);
      touch('touchstart', 44, 0, cameraButton);
      assert.equal(cameraToggles, 2, 'remount binds one camera touch handler without stale duplicates');
    } finally {
      remount.abort();
    }
    console.log('PASS: camera button touch handler follows teardown and remount');
  } finally {
    ac.abort();
    Controls.resetControls();
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
