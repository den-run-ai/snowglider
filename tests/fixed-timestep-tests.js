// @ts-check
/**
 * Unit tests for the fixed-timestep accumulator math (src/game/fixed-timestep.ts).
 *
 * `planSubsteps` is the pure scheduler the run loop (main-loop.ts) uses to advance
 * physics in whole 1/60 s steps regardless of render rate. It is deterministic and
 * Three.js/DOM-free, so it unit-tests headlessly. These guard the contract the
 * determinism + no-tunnel guarantees rest on: correct step counts, the spiral-of-death
 * cap, alpha staying in [0,1), accumulator carry across frames, and bad-delta safety.
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/fixed-timestep-tests.js
 */
'use strict';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name); }
}
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

(async () => {
const { FIXED_DT, MAX_SUBSTEPS, planSubsteps } = await import('../src/game/fixed-timestep.ts');

console.log('=== fixed-timestep accumulator (planSubsteps) ===');

// Constants are the values the harness pins to.
check('FIXED_DT is 1/60', near(FIXED_DT, 1 / 60));
check('MAX_SUBSTEPS is 8', MAX_SUBSTEPS === 8);

// A frame exactly one step long runs exactly one substep and leaves no remainder.
{
  const p = planSubsteps(0, FIXED_DT);
  check('one-step frame -> 1 substep', p.steps === 1);
  check('one-step frame -> ~0 accumulator', near(p.accumulator, 0));
  check('one-step frame -> alpha ~0', near(p.alpha, 0));
}

// A frame faster than 60 Hz runs 0 substeps and banks the time as accumulator/alpha.
{
  const p = planSubsteps(0, 1 / 144);
  check('144 FPS frame -> 0 substeps', p.steps === 0);
  check('144 FPS frame -> accumulator carries the frame delta', near(p.accumulator, 1 / 144));
  check('144 FPS frame -> alpha in [0,1)', p.alpha >= 0 && p.alpha < 1);
}

// Two sub-60 frames accumulate across the boundary into one step (carry works).
{
  const p1 = planSubsteps(0, 1 / 120);          // 0 steps, half a step banked
  const p2 = planSubsteps(p1.accumulator, 1 / 120); // crosses the boundary -> 1 step
  check('two 120 FPS frames -> second yields 1 step', p2.steps === 1);
  check('carry leaves accumulator < FIXED_DT', p2.accumulator < FIXED_DT);
}

// A 30 FPS frame (two steps' worth) runs exactly two substeps.
{
  const p = planSubsteps(0, 1 / 30);
  check('30 FPS frame -> 2 substeps', p.steps === 2);
  check('30 FPS frame -> ~0 remainder', near(p.accumulator, 0, 1e-9));
}

// Spiral-of-death guard: a huge frame is capped to MAX_SUBSTEPS, never more, and the
// frameDelta is clamped to the ceiling rather than the raw delta.
{
  const p = planSubsteps(0, 5.0); // 5 s frame (a GC pause / tab resume)
  check('huge frame -> capped at MAX_SUBSTEPS steps', p.steps === MAX_SUBSTEPS);
  check('huge frame -> frameDelta clamped to ceiling', near(p.frameDelta, MAX_SUBSTEPS * FIXED_DT));
  check('huge frame -> alpha still in [0,1)', p.alpha >= 0 && p.alpha < 1);
  check('huge frame -> accumulator still < FIXED_DT (no runaway carry)', p.accumulator < FIXED_DT);
}

// The old 0.1 s loop-cap regime (~10 FPS) still resolves to whole steps with no drop.
{
  const p = planSubsteps(0, 0.1);
  check('10 FPS frame -> 6 substeps (0.1s / (1/60))', p.steps === 6);
  check('10 FPS frame -> alpha in [0,1)', p.alpha >= 0 && p.alpha < 1);
}

// Bad deltas (NaN / negative / zero) inject no steps and no NaN into the accumulator.
for (const bad of [NaN, Infinity, -0.5, 0]) {
  const p = planSubsteps(0, bad);
  check(`bad delta ${bad} -> 0 steps`, p.steps === 0);
  check(`bad delta ${bad} -> finite accumulator`, Number.isFinite(p.accumulator) && p.accumulator === 0);
}

console.log(`\nFIXED-TIMESTEP TESTS: ${fail ? 'FAIL ❌' : 'OK ✅'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
