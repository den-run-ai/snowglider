// scenery-ambient-tests.js — headless coverage for the ambient-life layer
// (src/scenery/ambient-life.ts, issue #320 PR 7): drifting clouds, circling birds, spindrift.
//
// The first ANIMATED scenery layer, so beyond the usual invariants (bounded pooled geometry,
// stream neutrality) it pins the motion contract: update() animates cosmetically off dt, never
// mutates the player position, consumes no global Math.random per frame, and FREEZES under
// prefers-reduced-motion.
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-ambient-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { buildAmbientLife } = await import('../src/scenery/ambient-life.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  testStructure(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testMotion(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testCosmeticNeutral(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testMaterials(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testDeterminism(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testStreamNeutrality(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  await testReducedMotion(THREE, buildAmbientLife, makeSceneryRng, DEFAULT_SCENERY_BUDGET);

  console.log(`\nSCENERY-AMBIENT TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function instanced(THREE, group) {
  const out = {};
  group.traverse((o) => { if (o.isInstancedMesh) out[o.name] = o; });
  return out;
}
function firstMatrix(THREE, mesh) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  return Array.from(m.elements);
}

function testStructure(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: structure ---');
  const sys = build(makeSceneryRng(4), budget);
  check('returns { group, update }', !!sys.group && typeof sys.update === 'function');
  check('group named "ambient-life"', sys.group.name === 'ambient-life');
  const im = instanced(THREE, sys.group);
  check('three InstancedMeshes: clouds, birds, spindrift', !!im['ambient-clouds'] && !!im['ambient-birds'] && !!im['ambient-spindrift']);
  // Geometry stays tiny (one per layer) — the same perf discipline as the other layers.
  const geos = new Set();
  sys.group.traverse((o) => { if (o.isMesh) geos.add(o.geometry); });
  check('bounded geometry count (<= 3, one per layer)', geos.size <= 3);
  let finite = true;
  const m = new THREE.Matrix4();
  for (const name of Object.keys(im)) { const mesh = im[name]; for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); if (m.elements.some((v) => !Number.isFinite(v))) finite = false; } }
  check('all instance matrices finite at rest', finite);
}

function testMotion(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: update animates ---');
  const sys = build(makeSceneryRng(4), budget);
  const im = instanced(THREE, sys.group);
  const before = { c: firstMatrix(THREE, im['ambient-clouds']), b: firstMatrix(THREE, im['ambient-birds']), s: firstMatrix(THREE, im['ambient-spindrift']) };
  for (let i = 0; i < 30; i++) sys.update(1 / 60, new THREE.Vector3(0, 0, -20), 0.5);
  const after = { c: firstMatrix(THREE, im['ambient-clouds']), b: firstMatrix(THREE, im['ambient-birds']), s: firstMatrix(THREE, im['ambient-spindrift']) };
  const changed = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-6);
  check('clouds drift over time', changed(before.c, after.c));
  check('birds move over time', changed(before.b, after.b));
  check('spindrift streams over time', changed(before.s, after.s));

  // A zero delta is a no-op (no accumulation, no throw).
  const snap = firstMatrix(THREE, im['ambient-birds']);
  sys.update(0, new THREE.Vector3(), 0.5);
  check('zero-dt update is a no-op', !changed(snap, firstMatrix(THREE, im['ambient-birds'])));
}

function testCosmeticNeutral(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: cosmetic-neutral update ---');
  const sys = build(makeSceneryRng(4), budget);
  const player = new THREE.Vector3(3, 4, -25);
  let threw = false;
  try { for (let i = 0; i < 10; i++) sys.update(1 / 60, player, 0.8); } catch { threw = true; }
  check('update does not throw', !threw);
  check('update never mutates the player position', player.x === 3 && player.y === 4 && player.z === -25);
}

function testMaterials(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: render-only materials ---');
  const im = instanced(THREE, build(makeSceneryRng(4), budget).group);
  const all = Object.values(im);
  check('every layer is unlit MeshBasicMaterial', all.every((m) => m.material.isMeshBasicMaterial === true));
  check('every layer is fog-enabled', all.every((m) => m.material.fog === true));
  check('nothing casts or receives a shadow', all.every((m) => m.castShadow === false && m.receiveShadow === false));
  check('spindrift is transparent (soft wisps)', im['ambient-spindrift'].material.transparent === true);
}

function testDeterminism(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: seeded determinism ---');
  const layout = (sys) => firstMatrix(THREE, instanced(THREE, sys.group)['ambient-birds']);
  const a = layout(build(makeSceneryRng(21), budget));
  const b = layout(build(makeSceneryRng(21), budget));
  const c = layout(build(makeSceneryRng(22), budget));
  check('same seed => identical initial layout', a.every((v, i) => v === b[i]));
  check('different seed => different initial layout', a.some((v, i) => v !== c[i]));
}

function testStreamNeutrality(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    const sys = build(makeSceneryRng(88), budget);
    check('build consumes no global Math.random', calls === 0);
    const at = calls;
    for (let i = 0; i < 20; i++) sys.update(1 / 60, new THREE.Vector3(), 0.5);
    check('per-frame update consumes no global Math.random', calls === at);
  } finally {
    Math.random = savedRandom;
  }
}

// prefers-reduced-motion: inject a fake matchMedia so the layer freezes, and assert update()
// leaves every matrix untouched.
async function testReducedMotion(THREE, build, makeSceneryRng, budget) {
  console.log('--- ambient life: frozen under prefers-reduced-motion ---');
  const g = globalThis;
  const prevWindow = g.window;
  g.window = { matchMedia: (q) => ({ matches: /prefers-reduced-motion/.test(q) }) };
  try {
    const sys = build(makeSceneryRng(4), budget);
    const im = instanced(THREE, sys.group);
    const before = firstMatrix(THREE, im['ambient-clouds']);
    for (let i = 0; i < 60; i++) sys.update(1 / 60, new THREE.Vector3(), 1);
    const after = firstMatrix(THREE, im['ambient-clouds']);
    check('reduced-motion freezes the ambient layer (no matrix change)', before.every((v, i) => v === after[i]));
  } finally {
    if (prevWindow === undefined) delete g.window; else g.window = prevWindow;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
