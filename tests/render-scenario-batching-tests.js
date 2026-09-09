// @ts-check
// Run the actual Playwright phase helpers against a deterministic Page boundary.
// Browser-call count is the regression contract: CI traces spent 133–155 seconds
// between calls while only 1.6–1.9 seconds ran inside the controlled frame steps.
const assert = require('node:assert/strict');

async function main() {
  const { RENDER_PHASES, enterRenderPhase, measureRenderPhase, assertRenderPhase } =
    await import('./e2e/render-scenarios.ts');
  const savedWindow = globalThis.window;
  const controls = { up: false, down: false, left: false, right: false, jump: false };
  const info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 7, textures: 5 }, programs: [1, 2, 3] };
  const identity = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const sprites = [{ userData: { active: false }, parent: null }];
  const powder = [{ visible: false }];
  let frame = 0, evaluations = 0, cameraEntries = 0, triggers = 0, debris = false;
  const phaseEntryFrames = [];
  const world = {
    pos: { x: 0, y: 0, z: 0 }, velocity: { x: 0, z: 0 },
    snowman: { position: { set() {} }, rotation: {} },
    cameraManager: { initialize() { cameraEntries++; phaseEntryFrames.push(frame); } },
    getTerrainHeight: () => 4,
    getControls: () => controls,
    showGameOver() { debris = true; phaseEntryFrames.push(frame); },
    testHooks: { isDebrisActive: () => debris },
    snowSplash: { particles: sprites },
    avalanche: { active: false, powder, trigger() { this.active = true; powder[0].visible = true; triggers++; } },
    renderer: { info },
    __renderClock: {
      step() {
        frame++;
        sprites[0].userData.active = controls.right;
        info.render.calls = 100 + frame;
        info.render.triangles = 1000 + frame;
        return { cpuMs: frame, synchronizedMs: frame + .5 };
      },
    },
    scene: {
      traverse(callback) {
        for (const chunk of ['near', 'far']) {
          callback({ name: 'forestInstanced', userData: { forestChunk: chunk }, matrixWorld: identity });
        }
        callback({
          name: 'snowBillboards', matrixWorld: identity,
          geometry: {
            instanceCount: 12,
            getAttribute: () => ({ count: 1528 }),
            attributes: { position: { array: new Float32Array([0, 1, 2]) } },
          },
        });
      },
    },
  };
  globalThis.window = /** @type {any} */ (world);
  const page = /** @type {import('@playwright/test').Page} */ (/** @type {unknown} */ ({
    async evaluate(callback, argument) {
      evaluations++;
      return callback(argument);
    },
  }));
  try {
    for (const phase of RENDER_PHASES) {
      const before = frame;
      let callsBefore = evaluations;
      await enterRenderPhase(page, phase);
      assert.equal(frame, before + 8, `${phase}: retain all eight settling frames`);
      assert.equal(evaluations - callsBefore, 1, `${phase}: settling must use one browser call`);
      callsBefore = evaluations;
      const metrics = await measureRenderPhase(page, phase);
      assert.equal(frame, before + 20, `${phase}: retain all twelve measurement frames`);
      assert.equal(evaluations - callsBefore, 1, `${phase}: sampling and state must use one browser call`);
      assert.equal(metrics.calls, 100 + frame, 'peak includes the final measured frame');
      assert.equal(metrics.triangles, 1000 + frame);
      assert.deepEqual(metrics.frameCpuMs, { p50: before + 14, p95: before + 20 },
        'quantiles include twelve distinct samples, excluding settling frames');
      assert.deepEqual(metrics.synchronizedFrameMs, { p50: before + 14.5, p95: before + 20.5 });
      assertRenderPhase(metrics);
      assert.throws(() => assertRenderPhase({ ...metrics, state: { ...metrics.state, snowInstances: 0 } }),
        /live snow instances must render/, 'an empty snow draw cannot satisfy the particle guard');
    }
    assert.equal(frame, 100, 'all five phases keep their complete controlled-frame workload');
    assert.equal(evaluations, 10, 'bounded automation crossings across the full scenario');
    assert.equal(cameraEntries, 4);
    assert.equal(triggers, 1);
    assert.deepEqual(phaseEntryFrames, [0, 20, 40, 60, 80], 'phase actions precede settling, including crash');
    assert.equal(debris, true);
  } finally {
    globalThis.window = savedWindow;
  }
  console.log('Render scenario batching: 100 frames, 10 browser calls, exact sample quantiles, phase ordering and nonempty particles verified.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
