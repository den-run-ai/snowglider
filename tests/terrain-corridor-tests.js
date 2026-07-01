// @ts-check
/**
 * Unit tests for the winding terrain corridor (D3.2b) — mountains/terrain.ts.
 *
 * The corridor banks the skiable channel onto the descent centerline (course-line.ts)
 * and raises walls off it. These tests pin the contracts D3.2b promises:
 *   - NO corridor ⇒ `corridorWallHeight` is 0 and getTerrainHeight is untouched (the
 *     byte-identical guardrail for Bunny/Blue).
 *   - the wall is 0 on the line (and inside `channelHalfWidth`) so the on-line height
 *     AND gradient are exactly today's — the run stays skiable on the line.
 *   - off the line the wall ramps up monotonically to `wallHeight` and no further.
 *   - getTerrainHeight WITH a corridor == today's height + the SAME wall term (the
 *     two-formula contract: getTerrainHeight and the mesh add one shared formula).
 *   - the gradient is steeper off the line than on it (running straight is punishing).
 *   - setting/clearing the corridor resets the (tier-blind) heightMap cache.
 *
 * Imports the THREE-free terrain LEAF directly (not the mountains facade, which pulls
 * in three.js), so it runs headlessly.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/terrain-corridor-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps == null ? 1e-9 : eps)) {
    throw new Error(`${msg || 'expected close'}: ${a} vs ${b} (eps ${eps})`);
  }
}

(async () => {
  const T = await import('../src/mountains/terrain.js');
  const { courseLineFor } = await import('../src/course-line.js');
  const { getDifficultyConfig } = await import('../src/difficulty.js');
  const {
    setTerrainCorridor, corridorWallHeight, hasActiveCorridor, resetHeightMap,
    getTerrainHeight, getTerrainGradient, heightMap,
  } = T;

  console.log('\n⛰️  SNOWGLIDER TERRAIN-CORRIDOR TESTS (D3.2b) ⛰️');
  console.log('=================================================\n');

  const black = getDifficultyConfig('black');
  const line = courseLineFor(black);
  const params = black.terrain;
  const corridor = { line, params };

  // z column inside the lane span where the line actually winds.
  const zSamples = [];
  for (let z = -20; z >= -190; z -= 4) zSamples.push(z);

  runTest('Black ships a terrain corridor block (channelHalfWidth/wallRamp/wallHeight)', () => {
    assert(params && typeof params.channelHalfWidth === 'number'
      && typeof params.wallRamp === 'number' && typeof params.wallHeight === 'number',
      'Black.terrain is well-formed');
    assert(params.channelHalfWidth > 0 && params.wallRamp > 0 && params.wallHeight > 0, 'all positive');
  });

  runTest('no corridor ⇒ hasActiveCorridor false and wall is 0 everywhere (Blue guardrail)', () => {
    setTerrainCorridor(null);
    assert(hasActiveCorridor() === false, 'no active corridor');
    for (const z of zSamples) {
      for (const x of [-40, -10, 0, 10, 40]) {
        assert(corridorWallHeight(x, z) === 0, `wall 0 at (${x},${z}) with no corridor`);
      }
    }
  });

  runTest('Bunny + Blue carry no terrain corridor (stay straight/today)', () => {
    assert(getDifficultyConfig('bunny').terrain === undefined, 'Bunny has no corridor');
    assert(getDifficultyConfig('blue').terrain === undefined, 'Blue has no corridor');
  });

  runTest('wall is exactly 0 on the line and inside the channel floor', () => {
    setTerrainCorridor(corridor);
    assert(hasActiveCorridor() === true, 'corridor active');
    for (const z of zSamples) {
      const cx = line.laneX(z);
      assert(corridorWallHeight(cx, z) === 0, `on-line wall 0 at z=${z}`);
      // Anywhere within channelHalfWidth of the line is still flat floor.
      assert(corridorWallHeight(cx + (params.channelHalfWidth - 0.5), z) === 0, `inner-edge wall 0 at z=${z}`);
      assert(corridorWallHeight(cx - (params.channelHalfWidth - 0.5), z) === 0, `inner-edge(-) wall 0 at z=${z}`);
    }
  });

  runTest('wall ramps up to wallHeight off the line, and no higher (bounded)', () => {
    setTerrainCorridor(corridor);
    const far = params.channelHalfWidth + params.wallRamp + 5;
    for (const z of zSamples) {
      const cx = line.laneX(z);
      near(corridorWallHeight(cx + far, z), params.wallHeight, 1e-9, `full wall +far at z=${z}`);
      near(corridorWallHeight(cx - far, z), params.wallHeight, 1e-9, `full wall -far at z=${z}`);
      // Dense lateral sweep stays within [0, wallHeight].
      for (let dx = -60; dx <= 60; dx += 3) {
        const w = corridorWallHeight(cx + dx, z);
        assert(w >= 0 && w <= params.wallHeight + 1e-9, `wall in [0,wallHeight] at dx=${dx}, z=${z}`);
      }
    }
  });

  runTest('wall increases monotonically with distance from the line', () => {
    setTerrainCorridor(corridor);
    const z = -90;
    const cx = line.laneX(z);
    let prev = -1;
    for (let dx = 0; dx <= params.channelHalfWidth + params.wallRamp; dx += 0.5) {
      const w = corridorWallHeight(cx + dx, z);
      assert(w >= prev - 1e-12, `non-decreasing at dx=${dx} (${w} vs ${prev})`);
      prev = w;
    }
  });

  runTest('two-formula contract: getTerrainHeight(corridor) == today + the same wall term', () => {
    const pts = [[0, -25], [12, -70], [-20, -110], [5, -150], [25, -90]];
    for (const [x, z] of pts) {
      setTerrainCorridor(null);            // resets the cache
      const h0 = getTerrainHeight(x, z);   // today's height (no walls)
      setTerrainCorridor(corridor);        // resets the cache again
      const wall = corridorWallHeight(x, z);
      const h1 = getTerrainHeight(x, z);   // recomputed with the wall
      near(h1 - h0, wall, 1e-9, `delta == wall at (${x},${z})`);
    }
  });

  runTest('on the line getTerrainHeight is unchanged (delta 0 ⇒ skiable + Blue-equivalent on-line)', () => {
    for (const z of [-30, -75, -120, -165]) {
      const cx = line.laneX(z);
      setTerrainCorridor(null);
      const h0 = getTerrainHeight(cx, z);
      setTerrainCorridor(corridor);
      const h1 = getTerrainHeight(cx, z);
      near(h1, h0, 1e-9, `on-line height unchanged at z=${z}`);
    }
  });

  runTest('gradient is steeper off the line than on it (running straight is punishing)', () => {
    setTerrainCorridor(corridor);
    const z = -90;
    const cx = line.laneX(z);
    const gOn = getTerrainGradient(cx, z);
    const gOff = getTerrainGradient(cx + params.channelHalfWidth + params.wallRamp * 0.5, z);
    const magOn = Math.hypot(gOn.x, gOn.z);
    const magOff = Math.hypot(gOff.x, gOff.z);
    assert(magOff > magOn + 0.05, `off-line gradient steeper (${magOff.toFixed(3)} vs ${magOn.toFixed(3)})`);
  });

  runTest('setting/clearing the corridor resets the (tier-blind) heightMap cache', () => {
    setTerrainCorridor(null);
    getTerrainHeight(7, -60);
    assert(Object.keys(heightMap).length > 0, 'cache populated by a sample');
    setTerrainCorridor(corridor);
    assert(Object.keys(heightMap).length === 0, 'corridor change cleared the cache');
    getTerrainHeight(7, -60);
    resetHeightMap();
    assert(Object.keys(heightMap).length === 0, 'resetHeightMap empties the cache');
  });

  // Leave terrain in the default (no-corridor) state for any later importer.
  setTerrainCorridor(null);

  console.log('\n=================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
