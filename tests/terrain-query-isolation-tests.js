// @ts-check
// Real camera + kernel regression: render interpolation must never alter terrain
// queries on the fixed physics grid. The old rounded, first-writer height cache
// made a camera switch or refresh-rate change steer an identical seeded run.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

async function main() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/?seed=1' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const THREE = await import('three');
  const { Camera, CAMERA_MODES } = await import('../src/camera.ts');
  const { Physics } = await import('../src/player-state.ts');
  const terrain = await import('../src/mountains/terrain.ts');
  const runContext = await import('../src/run-context.ts');

  terrain.resetHeightMap();
  // Distinct points in the same former 0.1-unit cache cell must each sample
  // their own surface, regardless of who queried the neighbour first.
  const a = [0.001, -40.001], b = [0.049, -40.049];
  terrain.getTerrainHeight(a[0], a[1]);
  assert.equal(terrain.getTerrainHeight(b[0], b[1]), terrain.getTerrainHeightUncached(b[0], b[1]));
  const grad = terrain.getTerrainGradient(b[0], b[1]);
  assert.deepEqual(grad, terrain.getTerrainGradientUncached(b[0], b[1]));
  // A legacy diagnostic entry, even one from another coordinate, is inert.
  terrain.heightMap['0,-400'] = 999;
  assert.equal(terrain.getTerrainHeight(b[0], b[1]), terrain.getTerrainHeightUncached(b[0], b[1]));
  console.log('PASS: neighbouring samples and diagnostic entries cannot change terrain height or gradient');

  const STEPS = 900;
  const controls = { left: false, right: false, up: false, down: false, jump: false };
  /** @param {number} hz @param {import('../src/camera.ts').CameraMode | null} mode */
  function run(hz, mode, clear = true, seed = 0xABCD1234) {
    if (clear) terrain.resetHeightMap();
    runContext.setRunSeed(seed);
    const model = new THREE.Object3D();
    const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    model.userData = {
      targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
      leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1,
    };
    const camera = new Camera(new THREE.Scene());
    if (mode) camera.setMode(mode);
    const player = Physics.createPlayerState(terrain.getTerrainHeight);
    Physics.resetPlayer(player, model, terrain.getTerrainHeight, camera);
    const trajectory = [];
    let accumulator = 0;
    let previous = { ...player.pos }, current = { ...player.pos };
    while (trajectory.length < STEPS) {
      accumulator += 1 / hz;
      while (accumulator >= 1 / 60 && trajectory.length < STEPS) {
        previous = { ...current };
        Physics.stepPlayer(player, {
          snowman: model, delta: 1 / 60, controls,
          getTerrainHeight: terrain.getTerrainHeight,
          getTerrainGradient: terrain.getTerrainGradient,
          getDownhillDirection: terrain.getDownhillDirection,
          treePositions: [], rockPositions: [], gameActive: false, showGameOver() {},
        });
        current = { ...player.pos };
        trajectory.push([player.pos.x, player.pos.y, player.pos.z,
          player.velocity.x, player.velocity.z, player.isInAir, player.verticalVelocity]);
        accumulator -= 1 / 60;
      }
      if (mode) {
        // Mirror main-loop's render lerp, including frames with zero substeps.
        const alpha = accumulator * 60;
        model.position.set(
          previous.x + (current.x - previous.x) * alpha,
          previous.y + (current.y - previous.y) * alpha,
          previous.z + (current.z - previous.z) * alpha,
        );
        camera.update(model.position, model.rotation, player.velocity, terrain.getTerrainHeight,
          { frameDt: 1 / hz, isInAir: player.isInAir });
        model.position.set(player.pos.x, player.pos.y, player.pos.z);
      }
    }
    return trajectory;
  }

  const baseline = run(60, null);
  for (const mode of CAMERA_MODES) {
    for (const hz of [30, 60, 144]) {
      assert.deepEqual(run(hz, mode), baseline, `${mode} at ${hz} Hz changed the full physics trajectory`);
    }
  }
  console.log('PASS: all six real camera modes at 30/60/144 Hz preserve all 900 physics steps exactly');
  run(144, 'drone', false, 0xBEEF); // unrelated previous run on the same live terrain
  assert.deepEqual(run(144, 'auto', false), baseline, 'previous runs changed the replay');
  console.log('PASS: a replay stays byte-identical after another seed without clearing terrain caches');

  const before = Object.keys(terrain.heightMap).length;
  for (let i = 0; i < 10000; i++) terrain.getTerrainHeight((i % 101) / 7, -15 - i / 100);
  assert.equal(Object.keys(terrain.heightMap).length, before);
  console.log('PASS: moving runtime queries never grow the diagnostic height map');
  runContext.setRunSeed(null);
  dom.window.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
