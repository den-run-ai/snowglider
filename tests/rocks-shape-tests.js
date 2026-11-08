// @ts-check
/**
 * Unit tests for the seeded scrape pass in mountains/rocks.ts `createRock` (PR 1 of
 * the visual-materials plan): gl-rock-style plane scrapes that facet the jittered
 * dodecahedron into boulders/crag faces.
 *
 * Pins the load-bearing contracts:
 *   - Determinism: same {seed, size, cliff} ⇒ byte-identical scrape (with the global
 *     Math.random jitter held fixed); a different seed changes the shape.
 *   - RNG-stream neutrality: the scrape pass consumes ZERO global Math.random() draws
 *     (tier determinism + downstream tree/rock placement depend on the global stream).
 *   - Bounded shape: no vertex escapes the grounding envelope (placement sinks rocks
 *     by ~0.3·size, so the hull must stay full-size-ish and never dip inside 0.45·size),
 *     and no NaN/Infinity in positions or normals.
 *   - Snow shelves: applyRockSnowColors still engages on the up-facing scrape planes.
 *   - Cleanup matcher: every rock carries userData.isRock (addRocks' re-run de-dup
 *     sweep keys on it — geometry-agnostic, so it survives a future geometry swap).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rocks-shape-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Local deterministic PRNG to pin the global Math.random jitter during the
// determinism tests (same algorithm family as the module's private stream, but
// this one REPLACES Math.random so the pre-existing radial jitter repeats too).
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
  const { createRock } = await import('../src/mountains/rocks.js');
  const { ROCK_GALLERY_SAMPLES } = await import('../src/visual/rock-gallery-samples.js');

  console.log('\n🪨  SNOWGLIDER ROCK-SHAPE TESTS (seeded scrape pass) 🪨');
  console.log('======================================================\n');

  const realRandom = Math.random;
  /** Build a rock with Math.random pinned to a fixed stream, so only the module's
   *  private seeded scrape stream can differ between two builds. */
  function buildPinned(size, opts) {
    Math.random = mulberry32(1234);
    try { return createRock(size, opts); }
    finally { Math.random = realRandom; }
  }
  const positionsOf = (rock) => Float32Array.from(rock.geometry.attributes.position.array);

  runTest('same seed + size + cliff ⇒ byte-identical position buffers', () => {
    const a = positionsOf(buildPinned(2, { seed: 42 }));
    const b = positionsOf(buildPinned(2, { seed: 42 }));
    assert(a.length === b.length, 'vertex counts differ');
    for (let i = 0; i < a.length; i++) {
      assert(a[i] === b[i], `position[${i}] differs: ${a[i]} vs ${b[i]}`);
    }
  });

  runTest('a different seed produces a different shape', () => {
    const a = positionsOf(buildPinned(2, { seed: 42 }));
    const b = positionsOf(buildPinned(2, { seed: 43 }));
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
    assert(differs, 'seed 42 and 43 built identical rocks');
  });

  runTest('the scrape pass changes the shape vs scrape: false', () => {
    const a = positionsOf(buildPinned(2, { seed: 42 }));
    const b = positionsOf(buildPinned(2, { seed: 42, scrape: false }));
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
    assert(differs, 'scrape pass left every vertex untouched');
  });

  runTest('cliff seeds shape the cliff scrape deterministically too', () => {
    const a = positionsOf(buildPinned(4, { cliff: true, seed: 7 }));
    const b = positionsOf(buildPinned(4, { cliff: true, seed: 7 }));
    for (let i = 0; i < a.length; i++) {
      assert(a[i] === b[i], `cliff position[${i}] differs`);
    }
  });

  runTest('scrape consumes zero global Math.random() draws (stream neutrality)', () => {
    /** Count Math.random calls during a build (same underlying stream both times). */
    function countDraws(opts) {
      let calls = 0;
      const stream = mulberry32(999);
      Math.random = () => { calls++; return stream(); };
      try { createRock(2, opts); } finally { Math.random = realRandom; }
      return calls;
    }
    const withScrape = countDraws({ seed: 5 });
    const withoutScrape = countDraws({ seed: 5, scrape: false });
    assert(withScrape === withoutScrape,
      `scrape added global draws: ${withScrape} vs ${withoutScrape}`);
    // Seedless must ALSO add zero draws (the fallback is a counter, not Math.random).
    const seedless = countDraws({});
    assert(seedless === withoutScrape,
      `seedless scrape added global draws: ${seedless} vs ${withoutScrape}`);
  });

  runTest('boulder vertices stay inside the grounding envelope [0.45·size, 1.25·size]', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const size = 2;
      const p = positionsOf(buildPinned(size, { seed }));
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
        assert(r >= 0.45 * size - 1e-6, `seed ${seed}: vertex dipped to ${r} (< 0.45·size)`);
        assert(r <= 1.25 * size + 1e-6, `seed ${seed}: vertex escaped to ${r} (> 1.25·size)`);
      }
    }
  });

  runTest('cliff vertices stay inside their (taller) envelope [0.45·size, 1.8·size]', () => {
    for (const seed of [1, 2, 3]) {
      const size = 4;
      const p = positionsOf(buildPinned(size, { cliff: true, seed }));
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
        assert(r >= 0.45 * size - 1e-6, `seed ${seed}: cliff vertex dipped to ${r}`);
        assert(r <= 1.8 * size + 1e-6, `seed ${seed}: cliff vertex escaped to ${r}`);
      }
    }
  });

  runTest('no NaN/Infinity in positions or normals after scraping', () => {
    for (const opts of [{ seed: 11 }, { cliff: true, seed: 12 }, { seed: 13, scrapeCount: 12 }]) {
      const rock = buildPinned(3, opts);
      const p = rock.geometry.attributes.position.array;
      const n = rock.geometry.attributes.normal.array;
      for (let i = 0; i < p.length; i++) assert(Number.isFinite(p[i]), `position[${i}] not finite`);
      for (let i = 0; i < n.length; i++) assert(Number.isFinite(n[i]), `normal[${i}] not finite`);
    }
  });

  runTest('bounding sphere stays a sane rock size', () => {
    // The sphere is centred on the bounds centre (which the asymmetric scrape
    // shifts off the origin), so its radius can exceed the per-vertex origin
    // envelope a little — 1.5·size is the sanity lid, not the shape contract.
    const size = 2;
    const rock = buildPinned(size, { seed: 21 });
    rock.geometry.computeBoundingSphere();
    const r = rock.geometry.boundingSphere.radius;
    assert(r > 0.45 * size && r <= 1.5 * size, `bounding sphere radius ${r} out of envelope`);
  });

  runTest('snow shelves survive: up-facing scraped faces still take near-snow colour', () => {
    let snowy = 0;
    for (const seed of [31, 32, 33]) {
      const rock = buildPinned(2, { seed });
      const colors = rock.geometry.attributes.color.array;
      for (let i = 0; i < colors.length; i += 3) {
        // Full snow blend is (0.97, 0.98, 1.0); the stone base tones are all darker.
        if (colors[i] > 0.9 && colors[i + 1] > 0.9 && colors[i + 2] > 0.9) snowy++;
      }
    }
    assert(snowy > 0, 'no vertex reached near-snow colour — the snow band no longer engages');
  });

  runTest('warp changes the silhouette vs warp: false', () => {
    const a = positionsOf(buildPinned(2, { seed: 42 }));
    const b = positionsOf(buildPinned(2, { seed: 42, warp: false }));
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
    assert(differs, 'the mass warp left every vertex untouched');
  });

  runTest('warp preserves mean radius (mass conservation, ≤1.5% drift)', () => {
    // The warp renormalises to the exact pre-warp mean; the later scrape pass may
    // shave a whisker more, so compare full builds warp-on vs warp-off.
    for (const opts of [{ seed: 42 }, { cliff: true, seed: 7 }]) {
      const meanR = (p) => {
        let s = 0;
        for (let i = 0; i < p.length; i += 3) s += Math.hypot(p[i], p[i + 1], p[i + 2]);
        return s / (p.length / 3);
      };
      const on = meanR(positionsOf(buildPinned(3, opts)));
      const off = meanR(positionsOf(buildPinned(3, { ...opts, warp: false })));
      assert(Math.abs(on - off) / off < 0.015,
        `mean radius drifted ${(100 * (on - off) / off).toFixed(2)}% (${on.toFixed(3)} vs ${off.toFixed(3)})`);
    }
  });

  runTest('warp holds the horizontal-growth guard on the FINAL shape (scrape included)', () => {
    // Collision stays the frozen size-based radius until #348 (PR 5), so the warp
    // must not push visible mass horizontally past +5% of the pre-warp (jittered)
    // footprint — and the guard must hold AFTER the scrape pass too, because a
    // scrape pull can grow hypot(x,z) while shrinking 3D radius (Codex on #389).
    const maxH = (p) => {
      let m = 0;
      for (let i = 0; i < p.length; i += 3) m = Math.max(m, Math.hypot(p[i], p[i + 2]));
      return m;
    };
    // Fixed seeds plus EVERY real pinch-gate seed (both sides, every winding tier):
    // the gate crags sit only 3u outside the clear corridor, so they are exactly
    // where a footprint overrun becomes player-visible.
    const pinchSeeds = ROCK_GALLERY_SAMPLES.filter((s) => s.kind === 'pinch').map((s) => s.seed);
    for (const cliff of [false, true]) {
      for (const seed of [1, 2, 3, 7, 42, 77, 913, ...pinchSeeds]) {
        const opts = cliff ? { cliff, seed } : { seed };
        // Pre-warp footprint = the pinned jitter alone (warp+scrape disabled).
        const jittered = maxH(positionsOf(buildPinned(2.2, { ...opts, scrape: false, warp: false })));
        const finalShape = maxH(positionsOf(buildPinned(2.2, opts)));
        assert(finalShape <= jittered * 1.05 + 1e-6,
          `cliff=${cliff} seed=${seed}: final footprint ${finalShape.toFixed(3)} grew ` +
          `${(100 * (finalShape / jittered - 1)).toFixed(2)}% over the jittered ${jittered.toFixed(3)} (> 5%)`);
      }
    }
  });

  runTest('pinch-gate crags never reach into the clear corridor (≤3u horizontal reach)', () => {
    // addRocks places gate crags at PINCH_EDGE=8 off the lane with a 5u clear
    // corridor: any vertex reaching past 3u horizontally would visibly intrude
    // into the advertised safe path regardless of the rock's random yaw.
    const PINCH_SIZE = 2.2, MARGIN = 8 - 5;
    for (const s of ROCK_GALLERY_SAMPLES.filter((x) => x.kind === 'pinch')) {
      const p = positionsOf(buildPinned(PINCH_SIZE,
        { cliff: true, seed: s.seed, maxHorizontalReach: MARGIN }));
      for (let i = 0; i < p.length; i += 3) {
        const h = Math.hypot(p[i], p[i + 2]);
        assert(h <= MARGIN + 1e-6,
          `${s.id}: vertex reaches ${h.toFixed(3)}u horizontally (> ${MARGIN}u gate margin)`);
      }
    }
  });

  runTest('warp consumes zero global Math.random() draws (stream neutrality)', () => {
    function countDraws(opts) {
      let calls = 0;
      const stream = mulberry32(999);
      Math.random = () => { calls++; return stream(); };
      try { createRock(2, opts); } finally { Math.random = realRandom; }
      return calls;
    }
    assert(countDraws({ seed: 5 }) === countDraws({ seed: 5, warp: false }),
      'the warp pass drew from the global stream');
  });

  runTest('cleanup matcher intact: every rock is tagged userData.isRock', () => {
    // addRocks' re-run de-dup sweep keys on this flag (geometry-agnostic), so it must
    // ride on every rock regardless of type. Pins both boulders and cliffs.
    assert(buildPinned(2, { seed: 41 }).userData.isRock === true,
      `boulder missing userData.isRock (got ${buildPinned(2, { seed: 41 }).userData.isRock})`);
    assert(buildPinned(4, { cliff: true, seed: 42 }).userData.isRock === true,
      'cliff missing userData.isRock');
  });

  console.log(`\n==================================`);
  console.log(`Rock-shape tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Rock-shape test harness crashed:', e);
  process.exit(1);
});
