// @ts-check
// Real panel wiring with a fake wall clock: folding must respect user activity,
// holds, keyboard navigation, explicit pinning and lifetime boundaries.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<body><button id="outside">Outside</button></body>', {
    url: 'https://snowglider.ai/', pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = /** @type {any} */ (globalThis);
  g.window = window;
  g.document = window.document;
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { due: now + Number(delay), callback });
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); };
  const tick = (delay) => {
    now += delay;
    for (const [id, timer] of [...timers]) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const { setupCollapsiblePanel, setPanelCollapsed } = await import('../src/ui/collapsible-panel.ts');
  function mount(name) {
    window.document.body.insertAdjacentHTML('beforeend', `
      <section id="${name}"><header id="${name}Header"><h3>${name}</h3><button id="${name}Toggle"></button></header>
      <div id="${name}Content"><input id="${name}Range" type="range"><button id="${name}Action">Action</button></div></section>`);
    const owner = new window.AbortController();
    const options = {
      name, containerId: name, headerId: `${name}Header`, toggleButtonId: `${name}Toggle`, signal: owner.signal,
    };
    setupCollapsiblePanel(options);
    const container = document.getElementById(name);
    const toggle = document.getElementById(`${name}Toggle`);
    return {
      container, toggle, owner, options,
      pin: /** @type {HTMLButtonElement} */ (container.querySelector('.panel-pin')),
      range: document.getElementById(`${name}Range`),
      open() { setPanelCollapsed(container, toggle, false); },
      collapsed() { return container.classList.contains('collapsed'); },
    };
  }
  function pointer(target, type, id = 1) {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
  }
  function touch(target, type, count, changed = [0]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, id) => ({ identifier: id })) });
    Object.defineProperty(event, 'changedTouches', { value: changed.map((identifier) => ({ identifier })) });
    target.dispatchEvent(event);
    return event;
  }
  const panel = mount('Controls');
  assert.ok(panel.pin, 'shared setup supplies a pin');
  assert.equal(panel.pin.getAttribute('aria-pressed'), 'false');
  assert.equal(panel.pin.getAttribute('aria-label'), 'Keep Controls open');
  tick(3999);
  assert.equal(panel.collapsed(), false, 'panel remains visible for four seconds');
  tick(1);
  assert.equal(panel.collapsed(), true, 'idle panel folds at four seconds');
  assert.equal(panel.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById('ControlsContent').inert, true);

  panel.toggle.click();
  tick(3000);
  panel.range.dispatchEvent(new window.Event('input', { bubbles: true }));
  tick(3000);
  assert.equal(panel.collapsed(), false, 'changing a control resets the idle window');
  tick(1000);
  assert.equal(panel.collapsed(), true);

  panel.open();
  panel.pin.click();
  tick(20000);
  assert.equal(panel.collapsed(), false, 'pin suppresses idle folding');
  assert.equal(panel.pin.getAttribute('aria-pressed'), 'true');
  panel.toggle.click();
  assert.equal(panel.collapsed(), true, 'explicit collapse still works while pinned');
  panel.toggle.click();
  tick(10000);
  assert.equal(panel.collapsed(), false, 'manual reopening preserves the pin');
  panel.pin.click();
  tick(3999);
  assert.equal(panel.collapsed(), false, 'unpin grants a fresh idle interval');
  tick(1);
  assert.equal(panel.collapsed(), true);

  panel.open();
  pointer(panel.range, 'pointerdown');
  tick(10000);
  assert.equal(panel.collapsed(), false, 'stationary held slider never disappears');
  pointer(document.getElementById('outside'), 'pointerup');
  tick(4000);
  assert.equal(panel.collapsed(), true, 'release outside the panel rearms folding');
  panel.open();
  pointer(panel.range, 'pointerdown', 2);
  pointer(panel.range, 'pointerdown', 3);
  pointer(window, 'pointercancel', 2);
  tick(10000);
  assert.equal(panel.collapsed(), false, 'one cancelled pointer does not release the remaining hold');
  pointer(window, 'pointercancel', 3);
  tick(4000);
  assert.equal(panel.collapsed(), true, 'cancelled last pointer clears the hold');

  panel.open();
  touch(panel.range, 'touchstart', 1);
  tick(10000);
  assert.equal(panel.collapsed(), false, 'legacy touch holds pause idle folding');
  touch(window, 'touchcancel', 0);
  tick(4000);
  assert.equal(panel.collapsed(), true, 'touch cancellation rearms folding');
  panel.open();
  touch(document.getElementById('outside'), 'touchstart', 1, [0]);
  touch(panel.range, 'touchstart', 2, [1]);
  touch(window, 'touchend', 1, [1]);
  tick(4000);
  assert.equal(panel.collapsed(), true, 'remaining off-panel skiing finger does not keep a released panel open');
  touch(window, 'touchend', 0, [0]);

  panel.open();
  document.getElementById('outside').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  panel.range.focus();
  tick(12000);
  assert.equal(panel.collapsed(), false, 'keyboard navigation keeps the active panel open');
  document.getElementById('outside').focus();
  await Promise.resolve();
  tick(4000);
  assert.equal(panel.collapsed(), true, 'leaving keyboard controls rearms folding');

  panel.open();
  pointer(panel.range, 'pointerdown');
  panel.range.focus();
  pointer(window, 'pointerup');
  tick(4000);
  assert.equal(panel.collapsed(), true, 'mouse/touch focus does not silently pin a panel');
  assert.equal(document.activeElement, panel.toggle, 'idle folding moves hidden focus to disclosure');

  // Native button clicks leave focus behind, but ordinary in-run buttons still
  // allow WASD/arrows to ski. Those keys must not turn that stale focus into a pin.
  const action = document.getElementById('ControlsAction');
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']) {
    panel.open();
    pointer(action, 'pointerdown');
    action.focus();
    pointer(window, 'pointerup');
    action.click();
    for (let i = 0; i < 4; i++) {
      action.dispatchEvent(new window.KeyboardEvent('keydown', { key, repeat: i > 0, bubbles: true }));
      tick(1000);
    }
    assert.equal(panel.collapsed(), true, `${key} held after clicking a panel button still allows idle folding`);
  }

  panel.open();
  pointer(panel.range, 'pointerdown');
  panel.range.focus();
  pointer(window, 'pointerup');
  panel.range.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  tick(12000);
  assert.equal(panel.collapsed(), false, 'arrow adjustment of a focused range keeps its panel open');
  document.getElementById('outside').focus();
  await Promise.resolve();
  tick(4000);
  assert.equal(panel.collapsed(), true);

  panel.open();
  document.getElementById('outside').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  action.focus();
  tick(12000);
  assert.equal(panel.collapsed(), false, 'Tab navigation to a panel button keeps its panel open');
  action.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  tick(12000);
  assert.equal(panel.collapsed(), false, 'keyboard button activation retains keyboard navigation');
  for (let i = 0; i < 4; i++) {
    action.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'w', repeat: i > 0, bubbles: true }));
    tick(1000);
  }
  assert.equal(panel.collapsed(), true, 'resuming skiing releases a prior keyboard-navigation hold');

  panel.open();
  for (let i = 0; i < 4; i++) {
    document.getElementById('outside').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    tick(1000);
  }
  assert.equal(panel.collapsed(), true, 'skiing keyboard activity outside a panel does not prevent folding');
  panel.open();
  for (let i = 0; i < 4; i++) {
    pointer(document.getElementById('outside'), 'pointerdown');
    pointer(document.getElementById('outside'), 'pointerup');
    tick(1000);
  }
  assert.equal(panel.collapsed(), true, 'off-panel steering touches do not postpone idle folding');
  panel.open();
  pointer(panel.range, 'pointerdown');
  window.dispatchEvent(new window.Event('blur'));
  tick(4000);
  assert.equal(panel.collapsed(), true, 'window blur releases a lost hold');

  panel.open();
  const tapEnd = touch(panel.pin, 'touchstart', 1);
  assert.equal(tapEnd.defaultPrevented, false);
  const release = touch(panel.pin, 'touchend', 0);
  assert.equal(release.defaultPrevented, false, 'pin touch keeps its native click');
  panel.pin.click();
  assert.equal(panel.collapsed(), false, 'pin tap does not toggle disclosure');
  assert.equal(panel.pin.getAttribute('aria-pressed'), 'true');
  panel.pin.focus();
  panel.pin.click();
  tick(4000);
  assert.equal(panel.collapsed(), true);
  assert.equal(document.activeElement, panel.toggle, 'unpinning returns hidden pin focus to disclosure on idle fold');
  panel.open();
  panel.pin.click();

  Object.defineProperty(window, 'innerWidth' , { value: 390, configurable: true });
  const peer = mount('Camera');
  peer.toggle.click();
  peer.toggle.click();
  assert.equal(panel.collapsed(), true, 'compact accordion deliberately closes pinned peers');
  assert.equal(panel.pin.getAttribute('aria-pressed'), 'true', 'accordion retains pin preference');
  peer.owner.abort();
  panel.open();
  setupCollapsiblePanel({ ...panel.options, resetListeners: true });
  const newPin = /** @type {HTMLButtonElement} */ (panel.container.querySelector('.panel-pin'));
  assert.equal(panel.container.querySelectorAll('.panel-pin').length, 1, 'rewiring never duplicates pin');
  assert.equal(newPin.getAttribute('aria-pressed'), 'true', 'rewiring preserves pin state');
  newPin.click();
  tick(2000);
  setupCollapsiblePanel(panel.options);
  tick(2000);
  assert.equal(panel.collapsed(), false, 'old setup timer cannot collapse the rewired panel');
  panel.owner.abort();
  tick(10000);
  assert.equal(panel.collapsed(), false, 'teardown cancels pending folding');
  assert.equal(timers.size, 0, 'teardown leaves no timers');

  const persisted = mount('Persisted');
  persisted.pin.click();
  assert.equal(window.localStorage.getItem('snowglider.panelPinned.Persisted'), 'true');
  persisted.owner.abort();
  persisted.container.remove();
  const recreated = mount('Persisted');
  assert.equal(recreated.pin.getAttribute('aria-pressed'), 'true', 'recreated tray restores its pin');
  tick(12000);
  assert.equal(recreated.collapsed(), false);
  recreated.pin.click();
  assert.equal(window.localStorage.getItem('snowglider.panelPinned.Persisted'), 'false');
  recreated.owner.abort();
  const storage = window.localStorage;
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked storage'); } });
  const blocked = mount('Blocked');
  blocked.pin.click();
  tick(12000);
  assert.equal(blocked.collapsed(), false, 'blocked storage still supports an in-session pin');
  blocked.pin.click();
  tick(4000);
  assert.equal(blocked.collapsed(), true, 'blocked storage does not prevent unpinning');
  blocked.owner.abort();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  assert.equal(timers.size, 0);
  dom.window.close();
  console.log('Panel idle/pin: all regressions passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
