// @ts-check
// fixed-timestep-tests.js — unit coverage for the PURE fixed-timestep accumulator math
// (src/game/fixed-timestep.ts) that the run loop uses to advance physics in fixed 1/60 s
// substeps regardless of render rate. These assert the bookkeeping the determinism /
// no-tunnelling guarantee rests on; the integration proof (kernel trajectories match
// across frame rates) lives in tests/verification/fixed_timestep_harness.js.
//
// Run via the register-ts-resolve loader so the `.ts` source resolves headlessly.
const { pathToFileURL } = require('url');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

(async () => {
  await import(pathToFileURL(path.join(__dirname, 'loaders', 'register-ts-resolve.mjs')).href);
  const { FIXED_DT, MAX_SUBSTEPS, planSubsteps, lerp } = await import('../src/game/fixed-timestep.ts');

  console.log('--- constants ---');
  check('FIXED_DT is 1/60 (the rate the invariant harness pins)', near(FIXED_DT, 1 / 60));
  check('MAX_SUBSTEPS is 8 (~133 ms ceiling)', MAX_SUBSTEPS === 8);

  console.log('\n--- planSubsteps: exact-60-FPS frame consumes exactly one substep ---');
  {
    const p = planSubsteps(FIXED_DT, 0);
    check('one substep', p.substeps === 1);
    check('accumulator drained to ~0', near(p.accumulator, 0));
    check('alpha ~0', near(p.alpha, 0));
  }

  console.log('\n--- planSubsteps: sub-60 render frame runs multiple substeps ---');
  {
    // A 20 FPS frame (0.05 s) is exactly 3 fixed steps.
    const p = planSubsteps(0.05, 0);
    check('three substeps at 20 FPS', p.substeps === 3);
    check('no remainder', near(p.accumulator, 0));
  }

  console.log('\n--- planSubsteps: high-refresh frame carries a remainder, runs 0 substeps ---');
  {
    // A 144 FPS frame (~0.00694 s) is below one fixed step: 0 substeps, accumulate.
    const p = planSubsteps(1 / 144, 0);
    check('zero substeps below the fixed step', p.substeps === 0);
    check('remainder carried in accumulator', near(p.accumulator, 1 / 144));
    check('alpha = accumulator / FIXED_DT in [0,1)', p.alpha >= 0 && p.alpha < 1 && near(p.alpha, (1 / 144) / FIXED_DT));
  }

  console.log('\n--- planSubsteps: remainder accumulates across frames into a step ---');
  {
    // Two 144 FPS frames (~0.0139 s) still under one step; the third crosses it.
    let acc = 0, total = 0;
    for (let i = 0; i < 3; i++) { const p = planSubsteps(1 / 144, acc); acc = p.accumulator; total += p.substeps; }
    check('a substep eventually fires once enough time accrues', total === 1);
    check('leftover stays below one fixed step', acc >= 0 && acc < FIXED_DT);
  }

  console.log('\n--- planSubsteps: spiral-of-death guard caps substeps per frame ---');
  {
    // A 2 s pause would be 120 steps; the ceiling clamps it to MAX_SUBSTEPS and drops the rest.
    const p = planSubsteps(2.0, 0);
    check('substeps capped at MAX_SUBSTEPS', p.substeps === MAX_SUBSTEPS);
    check('excess real time dropped (accumulator < FIXED_DT)', p.accumulator < FIXED_DT);
  }

  console.log('\n--- planSubsteps: pathological deltas cannot rewind or burst ---');
  {
    const neg = planSubsteps(-1, 0);
    check('negative delta runs no substeps', neg.substeps === 0 && near(neg.accumulator, 0));
    const nan = planSubsteps(NaN, 0);
    check('NaN delta runs no substeps (no burst)', nan.substeps === 0 && Number.isFinite(nan.accumulator));
  }

  console.log('\n--- planSubsteps: total substeps over a descent are frame-rate INVARIANT ---');
  {
    // The core determinism property: the same in-game time advances the SAME number of
    // fixed substeps no matter how it is chopped into frames, so the kernel sees an
    // identical sequence of FIXED_DT steps at every render rate.
    const SECONDS = 10;
    function totalSubsteps(frameDt) {
      let acc = 0, total = 0, t = 0;
      while (t < SECONDS - 1e-12) { const p = planSubsteps(frameDt, acc); acc = p.accumulator; total += p.substeps; t += frameDt; }
      return total;
    }
    const expected = Math.round(SECONDS / FIXED_DT); // 600
    const at60 = totalSubsteps(1 / 60);
    const at30 = totalSubsteps(1 / 30);
    const at144 = totalSubsteps(1 / 144);
    // Equal to within one substep across rates — the only slack is sub-FIXED_DT
    // floating-point residue at the frame boundaries, never a per-rate force scaling.
    check(`60 FPS over ${SECONDS}s runs ~${expected} substeps`, Math.abs(at60 - expected) <= 1);
    check('30 FPS runs the same total (±1)', Math.abs(at30 - at60) <= 1);
    check('144 FPS runs the same total (±1)', Math.abs(at144 - at60) <= 1);
  }

  console.log('\n--- lerp ---');
  check('lerp endpoints', near(lerp(2, 8, 0), 2) && near(lerp(2, 8, 1), 8));
  check('lerp midpoint', near(lerp(2, 8, 0.5), 5));

  console.log(`\nFIXED-TIMESTEP UNIT TESTS: ${fail === 0 ? 'OK ✅' : 'FAIL ❌'} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
