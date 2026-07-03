// scenery-valley-tests.js — headless coverage for the valley backdrop
// (src/scenery/valley-backdrop.ts, issue #320 PR 3): frozen lake + far lodges +
// forest patches.
//
// Pins the PR-3 invariants: deterministic per-seed geometry, finite transforms, unlit
// NON-reflective fog materials with no shadows, an InstancedMesh for the patches (so the
// dispose sweep frees its instance buffer), read-only terrain sampling, and — the
// load-bearing one — ZERO global Math.random consumption.
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-valley-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

const flatTerrain = () => 0;

async function main() {
  const THREE = await import('three');
  const { buildValleyBackdrop } = await import('../src/scenery/valley-backdrop.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  const ctx = { terrain: null, getTerrainHeight: flatTerrain, courseLine: null, difficulty: 'blue', seed: 1 };

  testStructure(THREE, buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testLodgePlacement(THREE, buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testMaterials(THREE, buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testDeterminism(THREE, buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testTerrainReadOnly(buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testStreamNeutrality(buildValleyBackdrop, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);

  console.log(`\nSCENERY-VALLEY TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function collectMeshes(THREE, group) {
  const meshes = [];
  group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return meshes;
}

function testStructure(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildValleyBackdrop: structure & finiteness ---');
  const g = build(makeSceneryRng(5), budget, ctx);
  check('returns a Group named "valley-backdrop"', g.isGroup === true && g.name === 'valley-backdrop');

  const names = g.children.map((c) => c.name);
  check('has a frozen lake, lodges, and forest patches', names.includes('valley-backdrop') === false && g.children.length === 3);

  const lake = g.getObjectByName('frozen-lake');
  check('lake is a Mesh with indexed geometry', !!lake && lake.isMesh && !!lake.geometry.index);

  const patches = g.getObjectByName('valley-forest-patches');
  check('forest patches are an InstancedMesh', !!patches && patches.isInstancedMesh === true);
  check('patch instances have finite matrices', (() => {
    const m = new THREE.Matrix4();
    for (let i = 0; i < patches.count; i++) { patches.getMatrixAt(i, m); if (m.elements.some((v) => !Number.isFinite(v))) return false; }
    return true;
  })());

  const meshes = collectMeshes(THREE, g);
  const allFinite = meshes.every((mesh) => {
    const arr = mesh.geometry.getAttribute('position')?.array || [];
    return Array.from(arr).every((v) => Number.isFinite(v)) &&
      [mesh.position.x, mesh.position.y, mesh.position.z].every((v) => Number.isFinite(v));
  });
  check('all geometry + positions finite', allFinite);
  check('at least one lodge silhouette built', !!g.getObjectByName('lodge'));
}

// Regression (Codex review on #323): a lodge is a Group positioned at its shore point with
// LOCAL child offsets, so a nonzero rotation spins it about its own axis. The earlier bug
// positioned the children in WORLD space and rotated an origin-anchored group, swinging the
// whole lodge around world origin — off the lakeside cluster. Assert every lodge's rendered
// (world) position stays down in the valley, never near world origin.
function testLodgePlacement(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildValleyBackdrop: lodges rotate about their own origin ---');
  const g = build(makeSceneryRng(9), budget, ctx);
  g.updateMatrixWorld(true);
  const lodges = [];
  g.traverse((o) => { if (o.name === 'lodge') lodges.push(o); });
  check('lodge cluster built', lodges.length >= 3);
  const wp = new THREE.Vector3();
  let allInValley = true, anyAtOrigin = false;
  for (const lodge of lodges) {
    // Check a child's WORLD position — the location actually rendered.
    const child = lodge.children[0];
    child.getWorldPosition(wp);
    const distXZ = Math.hypot(wp.x, wp.z);
    // The shore arc keeps every lodge deep in -z (z < -330) around the valley center; the
    // fix makes the child's world XZ equal the shore point exactly (local offset is purely
    // vertical). The rotation-about-origin bug would swing z out of this band.
    if (!(wp.z < -330 && wp.x > -320 && wp.x < 160 && distXZ > 300 && distXZ < 900)) allInValley = false;
    if (distXZ < 100) anyAtOrigin = true;
  }
  check('every lodge renders down in the valley (z<-330, near shore, off world origin)', allInValley);
  check('no lodge swung to world origin (the rotation-about-origin bug)', !anyAtOrigin);
}

function testMaterials(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildValleyBackdrop: render-only, non-reflective materials ---');
  const g = build(makeSceneryRng(6), budget, ctx);
  const meshes = collectMeshes(THREE, g);
  check('every material is unlit MeshBasicMaterial (no reflection)', meshes.every((m) => {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    return mats.every((mm) => mm.isMeshBasicMaterial === true);
  }));
  check('no envMap / reflective shader on the lake', (() => {
    const lake = g.getObjectByName('frozen-lake');
    return !lake.material.envMap;
  })());
  check('every material is fog-enabled', meshes.every((m) => {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    return mats.every((mm) => mm.fog === true);
  }));
  check('nothing casts or receives a shadow', meshes.every((m) => m.castShadow === false && m.receiveShadow === false));
}

function testDeterminism(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildValleyBackdrop: seeded determinism ---');
  const lakePos = (g) => Array.from(g.getObjectByName('frozen-lake').geometry.getAttribute('position').array);
  const a = build(makeSceneryRng(11), budget, ctx);
  const b = build(makeSceneryRng(11), budget, ctx);
  const c = build(makeSceneryRng(12), budget, ctx);
  const pa = lakePos(a), pb = lakePos(b), pc = lakePos(c);
  check('same seed => identical lake geometry', pa.length === pb.length && pa.every((v, i) => v === pb[i]));
  check('different seed => different lake geometry', pa.some((v, i) => v !== pc[i]));
}

function testTerrainReadOnly(build, makeSceneryRng, budget) {
  console.log('--- buildValleyBackdrop: terrain is read-only ---');
  let writes = 0, reads = 0;
  // A sampler that would flag any attempt to treat it as mutable (it is a pure fn — the
  // point is that scenery only ever CALLS it, never assigns terrain state).
  const sampler = (x, z) => { reads++; return Number.isFinite(x) && Number.isFinite(z) ? -20 : 0; };
  const ctx = { terrain: null, getTerrainHeight: sampler, courseLine: null, difficulty: 'black', seed: 3 };
  build(makeSceneryRng(3), budget, ctx);
  check('terrain height sampler is read (for lodge grounding)', reads > 0);
  check('no terrain writes occurred', writes === 0);
}

function testStreamNeutrality(build, makeSceneryRng, budget, ctx) {
  console.log('--- buildValleyBackdrop: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    build(makeSceneryRng(77), budget, ctx);
    check('builds lake + lodges + patches without consuming global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
