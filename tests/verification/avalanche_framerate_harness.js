// avalanche_framerate_harness.js
// Frame-rate-independence gate for the avalanche boulder kernel (AvalancheSystem.update).
//
// Sibling to forward_stress_harness.js (PR #209). The snowman drag fix in that PR
// corrected a per-frame multiplier mixed in with dt-scaled forces; the SAME bug class
// lived on in src/avalanche.ts, where the ground `friction = 0.98` was applied once
// per frame instead of integrated per second. That made boulders decay ~4x less at the
// capped 10 FPS delta than at 60 FPS, so on a slow device the avalanche reached FARTHER
// and FASTER — directly skewing burial (game-over) fairness by frame rate.
//
// This harness triggers ONE deterministic avalanche (seeded Math.random so every frame
// rate gets byte-identical initial boulder state + terrain) and steps it for a fixed
// amount of IN-GAME time at several frame rates. It then compares how far downhill the
// boulder front travelled. It guards two properties:
//
//   1. FRAME-RATE-BOUNDED REACH — the 10-FPS / 60-FPS front-travel ratio must stay near
//      1. Before the fix it ballooned well past the cap (low FPS = less friction = more
//      reach); the fix (friction -> Math.pow(0.98, dt*60)) brings every frame rate in
//      line, byte-identical at the 1/60 baseline.
//   2. NO NaN/Infinity — every boulder position/velocity stays finite at every frame
//      rate, including the capped 0.1 s delta.
//
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/verification/avalanche_framerate_harness.js
const { pathToFileURL } = require('url');
const path = require('path');

// Minimal browser globals the kernel + terrain touch (no DOM/WebGL).
global.window = { location: { search: '' }, matchMedia: () => ({ matches: false }), terrainMesh: null };
global.document = undefined;
try { Object.defineProperty(global, 'navigator', { value: { webdriver: false }, configurable: true }); } catch { /* keep existing */ }

// Seeded PRNG so boulder spawn (trigger() calls Math.random) is reproducible and the
// only variable across the FRAME_RATES loop is dt.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '..', 'loaders', 'register-ts-resolve.mjs')).href);
  const THREE = await import('three');
  const { AvalancheSystem } = await import('../../src/avalanche.ts');

  // FLAT terrain on purpose — like physics_invariant_harness.js pins the snowman on a
  // synthetic slope rather than the real mountain. On the real downhill slope, boulder
  // reach is dominated by ballistic gravity + (correctly dt-scaled) slide, so the
  // grounded FRICTION term — the buggy one — barely shows. On flat ground the boulders
  // settle and enter the grounded-slide regime where terminal slide speed is
  // -2*dt/(1-friction): ~6x larger at 10 FPS than 60 FPS pre-fix, ~flat post-fix. That
  // is the clean, large, reliable signal this gate needs.
  const getTerrainHeight = () => 0;

  const SEEDS = [12345, 777, 42, 9001];
  const FRAME_RATES = [1 / 60, 1 / 30, 1 / 10]; // 60, 30, and the capped-delta 10 FPS
  // Long enough that boulders settle into the grounded-slide regime, where the
  // frame-rate dependence is strongest (see terrain note above).
  const SIM_SECONDS = 12;                        // in-game wall clock to integrate per run
  const PLAYER = { x: 0, y: 2, z: -60 };

  // Trigger one avalanche from a fixed seed, step it for SIM_SECONDS at `dt`, and report
  // how far downhill (-Z) the boulder front and mean reached, plus a finiteness flag.
  function runAvalanche(seed, dt) {
    Math.random = makeRng(seed);
    // Silence the unconditional trigger() log so harness output stays readable.
    const _log = console.log;
    console.log = () => {};
    const scene = new THREE.Scene();
    const av = new AvalancheSystem(scene, 120);
    av.setTerrainFunction(getTerrainHeight);
    av.trigger(PLAYER);
    console.log = _log;

    // Snapshot the spawned front Z (max -Z reached so far = most downhill = min z).
    const startLeadZ = Math.min(...sampleZ(av));

    let finite = true;
    const steps = Math.round(SIM_SECONDS / dt);
    for (let f = 0; f < steps; f++) {
      av.update(dt);
      if (finite) {
        for (let i = 0; i < av.count; i++) {
          const idx = i * 3;
          if (!Number.isFinite(av.positions[idx]) || !Number.isFinite(av.positions[idx + 1]) ||
              !Number.isFinite(av.positions[idx + 2]) || !Number.isFinite(av.velocities[idx + 2])) {
            finite = false; break;
          }
        }
      }
    }

    const zs = sampleZ(av);
    const leadZ = Math.min(...zs);
    const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
    // Travel = how much further downhill (more negative Z) the front advanced.
    const frontTravel = startLeadZ - leadZ;
    return { frontTravel, leadZ, meanZ, finite };
  }

  function sampleZ(av) {
    const zs = [];
    for (let i = 0; i < av.count; i++) zs.push(av.positions[i * 3 + 2]);
    return zs;
  }

  let hardFail = false;
  let worstReachRatio = 0, worstReachSeed = 0, allFinite = true;
  const rows = [];
  for (const seed of SEEDS) {
    const byDt = {};
    for (const dt of FRAME_RATES) {
      const r = runAvalanche(seed, dt);
      byDt[dt] = r;
      if (!r.finite) allFinite = false;
      rows.push({ seed, fps: Math.round(1 / dt), ...r });
    }
    const ratio = byDt[1 / 10].frontTravel / byDt[1 / 60].frontTravel;
    if (ratio > worstReachRatio) { worstReachRatio = ratio; worstReachSeed = seed; }
  }

  console.log('=== Avalanche frame-rate independence: real terrain, one triggered slide ===');
  console.log('  seed     FPS  frontTravel   leadZ    meanZ   finite');
  for (const r of rows) {
    console.log('  %s  %s   %s   %s  %s    %s',
      String(r.seed).padStart(6), String(r.fps).padStart(3),
      r.frontTravel.toFixed(2).padStart(8), r.leadZ.toFixed(1).padStart(7),
      r.meanZ.toFixed(1).padStart(7), r.finite ? 'yes' : 'NO ❌');
  }

  // Before the fix this ratio ran well above 1 (low FPS = less friction = more reach).
  // 1.6 mirrors the forward harness's speed cap: tight enough to fail hard on a per-frame
  // friction regression, loose enough for honest coarse-dt integration drift.
  const REACH_RATIO_CAP = 1.6;
  const reachBounded = worstReachRatio < REACH_RATIO_CAP;
  console.log('\n--- Avalanche reach does not balloon at low frame rate [GATING] ---');
  console.log('  worst 10-FPS / 60-FPS front-travel ratio:', worstReachRatio.toFixed(2),
    `(seed ${worstReachSeed})`, '| cap:', REACH_RATIO_CAP);
  console.log('  PASS:', reachBounded ? 'low-FPS reach stays bounded ✅' : 'reach scales with frame rate ❌');
  if (!reachBounded) hardFail = true;

  console.log('\n--- No NaN/Infinity in boulder state at any frame rate [GATING] ---');
  console.log('  PASS:', allFinite ? 'all boulder positions/velocities finite ✅' : 'a boulder went non-finite ❌');
  if (!allFinite) hardFail = true;

  console.log(`\nAVALANCHE FRAME-RATE HARNESS: ${hardFail ? 'FAIL ❌ (a gating check failed)' : 'OK ✅ (reach frame-rate bounded; all finite)'}`);
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
