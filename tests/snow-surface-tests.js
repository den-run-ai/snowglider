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

  // --- Wind-drift streaks / sastrugi (PR 2 of the visual-materials plan) ---------
  // sastrugiDriftAmount is the pure per-vertex band function applySnowVertexColors
  // folds in on open, gentle ground. Deterministic, capped, gated, and directional.
  console.log('\n--- snow-surface: sastrugi wind-drift streaks ---');
  const { sastrugiDriftAmount } = await import('../src/mountains/snow-surface.ts');
  const { DEFAULT_WIND_CONFIG } = await import('../src/wind.ts');

  let deterministic = true, capped = true, someDrift = false;
  for (let x = -60; x <= 60; x += 3.7) {
    for (let z = -120; z <= 20; z += 5.3) {
      const d = sastrugiDriftAmount(x, z, 0, 0);
      if (d !== sastrugiDriftAmount(x, z, 0, 0)) deterministic = false;
      if (d < 0 || d > 0.10 + 1e-9) capped = false;
      if (d > 0.05) someDrift = true;
    }
  }
  check('drift is deterministic (pure function of x, z)', deterministic);
  check('drift amplitude is capped at 0.10 (powder stays bright)', capped);
  check('open flat ground shows real streak crests (> half amplitude somewhere)', someDrift);

  check('dense forest stands fully fade the streaks (stand gate)',
    sastrugiDriftAmount(10, -40, 0, 0.7) === 0 && sastrugiDriftAmount(3, -80, 0, 1) === 0);
  check('steep pitches fully fade the streaks (tilt gate)',
    sastrugiDriftAmount(10, -40, 0.9, 0) === 0 && sastrugiDriftAmount(3, -80, 1, 0) === 0);

  // Directionality: crest lines run ALONG the prevailing wind, so the drift changes
  // much faster across the wind than along it. Compare the mean absolute finite
  // difference on the two axes over a broad 2D sample (the phase gradient is
  // SASTRUGI_CROSS_FREQ across vs only the slow wobble along).
  const wx = Math.cos(DEFAULT_WIND_CONFIG.prevailingAngle);
  const wz = Math.sin(DEFAULT_WIND_CONFIG.prevailingAngle);
  const meanDelta = (dirX, dirZ) => {
    const h = 0.25;
    let sum = 0, n = 0;
    for (let x = -50; x <= 50; x += 7.3) {
      for (let z = -110; z <= 10; z += 9.1) {
        sum += Math.abs(sastrugiDriftAmount(x + h * dirX, z + h * dirZ, 0, 0) -
                        sastrugiDriftAmount(x, z, 0, 0));
        n++;
      }
    }
    return sum / n;
  };
  check('drift varies far more across the wind than along it (bands align with the wind)',
    meanDelta(-wz, wx) > meanDelta(wx, wz) * 2);

  // The baked vertex colours fold the drift in: an open flat grid must show the
  // band variation while every channel stays bright (>= 0.9 — a tint, never dirt).
  const flat = new THREE.PlaneGeometry(60, 60, 20, 20);
  flat.rotateX(-Math.PI / 2);
  flat.computeVertexNormals();
  applySnowVertexColors(flat);
  const fc = flat.attributes.color.array;
  let minC = 1, maxSpread = 0;
  for (let i = 0; i < fc.length; i += 3) {
    minC = Math.min(minC, fc[i], fc[i + 1], fc[i + 2]);
  }
  for (let i = 3; i < fc.length; i += 3) maxSpread = Math.max(maxSpread, Math.abs(fc[i] - fc[0]));
  check('flat-grid vertex colours vary (streaks/tints engage in the baked pass)', maxSpread > 1e-4);
  check('flat-grid vertex colours all stay bright (every channel >= 0.9)', minC >= 0.9);

  console.log(`\nsnow-surface: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ SNOW-SURFACE TESTS FAILED:', err); process.exit(1); });
