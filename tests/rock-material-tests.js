// @ts-check
/**
 * Unit tests for the shared rock materials in mountains/rocks.ts. Rocks now share ONE
 * MeshStandardMaterial per type (boulder/cliff) instead of one per rock — safe because
 * the per-rock stone hue + snow cap ride in each geometry's vertex-colour attribute, not
 * the material.
 *
 * Pins:
 *   - Sharing: same-type rocks reuse one material instance; boulders and cliffs use two
 *     distinct materials (fails against the old per-rock `new` code).
 *   - RNG budget preserved: sharing removes the per-rock material UUID draw, so createRock
 *     burns it back — every rock still consumes the legacy per-rock global budget
 *     (448 boulder / 340 cliff, size-independent), keeping scenery placement byte-identical
 *     to main. Pinned absolutely AND by a downstream stream-position sentinel.
 *   - Teardown safety: resetRockCaches disposes the shared materials + normal texture and
 *     nulls the caches, so a rebuild creates FRESH materials rather than reusing freed
 *     handles (also fixes the previously un-reset rock-normal-texture leak).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rock-material-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The legacy per-rock global-draw budget (measured on main), hardcoded independently of
// the module so this suite fails if real consumption ever drifts from main's.
const LEGACY_DRAWS = { boulder: 448, cliff: 340 };
/** @param {import('three').Mesh} rock */
const matOf = (rock) => /** @type {any} */ (rock.material);

(async () => {
  const { createRock, resetRockCaches } = await import('../src/mountains/rocks.js');
  const realRandom = Math.random;

  console.log('\n🪨  SNOWGLIDER ROCK-MATERIAL TESTS (shared materials) 🪨');
  console.log('======================================================\n');

  /** Count global Math.random() draws during one createRock (deterministic private stream). */
  function countDraws(size, opts) {
    let calls = 0;
    const stream = mulberry32(999);
    Math.random = () => { calls++; return stream(); };
    try { createRock(size, opts); } finally { Math.random = realRandom; }
    return calls;
  }

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

  runTest('RNG budget preserved absolutely: 448 (boulder) / 340 (cliff), size-independent', () => {
    resetRockCaches();
    countDraws(2, { seed: 1 }); // warm the cached normal texture + build the shared materials
    for (const size of [0.5, 2, 5, 12]) {
      const n = countDraws(size, { seed: 9 });
      assert(n === LEGACY_DRAWS.boulder, `boulder size ${size}: ${n} global draws (want ${LEGACY_DRAWS.boulder})`);
    }
    for (const size of [2, 4, 8]) {
      const n = countDraws(size, { cliff: true, seed: 9 });
      assert(n === LEGACY_DRAWS.cliff, `cliff size ${size}: ${n} global draws (want ${LEGACY_DRAWS.cliff})`);
    }
  });

  runTest('downstream stream-position sentinel: createRock leaves the stream where main did', () => {
    resetRockCaches();
    countDraws(2, { seed: 1 }); // warm texture + materials (matches the reference below)
    Math.random = mulberry32(555);
    createRock(2, { seed: 3 });
    createRock(4, { cliff: true, seed: 4 });
    const next = Math.random();
    Math.random = realRandom;
    const ref = mulberry32(555);
    for (let i = 0; i < LEGACY_DRAWS.boulder + LEGACY_DRAWS.cliff; i++) ref();
    assert(next === ref(), 'global stream position drifted after createRock — downstream placement would shift');
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
    resetRockCaches();
    assert(true);
  });

  console.log(`\n==================================`);
  console.log(`Rock-material tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Rock-material test harness crashed:', e);
  process.exit(1);
});
