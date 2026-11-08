// @ts-check
const assert = require('node:assert/strict');

(async () => {
  const { PerformanceCapture, CAPTURE_LIMITS, readPerformanceProbe, readCaptureContext } =
    await import('../src/performance-capture.js');
  let clock = 0;
  let reads = 0;
  const probe = () => { reads++; return readPerformanceProbe(); };
  const make = () => new PerformanceCapture(undefined, () => clock, probe);
  const capture = make();
  for (const dt of [0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.3]) {
    clock += dt * 1000;
    capture.record(dt);
  }
  capture.reset();
  capture.stop();
  const report = capture.snapshot();
  assert.deepEqual(report.windows[0], {
    startMs: 0, endMs: 550, frames: 7, sampledMs: 550, meanMs: 78.57,
    p50Ms: 40, p95Ms: 240, p99Ms: 288, maxMs: 300,
    over16_7Ms: 6, over33_3Ms: 4, over50Ms: 2, over100Ms: 1, over250Ms: 1,
  });
  assert.equal(report.resetCount, 1, 'reset preserves the existing measurement window');
  assert.equal(report.status, 'stopped');
  assert.equal(report.stopReason, 'manual');
  assert.equal(report.errors.missingRenderer, 3, 'missing observations remain explicit, not zero resources');
  assert.equal(report.checkpoints[0].probe.renderer.geometries, null);
  clock += 1000;
  capture.record(1);
  capture.reset();
  capture.stop();
  assert.deepEqual(capture.snapshot(), report, 'stopping freezes the capture');
  report.checkpoints[0].probe.renderer.geometries = 999;
  assert.equal(capture.snapshot().checkpoints[0].probe.renderer.geometries, null, 'exports cannot mutate the retained report');

  clock = reads = 0;
  const sustained = make();
  for (let i = 1; i <= 6000; i++) {
    clock = i * 100;
    sustained.record(0.1);
  }
  const bounded = sustained.snapshot();
  assert.equal(bounded.stopReason, 'duration_limit');
  assert.equal(bounded.elapsedMs, CAPTURE_LIMITS.durationMs);
  assert.equal(bounded.windows.length, CAPTURE_LIMITS.windows);
  assert.equal(bounded.truncated.duration, true);
  assert.equal(bounded.checkpoints.at(-1).probe, null, 'a cap marker never mislabels a later renderer observation as an in-limit sample');
  assert.ok(reads <= 602, 'renderer probes are at most once per second plus boundaries');
  assert.ok(bounded.windows.every(w => w.endMs - w.startMs <= CAPTURE_LIMITS.windowMs));
  assert.ok(bounded.windows.every(w => w.frames <= CAPTURE_LIMITS.framesPerWindow));
  assert.ok(bounded.checkpoints.length <= CAPTURE_LIMITS.checkpoints);

  clock = 0;
  const flooding = make();
  for (let i = 0; i <= CAPTURE_LIMITS.framesPerWindow; i++) flooding.record(0.001);
  assert.equal(flooding.snapshot().stopReason, 'frame_limit');
  assert.equal(flooding.snapshot().windows[0].frames, CAPTURE_LIMITS.framesPerWindow);
  assert.equal(flooding.snapshot().truncated.frames, true);
  const resetting = make();
  for (let i = 0; i < 1000; i++) resetting.reset();
  resetting.stop();
  assert.equal(resetting.snapshot().checkpoints.length, CAPTURE_LIMITS.checkpoints);
  assert.equal(resetting.snapshot().truncated.checkpoints, true);

  const failed = new PerformanceCapture(undefined, () => clock, () => { throw new Error('private@example.invalid secret URL'); });
  for (const dt of [NaN, Infinity, -1, 0]) failed.record(dt);
  clock = NaN;
  failed.record(0.02);
  clock = 100;
  failed.stop();
  assert.equal(failed.snapshot().errors.invalidFrames, 4);
  assert.equal(failed.snapshot().errors.clockFailures, 1);
  assert.equal(failed.snapshot().errors.probeFailures, 2);
  assert.equal(failed.snapshot().windows[0].frames, 1);
  assert.doesNotMatch(JSON.stringify(failed.snapshot()), /private@|secret URL|stack/);

  // A menu/hidden gap is not invented as a frame or as a longer measurement window.
  clock = 0;
  const gap = make();
  clock = 100;
  gap.record(0.1);
  clock = 45000;
  gap.stop();
  assert.equal(gap.snapshot().windows[0].endMs, 10000);
  assert.equal(gap.snapshot().windows[0].sampledMs, 100);

  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ html: '<meta name="build-id" content="2026-11-08 12:00 UTC">', url: 'https://snowglider.ai/?token=private' });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent: 'Mozilla/5.0 (iPhone) Version/18.1 Mobile Safari/604.1 private@example.invalid',
    platform: 'iPhone', maxTouchPoints: 5,
  } });
  try {
    assert.deepEqual(readCaptureContext(), { build: '2026-11-08 12:00 UTC', device: 'iphone', browser: 'safari', browserMajor: 18 });
    const w = /** @type {any} */ (env.window);
    w.renderer = {
      info: { render: { calls: 12, triangles: Infinity }, memory: { geometries: NaN, textures: 8 }, programs: [] },
      getPixelRatio() { return 1.5; },
      domElement: { width: 585, height: 1050, dataset: { renderQuality: 'balanced', renderQualityMode: 'auto' } },
    };
    const partial = readPerformanceProbe();
    assert.equal(partial.renderer.geometries, null);
    assert.equal(partial.renderer.triangles, null);
    assert.equal(partial.renderer.textures, 8);
    assert.equal(partial.renderer.programs, 0);
    assert.equal(partial.renderer.quality, 'balanced');
    assert.equal(partial.renderer.pixelRatio, 1.5);
    clock = 0;
    const changes = make();
    w.renderer.domElement.dataset.renderQuality = 'low';
    clock = 1000;
    changes.record(0.03);
    changes.stop();
    assert.deepEqual(changes.snapshot().checkpoints.slice(0, 2).map(p => p.probe.renderer.quality), ['balanced', 'low']);
    assert.doesNotMatch(JSON.stringify(changes.snapshot()), /private@|token=|https:|userAgent/);
    delete w.renderer;
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    env.teardown();
  }
  console.log('Performance capture: exact window statistics, duration/frame/checkpoint caps, reset persistence, gaps, quality, missing data and privacy passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
