// diagnostics-tests.js — headless unit tests for the physics/frame-rate telemetry
// (src/diagnostics.ts, the runtime counterpart to the offline stress harnesses).
//
// Diag's analytics are exported PURE functions (percentile / classifyFrame / foldFrame /
// fpsSpeedRatio / frameRateHealth), so the whole detector chain unit-tests in plain Node
// with no DOM. The point of these tests: prove the detector actually FIRES on the real
// PR #209 signature (terminal speed ballooning ~8 → ~32 m/s from 60 to 10 FPS, and a
// per-frame step of 3.17 u jumping the 2.5 u tree collision radius) and stays QUIET on a
// healthy steady-60-FPS run — otherwise a green diagnostics test would prove nothing.
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/diagnostics-tests.js

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Fold a list of {dt, speed, x, z} samples through the real classify+fold chain and
// return the running summary, exactly as Diag.record() does frame by frame.
function summarize(D, samples, cfg) {
  const agg = D.emptySummary();
  let prev = null;
  for (const s0 of samples) {
    const s = { technique: 'tuck', isInAir: false, ...s0 };
    const flags = D.classifyFrame(prev, s, cfg);
    D.foldFrame(agg, s, flags);
    if (!flags.nonFinite) prev = { x: s.x, z: s.z };
  }
  return agg;
}

// Build a straight-down-the-fall-line descent at a fixed dt and constant terminal speed,
// stepping z by speed*dt each frame (x held at 0). Mirrors "hold Up" cruising.
function descent({ dt, speed, frames, x = 0 }) {
  const out = [];
  let z = -15;
  for (let i = 0; i < frames; i++) { z -= speed * dt; out.push({ dt, speed, x, z }); }
  return out;
}

async function main() {
  const D = await import('../src/diagnostics.js');
  const cfg = D.DEFAULT_CONFIG; // frameCap 0.1s, collisionRadius 2.5, speedExpected 8

  // --- percentile -------------------------------------------------------------
  check('percentile: empty is NaN', Number.isNaN(D.percentile([], 0.5)));
  check('percentile: median of 1..5 is 3', approx(D.percentile([1, 2, 3, 4, 5], 0.5), 3));
  check('percentile: p0 / p100 are the ends', D.percentile([1, 2, 3, 4, 5], 0) === 1 && D.percentile([1, 2, 3, 4, 5], 1) === 5);
  check('percentile: interpolates between samples', approx(D.percentile([0, 10], 0.25), 2.5));

  // --- classifyFrame: per-frame anomaly flags ---------------------------------
  // A 10-FPS (capped 0.1s) frame at 32 m/s steps 3.2 u — past the 2.5 u tree radius.
  const slowStep = D.classifyFrame({ x: 0, z: 0 }, { dt: 0.1, speed: 32, x: 0, z: -3.2, technique: 'tuck', isInAir: false }, cfg);
  check('classify: capped 0.1s frame flagged clamped', slowStep.clamped === true);
  check('classify: 3.2u step past 2.5u radius is a tunnel risk', slowStep.tunnelRisk === true && approx(slowStep.step, 3.2, 1e-9));
  check('classify: 10 FPS reported', approx(slowStep.fps, 10));
  // A healthy 60-FPS frame at 8 m/s steps ~0.13 u — well under the radius, not clamped.
  const fastStep = D.classifyFrame({ x: 0, z: 0 }, { dt: 1 / 60, speed: 8, x: 0, z: -8 / 60, technique: 'tuck', isInAir: false }, cfg);
  check('classify: 60 FPS frame not clamped', fastStep.clamped === false);
  check('classify: small step is no tunnel risk', fastStep.tunnelRisk === false);
  // NaN guard.
  const bad = D.classifyFrame({ x: 0, z: 0 }, { dt: 1 / 60, speed: NaN, x: 0, z: 0, technique: 'tuck', isInAir: false }, cfg);
  check('classify: non-finite speed flagged', bad.nonFinite === true);

  // --- fpsSpeedRatio: the core frame-rate-dependence detector ------------------
  // No signal without both a fast and a slow band populated (a steady-FPS run).
  const steady60 = summarize(D, descent({ dt: 1 / 60, speed: 8, frames: 200 }), cfg);
  check('fps→speed: steady 60 FPS gives ratio ~1 (no signal)', approx(D.fpsSpeedRatio(steady60), 1, 1e-9));

  // THE #209 SIGNATURE: mix a 60-FPS leg at ~8 m/s with a 10-FPS leg at ~32 m/s.
  const buggy = summarize(D, [
    ...descent({ dt: 1 / 60, speed: 8, frames: 200 }),
    ...descent({ dt: 0.1, speed: 32, frames: 40 }),
  ], cfg);
  const ratio = D.fpsSpeedRatio(buggy);
  check('fps→speed: 8→32 m/s across the FPS drop flags ~4x dependence', ratio >= 3.5 && ratio <= 4.5);

  // --- frameRateHealth verdicts ----------------------------------------------
  const healthySummary = summarize(D, descent({ dt: 1 / 60, speed: 8, frames: 300 }), cfg);
  const healthy = D.frameRateHealth(healthySummary, cfg);
  check('health: steady 60 FPS run is OK', healthy.level === 'ok');

  const buggyHealth = D.frameRateHealth(buggy, cfg);
  check('health: the #209 run is graded BAD', buggyHealth.level === 'bad');
  check('health: BAD verdict cites tunnel risk', buggyHealth.reasons.some((r) => /tunnel/i.test(r)));
  check('health: BAD verdict cites frame-rate-dependent force', buggyHealth.reasons.some((r) => /frame-rate-dependent/i.test(r)));

  // A device that is merely slow but consistent (steady 10 FPS, bounded speed) must be
  // WARNED about the low frame rate but NOT accused of the speed bug (no fast band to
  // compare against → no false positive). This is the guard against crying wolf.
  const slowButOk = summarize(D, descent({ dt: 0.1, speed: 8, frames: 120 }), cfg);
  const slowHealth = D.frameRateHealth(slowButOk, cfg);
  check('health: steady-slow-but-bounded device is not falsely accused of the speed bug',
    !slowHealth.reasons.some((r) => /frame-rate-dependent/i.test(r)));
  check('health: steady-slow device is warned about the delta cap',
    slowHealth.reasons.some((r) => /delta cap|below/i.test(r)));

  // --- non-finite frames surface in the summary + verdict ---------------------
  const withNaN = summarize(D, [
    ...descent({ dt: 1 / 60, speed: 8, frames: 30 }),
    { dt: 1 / 60, speed: Infinity, x: NaN, z: NaN },
  ], cfg);
  check('summary: counts the non-finite frame', withNaN.nonFiniteFrames === 1);
  check('health: any non-finite frame is BAD', D.frameRateHealth(withNaN, cfg).level === 'bad');

  // --- foldFrame is additive (record() folds one frame at a time) -------------
  const all = descent({ dt: 1 / 60, speed: 8, frames: 50 });
  const once = summarize(D, all, cfg);
  const split = (() => {
    const agg = D.emptySummary(); let prev = null;
    for (const s of all) { const f = D.classifyFrame(prev, { technique: 'tuck', isInAir: false, ...s }, cfg); D.foldFrame(agg, { technique: 'tuck', isInAir: false, ...s }, f); prev = { x: s.x, z: s.z }; }
    return agg;
  })();
  check('fold: incremental == batch (frames + speedMax)',
    once.frames === split.frames && approx(once.speedMax, split.speedMax));

  // --- the live recorder is inert + safe in Node (no DOM) ---------------------
  D.Diag.init(cfg);            // no window/document in Node → headless recorder path
  D.Diag.record({ dt: 1 / 60, speed: 8, x: 0, z: -1, technique: 'tuck', isInAir: false });
  const snap = D.Diag.snapshot();
  check('recorder: snapshot is JSON-serialisable with a health verdict',
    !!snap && !!snap.health && typeof JSON.stringify(snap) === 'string');
  D.Diag.reset();
  check('recorder: reset clears the trace', D.Diag.snapshot().summary.frames === 0);

  console.log(`\nDIAGNOSTICS TESTS: ${fail === 0 ? 'OK ✅' : 'FAIL ❌'} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
