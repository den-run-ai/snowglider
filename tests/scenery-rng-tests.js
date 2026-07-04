// @ts-check
// scenery-rng-tests.js — headless coverage for the scenery RNG helpers
// (src/scenery/scenery-rng.ts): the seeded placement generator and the
// private-Math.random guard that keeps Three.js UUID draws from perturbing a
// caller's seeded global stream (invariant #4 of the scenery plan, issue #320).
//
// Run via the ts-resolve loader so the `./*.js` sibling specifiers resolve to
// their `.ts` sources:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/scenery-rng-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { makeSceneryRng, withPrivateThreeRandom } = await import('../src/scenery/scenery-rng.ts');

  testMakeSceneryRng(makeSceneryRng);
  testWithPrivateThreeRandom(THREE, withPrivateThreeRandom);

  console.log(`\nSCENERY-RNG TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function testMakeSceneryRng(makeSceneryRng) {
  console.log('--- makeSceneryRng: seeded, deterministic, range-safe ---');

  const a = makeSceneryRng(12345);
  const b = makeSceneryRng(12345);
  const seqA = Array.from({ length: 16 }, () => a());
  const seqB = Array.from({ length: 16 }, () => b());
  check('same seed => identical sequence', seqA.every((v, i) => v === seqB[i]));

  const c = makeSceneryRng(999);
  const seqC = Array.from({ length: 16 }, () => c());
  check('different seed => different sequence', seqC.some((v, i) => v !== seqA[i]));

  const all = seqA.concat(seqB, seqC);
  check('all values in [0, 1)', all.every((v) => v >= 0 && v < 1));
  check('no NaN / Infinity', all.every((v) => Number.isFinite(v)));

  // Non-integer / non-finite seeds must not wedge the generator or emit NaN.
  const frac = makeSceneryRng(3.14159);
  const fracSeq = Array.from({ length: 8 }, () => frac());
  check('fractional seed still finite & in range', fracSeq.every((v) => Number.isFinite(v) && v >= 0 && v < 1));
  const nanRng = makeSceneryRng(NaN);
  const nanSeq = Array.from({ length: 8 }, () => nanRng());
  check('NaN seed coerced (finite outputs)', nanSeq.every((v) => Number.isFinite(v) && v >= 0 && v < 1));
  // NaN coerces to the same 32-bit seed (0), so it is reproducible like any other seed.
  const nanRng2 = makeSceneryRng(NaN);
  check('NaN seed is reproducible', Array.from({ length: 8 }, () => nanRng2()).every((v, i) => v === nanSeq[i]));

  // Independent generators do not share state.
  const g1 = makeSceneryRng(7), g2 = makeSceneryRng(7);
  g1(); g1(); g1(); // advance g1 only
  check('generators are independent (no shared state)', g1() !== g2());
}

function testWithPrivateThreeRandom(THREE, withPrivateThreeRandom) {
  console.log('--- withPrivateThreeRandom: global Math.random neutrality ---');

  // Install a deterministic fake global Math.random that records every consumption,
  // so we can prove the guard neither advances nor perturbs the caller's stream.
  const savedRandom = Math.random;
  let calls = 0;
  const scripted = () => { calls++; return ((calls * 0.1234567) % 1); };
  Math.random = scripted;
  try {
    const before = calls;
    // The guard must swap Math.random out for its own private stream, so constructing
    // Three.js objects that draw UUIDs (Group/Mesh/Material/BufferGeometry) inside it
    // consumes ZERO of the scripted global calls.
    const group = withPrivateThreeRandom(() => {
      const g = new THREE.Group();
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(geo, mat);
      g.add(mesh);
      return g;
    });
    check('THREE construction inside guard consumes no global Math.random', calls === before);
    check('guard returns the callback value', group && group.isGroup === true);
    check('guard restored the original Math.random', Math.random === scripted);

    // The restored global stream still advances normally afterward.
    const n = Math.random();
    check('global stream advances after the guard (one call)', calls === before + 1 && Number.isFinite(n));

    // Distinct UUIDs still get minted (the private stream produces distinct draws).
    const g1 = withPrivateThreeRandom(() => new THREE.Group());
    const g2 = withPrivateThreeRandom(() => new THREE.Group());
    check('distinct uuids across guarded constructions', g1.uuid !== g2.uuid);

    // Restores even when the callback throws.
    let threw = false;
    try { withPrivateThreeRandom(() => { throw new Error('boom'); }); }
    catch { threw = true; }
    check('callback throw propagates', threw);
    check('Math.random restored after a throwing callback', Math.random === scripted);
  } finally {
    Math.random = savedRandom;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });