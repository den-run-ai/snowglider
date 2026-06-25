// leak-tests.js — lifecycle / disposal leak-regression for the THREE-object systems
// that allocate-and-dispose GPU resources (plan §1C, "disposal / leak regression").
//
// The debris + avalanche suites already confirm a SINGLE shatter/trigger -> reset cycle
// returns the scene to its baseline child count, and debris-tests.js even *collects* the
// fragment geometry set — but nothing asserts that REPEATED cycles return live geometry
// to baseline, nor that dispose() actually fired on the resources a cycle created. That
// lifecycle is "observed but not guarded". This promotes it into an explicit leak guard:
// spy on THREE.BufferGeometry/Material.prototype.dispose, run many cycles, and assert no
// unbounded growth in live (created-but-never-disposed) resources.
//
// Scope note: the plan listed "debris -> avalanche -> snow-surface", but src/mountains/
// snow-surface.ts is render-only (one-shot vertex-colour / normal baking, no reset/cover
// cycle) and src/snowtracks.ts (the grooves system) exposes only reset() (zeroes instance
// matrices) with no dispose() — neither owns a disposable per-cycle lifecycle to guard.
// The two systems that genuinely allocate-and-dispose are SnowmanDebris and
// AvalancheSystem, so the leak assertions live here for those two.
//
// Headless: both systems import only `three` (bare) and self-guard on
// requestAnimationFrame, so they run under Node like debris-tests.js. Drive update(dt)
// manually (no rAF in Node). Run via:  node tests/leak-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

// Distinct geometries currently attached anywhere under the scene graph.
function liveSceneGeometries(scene) {
  const set = new Set();
  scene.traverse(o => { if (o.geometry) set.add(o.geometry); });
  return set;
}

async function main() {
  const THREE = await import('three');

  // Install dispose() spies that record which geometry/material UUIDs were disposed.
  // (Patched on the prototypes so they catch dispose() no matter who calls it; restored
  // in the finally block so the spies never leak into other suites' process — though
  // each test:* script is its own process anyway.)
  const disposedGeo = new Set();
  const disposedMat = new Set();
  const geoProto = THREE.BufferGeometry.prototype;
  const matProto = THREE.Material.prototype;
  const realGeoDispose = geoProto.dispose;
  const realMatDispose = matProto.dispose;
  geoProto.dispose = function (...args) { disposedGeo.add(this.uuid); return realGeoDispose.apply(this, args); };
  matProto.dispose = function (...args) { disposedMat.add(this.uuid); return realMatDispose.apply(this, args); };

  try {
    await testDebrisCycles(THREE, disposedGeo, disposedMat);
    await testAvalancheCycles(THREE, disposedGeo, disposedMat);
  } finally {
    geoProto.dispose = realGeoDispose;
    matProto.dispose = realMatDispose;
  }

  console.log(`\nLEAK TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- Debris: every shatter -> settle -> reset cycle disposes exactly what it created,
// returns the scene to the snowman-only baseline, and never disposes the snowman's own
// geometry. Run many cycles to catch per-cycle accumulation. ----
async function testDebrisCycles(THREE, disposedGeo, disposedMat) {
  console.log('--- debris: repeated shatter -> settle -> reset leaves no live debris assets ---');
  const { SnowmanDebris } = await import('../src/debris.ts');
  const { createSnowman } = await import('../src/snowman/model.ts');

  const scene = new THREE.Scene();
  const snowman = createSnowman(scene);
  const debris = new SnowmanDebris();
  debris.setTerrainFunction(() => 0);

  // Baseline = snowman-only scene. Its geometries must survive every cycle.
  const baselineChildren = scene.children.length;
  const baselineGeoms = liveSceneGeometries(scene);
  const snowmanGeomUuids = new Set([...baselineGeoms].map(g => g.uuid));

  const createdGeoUuids = new Set();
  const createdMatUuids = new Set();
  const CYCLES = 20;
  let childCountDrifted = false;
  let maxLiveExtraAfterReset = 0;

  for (let i = 0; i < CYCLES; i++) {
    debris.shatter(scene, snowman, { x: (i % 5) - 2, z: -8 - i });

    // Record every debris-owned geometry/material the burst attached this cycle. Skip
    // the snowman's own meshes (their geometry is in the baseline set) — debris must
    // never dispose those, so collecting their materials would wrongly fail the guard.
    scene.traverse(o => {
      if (!o.isMesh || o === snowman) return;
      if (!o.geometry || baselineGeoms.has(o.geometry)) return; // snowman's own mesh
      createdGeoUuids.add(o.geometry.uuid);
      const mat = o.material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(m => createdMatUuids.add(m.uuid));
    });

    // Settle the burst (manual stepping; converges well within the budget).
    let steps = 0;
    while (debris.update(1 / 60) && steps < 400) steps++;

    debris.reset();

    if (scene.children.length !== baselineChildren) childCountDrifted = true;
    const extraLive = [...liveSceneGeometries(scene)].filter(g => !baselineGeoms.has(g)).length;
    if (extraLive > maxLiveExtraAfterReset) maxLiveExtraAfterReset = extraLive;
  }

  check(`scene returns to the baseline child count after each of ${CYCLES} cycles`, !childCountDrifted);
  check('no debris geometry remains attached to the scene after reset (no leak)', maxLiveExtraAfterReset === 0);

  const undisposedGeo = [...createdGeoUuids].filter(u => !disposedGeo.has(u));
  const undisposedMat = [...createdMatUuids].filter(u => !disposedMat.has(u));
  check('every debris-owned geometry created across cycles had dispose() called',
    createdGeoUuids.size > 0 && undisposedGeo.length === 0);
  check('every debris-owned material created across cycles had dispose() called',
    createdMatUuids.size > 0 && undisposedMat.length === 0);

  const snowmanDisposed = [...snowmanGeomUuids].filter(u => disposedGeo.has(u));
  check('the snowman\'s own geometry was never disposed by the debris cycles',
    snowmanGeomUuids.size > 0 && snowmanDisposed.length === 0);
}

// ---- Avalanche: the InstancedMesh + material + powder texture are one-time assets built
// in the constructor and reused across trigger/reset cycles. Assert repeated cycles never
// grow the scene (no per-cycle leak), and that dispose() detaches the mesh and frees its
// geometry/material. ----
async function testAvalancheCycles(THREE, disposedGeo, disposedMat) {
  console.log('--- avalanche: repeated trigger -> settle -> reset is flat; dispose() frees assets ---');
  const { AvalancheSystem } = await import('../src/avalanche.ts');

  const scene = new THREE.Scene();
  const av = new AvalancheSystem(scene, 16);
  av.setTerrainFunction(() => 0);

  const baselineChildren = scene.children.length;
  const CYCLES = 20;
  let childCountDrifted = false;

  for (let i = 0; i < CYCLES; i++) {
    av.trigger({ x: 0, y: 10, z: -50 - i });
    for (let steps = 0; steps < 300; steps++) av.update(1 / 60);
    av.reset();
    if (scene.children.length !== baselineChildren) childCountDrifted = true;
  }
  check(`avalanche scene child count stays flat across ${CYCLES} trigger/reset cycles (no per-cycle leak)`,
    !childCountDrifted);

  // dispose(): one-time geometry/material/texture freed and the mesh detached.
  const meshGeoUuid = av.mesh.geometry.uuid;
  const meshMatUuid = av.mesh.material.uuid;
  const childrenBeforeDispose = scene.children.length;
  av.dispose();
  check('dispose() detaches the avalanche InstancedMesh from the scene',
    scene.children.length < childrenBeforeDispose);
  check('dispose() disposes the InstancedMesh geometry', disposedGeo.has(meshGeoUuid));
  check('dispose() disposes the InstancedMesh material', disposedMat.has(meshMatUuid));
}

main().catch((err) => { console.error('leak test harness crashed:', err); process.exit(1); });
