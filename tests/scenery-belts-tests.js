// @ts-check
// scenery-belts-tests.js — headless coverage for the decorative forest belts
// (src/scenery/forest-belts.ts, issue #320 PR 4).
//
// Pins the PR-4 invariants: two InstancedMeshes (foliage + trunks) sharing per-instance
// transforms, every instance OUTSIDE the racing lane (the load-bearing collision-neutral
// property — belts must never intrude on the play corridor), grounded on the terrain via a
// read-only sampler, lit-but-shadowless fog materials, seeded determinism, and ZERO global
// Math.random consumption.
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-belts-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { buildForestBelts } = await import('../src/scenery/forest-belts.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  const flat = (_x, _z) => 3; // constant terrain height for grounding checks
  const ctx = { terrain: null, getTerrainHeight: flat, courseLine: null, difficulty: 'blue', seed: 1 };

  testStructure(THREE, buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testOutsideLane(THREE, buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testGrounded(THREE, buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testMaterials(THREE, buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testDeterminism(THREE, buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testStreamNeutrality(buildForestBelts, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);

  console.log(`\nSCENERY-BELTS TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function instancedOf(THREE, group) {
  const out = [];
  group.traverse((o) => { if (o.isInstancedMesh) out.push(o); });
  return out;
}

function testStructure(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildForestBelts: structure ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  check('returns a Group named "forest-belts"', g.isGroup === true && g.name === 'forest-belts');
  const inst = instancedOf(THREE, g);
  check('two InstancedMeshes (foliage + trunks)', inst.length === 2);
  check('foliage + trunk meshes present by name', !!g.getObjectByName('forest-belt-foliage') && !!g.getObjectByName('forest-belt-trunks'));
  const counts = inst.map((m) => m.count);
  check('both meshes share the same instance count', counts[0] === counts[1] && counts[0] > 0);

  const m = new THREE.Matrix4();
  let finite = true;
  for (const im of inst) for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); if (m.elements.some((v) => !Number.isFinite(v))) finite = false; }
  check('all instance matrices finite', finite);
}

function testOutsideLane(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildForestBelts: every instance outside the racing lane ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  const foliage = g.getObjectByName('forest-belt-foliage');
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let allOutside = true, allOnTerrain = true;
  for (let i = 0; i < foliage.count; i++) {
    foliage.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    if (Math.abs(p.x) < 100) allOutside = false;        // never inside the play corridor
    if (Math.abs(p.x) > 150 || p.z < -200 || p.z > 200) allOnTerrain = false; // within the 300x400 terrain
  }
  check('every belt tree is clear of the lane (|x| >= 100)', allOutside);
  check('every belt tree is on the rendered terrain (|x|<=150, |z|<=200)', allOnTerrain);
}

function testGrounded(THREE, build, makeSceneryRng, budget) {
  console.log('--- buildForestBelts: grounded on the terrain sampler ---');
  let reads = 0;
  const sampler = (x, z) => { reads++; return Number.isFinite(x) && Number.isFinite(z) ? 7.5 : 0; };
  const ctx = { terrain: null, getTerrainHeight: sampler, courseLine: null, difficulty: 'black', seed: 2 };
  const g = build(makeSceneryRng(2), budget, ctx);
  check('terrain height sampler is read for grounding', reads > 0);
  const foliage = g.getObjectByName('forest-belt-foliage');
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  let grounded = true;
  for (let i = 0; i < foliage.count; i++) { foliage.getMatrixAt(i, m); p.setFromMatrixPosition(m); if (Math.abs(p.y - 7.5) > 1e-3) grounded = false; }
  check('every belt tree is grounded to the sampled terrain height', grounded);
}

function testMaterials(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildForestBelts: lit-but-shadowless fog materials ---');
  const inst = instancedOf(THREE, build(makeSceneryRng(4), budget, ctx));
  check('materials are MeshStandardMaterial (lit like the scene)', inst.every((m) => m.material.isMeshStandardMaterial === true));
  check('materials are fog-enabled', inst.every((m) => m.material.fog === true));
  check('no belt mesh casts a shadow (cheap)', inst.every((m) => m.castShadow === false));
  check('no belt mesh receives a shadow', inst.every((m) => m.receiveShadow === false));
}

function testDeterminism(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildForestBelts: seeded determinism ---');
  const mats = (g) => {
    const f = g.getObjectByName('forest-belt-foliage');
    return Array.from(f.instanceMatrix.array);
  };
  const a = mats(build(makeSceneryRng(13), budget, ctx));
  const b = mats(build(makeSceneryRng(13), budget, ctx));
  const c = mats(build(makeSceneryRng(14), budget, ctx));
  check('same seed => identical instance transforms', a.length === b.length && a.every((v, i) => v === b[i]));
  check('different seed => different instance transforms', a.some((v, i) => v !== c[i]));
}

function testStreamNeutrality(build, makeSceneryRng, budget, ctx) {
  console.log('--- buildForestBelts: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    build(makeSceneryRng(88), budget, ctx);
    check('builds both InstancedMeshes without consuming global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });