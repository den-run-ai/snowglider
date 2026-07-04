// scenery-props-tests.js — headless coverage for the decorative prop catalog + placement
// (src/scenery/prop-catalog.ts + src/scenery/decorative-props.ts, issue #320 PR 6).
//
// Pins the PR-6 invariants: a catalog of procedural archetypes each building an Object3D with
// its base at local y=0; placement that scatters props OUTSIDE the lane (collision-neutral) and
// grounded on the terrain; lit-but-shadowless fog materials; seeded determinism; and ZERO
// global Math.random consumption.
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-props-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { PROP_CATALOG, createPropPool } = await import('../src/scenery/prop-catalog.ts');
  const { buildDecorativeProps } = await import('../src/scenery/decorative-props.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  const flat = (_x, _z) => 4;
  const ctx = { terrain: null, getTerrainHeight: flat, courseLine: null, difficulty: 'blue', seed: 1 };

  testCatalog(THREE, PROP_CATALOG, createPropPool, makeSceneryRng);
  testPlacement(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testOutsideLane(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testGrounded(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testMaterials(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testGeometryPooling(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testDeterminism(THREE, buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testStreamNeutrality(buildDecorativeProps, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);

  console.log(`\nSCENERY-PROPS TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function testCatalog(THREE, catalog, createPropPool, makeSceneryRng) {
  console.log('--- prop catalog: archetypes ---');
  check('catalog has several archetypes', catalog.length >= 4);
  const rng = makeSceneryRng(1);
  const pool = createPropPool();
  let allObjects = true, basedAtGround = true;
  for (const a of catalog) {
    const o = a.build(rng, pool);
    if (!o || !o.isObject3D) allObjects = false;
    o.updateMatrixWorld(true);
    // Base near local y=0: the lowest child should not sit far below the origin.
    const box = new THREE.Box3().setFromObject(o);
    if (box.min.y < -0.6) basedAtGround = false;
  }
  check('every archetype builds an Object3D', allObjects);
  check('every archetype is based at ~local y=0 (placer grounds it)', basedAtGround);
}

// Perf regression guard (Codex review on #327): all scattered props must SHARE a pooled set of
// geometries/materials, so the live BufferGeometry count stays bounded regardless of how many
// props are scattered — the same invariant tests/e2e/perf-budget.spec.ts pins for the forest.
function testGeometryPooling(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: geometry/material pooling ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  const geos = new Set(), mats = new Set();
  let meshCount = 0;
  g.traverse((o) => {
    if (o.isMesh) { meshCount++; geos.add(o.geometry); const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => mats.add(x)); }
  });
  check('scatter produces many meshes', meshCount >= 16);
  // A handful of shared geometries/materials — NOT one per mesh. 7 geos + 6 mats in the pool.
  check('unique geometries stay pooled + bounded (<= 8)', geos.size <= 8);
  check('unique materials stay pooled + bounded (<= 8)', mats.size <= 8);
  check('far fewer unique geometries than meshes (pooled, not per-prop)', geos.size < meshCount);
}

function testPlacement(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: placement structure ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  check('returns a Group named "decorative-props"', g.isGroup === true && g.name === 'decorative-props');
  check('scatters several props', g.children.length >= 8);
  const knownNames = new Set(['cairn', 'trail-marker', 'fence', 'stump']);
  check('every prop is a known catalog archetype', g.children.every((c) => knownNames.has(c.name)));
}

function testOutsideLane(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: outside the lane, on terrain ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  let allOutside = true, allOnTerrain = true;
  for (const c of g.children) {
    if (Math.abs(c.position.x) < 40) allOutside = false;   // clear of the lane + drift margin
    if (Math.abs(c.position.x) > 150 || c.position.z < -200 || c.position.z > 200) allOnTerrain = false;
  }
  check('every prop is clear of the lane (|x| >= 40)', allOutside);
  check('every prop is on the rendered terrain', allOnTerrain);
}

function testGrounded(THREE, build, makeSceneryRng, budget) {
  console.log('--- decorative props: grounded on the terrain sampler ---');
  let reads = 0;
  const sampler = (x, z) => { reads++; return Number.isFinite(x) && Number.isFinite(z) ? 6.25 : 0; };
  const ctx = { terrain: null, getTerrainHeight: sampler, courseLine: null, difficulty: 'black', seed: 2 };
  const g = build(makeSceneryRng(2), budget, ctx);
  check('terrain height sampler is read for grounding', reads > 0);
  check('every prop is grounded to the sampled height', g.children.every((c) => Math.abs(c.position.y - 6.25) < 1e-9));
}

function testMaterials(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: lit-but-shadowless fog materials ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  const meshes = [];
  g.traverse((o) => { if (o.isMesh) meshes.push(o); });
  check('props contain meshes', meshes.length > 0);
  check('every mesh material is MeshStandardMaterial', meshes.every((m) => m.material.isMeshStandardMaterial === true));
  check('every mesh material is fog-enabled', meshes.every((m) => m.material.fog === true));
  check('no prop mesh casts a shadow', meshes.every((m) => m.castShadow === false));
  check('no prop mesh receives a shadow', meshes.every((m) => m.receiveShadow === false));
}

function testDeterminism(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: seeded determinism ---');
  const sig = (g) => g.children.map((c) => `${c.name}:${c.position.x.toFixed(4)},${c.position.z.toFixed(4)},${c.rotation.y.toFixed(4)}`).join('|');
  const a = sig(build(makeSceneryRng(17), budget, ctx));
  const b = sig(build(makeSceneryRng(17), budget, ctx));
  const c = sig(build(makeSceneryRng(18), budget, ctx));
  check('same seed => identical prop layout', a === b);
  check('different seed => different prop layout', a !== c);
}

function testStreamNeutrality(build, makeSceneryRng, budget, ctx) {
  console.log('--- decorative props: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    build(makeSceneryRng(88), budget, ctx);
    check('builds every prop without consuming global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
