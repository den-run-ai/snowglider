// @ts-check
/**
 * Unit tests for the shared snow palette (src/mountains/snow-palette.ts) and the
 * difficulty-themed ski top sheets (PR 2 of the visual-materials plan).
 *
 * The palette module ends the constant drift: the same snow white / shade / cavity
 * values were previously duplicated across rocks.ts, trees.ts, snow-surface.ts and
 * snowman/snow-material.ts. These assertions pin (a) the palette values themselves
 * (they were copied verbatim from the shipped constants, so the refactor is visually
 * a no-op by construction), and (b) that the reachable consumers really render with
 * them. Guards future drift the way test:limits-sync guards the score limits.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/snow-palette-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

(async () => {
  const THREE = await import('three');
  const palette = await import('../src/mountains/snow-palette.js');
  const { SNOW_WHITE, SNOW_SHADE, CAVITY_COLOR, SNOW_ROUGHNESS_SURFACE, SNOW_ROUGHNESS_CAPS } = palette;

  console.log('\n❄️  SNOWGLIDER SNOW-PALETTE TESTS ❄️');
  console.log('===================================\n');

  runTest('palette values are the shipped constants (visual no-op contract)', () => {
    assert(SNOW_WHITE.r === 0.97 && SNOW_WHITE.g === 0.98 && SNOW_WHITE.b === 1.0, 'SNOW_WHITE drifted');
    assert(SNOW_SHADE.r === 0.93 && SNOW_SHADE.g === 0.95 && SNOW_SHADE.b === 0.99, 'SNOW_SHADE drifted');
    assert(CAVITY_COLOR.r === 0.8 && CAVITY_COLOR.g === 0.84 && CAVITY_COLOR.b === 0.93, 'CAVITY_COLOR drifted');
    assert(SNOW_ROUGHNESS_SURFACE === 0.92, 'SNOW_ROUGHNESS_SURFACE drifted');
    assert(SNOW_ROUGHNESS_CAPS === 0.82, 'SNOW_ROUGHNESS_CAPS drifted');
  });

  const { SNOWMAN_SNOW_ROUGHNESS } = await import('../src/snowman/snow-material.js');
  runTest('snowman snow roughness is single-sourced from the palette', () => {
    assert(SNOWMAN_SNOW_ROUGHNESS === SNOW_ROUGHNESS_SURFACE,
      `SNOWMAN_SNOW_ROUGHNESS ${SNOWMAN_SNOW_ROUGHNESS} !== palette ${SNOW_ROUGHNESS_SURFACE}`);
  });

  const { createRock } = await import('../src/mountains/rocks.js');
  runTest('rock snow caps saturate to the palette SNOW_WHITE', () => {
    // Fully up-facing faces (normal.y >= 0.55) blend all the way to the cap white.
    // Float32Array storage rounds the values, hence the 1e-3 tolerance.
    let saturated = 0;
    for (let k = 0; k < 5; k++) {
      const rock = createRock(2, { seed: 100 + k });
      const colors = rock.geometry.attributes.color.array;
      for (let i = 0; i < colors.length; i += 3) {
        if (near(colors[i], SNOW_WHITE.r, 1e-3) &&
            near(colors[i + 1], SNOW_WHITE.g, 1e-3) &&
            near(colors[i + 2], SNOW_WHITE.b, 1e-3)) saturated++;
      }
    }
    assert(saturated > 0, 'no rock vertex reached the palette snow-cap white');
  });

  // --- Difficulty-themed ski top sheets ---------------------------------------
  const { SKI_TOP_SHEET, createSnowman } = await import('../src/snowman/model.js');
  const { DIFFICULTIES } = await import('../src/difficulty.js');

  runTest('every difficulty tier has a distinct ski top-sheet colour', () => {
    const ids = DIFFICULTIES.map((d) => d.id);
    const colors = ids.map((id) => SKI_TOP_SHEET[id]);
    assert(colors.every((c) => typeof c === 'number'), 'a tier is missing from SKI_TOP_SHEET');
    assert(new Set(colors).size === ids.length, `tiers share a top-sheet colour: ${colors.map(c => c.toString(16))}`);
  });

  runTest('blue keeps the original red (default tier is a visual no-op)', () => {
    assert(SKI_TOP_SHEET.blue === 0xD42B2B, `blue top sheet is ${SKI_TOP_SHEET.blue.toString(16)}`);
  });

  /** The ski tip arm's material[0] is the top sheet (RING_MAT slot 0). */
  function topSheetColorOf(group) {
    const tip = group.userData.parts.leftSkiTip;
    return tip.material[0].color.getHex();
  }

  runTest('createSnowman default ski top sheet is the blue-tier red', () => {
    const scene = new THREE.Scene();
    const g = createSnowman(scene);
    assert(topSheetColorOf(g) === SKI_TOP_SHEET.blue,
      `default top sheet ${topSheetColorOf(g).toString(16)}`);
  });

  runTest('createSnowman honours the skiTopSheet option per tier', () => {
    for (const tier of /** @type {const} */ (['bunny', 'black', 'expert'])) {
      const scene = new THREE.Scene();
      const g = createSnowman(scene, { skiTopSheet: SKI_TOP_SHEET[tier] });
      assert(topSheetColorOf(g) === SKI_TOP_SHEET[tier],
        `${tier}: top sheet ${topSheetColorOf(g).toString(16)} !== ${SKI_TOP_SHEET[tier].toString(16)}`);
    }
  });

  console.log(`\n==================================`);
  console.log(`Snow-palette tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('Snow-palette test harness crashed:', e);
  process.exit(1);
});
