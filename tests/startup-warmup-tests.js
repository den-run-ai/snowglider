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
  assert.equal(frames.size, 0, 'hidden tab does not schedule startup GPU work');
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
  let submittedAfterTeardown = false;
  const cancelledSubmission = warmupStartupScene({
    assetsReady: () => true,
    waitForAssets: () => Promise.resolve(),
    useFallback: () => {},
    compile: () => { submittedAfterTeardown = true; },
    signal: teardownAfterPaint.signal,
  });
  tick();
  tick();
  // Disposal can run in the same task that completes the paint boundary,
  // before the warmup promise's continuation gets its turn.
  teardownAfterPaint.abort();
  assert.equal(await cancelledSubmission, false);
  assert.equal(submittedAfterTeardown, false, 'a completed paint never authorizes work against a disposed renderer');
  assert.equal(frames.size, 0);
  // Shader/asset timing cases need no visual scheduler; only the scheduling
  // tests above install one in this otherwise headless DOM.
  delete /** @type {any} */ (window).requestAnimationFrame;
  delete /** @type {any} */ (window).cancelAnimationFrame;

  let assetsReady = false;
  let finishAssets = () => {};
  let fallbackCalls = 0;
  let compileCalls = 0;
  const pendingAssets = new Promise(resolve => { finishAssets = () => { assetsReady = true; resolve(undefined); }; });
  const preparation = warmupStartupScene({
    assetsReady: () => assetsReady,
    waitForAssets: () => pendingAssets,
    useFallback: () => { fallbackCalls++; assetsReady = true; },
    compile: () => { compileCalls++; },
  });
  await Promise.resolve();
  assert.equal(compileCalls, 0, 'shaders wait for visible/collidable assets');
  finishAssets();
  assert.equal(await preparation, true);
  assert.equal(fallbackCalls, 0);
  assert.equal(compileCalls, 1);

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

  // Shader submission must not own a deadline or completion poll. In r184 an
  // outstanding compileAsync poll could outlive renderer.dispose() on context
  // loss; readiness now returns immediately after the one-shot submission.
  const realSetTimeout = globalThis.setTimeout;
  let shaderTimers = 0;
  globalThis.setTimeout = /** @type {typeof setTimeout} */ ((callback, delay, ...args) => {
    shaderTimers++;
    return realSetTimeout(callback, delay, ...args);
  });
  try {
    assert.equal(await warmupStartupScene({
      assetsReady: () => true,
      waitForAssets: () => { throw new Error('already-ready assets must not reload'); },
      useFallback: () => { throw new Error('ready assets need no fallback'); },
      compile: () => { compileCalls++; },
    }), true, 'shader submission adds no GPU completion wait');
    assert.equal(shaderTimers, 0, 'shader preparation leaves no callback that can touch a disposed renderer');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(compileCalls, 2, 'each preparation submits once');
  assert.equal(await warmupStartupScene({
    assetsReady: () => true,
    waitForAssets: () => Promise.resolve(),
    useFallback: () => {},
    compile: () => { throw new Error('driver declined warmup'); },
  }), true, 'optional compile failures do not prevent ordinary rendering');

  const teardown = new AbortController();
  let lateAssets = () => {};
  const cancelled = warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => new Promise(resolve => { lateAssets = () => resolve(undefined); }),
    useFallback: () => { throw new Error('teardown must not build fallback geometry'); },
    compile: () => { throw new Error('teardown must not touch renderer'); },
    signal: teardown.signal,
  });
  await Promise.resolve();
  teardown.abort();
  assert.equal(await cancelled, false);
  lateAssets();
  await Promise.resolve();
  const immediateAbort = new AbortController();
  const abortedBeforeAssets = warmupStartupScene({
    assetsReady: () => false,
    waitForAssets: () => { throw new Error('cancelled work must not begin'); },
    useFallback: () => { throw new Error('cancelled fallback must not begin'); },
    signal: immediateAbort.signal,
  });
  immediateAbort.abort();
  assert.equal(await abortedBeforeAssets, false);
  env.teardown();
  console.log('Startup paints first, waits for assets, submits shaders without polling, and cancels safely.');
})().catch(error => { console.error(error); process.exitCode = 1; });
