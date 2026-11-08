// @ts-check
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/?debug&private=not-exported' });
  const g = /** @type {any} */ (globalThis);
  const abortController = globalThis.AbortController;
  g.AbortController = env.window.AbortController;
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let clock = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  const originalCreate = document.createElement.bind(document);
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  const blobs = [];
  const revoked = [];
  const downloads = [];
  URL.createObjectURL = blob => { blobs.push(blob); return `blob:capture-${blobs.length}`; };
  URL.revokeObjectURL = url => { revoked.push(url); };
  document.createElement = tag => {
    const node = originalCreate(tag);
    if (tag === 'a') node.click = () => downloads.push(node.download);
    return node;
  };
  const { Diag } = await import('../src/diagnostics.js');
  const { openOverlayFocus, closeOverlayFocus } = await import('../src/ui/accessibility.js');
  const modal = document.createElement('section');
  modal.innerHTML = '<button>Play</button>';
  document.body.appendChild(modal);
  openOverlayFocus(modal);
  const events = [];
  try {
    Diag.init(undefined, { report: (name, data) => events.push({ name, data }) });
    await Promise.resolve(); // the already-open menu observes the late debug UI
    const api = /** @type {any} */ (window.__snowgliderDiag);
    const start = /** @type {HTMLButtonElement} */ (document.getElementById('diagCaptureStart'));
    const stop = /** @type {HTMLButtonElement} */ (document.getElementById('diagCaptureStop'));
    assert.ok(start && stop);
    assert.notEqual(document.getElementById('diagOverlay').inert, true, 'debug controls stay usable beside a blocking menu/result');
    start.focus();
    assert.equal(document.activeElement, start, 'modal focus allows the explicit debug controls');
    assert.equal(start.style.minHeight, '44px');
    assert.equal(start.style.touchAction, 'manipulation');
    assert.equal(stop.disabled, true);
    assert.equal(api.captureSnapshot(), null, 'showing the debug HUD does not opt into capture');
    const frame = () => {
      clock += 20;
      Diag.record({ dt: 0.02, speed: 8, x: 0, z: -15, technique: 'glide', isInAir: false });
    };
    frame();
    assert.equal(api.captureSnapshot(), null);
    start.click();
    assert.equal(start.disabled, true);
    for (let i = 0; i < 60; i++) frame();
    Diag.reset();
    assert.equal(Diag.snapshot().summary.frames, 0);
    assert.equal(api.captureSnapshot().resetCount, 1);
    for (let i = 0; i < 40; i++) frame();
    Diag.reportError(new Error('private@example.invalid account token'), 'animation_loop');
    stop.click();
    assert.deepEqual(downloads, ['snowglider-performance.json']);
    const exported = JSON.parse(await blobs[0].text());
    assert.equal(exported.status, 'stopped');
    assert.equal(exported.resetCount, 1);
    assert.equal(exported.windows[0].frames, 100, 'capture spans actual Diag.reset without losing samples');
    assert.ok(exported.checkpoints.some(p => p.reason === 'reset'));
    assert.doesNotMatch(JSON.stringify(exported), /private@|token|not-exported|https:/);
    assert.ok(events.every(e => !e.name.includes('capture') && !('checkpoints' in e.data)), 'capture never uses the Analytics sink');
    assert.equal(start.disabled, false);
    assert.equal(stop.textContent, 'Download capture');
    assert.equal(revoked.length, 0, 'retain the URL through the phone download handoff');

    URL.createObjectURL = () => { throw new Error('denied'); };
    stop.click();
    assert.equal(api.captureSnapshot().errors.exportFailures, 1);
    assert.match(document.getElementById('diagCaptureStatus').textContent, /unavailable/);
    URL.createObjectURL = blob => { blobs.push(blob); return `blob:capture-${blobs.length}`; };
    stop.click();
    assert.equal(downloads.length, 2, 'a failed export can be retried from the same result');
    assert.equal((JSON.parse(await blobs[1].text())).errors.exportFailures, 1);

    // Hiding the overlay must not stop a capture; teardown must release it.
    start.click();
    frame();
    api.overlay(false);
    frame();
    assert.equal(api.captureSnapshot().pendingWindowFrames, 2);
    api.overlay(true);
    assert.equal(/** @type {HTMLButtonElement} */ (document.getElementById('diagCaptureStart')).disabled, true);
    closeOverlayFocus(modal);
    Diag.teardown();
    assert.equal(window.__snowgliderDiag, undefined);
    assert.equal(document.getElementById('diagOverlay'), null);
    assert.equal(start.onclick, null, 'detached touch controls release their callbacks');
    assert.equal(api.captureSnapshot(), null, 'teardown releases the capture, even through an old API reference');
    assert.ok(revoked.includes('blob:capture-1') && revoked.includes('blob:capture-2'));
    env.window.history.replaceState({}, '', '/');
    Diag.init();
    assert.equal(document.getElementById('diagCaptureStart'), null, 'ordinary player UI is unchanged');
    Diag.teardown();
  } finally {
    closeOverlayFocus(modal);
    Diag.teardown();
    URL.createObjectURL = originalCreateUrl;
    URL.revokeObjectURL = originalRevokeUrl;
    document.createElement = originalCreate;
    g.AbortController = abortController;
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    env.teardown();
  }
  console.log('Performance capture DOM: explicit controls, modal access, reset persistence, private download, failure/retry and teardown passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
