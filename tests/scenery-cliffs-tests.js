// @ts-check
// scenery-cliffs-tests.js — headless coverage for the flank cliff outcrops
// (src/scenery/cliff-bands.ts, issue #320 PR 5).
//
// Pins the PR-5 invariants: one InstancedMesh of a craggy snow-capped rock, every instance
// OUTSIDE the corridor (the collision-neutral property — cliffs must never sit in the play
// area), grounded on the terrain via a read-only sampler, a snow-cap vertex gradient,
// lit-but-shadowless fog material, seeded determinism, and ZERO global Math.random.
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-cliffs-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { buildCliffBands } = await import('../src/scenery/cliff-bands.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  const flat = (_x, _z) => 5;
  const ctx = { terrain: null, getTerrainHeight: flat, courseLine: null, difficulty: 'blue', seed: 1 };

  testStructure(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testOutsideCorridor(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testGrounded(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testSnowCap(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testMaterial(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testDeterminism(THREE, buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);
  testStreamNeutrality(buildCliffBands, makeSceneryRng, DEFAULT_SCENERY_BUDGET, ctx);

  console.log(`\nSCENERY-CLIFFS TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function cliffMesh(THREE, group) {
  let m = null;
  group.traverse((o) => { if (o.isInstancedMesh) m = o; });
  return m;
}

function testStructure(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: structure ---');
  const g = build(makeSceneryRng(4), budget, ctx);
  check('returns a Group named "cliff-bands"', g.isGroup === true && g.name === 'cliff-bands');
  const cliffs = cliffMesh(THREE, g);
  check('one InstancedMesh of outcrops', !!cliffs && cliffs.isInstancedMesh === true);
  check('outcrop count in the expected range (10..28)', cliffs.count >= 10 && cliffs.count <= 28);
  const m = new THREE.Matrix4();
  let finite = true;
  for (let i = 0; i < cliffs.count; i++) { cliffs.getMatrixAt(i, m); if (m.elements.some((v) => !Number.isFinite(v))) finite = false; }
  check('all instance matrices finite', finite);
}

function testOutsideCorridor(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: every outcrop outside the corridor ---');
  const cliffs = cliffMesh(THREE, build(makeSceneryRng(4), budget, ctx));
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  let allOutside = true, allOnTerrain = true;
  for (let i = 0; i < cliffs.count; i++) {
    cliffs.getMatrixAt(i, m); p.setFromMatrixPosition(m);
    if (Math.abs(p.x) < 118) allOutside = false;                 // well clear of the play corridor
    if (Math.abs(p.x) > 150 || p.z < -200 || p.z > 200) allOnTerrain = false;
  }
  check('every outcrop is clear of the corridor (|x| >= 118)', allOutside);
  check('every outcrop is on the rendered terrain', allOnTerrain);
}

function testGrounded(THREE, build, makeSceneryRng, budget) {
  console.log('--- buildCliffBands: grounded on the terrain sampler ---');
  let reads = 0;
  const sampler = (x, z) => { reads++; return Number.isFinite(x) && Number.isFinite(z) ? 9 : 0; };
  const ctx = { terrain: null, getTerrainHeight: sampler, courseLine: null, difficulty: 'black', seed: 2 };
  build(makeSceneryRng(2), budget, ctx);
  check('terrain height sampler is read for grounding', reads > 0);
}

function testSnowCap(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: snow-capped vertex gradient ---');
  const cliffs = cliffMesh(THREE, build(makeSceneryRng(6), budget, ctx));
  const col = cliffs.geometry.getAttribute('color');
  check('outcrop geometry carries a per-vertex colour attribute', !!col && col.count === cliffs.geometry.getAttribute('position').count);
  const lum = (i) => 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i);
  let maxL = 0, minL = 1;
  for (let i = 0; i < col.count; i++) { const l = lum(i); if (l > maxL) maxL = l; if (l < minL) minL = l; }
  check('has a bright snow cap (max luminance high)', maxL > 0.85);
  check('has darker rock (a real gradient, not flat)', maxL - minL > 0.15);
}

function testMaterial(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: lit-but-shadowless fog material ---');
  const cliffs = cliffMesh(THREE, build(makeSceneryRng(4), budget, ctx));
  check('material is MeshStandardMaterial with vertex colours', cliffs.material.isMeshStandardMaterial === true && cliffs.material.vertexColors === true);
  check('material is fog-enabled', cliffs.material.fog === true);
  check('outcrops cast no shadow (cheap)', cliffs.castShadow === false);
  check('outcrops receive no shadow', cliffs.receiveShadow === false);
}

function testDeterminism(THREE, build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: seeded determinism ---');
  const data = (g) => {
    const c = cliffMesh(THREE, g);
    return { mats: Array.from(c.instanceMatrix.array), verts: Array.from(c.geometry.getAttribute('position').array) };
  };
  const a = data(build(makeSceneryRng(15), budget, ctx));
  const b = data(build(makeSceneryRng(15), budget, ctx));
  const c = data(build(makeSceneryRng(16), budget, ctx));
  check('same seed => identical transforms + crag geometry',
    a.mats.every((v, i) => v === b.mats[i]) && a.verts.every((v, i) => v === b.verts[i]));
  check('different seed => different transforms or geometry',
    a.mats.some((v, i) => v !== c.mats[i]) || a.verts.some((v, i) => v !== c.verts[i]));
}

function testStreamNeutrality(build, makeSceneryRng, budget, ctx) {
  console.log('--- buildCliffBands: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    build(makeSceneryRng(88), budget, ctx);
    check('builds the outcrop mesh + crag geometry without consuming global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });