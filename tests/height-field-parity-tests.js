// @ts-check
/**
 * One height field — mesh/physics parity (issue #401).
 *
 * The audit's P0: the rendered terrain (mesh vertex formula) and the physical
 * terrain (getTerrainHeight sampler) used materially different height formulas
 * — Simplex x2.0 + ridge x1.5 + per-vertex Math.random bumps vs sin*cos x1.5 +
 * ridge x0.8 — partially masked by the shared heightMap cache serving whichever
 * value was computed first. Since #401 the mesh samples getTerrainHeightUncached
 * per vertex, so there is ONE formula.
 *
 * Gates:
 *  1. Dense mesh-vs-sampler parity: EVERY vertex of the real createTerrain mesh
 *     equals getTerrainHeightUncached(x, z) exactly (diff 0, not tolerance).
 *  2. Determinism: two independent builds produce byte-identical vertex buffers
 *     (the old mesh drew unseeded Simplex + Math.random bumps — different every
 *     run).
 *  3. Cache integrity: after a build, every heightMap entry a fresh analytic
 *     query would produce matches the cached value (pure memoization).
 *  4. Cosmetic cache-neutrality: updateSnowflakes samples the cache-NEUTRAL
 *     path — a storm of moving flakes must not grow the gameplay-owned cache.
 *  5. Gradient parity: the physics gradient at random points equals the
 *     cache-neutral gradient when the cache holds only mesh-build entries.
 */
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function main() {
  console.log('\n⛰️  HEIGHT-FIELD PARITY TESTS (#401) ⛰️');
  console.log('=========================================\n');

  // jsdom + canvas stub so the REAL createTerrain builds headlessly.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://snowglider.ai/' });
  const g = /** @type {any} */ (globalThis);
  g.window = dom.window;
  g.document = dom.window.document;
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'canvas') {
      el.getContext = () => ({
        fillStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
        clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}
      });
    }
    return el;
  };

  const THREE = await import('three');
  const terrain = await import('../src/mountains/terrain.ts');
  const { createTerrain } = await import('../src/mountains/terrain-mesh.ts');
  const { Trees } = await import('../src/mountains/trees.ts');
  const { Snow } = await import('../src/snow.ts');
  Trees.setEzForestEnabled(false); // synchronous stylized forest for a unit test

  const quiet = (fn) => {
    const _log = console.log, _warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { return fn(); } finally { console.log = _log; console.warn = _warn; }
  };

  // ---------- 1) dense mesh-vs-sampler parity ----------
  console.log('--- dense mesh vs sampler parity ---');
  const built = quiet(() => createTerrain(new THREE.Scene()));
  const verts = /** @type {Float32Array} */ (built.terrain.geometry.attributes.position.array);
  {
    // The vertex buffer is a Float32Array, so the stored height is the float32
    // ROUNDING of the sampler's float64 value — the parity contract is exact
    // equality after Math.fround, not raw float64 equality.
    let mismatches = 0, checkedAll = 0;
    for (let i = 0; i < verts.length; i += 3) {
      if (verts[i + 1] !== Math.fround(terrain.getTerrainHeightUncached(verts[i], verts[i + 2]))) mismatches++;
      checkedAll++;
    }
    check(`every mesh vertex equals the analytic sampler exactly, to float32 (${checkedAll} vertices)`,
      mismatches === 0, `${mismatches} mismatching vertices`);
  }

  // ---------- 2) build determinism ----------
  console.log('\n--- build determinism ---');
  {
    const b2 = quiet(() => createTerrain(new THREE.Scene()));
    const v2 = /** @type {Float32Array} */ (b2.terrain.geometry.attributes.position.array);
    let same = verts.length === v2.length;
    for (let i = 0; same && i < verts.length; i++) same = verts[i] === v2[i];
    check('two independent builds produce byte-identical vertex buffers', same);
  }

  // ---------- 3) cache is a pure memoization ----------
  console.log('\n--- heightMap cache integrity ---');
  {
    // Every cached entry must be a value the analytic path COULD have produced
    // for some query in its 0.1-unit cell. For vertex-populated entries the
    // vertex coordinates are exact cell centers, so equality is exact.
    let mismatches = 0, sampled = 0;
    for (let i = 0; i < verts.length; i += 3 * 97) { // stride: ~1% of vertices
      const x = verts[i], z = verts[i + 2];
      const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
      const cached = terrain.heightMap[key];
      if (cached === undefined) continue;
      sampled++;
      if (cached !== terrain.getTerrainHeightUncached(x, z)) mismatches++;
    }
    check(`cached vertex cells equal the analytic value exactly (${sampled} sampled)`,
      sampled > 0 && mismatches === 0, `${mismatches} mismatches`);
  }

  // ---------- 4) snowflakes are cache-neutral ----------
  console.log('\n--- cosmetic cache-neutrality (snowflakes) ---');
  {
    const scene = new THREE.Scene();
    quiet(() => Snow.createSnowflakes(scene));
    const before = Object.keys(terrain.heightMap).length;
    // A storm of frames with the player far from any cached cell: flakes fall,
    // respawn, and sample ad-hoc moving coordinates every frame.
    for (let f = 0; f < 120; f++) {
      Snow.updateSnowflakes(1 / 60, { x: 987.5, y: 10, z: 987.5 }, scene);
    }
    const after = Object.keys(terrain.heightMap).length;
    check('120 snowflake frames do not grow the gameplay heightMap cache',
      after === before, `${before} -> ${after} entries`);
  }

  // ---------- 5) gradient parity ----------
  console.log('\n--- gradient parity at random points ---');
  {
    const rng = makeRng(0xD1FF);
    let maxDiff = 0;
    for (let k = 0; k < 200; k++) {
      const x = (rng() - 0.5) * 220;
      const z = -200 + rng() * 260;
      const a = terrain.getTerrainGradient(x, z);
      const b = terrain.getTerrainGradientUncached(x, z);
      maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.z - b.z));
    }
    // The cached path may quantize into 0.1-unit cells populated by the mesh
    // build; with ONE formula the residual is bounded by the cell size, not by
    // a formula mismatch (which reached several units before #401).
    check('cached vs analytic gradients agree to within the 0.1-cell quantization',
      maxDiff < 0.5, `max abs diff ${maxDiff.toFixed(4)}`);
  }

  // ---------- 6) KICKERS: off-vertex parity across the lip discontinuity ----------
  // The maintainer-measured #408 blocker: expert kickers drop ~3 units abruptly at
  // the lip, the 2-unit mesh grid interpolates across that discontinuity, and the
  // old analytic physics sampler diverged from the rendered surface by ~1.49 units
  // at z=-71 (approaching ~2.99 right below the lip). Physics now samples the SAME
  // piecewise-linear triangles the GPU rasterizes, so the gap must be gone at
  // every off-vertex point around every lip and lateral edge.
  console.log('\n--- kicker-lip off-vertex parity (active expert kickers) ---');
  {
    const { getDifficultyConfig } = await import('../src/difficulty.ts');
    const { courseLineFor } = await import('../src/course-line.ts');
    const cfg = getDifficultyConfig('expert');
    const line = courseLineFor(cfg);
    terrain.setTerrainCorridor(cfg.terrain ? { line, params: cfg.terrain } : null);
    terrain.setTerrainKickers(cfg.features ?? null, line);

    const kBuilt = quiet(() => createTerrain(new THREE.Scene()));
    const kVerts = /** @type {Float32Array} */ (kBuilt.terrain.geometry.attributes.position.array);
    // Sample the RENDERED surface: the exact PlaneGeometry triangle split, from
    // the float32 vertex buffer (i = (x+150)/2 col, j = (z+200)/2 row).
    const meshHeight = (x, z) => {
      const fx = (x + 150) / 2, fz = (z + 200) / 2;
      const i = Math.min(149, Math.floor(fx)), j = Math.min(199, Math.floor(fz));
      const u = fx - i, v = fz - j;
      const h = (ii, jj) => kVerts[(ii + 151 * jj) * 3 + 1];
      const ha = h(i, j), hb = h(i, j + 1), hc = h(i + 1, j + 1), hd = h(i + 1, j);
      return (u + v <= 1)
        ? ha + u * (hd - ha) + v * (hb - ha)
        : hc + (1 - u) * (hb - hc) + (1 - v) * (hd - hc);
    };

    let maxPhysVsMesh = 0, maxAnalyticVsMesh = 0, points = 0;
    for (const spec of cfg.features ?? []) {
      for (let z = spec.z - 2.5; z <= spec.z + spec.length + 2.5; z += 0.31) {
        const xc = line.laneX(z);
        for (let dx = -spec.halfWidth - 2.5; dx <= spec.halfWidth + 2.5; dx += 0.47) {
          const x = xc + dx;
          const m = meshHeight(x, z);
          maxPhysVsMesh = Math.max(maxPhysVsMesh, Math.abs(terrain.getTerrainHeightUncached(x, z) - m));
          maxAnalyticVsMesh = Math.max(maxAnalyticVsMesh, Math.abs(terrain.analyticTerrainHeight(x, z) - m));
          points++;
        }
      }
    }
    check(`physics == rendered surface at ${points} off-vertex points around every kicker lip/edge`,
      maxPhysVsMesh < 1e-3, `max abs diff ${maxPhysVsMesh.toExponential(3)}`);
    check('the OLD analytic sampler genuinely diverged from the rendered lip (the closed gap)',
      maxAnalyticVsMesh > 1.0, `analytic-vs-mesh max ${maxAnalyticVsMesh.toFixed(3)} units`);

    // Random off-vertex parity across the whole playable field, kickers active.
    const rng = makeRng(0xF00D);
    let maxGlobal = 0;
    for (let k = 0; k < 500; k++) {
      const x = (rng() - 0.5) * 240;
      const z = -195 + rng() * 250;
      maxGlobal = Math.max(maxGlobal, Math.abs(terrain.getTerrainHeightUncached(x, z) - meshHeight(x, z)));
    }
    check('physics == rendered surface at 500 random off-vertex points (kickers active)',
      maxGlobal < 1e-3, `max abs diff ${maxGlobal.toExponential(3)}`);

    // Leave the module clean for any later consumer.
    terrain.setTerrainKickers(null, null);
    terrain.setTerrainCorridor(null);
  }

  console.log('\n=========================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
