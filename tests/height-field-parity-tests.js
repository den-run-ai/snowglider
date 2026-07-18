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

  console.log('\n=========================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
