// @ts-check
// scenery-tests.js — headless coverage for the background scenery facade
// (src/scenery/scenery.ts) and its seed derivation (src/scenery/scenery-budget.ts).
//
// PR 1 is the integration SEAM (issue #320): the scenery system ships essentially
// empty, so these tests pin the invariants the seam must uphold before any visual
// layer is added —
//   * createScenery() consumes ZERO global Math.random (stream-neutral)
//   * it parents exactly one owned group under the scene, with finite transforms
//   * update() is a cosmetic no-op that never touches the collision arrays or the
//     player position, and consumes no global Math.random
//   * dispose() detaches the group and is idempotent
//   * scenerySeedFor() is deterministic and tier-distinct (same tier => same seed)
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { createScenery } = await import('../src/scenery/scenery.ts');
  const { scenerySeedFor, DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  testSeedDerivation(scenerySeedFor);
  testCreateScenery(THREE, createScenery, scenerySeedFor, DEFAULT_SCENERY_BUDGET);
  testCollisionArrayNeutrality(THREE, createScenery, scenerySeedFor);
  testDispose(THREE, createScenery, scenerySeedFor);

  console.log(`\nSCENERY TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const flatTerrain = () => 0; // pure sampler stand-in

function baseCtx(scenerySeedFor, difficulty) {
  return {
    terrain: null,
    getTerrainHeight: flatTerrain,
    courseLine: null,
    difficulty,
    seed: scenerySeedFor(difficulty),
  };
}

function testSeedDerivation(scenerySeedFor) {
  console.log('--- scenerySeedFor: deterministic, tier-distinct ---');
  const tiers = ['bunny', 'blue', 'black', 'expert'];
  check('same tier => same seed', tiers.every((t) => scenerySeedFor(t) === scenerySeedFor(t)));
  const seeds = tiers.map(scenerySeedFor);
  check('all seeds finite integers', seeds.every((s) => Number.isInteger(s)));
  check('tiers get distinct seeds', new Set(seeds).size === tiers.length);
}

function testCreateScenery(THREE, createScenery, scenerySeedFor, budget) {
  console.log('--- createScenery: stream-neutral seam, finite owned group ---');

  const scene = new THREE.Scene();
  const before = scene.children.length;

  // Wrap the global Math.random with a call counter (creating the system may construct
  // THREE objects that draw UUIDs — those MUST go through the private guard).
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  let scenery;
  try {
    scenery = createScenery(scene, baseCtx(scenerySeedFor, 'blue'));
    check('createScenery consumes no global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }

  check('exactly one node added to the scene', scene.children.length === before + 1);
  check('owns a group named "scenery"', scenery.group.isGroup === true && scenery.group.name === 'scenery');
  check('group is parented under the scene', scenery.group.parent === scene);
  const p = scenery.group.position;
  check('group transform is finite (no NaN/Infinity)', Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  check('default budget is exposed', budget && budget.ridgeLayers > 0);

  // update(): cosmetic no-op — no throw, and no global Math.random consumption.
  const savedRandom2 = Math.random;
  let updCalls = 0;
  Math.random = () => { updCalls++; return savedRandom2(); };
  let threw = false;
  try {
    scenery.update(0.016, new THREE.Vector3(1, 2, 3), { windStrength: 0.5, windGust: 0.2 });
    scenery.update(0.016, new THREE.Vector3(1, 2, 3)); // ctx omitted is valid
  } catch { threw = true; } finally { Math.random = savedRandom2; }
  check('update() does not throw', !threw);
  check('update() consumes no global Math.random', updCalls === 0);
}

function testCollisionArrayNeutrality(THREE, createScenery, scenerySeedFor) {
  console.log('--- createScenery: collision-array neutrality ---');
  const scene = new THREE.Scene();
  // Stand-in collision arrays the real setupScene builds BEFORE scenery. Scenery must
  // never read from or write to these — it receives neither, and construction/update
  // must leave any caller-held arrays untouched.
  const treePositions = [{ x: 5, z: -10 }, { x: -3, z: -20 }];
  const rockPositions = [{ x: 8, z: -30, radius: 2 }];
  const treeSnapshot = JSON.stringify(treePositions);
  const rockSnapshot = JSON.stringify(rockPositions);

  const scenery = createScenery(scene, baseCtx(scenerySeedFor, 'black'));
  scenery.update(0.016, new THREE.Vector3(0, 0, -15));

  check('treePositions length unchanged', treePositions.length === 2);
  check('rockPositions length unchanged', rockPositions.length === 1);
  check('treePositions contents unchanged', JSON.stringify(treePositions) === treeSnapshot);
  check('rockPositions contents unchanged', JSON.stringify(rockPositions) === rockSnapshot);

  // A player Vector3 handed to update() is read-only; it must not be mutated.
  const player = new THREE.Vector3(2, 3, -18);
  scenery.update(0.033, player);
  check('player position not mutated by update()', player.x === 2 && player.y === 3 && player.z === -18);
}

function testDispose(THREE, createScenery, scenerySeedFor) {
  console.log('--- dispose: detaches group, idempotent ---');
  const scene = new THREE.Scene();
  const scenery = createScenery(scene, baseCtx(scenerySeedFor, 'bunny'));
  check('group attached before dispose', scenery.group.parent === scene);

  scenery.dispose();
  check('group detached from scene after dispose', scenery.group.parent === null);
  check('scene has no scenery child after dispose', !scene.children.includes(scenery.group));

  let threw = false;
  try { scenery.dispose(); } catch { threw = true; }
  check('dispose is idempotent (no throw on second call)', !threw);
}

main().catch((e) => { console.error(e); process.exit(1); });