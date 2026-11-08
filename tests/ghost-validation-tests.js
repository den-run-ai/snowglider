// @ts-check
// Exercise persisted data through the real CourseModule init/reset/update path.
// A current physics/seed stamp does not make malformed localStorage data trusted.
const assert = require('node:assert/strict');

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const THREE = await import('three');
  const { CourseModule: Course } = await import('../src/course.ts');
  const RC = await import('../src/run-context.ts');
  const { START_Z, FINISH_Z, splitPoints } = Course._config;
  const ghostKey = 'snowgliderGhost_black';
  const splitsKey = 'snowgliderBestSplits_black';
  const metaKey = `${ghostKey}_meta`;
  const local = env.localStorage;
  let cases = 0;

  // Only gate-label painting is mocked; geometry, ghost construction, playback,
  // split detection, result rendering and persistence are the production code.
  Object.defineProperty(env.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ fillRect() {}, fillText() {} }),
  });

  /** @type {import('three').Scene | null} */
  let scene = null;
  /** @type {import('three').Group | null} */
  let ghost = null;
  function cleanup() {
    Course.teardown();
    if (scene) scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
          material.dispose();
        }
      }
    });
    scene = null;
    ghost = null;
  }

  const valid = [
    { t: 0, x: 0, y: 30, z: START_Z, rot: 0 },
    { t: 10, x: 10, y: 40, z: START_Z - 20, rot: 1 },
    { t: 20, x: 20, y: 30, z: START_Z - 40, rot: 2 },
  ];

  /** @param {string} rawGhost @param {string} [rawSplits] @param {unknown} [stamp] */
  function start(rawGhost, rawSplits = '[2,4,6,20]', stamp = RC.getRunStamp()) {
    cleanup();
    local.clear();
    local.setItem(ghostKey, rawGhost);
    local.setItem(splitsKey, rawSplits);
    local.setItem(metaKey, JSON.stringify(stamp));
    scene = new THREE.Scene();
    Course.init({
      scene,
      getTerrainHeight: () => 30,
      createSnowman: (target) => {
        ghost = new THREE.Group();
        target.add(ghost);
        return ghost;
      },
      getDifficulty: () => 'black',
    });
    Course.reset();
    Course.update({ x: 0, y: 30, z: START_Z - 10 }, 5);
  }

  function finish() {
    splitPoints.forEach(({ z }, index) => {
      Course.update({ x: 4, y: 35, z }, (index + 1) * 10);
    });
    return Course.onFinish(40, Infinity);
  }

  try {
    RC.setRunSeed(RC.CANONICAL_WORLD_SEED);
    const invalidGhosts = [
      'not json', 'null', '{}', '[]', JSON.stringify([valid[0]]),
      JSON.stringify([null, valid[1]]),
      JSON.stringify([valid[0], {}]),
      JSON.stringify([valid[0], { ...valid[1], x: '10' }]),
      JSON.stringify([valid[0], { ...valid[1], y: null }]),
      JSON.stringify([valid[0], { ...valid[1], z: null }]),
      JSON.stringify([valid[0], { ...valid[1], rot: null }]),
      JSON.stringify([valid[0], { ...valid[1], t: '10' }]),
      JSON.stringify([{ ...valid[0], t: -1 }, valid[1]]),
      JSON.stringify([valid[1], valid[0]]),
      JSON.stringify([valid[0], { ...valid[1], t: 0 }]),
      '[{"t":0,"x":0,"y":30,"z":-15,"rot":0},{"t":1e999,"x":0,"y":30,"z":-35,"rot":0}]',
      '[{"t":0,"x":0,"y":30,"z":-15,"rot":0},{"t":10,"x":1e999,"y":30,"z":-35,"rot":0}]',
    ];
    for (const raw of invalidGhosts) {
      assert.doesNotThrow(() => start(raw), `malformed ghost must not crash: ${raw}`);
      assert.equal(ghost, null, `malformed ghost must not be built: ${raw}`);
      finish();
      assert.notEqual(local.getItem(ghostKey), raw, 'a rejected ghost must not block the next valid tier best');
      cases++;
    }

    start(JSON.stringify(valid));
    assert.ok(ghost, 'current-stamped valid ghost is built');
    assert.deepEqual(ghost.position.toArray(), [5, 35, START_Z - 10], 'valid playback interpolates x/y/z');
    assert.equal(ghost.rotation.y, 0.5, 'valid playback interpolates rotation');
    cases++;

    // Reset reloads changed storage rather than retaining a previously valid track.
    local.setItem(ghostKey, JSON.stringify([null, valid[1]]));
    Course.reset();
    ghost.position.set(123, 456, 789);
    assert.doesNotThrow(() => Course.update({ x: 0, y: 30, z: START_Z - 10 }, 5));
    assert.deepEqual(ghost.position.toArray(), [123, 456, 789], 'corrupt replacement disables old playback');
    cases++;

    // The actual writer appends an equal-time finish sample. Do not invalidate
    // ordinary saved runs by requiring strictly increasing sample timestamps.
    start('[]');
    finish();
    const saved = local.getItem(ghostKey);
    assert.ok(saved);
    const samples = JSON.parse(saved);
    assert.equal(samples.at(-1).t, samples.at(-2).t, 'fixture drives the real duplicate-finish writer');
    start(saved);
    assert.ok(ghost, 'writer output round-trips through validation');
    Course.update({ x: 4, y: 35, z: FINISH_Z }, 40);
    assert.deepEqual(ghost.position.toArray(), [4, 35, FINISH_Z], 'duplicate finish timestamp uses the final pose');
    cases++;

    const invalidSplits = [
      'not json', 'null', '{}', '[]', '[2,4,6]', '[2,4,6,20,21]',
      '[-2,4,6,20]', '[2,1,6,20]', '[2,4,null,20]', '[2,4,"6",20]',
      '[0,0,0,0]', '[2,4,6,1e999]',
    ];
    for (const raw of invalidSplits) {
      start(JSON.stringify(valid), raw);
      const table = finish().querySelector('#resultSplitTable');
      assert.ok(table);
      assert.equal((table.textContent.match(/—/g) || []).length, 4, `invalid splits show no deltas: ${raw}`);
      assert.ok(!table.textContent.includes('NaN'), 'bad persisted values never reach the UI');
      cases++;
    }

    start(JSON.stringify(valid), '[0,10,10,20]');
    const table = finish().querySelector('#resultSplitTable');
    assert.ok(table);
    assert.ok(!table.textContent.includes('—'), 'valid cumulative splits accept zero and equal checkpoint times');
    cases++;

    // An absent/string seed is not equivalent to an explicitly unseeded stamp.
    RC.setRunSeed(null);
    for (const stamp of [
      { physicsVersion: RC.PHYSICS_VERSION },
      { physicsVersion: RC.PHYSICS_VERSION, seed: 'bad' },
      { physicsVersion: RC.PHYSICS_VERSION, seed: 123 },
      { physicsVersion: -1, seed: null },
    ]) {
      start(JSON.stringify(valid), '[2,4,6,20]', stamp);
      assert.equal(ghost, null, 'invalid/world-mismatched stamp is rejected');
      cases++;
    }
    start(JSON.stringify(valid));
    assert.ok(ghost, 'explicit null seed remains valid for unseeded harness runs');
    cases++;
  } finally {
    cleanup();
    RC.setRunSeed(null);
    env.teardown();
  }
  console.log(`Ghost validation: ${cases} integration cases passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
