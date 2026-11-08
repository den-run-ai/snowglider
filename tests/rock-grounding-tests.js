// @ts-check
/**
 * Unit tests for the rock grounding layer (rock realism recovery PR 4, issue #385):
 * slope-aware sink depths, terrain-draped snow collars, and pebble chips.
 *
 * Pins the render-only contract:
 *   - Placement neutrality: the returned hazard list, the outAllRendered list, AND
 *     the global Math.random stream position are byte-identical with grounding on
 *     vs off (the decorations may never move a rock or shift downstream trees).
 *   - The #317 anti-pattern is impossible: every collar vertex sits within
 *     [-sink, +profile] of the terrain surface directly beneath it (a rigid tilted
 *     disc on a slope would violate this by ±R·slope).
 *   - Collars bias uphill (drifts pile against the uphill face).
 *   - Grounding meshes are tagged, non-hazard, and swept + disposed on re-run.
 *   - rockSinkDepth: flat boulders keep the classic 0.3·size; steep slopes sink
 *     deeper (capped at +0.08·size); cliffs stay at 0.28·size; NaN-safe.
 *   - resetRockCaches disposes the shared collar material.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rock-grounding-tests.js
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

(async () => {
  const THREE = await import('three');
  const { addRocks, rockSinkDepth, collarCenterFor, resetRockCaches, createRock } =
    await import('../src/mountains/rocks.js');
  const { getTerrainHeight, getTerrainGradient, heightMap, resetHeightMap } =
    await import('../src/mountains/terrain.js');

  console.log('\n🪨🕳️  SNOWGLIDER ROCK GROUNDING TESTS (sinks, collars, chips) 🪨🕳️');
  console.log('==================================================================\n');

  const realRandom = Math.random;
  /** Run addRocks with the global stream pinned; returns everything observable. */
  function runPinned(grounding) {
    const scene = new THREE.Scene();
    /** @type {any[]} */
    const rendered = [];
    Math.random = mulberry32(20260709);
    let hazards, sentinel;
    try {
      hazards = addRocks(scene, rendered, { grounding });
      sentinel = Math.random(); // stream-position probe
    } finally {
      Math.random = realRandom;
    }
    return { scene, hazards, rendered, sentinel };
  }

  runTest('rockSinkDepth: classic on flat, deeper on steep (capped), cliffs fixed, NaN-safe', () => {
    assert(rockSinkDepth(2, 0, false) === 0.6, `flat boulder: ${rockSinkDepth(2, 0, false)}`);
    assert(rockSinkDepth(2, 0.3, false) > 0.6, 'steep boulder did not sink deeper');
    assert(Math.abs(rockSinkDepth(2, 9, false) - 2 * 0.38) < 1e-12, 'extra sink not capped at 0.08·size');
    assert(rockSinkDepth(2, 0.5, true) === 0.56, 'cliff sink moved (must stay 0.28·size until #348/PR 5)');
    assert(rockSinkDepth(2, NaN, false) === 0.6, 'NaN steepness poisoned the sink');
  });

  runTest('placement neutrality: hazards, rendered list, and RNG stream identical on/off', () => {
    const on = runPinned(true);
    const off = runPinned(false);
    assert(on.sentinel === off.sentinel,
      'global Math.random stream position diverged — downstream tree placement would shift');
    assert(JSON.stringify(on.hazards) === JSON.stringify(off.hazards),
      'collision hazard list changed with grounding on');
    assert(JSON.stringify(on.rendered) === JSON.stringify(off.rendered),
      'outAllRendered (contact-shadow input) changed with grounding on');
  });

  runTest('grounding leaves the shared heightMap cache byte-identical (no sample poisoning)', () => {
    // getTerrainHeight memoizes every query into 0.1-unit cells that later tree
    // placement and live physics read. The render-only grounding layer samples
    // hundreds of ad-hoc collar/chip coordinates, so it must go through the
    // UNCACHED evaluators — otherwise a decorative collar changes the terrain
    // heights downstream consumers see vs `grounding: false` (Codex on #390).
    resetHeightMap();
    runPinned(false);
    const off = { ...heightMap };
    resetHeightMap();
    runPinned(true);
    const onKeys = Object.keys(heightMap).sort();
    const offKeys = Object.keys(off).sort();
    assert(onKeys.length === offKeys.length &&
      JSON.stringify(onKeys) === JSON.stringify(offKeys),
      `grounding changed the heightMap key set (${onKeys.length} vs ${offKeys.length} cells)`);
    for (const k of onKeys) {
      assert(heightMap[k] === off[k], `heightMap[${k}] diverged with grounding on`);
    }
    resetHeightMap();
  });

  runTest('grounding meshes exist, are tagged, and are absent with grounding off', () => {
    const on = runPinned(true);
    const collars = on.scene.children.filter((c) => c.userData.isRockSnowCollar === true);
    assert(collars.length === 1, `expected 1 merged collar mesh, got ${collars.length}`);
    assert(collars[0].userData.isRockGrounding === true, 'collar missing the grounding sweep tag');
    // ~150 rendered rocks make a size-≥3.2 cliff block near-certain under any
    // stream, but stay tolerant: if chips exist they must be tagged correctly.
    const chips = on.scene.children.filter((c) => c.userData.isRockChips === true);
    for (const chip of chips) {
      assert(chip.userData.isRockGrounding === true, 'chip mesh missing the grounding sweep tag');
    }
    const off = runPinned(false);
    assert(off.scene.children.every((c) => c.userData.isRockGrounding !== true),
      'grounding meshes present despite grounding: false');
  });

  runTest('collars conform to the terrain (the #317 floating-disc anti-pattern is impossible)', () => {
    const { scene } = runPinned(true);
    const collar = scene.children.find((c) => c.userData.isRockSnowCollar === true);
    assert(collar, 'no collar mesh');
    const posAttr = /** @type {any} */ (collar).geometry.attributes.position;
    const MAX_SIZE = 5; // largest possible rock -> profile ≤ 0.23·size, sink ≤ 0.05·size
    let checked = 0;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      const dy = y - getTerrainHeight(x, z);
      assert(dy >= -0.05 * MAX_SIZE - 1e-6 && dy <= 0.23 * MAX_SIZE + 1e-6,
        `collar vertex ${i} floats/tunnels: ${dy.toFixed(3)}u off the terrain surface`);
      checked++;
    }
    assert(checked > 0, 'no collar vertices checked');
  });

  runTest('collar centres bias uphill (along +gradient)', () => {
    let biased = 0, tested = 0;
    for (const [x, z] of [[40, -60], [-55, -95], [70, -130], [-30, -40]]) {
      const g = getTerrainGradient(x, z);
      const len = Math.hypot(g.x, g.z);
      if (!(len > 1e-4)) continue;
      const c = collarCenterFor(x, z, 2);
      const dot = (c.x - x) * g.x + (c.z - z) * g.z;
      tested++;
      if (dot > 0) biased++;
    }
    assert(tested > 0 && biased === tested, `uphill bias failed (${biased}/${tested})`);
  });

  runTest('chips never enter the hazard or rendered lists', () => {
    const { scene, hazards, rendered } = runPinned(true);
    const chips = scene.children.find((c) => c.userData.isRockChips === true);
    if (!chips) { assert(true); return; } // no large cliffs under this stream — fine
    // Chip vertices are tiny scattered pebbles; the lists carry only rock centres.
    assert(hazards.length > 0 && rendered.length >= hazards.length, 'sanity');
    assert(rendered.length === runPinned(false).rendered.length, 'chips leaked into the rendered list');
  });

  runTest('re-running addRocks sweeps and disposes the previous grounding meshes', () => {
    const scene = new THREE.Scene();
    Math.random = mulberry32(1);
    try {
      addRocks(scene, undefined, { grounding: true });
      const first = scene.children.filter((c) => c.userData.isRockGrounding === true);
      let disposed = 0;
      for (const meshObj of first) {
        const g = /** @type {any} */ (meshObj).geometry;
        const orig = g.dispose.bind(g);
        g.dispose = () => { disposed++; orig(); };
      }
      addRocks(scene, undefined, { grounding: true });
      const second = scene.children.filter((c) => c.userData.isRockGrounding === true);
      assert(disposed === first.length, `swept grounding geometries not disposed (${disposed}/${first.length})`);
      for (const meshObj of second) {
        assert(!first.includes(meshObj), 'stale grounding mesh survived the re-run sweep');
      }
    } finally {
      Math.random = realRandom;
    }
  });

  runTest('resetRockCaches disposes the shared collar material and rebuilds fresh', () => {
    resetRockCaches();
    const { scene } = runPinned(true);
    const collar = /** @type {any} */ (scene.children.find((c) => c.userData.isRockSnowCollar === true));
    const before = collar.material;
    let disposed = false;
    const orig = before.dispose.bind(before);
    before.dispose = () => { disposed = true; orig(); };
    resetRockCaches();
    assert(disposed, 'resetRockCaches did not dispose the collar material');
    const again = /** @type {any} */ (runPinned(true).scene.children.find((c) => c.userData.isRockSnowCollar === true));
    assert(again.material !== before, 'collar material reused after resetRockCaches');
  });

  runTest('grounding adds zero global Math.random() draws inside createRock too', () => {
    // The per-rock 448/340 budget is pinned absolutely by rock-material-tests; this
    // is the cheap local re-assertion that grounding did not touch createRock.
    function countDraws(opts) {
      let calls = 0;
      const stream = mulberry32(999);
      Math.random = () => { calls++; return stream(); };
      try { createRock(2, opts); } finally { Math.random = realRandom; }
      return calls;
    }
    assert(countDraws({ seed: 5 }) === 448, `boulder draws ${countDraws({ seed: 5 })} (want 448)`);
  });

  console.log(`\n==================================`);
  console.log(`Rock grounding tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Rock grounding test harness crashed:', e);
  process.exit(1);
});
