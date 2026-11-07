// @ts-check
// Background preparation must not run physics, block forever, or resume work
// after teardown. Scheduling uses the real visibility/animation-frame boundary.
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const { waitForStartupPaint, warmupStartupScene } = await import('../src/boot/startup-warmup.ts');
  const env = setupDom();
  let hidden = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  /** @type {Map<number, FrameRequestCallback>} */
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => { frames.delete(id); };
  function tick() {
    const frame = frames.entries().next().value;
    assert.ok(frame, 'expected an animation frame');
    frames.delete(frame[0]);
    frame[1](0);
  }
  let painted = false;
  const firstPaint = waitForStartupPaint().then(ready => { painted = ready; });
  assert.equal(frames.size, 0, 'hidden tab does not schedule scene construction');
  hidden = false;
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(frames.size, 1);
  tick();
  await Promise.resolve();
  assert.equal(painted, false, 'work cannot run in the first pre-paint callback');
  tick();
  await firstPaint;
  assert.equal(painted, true);
  assert.equal(frames.size, 0);

  const abortedPaint = new AbortController();
  const cancelledPaint = waitForStartupPaint(abortedPaint.signal);
  abortedPaint.abort();
  assert.equal(await cancelledPaint, false);
  assert.equal(frames.size, 0, 'cancelled paint callback is removed');

  const teardownAfterPaint = new AbortController();
  let builtAfterTeardown = false;
  hidden = true;
  const cancelledFallback = warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => Promise.reject(new Error('offline')),
    useFallback: () => { builtAfterTeardown = true; },
    signal: teardownAfterPaint.signal,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(frames.size, 0, 'asset failure in a hidden tab waits before building fallback geometry');
  hidden = false;
  document.dispatchEvent(new window.Event('visibilitychange'));
  tick();
  tick();
  // Disposal can run in the same task that completes the paint boundary,
  // before the warmup promise's continuation gets its turn.
  teardownAfterPaint.abort();
  assert.equal(await cancelledFallback, false);
  assert.equal(builtAfterTeardown, false, 'a completed paint never authorizes fallback construction after disposal');
  assert.equal(frames.size, 0);
  // Asset timing cases need no visual scheduler; only the scheduling
  // tests above install one in this otherwise headless DOM.
  delete /** @type {any} */ (window).requestAnimationFrame;
  delete /** @type {any} */ (window).cancelAnimationFrame;

  let assetsReady = false;
  let finishAssets = () => {};
  let fallbackCalls = 0;
  let preparationFinished = false;
  const pendingAssets = new Promise(resolve => { finishAssets = () => { assetsReady = true; resolve(undefined); }; });
  const preparation = warmupStartupScene({
    assetsReady: () => assetsReady,
    waitForAssets: () => pendingAssets,
    useFallback: () => { fallbackCalls++; assetsReady = true; },
  });
  void preparation.then(() => { preparationFinished = true; });
  await Promise.resolve();
  assert.equal(preparationFinished, false, 'readiness waits for visible/collidable assets');
  finishAssets();
  assert.equal(await preparation, true);
  assert.equal(fallbackCalls, 0);

  assetsReady = false;
  const fallbackReady = await warmupStartupScene({
    assetsReady: () => assetsReady,
    waitForAssets: () => new Promise(() => {}),
    useFallback: () => { fallbackCalls++; assetsReady = true; },
    assetTimeoutMs: 5,
  });
  assert.equal(fallbackReady, true);
  assert.equal(fallbackCalls, 1, 'hung asset request selects the existing fallback');

  assetsReady = false;
  await warmupStartupScene({
    assetsReady: () => assetsReady,
    waitForAssets: () => Promise.reject(new Error('offline')),
    useFallback: () => { fallbackCalls++; assetsReady = true; },
  });
  assert.equal(fallbackCalls, 2, 'failed asset request also selects the fallback');

  assert.equal(await warmupStartupScene({
    assetsReady: () => true,
    waitForAssets: () => { throw new Error('already-ready assets must not reload'); },
    useFallback: () => { throw new Error('ready assets need no fallback'); },
  }), true, 'already-prepared assets add no extra work');

  await assert.rejects(warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => Promise.resolve(),
    useFallback: () => {},
  }), /forest could not finish preparing/, 'a broken fallback must never advertise a playable scene');

  const teardown = new AbortController();
  let lateAssets = () => {};
  const cancelled = warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => new Promise(resolve => { lateAssets = () => resolve(undefined); }),
    useFallback: () => { throw new Error('teardown must not build fallback geometry'); },
    signal: teardown.signal,
  });
  await Promise.resolve();
  teardown.abort();
  assert.equal(await cancelled, false);
  lateAssets();
  await Promise.resolve();
  const immediateAbort = new AbortController();
  let assetRequests = 0;
  const abortedBeforeAssets = warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => { assetRequests++; return Promise.resolve(); },
    useFallback: () => { throw new Error('cancelled fallback must not begin'); },
    signal: immediateAbort.signal,
  });
  immediateAbort.abort();
  assert.equal(await abortedBeforeAssets, false);
  assert.equal(assetRequests, 0, 'cancelled asset work must not begin');
  env.teardown();
  console.log('Startup paints first, waits for assets, bounds fallback recovery, and cancels safely.');
})().catch(error => { console.error(error); process.exitCode = 1; });
