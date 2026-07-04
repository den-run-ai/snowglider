// scenery-ridges-tests.js — headless coverage for the distant alpine panorama
// (src/scenery/distant-ridges.ts, issue #320 PR 2): the layered ridge silhouettes.
//
// Pins the PR-2 invariants: deterministic per-seed geometry, finite vertices, unlit
// fog-friendly non-shadow-casting materials, seamless (closed) rings, and — the
// load-bearing one — ZERO global Math.random consumption (all THREE construction goes
// through withPrivateThreeRandom).
//
// Run via the ts-resolve loader:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-ridges-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { buildDistantRidges } = await import('../src/scenery/distant-ridges.ts');
  const { makeSceneryRng } = await import('../src/scenery/scenery-rng.ts');
  const { DEFAULT_SCENERY_BUDGET } = await import('../src/scenery/scenery-budget.ts');

  testStructure(THREE, buildDistantRidges, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testDeterminism(buildDistantRidges, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testMaterials(THREE, buildDistantRidges, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testSnowCaps(THREE, buildDistantRidges, makeSceneryRng, DEFAULT_SCENERY_BUDGET);
  testStreamNeutrality(buildDistantRidges, makeSceneryRng, DEFAULT_SCENERY_BUDGET);

  console.log(`\nSCENERY-RIDGES TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function ridgeMeshes(group) {
  return group.children.filter((c) => c.isMesh);
}

function positionsOf(group) {
  return ridgeMeshes(group).map((m) => Array.from(m.geometry.getAttribute('position').array));
}

function testStructure(THREE, buildDistantRidges, makeSceneryRng, budget) {
  console.log('--- buildDistantRidges: structure & finiteness ---');
  const group = buildDistantRidges(makeSceneryRng(42), budget);
  check('returns a Group named "distant-ridges"', group.isGroup === true && group.name === 'distant-ridges');
  const meshes = ridgeMeshes(group);
  check('builds 3–5 ridge layers', meshes.length >= 3 && meshes.length <= 5);
  check('every layer is a Mesh with indexed BufferGeometry', meshes.every((m) => m.isMesh && m.geometry.index));

  const allPos = positionsOf(group).flat();
  check('all vertex coordinates finite (no NaN/Infinity)', allPos.every((v) => Number.isFinite(v)));

  // Rings must close seamlessly: the first and last angular columns share the same x/z. The
  // geometry is column-major with `rowsPerCol` vertices per column (userData hints), so the
  // last column's first vertex is at index (cols-1)*rowsPerCol.
  const first = meshes[0].geometry.getAttribute('position');
  const cols = meshes[0].userData.cols;
  const rowsPerCol = meshes[0].userData.rowsPerCol;
  const lastColStart = (cols - 1) * rowsPerCol;
  const closed =
    Math.abs(first.getX(0) - first.getX(lastColStart)) < 1e-3 &&
    Math.abs(first.getZ(0) - first.getZ(lastColStart)) < 1e-3;
  check('ring closes seamlessly (first column == last column)', closed);
  check('geometry has vertical subdivisions (rows per column > 2)', rowsPerCol > 2);

  // Farther layers sit at larger radius (receding stack).
  const radiusOf = (m) => {
    const p = m.geometry.getAttribute('position');
    return Math.hypot(p.getX(0), p.getZ(0));
  };
  const radii = meshes.map(radiusOf);
  check('radii strictly increase outward', radii.every((r, i) => i === 0 || r > radii[i - 1]));
  check('nearest ring is a distant backdrop (radius > 400)', radii[0] > 400);
}

function testDeterminism(buildDistantRidges, makeSceneryRng, budget) {
  console.log('--- buildDistantRidges: seeded determinism ---');
  const a = positionsOf(buildDistantRidges(makeSceneryRng(7), budget));
  const b = positionsOf(buildDistantRidges(makeSceneryRng(7), budget));
  const c = positionsOf(buildDistantRidges(makeSceneryRng(8), budget));

  const sameAB = a.length === b.length && a.every((layer, i) => layer.length === b[i].length && layer.every((v, j) => v === b[i][j]));
  check('same seed => identical ridge vertices', sameAB);

  const diffAC = a.some((layer, i) => layer.some((v, j) => v !== c[i][j]));
  check('different seed => different ridge vertices', diffAC);
}

function testMaterials(THREE, buildDistantRidges, makeSceneryRng, budget) {
  console.log('--- buildDistantRidges: render-only materials ---');
  const meshes = ridgeMeshes(buildDistantRidges(makeSceneryRng(3), budget));
  check('materials are unlit MeshBasicMaterial', meshes.every((m) => m.material.isMeshBasicMaterial === true));
  check('materials are fog-enabled (haze into the horizon)', meshes.every((m) => m.material.fog === true));
  check('no layer casts a shadow', meshes.every((m) => m.castShadow === false));
  check('no layer receives a shadow', meshes.every((m) => m.receiveShadow === false));
  check('double-sided (visible from inside the ring)', meshes.every((m) => m.material.side === THREE.DoubleSide));
  check('driven by vertex colours (snow caps + rock)', meshes.every((m) => m.material.vertexColors === true));
}

// Detail pass (PR 3b): the ridges carry a per-vertex snow-cap gradient so they read as snowy
// peaks (not flat grey humps) in every lighting phase. Assert each ridge has a colour attribute
// with a real gradient: bright snow near the top of the tallest columns, darker rock elsewhere.
function testSnowCaps(THREE, buildDistantRidges, makeSceneryRng, budget) {
  console.log('--- buildDistantRidges: snow-capped vertex gradient ---');
  const meshes = ridgeMeshes(buildDistantRidges(makeSceneryRng(21), budget));
  const m0 = meshes[0];
  const col = m0.geometry.getAttribute('color');
  check('ridges carry a per-vertex colour attribute', !!col && col.count === m0.geometry.getAttribute('position').count);

  const lum = (i) => 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i);
  let maxLum = 0, minLum = 1;
  for (let i = 0; i < col.count; i++) { const l = lum(i); if (l > maxLum) maxLum = l; if (l < minLum) minLum = l; }
  check('has bright snow-cap vertices (max luminance high)', maxLum > 0.85);
  check('has darker rock vertices (a real gradient, not flat)', maxLum - minLum > 0.15);

  // The snow must sit near the TOPS: for the tallest column, the top-row vertex is brighter
  // than its base-row vertex.
  const cols = m0.userData.cols, rowsPerCol = m0.userData.rowsPerCol;
  const pos = m0.geometry.getAttribute('position');
  let tallCol = 0, tallH = -Infinity;
  for (let j = 0; j < cols; j++) {
    const top = pos.getY(j * rowsPerCol + (rowsPerCol - 1));
    if (top > tallH) { tallH = top; tallCol = j; }
  }
  const topLum = lum(tallCol * rowsPerCol + (rowsPerCol - 1));
  const baseLum = lum(tallCol * rowsPerCol);
  check('tallest peak is snow-capped (top brighter than base)', topLum > baseLum + 0.1);
}

function testStreamNeutrality(buildDistantRidges, makeSceneryRng, budget) {
  console.log('--- buildDistantRidges: global Math.random neutrality ---');
  const savedRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return savedRandom(); };
  try {
    // The seeded placement RNG is passed IN; all THREE construction (BufferGeometry,
    // Material, Mesh, Group — each a UUID draw) must go through the private guard, so
    // the global stream is untouched.
    buildDistantRidges(makeSceneryRng(99), budget);
    check('builds every layer without consuming global Math.random', calls === 0);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
