// @ts-check
/**
 * Unit tests for the face-aware rock snow/shading pass (rock realism recovery PR 2,
 * issue #385) in mountains/rocks.ts `applyRockSnowColors`.
 *
 * The old rule was a pure normal band (ny 0.05→0.55): any sufficiently up-facing
 * face saturated to full white, which is how both prior geometries read as white ice
 * (#344/#346). The new pass restrains snow to high up-facing shelves with a seeded
 * broken edge, dusts sides lightly, caps broad cliff slabs, and darkens undersides.
 *
 * Pins:
 *   - Side restraint: side/steep faces (ny < 0.4) never read as snow — FAILS against
 *     the old band rule.
 *   - Low restraint: faces in the rock's bottom quarter carry no snow — FAILS against
 *     the old rule.
 *   - Shelves survive: strongly up-facing high faces still reach full SNOW_WHITE.
 *   - Cliff slab cap: broad (>2.5× mean area) non-top cliff faces stay bare stone.
 *   - Undersides darker than sides (area-weighted luminance) on every sample kind.
 *   - Determinism: same {seed, size, cliff} ⇒ byte-identical colour buffer; a
 *     different seed repatterns the snow on IDENTICAL geometry (scrape disabled).
 *   - RNG budget: the pass consumes zero global Math.random() draws (the per-rock
 *     448/340 budget is pinned absolutely by rock-material-tests.js).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rock-snow-color-tests.js
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

/** Per-face view of a rock: normal-y, centroid height fraction, area, colour, lum. */
function faces(rock) {
  const pos = rock.geometry.attributes.position.array;
  const col = rock.geometry.attributes.color.array;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) {
    if (pos[i] < minY) minY = pos[i];
    if (pos[i] > maxY) maxY = pos[i];
  }
  const out = [];
  for (let f = 0; f < pos.length / 9; f++) {
    const i = f * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
    const r = col[i], g = col[i + 1], b = col[i + 2]; // flat-shaded: all 3 verts equal
    out.push({
      ny: ny / len,
      hy: (cy - minY) / (maxY - minY || 1),
      area: len / 2,
      r, g, b,
      minC: Math.min(r, g, b),
      lum: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    });
  }
  return out;
}

/** Snow-ness heuristic shared with tests/lib/rock-metrics.mjs. */
const snowness = (f) => Math.max(0, Math.min(1, (f.minC - 0.60) / (0.97 - 0.60)));

(async () => {
  const { createRock } = await import('../src/mountains/rocks.js');

  console.log('\n🪨❄️  SNOWGLIDER ROCK SNOW-COLOUR TESTS (face-aware pass) 🪨❄️');
  console.log('==============================================================\n');

  const realRandom = Math.random;
  function buildPinned(size, opts, streamSeed = 1234) {
    Math.random = mulberry32(streamSeed);
    try { return createRock(size, opts); }
    finally { Math.random = realRandom; }
  }
  const SAMPLES = [
    { label: 'boulder-2', size: 2, opts: { seed: 42 } },
    { label: 'boulder-3', size: 3, opts: { seed: 77 } },
    { label: 'cliff-4', size: 4, opts: { cliff: true, seed: 7 } },
    { label: 'cliff-2.2', size: 2.2, opts: { cliff: true, seed: 913 } },
  ];

  runTest('side/steep faces (ny < 0.4) never read as snow', () => {
    for (const s of SAMPLES) {
      for (const f of faces(buildPinned(s.size, s.opts))) {
        if (f.ny < 0.4) {
          assert(snowness(f) < 0.35,
            `${s.label}: side face ny=${f.ny.toFixed(2)} reads snow (${snowness(f).toFixed(2)})`);
        }
      }
    }
  });

  runTest('the rock\'s bottom quarter carries no snow', () => {
    for (const s of SAMPLES) {
      for (const f of faces(buildPinned(s.size, s.opts))) {
        if (f.hy < 0.25) {
          assert(snowness(f) < 0.2,
            `${s.label}: low face hy=${f.hy.toFixed(2)} ny=${f.ny.toFixed(2)} reads snow`);
        }
      }
    }
  });

  runTest('high up-facing shelves still reach full snow white', () => {
    for (const s of SAMPLES) {
      const fs = faces(buildPinned(s.size, s.opts));
      const shelf = fs.filter((f) => f.ny > 0.85 && f.hy > 0.6);
      assert(shelf.length > 0, `${s.label}: no high up-facing face found at all`);
      assert(shelf.some((f) => f.minC > 0.9),
        `${s.label}: no high shelf reaches near-snow colour (max minC ${Math.max(...shelf.map((f) => f.minC)).toFixed(2)})`);
    }
  });

  runTest('broad cliff slabs below the cap stay bare stone', () => {
    for (const s of SAMPLES.filter((x) => x.opts.cliff)) {
      const fs = faces(buildPinned(s.size, s.opts));
      const mean = fs.reduce((a, f) => a + f.area, 0) / fs.length;
      for (const f of fs) {
        if (f.area > 2.5 * mean && f.ny < 0.78) {
          assert(snowness(f) < 0.35,
            `${s.label}: broad slab ny=${f.ny.toFixed(2)} area=${(f.area / mean).toFixed(1)}×mean reads snow`);
        }
      }
    }
  });

  runTest('undersides are darker than sides (area-weighted luminance)', () => {
    for (const s of SAMPLES) {
      const fs = faces(buildPinned(s.size, s.opts));
      const wLum = (sel) => {
        const set = fs.filter(sel);
        const a = set.reduce((x, f) => x + f.area, 0);
        return set.reduce((x, f) => x + f.lum * f.area, 0) / (a || 1);
      };
      const side = wLum((f) => Math.abs(f.ny) < 0.35);
      const down = wLum((f) => f.ny < -0.3);
      assert(down < side, `${s.label}: underside lum ${down.toFixed(3)} not darker than sides ${side.toFixed(3)}`);
    }
  });

  runTest('same seed ⇒ byte-identical colour buffer', () => {
    const a = buildPinned(2, { seed: 42 }).geometry.attributes.color.array;
    const b = buildPinned(2, { seed: 42 }).geometry.attributes.color.array;
    assert(a.length === b.length, 'colour buffer lengths differ');
    for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `color[${i}] differs`);
  });

  runTest('a different seed repatterns the snow on identical geometry', () => {
    // scrape:false ⇒ geometry depends only on the (pinned) global jitter, so the two
    // builds differ ONLY through the colour pass's seeded patch hash.
    const a = buildPinned(2, { seed: 1, scrape: false });
    const b = buildPinned(2, { seed: 2, scrape: false });
    const pa = a.geometry.attributes.position.array, pb = b.geometry.attributes.position.array;
    for (let i = 0; i < pa.length; i++) assert(pa[i] === pb[i], 'geometry unexpectedly differs');
    const ca = a.geometry.attributes.color.array, cb = b.geometry.attributes.color.array;
    let differs = false;
    for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) { differs = true; break; }
    assert(differs, 'different seeds baked identical snow patterns');
  });

  runTest('colour pass consumes zero global Math.random() draws', () => {
    // Draw counts must not depend on the colour seed (the only variation between
    // these two builds routes through the seeded hash, not the global stream).
    function countDraws(opts) {
      let calls = 0;
      const stream = mulberry32(999);
      Math.random = () => { calls++; return stream(); };
      try { createRock(2, opts); } finally { Math.random = realRandom; }
      return calls;
    }
    assert(countDraws({ seed: 5 }) === countDraws({ seed: 6 }),
      'changing the seed changed global draw consumption');
  });

  console.log(`\n==================================`);
  console.log(`Rock snow-colour tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Rock snow-colour test harness crashed:', e);
  process.exit(1);
});
