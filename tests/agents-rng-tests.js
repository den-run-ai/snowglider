// @ts-check
// agents-rng-tests.js — headless coverage for the agent-layer RNG helpers
// (src/agents/agents-rng.ts): the seeded placement/motion generator and the
// private-Math.random guard that keeps Three.js UUID draws from perturbing a
// caller's seeded global stream (invariant #4 of the agent plan, issue #366).
//
// Run via the ts-resolve loader so the `./*.js` sibling specifiers resolve to
// their `.ts` sources:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/agents-rng-tests.js
'use strict';

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

async function main() {
  const THREE = await import('three');
  const { makeAgentRng, withPrivateThreeRandom } = await import('../src/agents/agents-rng.ts');
  const { withPrivateThreeRandom: withPrivateSceneryRandom } = await import('../src/scenery/scenery-rng.ts');

  testMakeAgentRng(makeAgentRng);
  testWithPrivateThreeRandom(THREE, withPrivateThreeRandom);
  testGuardStreamsAreDistinct(THREE, withPrivateThreeRandom, withPrivateSceneryRandom);

  console.log(`\nAGENTS-RNG TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function testMakeAgentRng(makeAgentRng) {
  console.log('--- makeAgentRng: seeded, deterministic, range-safe ---');

  const a = makeAgentRng(12345);
  const b = makeAgentRng(12345);
  const seqA = Array.from({ length: 16 }, () => a());
  const seqB = Array.from({ length: 16 }, () => b());
  check('same seed => identical sequence', seqA.every((v, i) => v === seqB[i]));

  const c = makeAgentRng(999);
  const seqC = Array.from({ length: 16 }, () => c());
  check('different seed => different sequence', seqC.some((v, i) => v !== seqA[i]));

  const all = seqA.concat(seqB, seqC);
  check('all values in [0, 1)', all.every((v) => v >= 0 && v < 1));
  check('no NaN / Infinity', all.every((v) => Number.isFinite(v)));

  // Non-integer / non-finite seeds must not wedge the generator or emit NaN.
  const frac = makeAgentRng(3.14159);
  const fracSeq = Array.from({ length: 8 }, () => frac());
  check('fractional seed still finite & in range', fracSeq.every((v) => Number.isFinite(v) && v >= 0 && v < 1));
  const nanRng = makeAgentRng(NaN);
  const nanSeq = Array.from({ length: 8 }, () => nanRng());
  check('NaN seed coerced (finite outputs)', nanSeq.every((v) => Number.isFinite(v) && v >= 0 && v < 1));
  const nanRng2 = makeAgentRng(NaN);
  check('NaN seed is reproducible', Array.from({ length: 8 }, () => nanRng2()).every((v, i) => v === nanSeq[i]));

  // Independent generators do not share state.
  const g1 = makeAgentRng(7), g2 = makeAgentRng(7);
  g1(); g1(); g1(); // advance g1 only
  check('generators are independent (no shared state)', g1() !== g2());
}

function testWithPrivateThreeRandom(THREE, withPrivateThreeRandom) {
  console.log('--- withPrivateThreeRandom: global Math.random neutrality ---');

  const savedRandom = Math.random;
  let calls = 0;
  const scripted = () => { calls++; return ((calls * 0.1234567) % 1); };
  Math.random = scripted;
  try {
    const before = calls;
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

    const n = Math.random();
    check('global stream advances after the guard (one call)', calls === before + 1 && Number.isFinite(n));

    const g1 = withPrivateThreeRandom(() => new THREE.Group());
    const g2 = withPrivateThreeRandom(() => new THREE.Group());
    check('distinct uuids across guarded constructions', g1.uuid !== g2.uuid);

    let threw = false;
    try { withPrivateThreeRandom(() => { throw new Error('boom'); }); }
    catch { threw = true; }
    check('callback throw propagates', threw);
    check('Math.random restored after a throwing callback', Math.random === scripted);
  } finally {
    Math.random = savedRandom;
  }
}

function testGuardStreamsAreDistinct(THREE, withPrivateThreeRandom, withPrivateSceneryRandom) {
  console.log('--- agent + scenery private guards do not share a stream ---');
  // The two subsystems seed their private xorshift off DISTINCT constants, so a fresh
  // guarded construction from each mints a different first uuid — proving they can never
  // collide on one stream (which would defeat the point of keeping them independent).
  const agentUuid = withPrivateThreeRandom(() => new THREE.Group()).uuid;
  const sceneryUuid = withPrivateSceneryRandom(() => new THREE.Group()).uuid;
  check('agent + scenery guards mint distinct uuids (distinct seed constants)', agentUuid !== sceneryUuid);
}

main().catch((e) => { console.error(e); process.exit(1); });
