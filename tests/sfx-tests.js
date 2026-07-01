// @ts-check
// sfx-tests.js — headless unit tests for the procedural sound-effects engine (#158).
//
// Sfx (src/sfx.ts) synthesises everything from Web Audio at runtime, so it has no
// asset dependency and — crucially — is fully inert without an AudioContext. That
// lets us unit-test the gain-mapping math (exported pure functions) and the engine's
// defensive no-op / mute behaviour in plain Node, with no browser. Run via:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/sfx-tests.js
//
// What we guard:
//  - the pure gain maps are clamped, monotonic where they should be, and NaN-safe;
//  - the engine no-ops (never throws) without Web Audio, even under automation;
//  - getStatus() reports an inert engine in Node;
//  - setMuted()/isMuted() track state without a context (so the shared mute button
//    can drive SFX before the context is ever unlocked).

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

async function main() {
  const Sfx = await import('../src/sfx.js');
  const { windGainForSpeed, windGainForField, carveGainForTechnique, avalancheGainForDistance, landGainForForce } = Sfx;

  // --- wind bed gain -----------------------------------------------------------
  check('wind: idle floor at speed 0 (slope never silent)', windGainForSpeed(0) > 0 && windGainForSpeed(0) < 0.1);
  check('wind: rises with speed', windGainForSpeed(20) > windGainForSpeed(5));
  check('wind: saturates (clamped) past the reference speed', approx(windGainForSpeed(100), windGainForSpeed(20)));
  check('wind: NaN-safe', Number.isFinite(windGainForSpeed(NaN)) && windGainForSpeed(NaN) === windGainForSpeed(0));
  check('wind: negative speed treated as 0', windGainForSpeed(-50) === windGainForSpeed(0));

  // --- wind bed coupled to the shared Wind field (#253 PR5) --------------------
  // The KEY invariant: a dead-calm field (strength 0) reduces EXACTLY to the pre-#253
  // speed-only sound, so an unwindy run (and the ?test= suites) are byte-identical.
  check('windField: dead-calm (strength 0) == pure speed gain, at rest', windGainForField(0, 0) === windGainForSpeed(0));
  check('windField: dead-calm (strength 0) == pure speed gain, moving', windGainForField(14, 0) === windGainForSpeed(14));
  check('windField: a gusty standstill is louder than a calm standstill', windGainForField(0, 1) > windGainForField(0, 0));
  check('windField: rises with field strength at a fixed speed', windGainForField(6, 1) > windGainForField(6, 0.3));
  check('windField: strength clamped at 1 (a storm cannot overdrive the bed)', approx(windGainForField(6, 5), windGainForField(6, 1)));
  check('windField: negative strength treated as calm', windGainForField(10, -3) === windGainForField(10, 0));
  check('windField: NaN strength treated as calm', windGainForField(10, NaN) === windGainForField(10, 0));
  check('windField: still moves with speed at full wind', windGainForField(20, 1) > windGainForField(5, 1));
  check('windField: stays within the mixer headroom (<= ~0.62)', windGainForField(100, 1) <= 0.62);

  // --- ski-edge swish gain -----------------------------------------------------
  check('carve: glide is silent', carveGainForTechnique('glide', 18) === 0);
  check('carve: air is silent', carveGainForTechnique('air', 18) === 0);
  check('carve: a skidded parallel scrapes louder than a committed carve', carveGainForTechnique('parallel', 18) > carveGainForTechnique('carve', 18));
  check('carve: tapers to silence when nearly stopped', carveGainForTechnique('skid', 0) === 0);
  check('carve: louder fast than slow (same technique)', carveGainForTechnique('carve', 12) > carveGainForTechnique('carve', 3));
  check('carve: speed taper saturates (clamped)', approx(carveGainForTechnique('skid', 50), carveGainForTechnique('skid', 12)));

  // --- avalanche rumble gain ---------------------------------------------------
  check('avalanche: silent when inactive', avalancheGainForDistance(false, 5) === 0);
  check('avalanche: louder when closer', avalancheGainForDistance(true, 10) > avalancheGainForDistance(true, 60));
  check('avalanche: full when very close, clamped', avalancheGainForDistance(true, 0) === avalancheGainForDistance(true, 8) && avalancheGainForDistance(true, 8) > 0);
  check('avalanche: zero once far enough away', avalancheGainForDistance(true, 200) === 0);
  check('avalanche: NaN distance does not explode', Number.isFinite(avalancheGainForDistance(true, NaN)));

  // --- landing thump gain ------------------------------------------------------
  check('land: trivial touchdown is silent', landGainForForce(0.05) === 0);
  check('land: a real landing makes noise', landGainForForce(0.5) > 0);
  check('land: harder landing is louder', landGainForForce(1.0) > landGainForForce(0.3));
  check('land: clamped at the top end', approx(landGainForForce(5), landGainForForce(1.2)));
  check('land: NaN-safe', landGainForForce(NaN) === 0);

  // --- engine: inert + defensive in Node (no AudioContext) ---------------------
  const engine = Sfx.Sfx;
  check('engine: isEnabled() true', engine.isEnabled() === true);
  let threw = false;
  try {
    engine.unlock();                         // gated off (no window) — must not throw
    engine.updateSkiing(18, 'carve', false); // no-op without a context (legacy 3-arg)
    engine.updateSkiing(18, 'carve', false, 0.7); // 4-arg wind-field form (#253 PR5)
    engine.setAvalanche(true, 10);
    engine.jump();
    engine.land(0.8);
    engine.endRun('finish');
    engine.endRun('crash');
    engine.teardown();                       // dispose-audit teardown — inert without a context
    engine.teardown();                       // idempotent
  } catch { threw = true; }
  check('engine: every method is a safe no-op without Web Audio', !threw);
  check('engine: teardown() leaves the engine inert (no context, not running)',
    engine.getStatus().active === false && engine.getStatus().running === false);

  const status = engine.getStatus();
  check('engine: reports inert (no context active) in Node', status.active === false && status.running === false);
  check('engine: contextState is "none" in Node', status.contextState === 'none');

  // --- mute tracking works before any context exists ---------------------------
  engine.setMuted(true);
  check('engine: setMuted(true) reflected by isMuted()', engine.isMuted() === true);
  engine.setMuted(false);
  check('engine: setMuted(false) reflected by isMuted()', engine.isMuted() === false);

  console.log(`\nSFX TESTS: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
