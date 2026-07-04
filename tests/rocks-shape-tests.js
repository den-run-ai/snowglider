// @ts-check
/**
 * Unit tests for the seeded convex-hull generator in mountains/rocks.ts `createRock`.
 * Replaces the seeded-scrape suite (PR #304) after the geometry rework: rocks are now
 * the convex hull of a private-seeded point cloud, which reads as real boulders/crags
 * (large planar facets, crisp edges) instead of a dented dodecahedron sphere.
 *
 * Pins the load-bearing contracts:
 *   - Determinism: same {seed, size, cliff} ⇒ byte-identical hull; a different seed
 *     changes the shape. Shape rides entirely on the private stream, so it is
 *     independent of the global Math.random sequence.
 *   - Facet budget ("reads as rock"): few large facets, not ~144 tiny ones — a low
 *     triangle count AND a high area-weighted planar-facet fraction. This is the
 *     assertion the old scrape suite lacked; the scrape-a-sphere geometry fails it.
 *   - RNG budget preserved: createRock consumes exactly the legacy per-rock global
 *     Math.random() budget (448 boulder / 340 cliff, size-independent) so downstream
 *     cliff/rock rotation and ALL tree placement stay byte-identical to main — pinned
 *     absolutely AND end-to-end by a downstream stream-position sentinel.
 *   - Bounded shape / grounding: every vertex radius within the (re-derived) hull
 *     envelope, bounding sphere sane, no NaN/Infinity in positions or normals.
 *   - Snow shelves: applyRockSnowColors still tints up-facing hull facets toward snow.
 *   - Cleanup matcher: every rock carries userData.isRock (addRocks' re-run de-dup
 *     sweep keys on it — geometry-agnostic, so it survives the geometry swap).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/rocks-shape-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Deterministic PRNG matching the module's private stream family. Used both to pin the
// global stream during builds and to build reference streams for the RNG-budget sentinel.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The legacy per-rock global-draw budget createRock preserves (measured on main's
// dodecahedron path, size-independent). Hardcoded here — independent of the module's
// own constant — so this suite fails if the real consumption ever drifts from main's.
const LEGACY_DRAWS = { boulder: 448, cliff: 340 };

(async () => {
  const { createRock } = await import('../src/mountains/rocks.js');

  console.log('\n🪨  SNOWGLIDER ROCK-SHAPE TESTS (seeded convex hull) 🪨');
  console.log('======================================================\n');

  const realRandom = Math.random;
  /** Build a rock with Math.random pinned to a fixed stream (keeps builds fast and fully
   *  reproducible; the hull shape depends only on the private seed regardless). */
  function buildPinned(size, opts) {
    Math.random = mulberry32(1234);
    try { return createRock(size, opts); }
    finally { Math.random = realRandom; }
  }
  const positionsOf = (rock) => Float32Array.from(rock.geometry.attributes.position.array);

  /** Count global Math.random() draws during one createRock (deterministic private stream). */
  function countDraws(size, opts) {
    let calls = 0;
    const stream = mulberry32(999);
    Math.random = () => { calls++; return stream(); };
    try { createRock(size, opts); } finally { Math.random = realRandom; }
    return calls;
  }

  /** Area-weighted fraction of surface area in the largest `k` coplanar facet clusters
   *  (normals within ~11° grouped). High for a hull (few big faces), tiny for a faceted
   *  sphere. Also returns the triangle count. */
  function facetProfile(geometry) {
    const p = geometry.attributes.position.array;
    const faces = [];
    let totalArea = 0;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const area = 0.5 * len;
      faces.push({ nx: nx / len, ny: ny / len, nz: nz / len, area });
      totalArea += area;
    }
    const used = new Array(faces.length).fill(false);
    const clusters = [];
    for (let i = 0; i < faces.length; i++) {
      if (used[i]) continue;
      let a = faces[i].area; used[i] = true;
      for (let j = i + 1; j < faces.length; j++) {
        if (used[j]) continue;
        if (faces[i].nx * faces[j].nx + faces[i].ny * faces[j].ny + faces[i].nz * faces[j].nz > 0.98) {
          a += faces[j].area; used[j] = true;
        }
      }
      clusters.push(a);
    }
    clusters.sort((x, y) => y - x);
    const top3 = (clusters[0] + (clusters[1] || 0) + (clusters[2] || 0)) / (totalArea || 1);
    return { triangles: faces.length, top3 };
  }

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
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { differs = true; break; }
    assert(differs || a.length !== b.length, 'seed 42 and 43 built identical rocks');
  });

  runTest('hull shape is independent of the global Math.random stream', () => {
    // Two different pinned global streams, same seed ⇒ identical hull (shape is private-seeded).
    Math.random = mulberry32(1);
    const a = positionsOf(createRock(2, { seed: 77 }));
    Math.random = mulberry32(999999);
    const b = positionsOf(createRock(2, { seed: 77 }));
    Math.random = realRandom;
    assert(a.length === b.length, 'vertex counts differ across global streams');
    for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `position[${i}] moved with the global stream`);
  });

  runTest('cliff seeds shape the cliff hull deterministically too', () => {
    const a = positionsOf(buildPinned(4, { cliff: true, seed: 7 }));
    const b = positionsOf(buildPinned(4, { cliff: true, seed: 7 }));
    assert(a.length === b.length, 'cliff vertex counts differ');
    for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `cliff position[${i}] differs`);
  });

  runTest('facet budget: few large planar facets, not a faceted sphere (reads as rock)', () => {
    // Hull rocks: low triangle count AND most surface area concentrated in a handful of
    // coplanar facets. The old scrape-a-dodecahedron sphere (~144 tiny facets, top-3 ≈ 2%)
    // fails BOTH bounds — this is the assertion that pins "reads as rock".
    for (const [size, cliff] of [[2, false], [4, true]]) {
      for (let seed = 1; seed <= 24; seed++) {
        const { triangles, top3 } = facetProfile(buildPinned(size, { cliff, seed }).geometry);
        assert(triangles >= 8 && triangles <= 45,
          `${cliff ? 'cliff' : 'boulder'} seed ${seed}: ${triangles} triangles out of [8,45]`);
        assert(top3 >= 0.18,
          `${cliff ? 'cliff' : 'boulder'} seed ${seed}: top-3 planar fraction ${top3.toFixed(3)} < 0.18`);
      }
    }
  });

  runTest('RNG budget preserved absolutely: 448 (boulder) / 340 (cliff), size-independent', () => {
    countDraws(2, { seed: 1 }); // warm the cached rock normal texture (a one-time uuid draw)
    for (const size of [0.5, 2, 5, 12]) {
      const n = countDraws(size, { seed: 9 });
      assert(n === LEGACY_DRAWS.boulder, `boulder size ${size}: ${n} global draws (want ${LEGACY_DRAWS.boulder})`);
    }
    for (const size of [2, 4, 8]) {
      const n = countDraws(size, { cliff: true, seed: 9 });
      assert(n === LEGACY_DRAWS.cliff, `cliff size ${size}: ${n} global draws (want ${LEGACY_DRAWS.cliff})`);
    }
    // Seedless must consume the same budget too (fallback seed is a private counter).
    countDraws(2, { seed: 1 });
    const seedless = countDraws(2, {});
    assert(seedless === LEGACY_DRAWS.boulder, `seedless boulder: ${seedless} draws (want ${LEGACY_DRAWS.boulder})`);
  });

  runTest('downstream stream-position sentinel: createRock leaves the global stream exactly where main did', () => {
    // Build a boulder then a cliff on a shared stream, then read the next draw; it must equal
    // a reference stream advanced by exactly boulder+cliff budget. Independent of the module's
    // own constants — catches any drift the burn misses (a leaked/short draw shifts trees).
    countDraws(2, { seed: 1 }); // warm normal-texture cache first (matches reference below)
    Math.random = mulberry32(555);
    createRock(2, { seed: 3 });
    createRock(4, { cliff: true, seed: 4 });
    const next = Math.random();
    Math.random = realRandom;
    const ref = mulberry32(555);
    for (let i = 0; i < LEGACY_DRAWS.boulder + LEGACY_DRAWS.cliff; i++) ref();
    assert(next === ref(), 'global stream position drifted after createRock — downstream placement would shift');
  });

  runTest('boulder vertices stay inside the grounding envelope [0.38·size, 1.45·size]', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const size = 2;
      const p = positionsOf(buildPinned(size, { seed }));
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
        assert(r >= 0.38 * size - 1e-6, `seed ${seed}: vertex dipped to ${(r / size).toFixed(3)}·size (< 0.38)`);
        assert(r <= 1.45 * size + 1e-6, `seed ${seed}: vertex escaped to ${(r / size).toFixed(3)}·size (> 1.45)`);
      }
    }
  });

  runTest('cliff vertices stay inside their envelope [0.18·size, 1.9·size]', () => {
    // Upper bound pins the collision-neutral height cap (peak ~1.5·size, within the old
    // dodecahedron cliff's ~1.59·size): a re-inflated crag would widen the visual/collision
    // gap the runtime rock-clearance check assumes (Codex PR #344 P2), so it must fail here.
    for (const seed of [1, 2, 3]) {
      const size = 4;
      const p = positionsOf(buildPinned(size, { cliff: true, seed }));
      for (let i = 0; i < p.length; i += 3) {
        const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
        assert(r >= 0.18 * size - 1e-6, `seed ${seed}: cliff vertex dipped to ${(r / size).toFixed(3)}·size`);
        assert(r <= 1.9 * size + 1e-6, `seed ${seed}: cliff vertex escaped to ${(r / size).toFixed(3)}·size (> 1.9 — widens the collision gap)`);
      }
    }
  });

  runTest('no NaN/Infinity in positions or normals', () => {
    for (const opts of [{ seed: 11 }, { cliff: true, seed: 12 }, { seed: 13 }]) {
      const rock = buildPinned(3, opts);
      const p = rock.geometry.attributes.position.array;
      const n = rock.geometry.attributes.normal.array;
      for (let i = 0; i < p.length; i++) assert(Number.isFinite(p[i]), `position[${i}] not finite`);
      for (let i = 0; i < n.length; i++) assert(Number.isFinite(n[i]), `normal[${i}] not finite`);
    }
  });

  runTest('bounding sphere stays a sane rock size', () => {
    const size = 2;
    const rock = buildPinned(size, { seed: 21 });
    rock.geometry.computeBoundingSphere();
    const r = rock.geometry.boundingSphere.radius;
    assert(r > 0.38 * size && r <= 1.6 * size, `bounding sphere radius ${(r / size).toFixed(3)}·size out of envelope`);
  });

  runTest('snow shelves survive: up-facing hull facets still take near-snow colour', () => {
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
