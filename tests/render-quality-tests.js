// @ts-check
const assert = require('node:assert/strict');

(async () => {
  const THREE = await import('three');
  const { createQualityPolicy, createRenderQuality, resolveRenderQualityMode } =
    await import('../src/game/render-quality.ts');
  const changes = [];
  const policy = createQualityPolicy(level => changes.push(level));
  const frames = (count, dt, ready = true) => {
    for (let i = 0; i < count; i++) policy.sample(dt, ready);
  };
  frames(120, 1 / 30); // startup grace and incomplete first window
  assert.equal(policy.getLevel(), 0);
  frames(105, 1 / 30);
  assert.equal(policy.getLevel(), 1, 'sustained slow rendering steps down one tier');
  frames(225, 1 / 30);
  assert.equal(policy.getLevel(), 2);
  frames(600, 1 / 30);
  assert.deepEqual(changes, [1, 2], 'quality is bounded and does not reallocate at the floor');
  frames(100, 1 / 60);
  assert.equal(policy.getLevel(), 2, 'brief fast periods cannot oscillate quality');
  frames(1000, 1 / 60);
  assert.equal(policy.getLevel(), 1, 'sustained headroom restores quality slowly');
  frames(1000, 1 / 60);
  assert.equal(policy.getLevel(), 0);
  frames(800, 1 / 50);
  assert.equal(policy.getLevel(), 0, 'dead band holds quality');
  frames(800, 1 / 30, false);
  assert.equal(policy.getLevel(), 0, 'loading/inactive observations do not lower quality');
  frames(60, 1 / 60);
  for (const dt of [NaN, Infinity, -1, 0, 10]) policy.sample(dt);
  assert.equal(policy.getLevel(), 0, 'invalid samples and hidden gaps are ignored');
  const overloaded = createQualityPolicy(() => {});
  for (let i = 0; i < 100; i++) overloaded.sample(0.3);
  assert.equal(overloaded.getLevel(), 2, 'sustained sub-4-FPS rendering still lowers quality');
  const isolated = createQualityPolicy(() => {});
  for (let i = 0; i < 200; i++) isolated.sample(1 / 60);
  isolated.sample(10);
  for (let i = 0; i < 200; i++) isolated.sample(1 / 60);
  assert.equal(isolated.getLevel(), 0, 'one long stall cannot force a quality reduction');

  const stalled50Hz = createQualityPolicy(() => {});
  for (let i = 0; i < 151; i++) stalled50Hz.sample(0.02);
  stalled50Hz.sample(1);
  for (let i = 0; i < 100; i++) stalled50Hz.sample(0.02);
  assert.equal(stalled50Hz.getLevel(), 0, 'one stall on a 50 Hz display cannot lower quality');
  for (let i = 0; i < 5000; i++) stalled50Hz.sample(0.02);
  assert.equal(stalled50Hz.getLevel(), 0, '50 Hz stays high without needing the below-18 ms upgrade path');

  for (const reset of ['normal', 'invalid', 'not-ready', 'explicit']) {
    const consecutive = createQualityPolicy(() => {});
    // Binary-exact intervals pin the boundaries: 24 warmup frames, then 16
    // samples per two-second window. No rounding tolerance or wall clock needed.
    for (let i = 0; i < 24; i++) consecutive.sample(0.125);
    for (let i = 0; i < 16; i++) consecutive.sample(0.125);
    assert.equal(consecutive.getLevel(), 0, 'the first slow window only arms a downgrade');
    if (reset === 'normal') {
      for (let i = 0; i < 100; i++) consecutive.sample(0.02);
    } else if (reset === 'invalid') consecutive.sample(NaN);
    else if (reset === 'not-ready') consecutive.sample(0.125, false);
    else consecutive.resetTiming();
    if (reset === 'not-ready' || reset === 'explicit') {
      for (let i = 0; i < 24; i++) consecutive.sample(0.125);
    }
    for (let i = 0; i < 16; i++) consecutive.sample(0.125);
    assert.equal(consecutive.getLevel(), 0, `${reset} observations reset the slow-window streak`);
    for (let i = 0; i < 15; i++) consecutive.sample(0.125);
    assert.equal(consecutive.getLevel(), 0, 'a partial second slow window cannot lower quality');
    consecutive.sample(0.125);
    assert.equal(consecutive.getLevel(), 1, 'the second complete consecutive slow window lowers one tier');
  }

  assert.equal(resolveRenderQualityMode('', false), 'auto');
  assert.equal(resolveRenderQualityMode('', true), 'high');
  assert.equal(resolveRenderQualityMode('?quality=auto', true), 'auto');
  assert.equal(resolveRenderQualityMode('?quality=low', false), 'low');
  assert.equal(resolveRenderQualityMode('?quality=invalid', false), 'auto');
  assert.equal(resolveRenderQualityMode('?quality=balanced', true), 'balanced');

  let pixelRatio = 2;
  let pixelWrites = 0;
  const renderer = /** @type {import('three').WebGLRenderer} */ (/** @type {unknown} */ ({
    getPixelRatio: () => pixelRatio,
    setPixelRatio: (value) => { pixelRatio = value; pixelWrites++; },
    shadowMap: { needsUpdate: false },
    domElement: { dataset: {} },
  }));
  const sun = new THREE.DirectionalLight();
  sun.shadow.mapSize.set(2048, 2048);
  const oldMap = new THREE.WebGLRenderTarget(2048, 2048);
  const oldPass = new THREE.WebGLRenderTarget(2048, 2048);
  let mapDisposed = 0, passDisposed = 0;
  oldMap.addEventListener('dispose', () => mapDisposed++);
  oldPass.addEventListener('dispose', () => passDisposed++);
  sun.shadow.map = oldMap;
  sun.shadow.mapPass = oldPass;
  const control = createRenderQuality(renderer, sun, 'auto', 3);
  assert.equal(pixelRatio, 2, 'maximum quality retains shipped DPR cap');
  assert.equal(pixelWrites, 0, 'initial high quality does not reallocate unchanged buffer');
  for (let i = 0; i < 225; i++) control.sample(1 / 30);
  assert.equal(pixelRatio, 1.5);
  assert.equal(sun.shadow.mapSize.x, 1024);
  assert.equal(sun.shadow.map, null);
  assert.equal(sun.shadow.mapPass, null);
  assert.equal(mapDisposed, 1);
  assert.equal(passDisposed, 1);
  assert.equal(sun.shadow.needsUpdate, true);
  assert.equal(renderer.shadowMap.needsUpdate, true);
  assert.equal(renderer.domElement.dataset.renderQuality, 'balanced');
  control.setDevicePixelRatio(1);
  assert.equal(pixelRatio, 1, 'moving displays honors actual device pixel ratio');
  control.setDevicePixelRatio(NaN);
  assert.equal(pixelRatio, 1, 'invalid DPR has a finite fallback');
  const fixed = createRenderQuality(renderer, sun, 'high', 2);
  for (let i = 0; i < 1000; i++) fixed.sample(1 / 30);
  assert.equal(pixelRatio, 2, 'fixed inspection/automation tier stays deterministic');
  assert.equal(sun.shadow.mapSize.x, 2048);
  console.log('Render quality: timing hysteresis, sustained overload, bounded resources, overrides and disposal passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
