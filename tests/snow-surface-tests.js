// @ts-check
// Headless coverage for the snow-surface cavity/AO vertex shading (issue #17 follow-up)
// and the single-sourced slope thresholds (src/slope-tiers.ts).
//
// applySnowVertexColors bakes a per-vertex snow tint into the terrain geometry. The
// shipped tint keys off slope magnitude only, so concave hollows stayed flat white; the
// new cavity term darkens + cool-shifts vertices that dip below their grid neighbours.
// These assertions build a tiny grid with a known hollow / peak / flat and verify the
// term darkens hollows, leaves convex peaks and flats untouched, and never modifies the
// vertex heights. Pure + WebGL-free (only THREE math + the function under test). CommonJS
// + dynamic import so the register-ts-resolve loader resolves the `.ts` sources + 'three'.

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const sum3 = (a, i) => a[i * 3] + a[i * 3 + 1] + a[i * 3 + 2];

async function main() {
  const THREE = await import('three');
  const { applySnowVertexColors } = await import('../src/mountains/snow-surface.ts');
  const { SLOPE_MODERATE, SLOPE_STEEP } = await import('../src/slope-tiers.ts');

  // --- Build a 7x7 grid (PlaneGeometry 6x6 segments), rotated so y is height. ---
  const COLS = 7, ROWS = 7;
  function freshGeo() {
    const g = new THREE.PlaneGeometry(12, 12, COLS - 1, ROWS - 1);
    g.rotateX(-Math.PI / 2); // now position.y is terrain height
    const p = g.attributes.position.array;
    // Flat field at y=0, with one concave hollow and one convex peak whose
    // 4-neighbourhoods don't overlap.
    const HOLLOW = 3 * COLS + 3; // (r=3,c=3) centre
    const PEAK = 1 * COLS + 1;   // (r=1,c=1)
    p[HOLLOW * 3 + 1] = -2;      // dips below neighbours -> concave
    p[PEAK * 3 + 1] = 2;         // rises above neighbours -> convex
    g.computeVertexNormals();
    return { g, HOLLOW, PEAK, FLAT: 5 * COLS + 5 };
  }

  console.log('--- snow-surface: cavity/AO term ---');
  const { g, HOLLOW, PEAK, FLAT } = freshGeo();
  const heightsBefore = Float32Array.from(g.attributes.position.array);

  // Slope tint only (no grid) — the baseline the cavity term adds onto.
  applySnowVertexColors(g);
  const base = Float32Array.from(g.attributes.color.array);

  // Same geometry, now with the grid so the cavity term engages.
  applySnowVertexColors(g, COLS, ROWS);
  const cav = Float32Array.from(g.attributes.color.array);

  check('hollow is darkened by the cavity term (sum drops vs slope-tint-only)',
    sum3(cav, HOLLOW) < sum3(base, HOLLOW) - 1e-4);
  check('hollow is cool/blue-shifted (b-r grows)',
    (cav[HOLLOW * 3 + 2] - cav[HOLLOW * 3]) > (base[HOLLOW * 3 + 2] - base[HOLLOW * 3]) + 1e-4);
  check('convex peak is left bright (cavity occ = 0, unchanged)',
    Math.abs(sum3(cav, PEAK) - sum3(base, PEAK)) < 1e-6);
  check('flat vertex unchanged by the cavity term',
    Math.abs(sum3(cav, FLAT) - sum3(base, FLAT)) < 1e-6);

  let inRange = true;
  for (let k = 0; k < cav.length; k++) if (cav[k] < 0 || cav[k] > 1) inRange = false;
  check('all cavity colour components stay within [0,1]', inRange);

  // The height field must be untouched — this is a render-only colour pass.
  const heightsAfter = g.attributes.position.array;
  let heightsIdentical = true;
  for (let k = 0; k < heightsAfter.length; k++) if (heightsAfter[k] !== heightsBefore[k]) heightsIdentical = false;
  check('vertex heights are NOT modified (physics height field untouched)', heightsIdentical);

  // Back-compat / guard: a mismatched grid size skips the cavity term entirely.
  const { g: g2, HOLLOW: H2 } = freshGeo();
  applySnowVertexColors(g2);
  const noGrid = Float32Array.from(g2.attributes.color.array);
  applySnowVertexColors(g2, 999, 999); // wrong dims -> cavity disabled
  const badGrid = Float32Array.from(g2.attributes.color.array);
  check('mismatched grid dims disable the cavity term (back-compat)',
    Math.abs(sum3(badGrid, H2) - sum3(noGrid, H2)) < 1e-6);

  console.log('\n--- slope-tiers: single source ---');
  check('SLOPE_MODERATE / SLOPE_STEEP are the documented edges', SLOPE_MODERATE === 0.32 && SLOPE_STEEP === 0.58);
  check('moderate edge is below the steep edge', SLOPE_MODERATE < SLOPE_STEEP);

  console.log(`\nsnow-surface: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ SNOW-SURFACE TESTS FAILED:', err); process.exit(1); });
