// @ts-check
/**
 * Unit tests for the shared rock materials in mountains/rocks.ts (PR C of the rock
 * rework). Rocks now share ONE MeshStandardMaterial per type (boulder/cliff) instead
 * of one per rock — safe because the per-rock stone hue + snow cap ride in each
 * geometry's vertex-colour attribute, not the material.
 *
 * Pins:
 *   - Sharing: same-type rocks reuse one material instance; boulders and cliffs use
 *     two distinct materials (fails against the old per-rock `new` code).
 *   - Teardown safety: resetRockCaches disposes the shared materials + normal texture
 *     and nulls the module caches, so a rebuild creates FRESH materials rather than
 *     reusing freed-but-still-referenced GPU handles (the leak resetTreePools guards).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rock-material-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
/** @param {import('three').Mesh} rock */
const matOf = (rock) => /** @type {any} */ (rock.material);

(async () => {
  const { createRock, resetRockCaches } = await import('../src/mountains/rocks.js');

  console.log('\n🪨  SNOWGLIDER ROCK-MATERIAL TESTS (shared materials) 🪨');
  console.log('======================================================\n');

  runTest('all boulders share one material instance; all cliffs share another', () => {
    resetRockCaches();
    const b1 = matOf(createRock(2, { seed: 1 }));
    const b2 = matOf(createRock(3, { seed: 2 }));
    const c1 = matOf(createRock(4, { cliff: true, seed: 3 }));
    const c2 = matOf(createRock(5, { cliff: true, seed: 4 }));
    assert(b1 === b2, 'two boulders did NOT share a material instance');
    assert(c1 === c2, 'two cliffs did NOT share a material instance');
    assert(b1 !== c1, 'boulder and cliff share a material (they must differ by roughness/normalScale)');
  });

  runTest('boulder vs cliff materials differ in roughness', () => {
    resetRockCaches();
    const b = matOf(createRock(2, { seed: 1 }));
    const c = matOf(createRock(4, { cliff: true, seed: 1 }));
    assert(b.roughness !== c.roughness, `boulder/cliff roughness identical (${b.roughness})`);
  });

  runTest('resetRockCaches disposes the shared materials and rebuilds fresh ones', () => {
    resetRockCaches();
    const before = matOf(createRock(2, { seed: 1 }));
    let disposed = false;
    const realDispose = before.dispose.bind(before);
    before.dispose = (/** @type {any[]} */ ...a) => { disposed = true; return realDispose(...a); };

    resetRockCaches();
    assert(disposed, 'resetRockCaches did not dispose the cached boulder material');

    const after = matOf(createRock(2, { seed: 1 }));
    assert(after !== before, 'createRock reused a material after resetRockCaches (stale/disposed handle)');
  });

  runTest('resetRockCaches is safe to call with nothing cached (idempotent)', () => {
    resetRockCaches();
    resetRockCaches(); // second call: caches already null — must not throw
    assert(true);
  });

  console.log(`\n==================================`);
  console.log(`Rock-material tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Rock-material test harness crashed:', e);
  process.exit(1);
});
