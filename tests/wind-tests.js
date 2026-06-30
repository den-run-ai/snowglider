// @ts-check
// wind-tests.js — headless unit tests for the shared wind field (issue #253).
//
// Wind (src/wind.ts) is a PURE, deterministic, three.js-free field, so the whole thing
// unit-tests in plain Node with no browser and no DOM. Run via:
//   node --import ./tests/loaders/register-ts-resolve.mjs tests/wind-tests.js
//
// What we guard:
//  - the pure field is deterministic (same (t, cfg) => same sample) and finite/NaN-safe;
//  - the magnitude stays within [base, base+gustRange] and the direction is a unit vector;
//  - gust + strength are normalized to [0,1];
//  - the stateful singleton advances with update(dt), reset() rewinds to t=0, and
//    configure() takes effect immediately;
//  - cosmetic-only: the module imports neither three.js nor the DOM (so it can't touch
//    pos/velocity and stays harness-safe).

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const isUnit = (x, z) => approx(Math.hypot(x, z), 1, 1e-9);

async function main() {
  const mod = await import('../src/wind.js');
  const { Wind, windFieldAt, DEFAULT_WIND_CONFIG } = mod;
  const cfg = DEFAULT_WIND_CONFIG;

  // --- pure field: determinism + bounds ---------------------------------------
  const a = windFieldAt(3.5, cfg);
  const b = windFieldAt(3.5, cfg);
  check('field: deterministic (same t,cfg => same sample)', a.x === b.x && a.z === b.z && a.gust === b.gust);
  check('field: a different time gives a different gust', windFieldAt(3.5, cfg).gust !== windFieldAt(8.1, cfg).gust);

  let withinBand = true, unitDir = true, normScalars = true, finiteAll = true;
  for (let t = 0; t <= 120; t += 0.37) {
    const s = windFieldAt(t, cfg);
    const span = cfg.baseStrength + cfg.gustRange;
    if (s.magnitude < cfg.baseStrength - 1e-9 || s.magnitude > span + 1e-9) withinBand = false;
    if (!isUnit(s.dirX, s.dirZ)) unitDir = false;
    if (s.gust < 0 || s.gust > 1 || s.strength < 0 || s.strength > 1) normScalars = false;
    if (![s.x, s.z, s.magnitude, s.gust, s.strength].every(Number.isFinite)) finiteAll = false;
  }
  check('field: magnitude stays within [base, base+gustRange]', withinBand);
  check('field: direction is always a unit vector', unitDir);
  check('field: gust and strength are normalized to [0,1]', normScalars);
  check('field: every component finite across the sweep', finiteAll);
  check('field: vector magnitude matches |(x,z)|', approx(Math.hypot(a.x, a.z), a.magnitude));

  // --- NaN / negative safety ---------------------------------------------------
  const nan = windFieldAt(NaN, cfg);
  check('field: NaN time degrades to t=0 (finite)', Number.isFinite(nan.x) && nan.gust === windFieldAt(0, cfg).gust);
  const negCfg = { ...cfg, baseStrength: -5, gustRange: -3 };
  const neg = windFieldAt(2, negCfg);
  check('field: negative base/range clamp to 0 (magnitude 0, strength 0)', neg.magnitude === 0 && neg.strength === 0);

  // --- stateful singleton ------------------------------------------------------
  Wind.reset();
  const atZero = Wind.sample();
  check('singleton: reset() rewinds to the t=0 sample', atZero.gust === windFieldAt(0, cfg).gust);

  Wind.update(3.5);
  check('singleton: update(dt) advances to the matching pure sample', approx(Wind.gust(), windFieldAt(3.5, cfg).gust));
  check('singleton: vector() agrees with sample()', Wind.vector().x === Wind.sample().x && Wind.vector().z === Wind.sample().z);
  check('singleton: dir() is a unit vector', isUnit(Wind.dir().x, Wind.dir().z));

  Wind.reset();
  check('singleton: reset() returns to t=0 after advancing', approx(Wind.gust(), windFieldAt(0, cfg).gust));

  // accumulated small steps == one big step (clock additivity)
  Wind.reset();
  for (let i = 0; i < 10; i++) Wind.update(0.35);
  check('singleton: 10×0.35 steps == windFieldAt(3.5) (clock additivity)', approx(Wind.gust(), windFieldAt(3.5, cfg).gust));

  Wind.update(-2); // negative dt must not rewind
  check('singleton: negative dt is ignored (no rewind)', approx(Wind.gust(), windFieldAt(3.5, cfg).gust));

  // --- configure() -------------------------------------------------------------
  Wind.reset();
  Wind.configure({ baseStrength: 0, gustRange: 0 }); // dead calm
  check('singleton: configure() takes effect immediately (calm => zero magnitude)', Wind.sample().magnitude === 0);
  Wind.configure({ baseStrength: DEFAULT_WIND_CONFIG.baseStrength, gustRange: DEFAULT_WIND_CONFIG.gustRange });
  check('singleton: configure() can restore a live field', Wind.sample().magnitude > 0);
  Wind.reset();

  // --- cosmetic-only: no three.js / DOM dependency -----------------------------
  // The grounded-physics invariant depends on this module never reaching pos/velocity;
  // the cleanest structural guarantee is that it imports neither three nor the DOM.
  const fs = await import('node:fs');
  const path = await import('node:path');
  // The npm script runs `node tests/wind-tests.js` from the repo root, so resolve the
  // source against cwd (avoids `import.meta`, which eslint parses these scripts without).
  const raw = fs.readFileSync(path.resolve('src/wind.ts'), 'utf8');
  // Strip comments so the structural checks scan CODE only (the header comment names
  // these very APIs to explain their absence, which would false-positive a raw scan).
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('source: imports no three.js (cosmetic, never touches physics)', !/from\s+['"]three['"]/.test(code));
  check('source: uses no Math.random (deterministic field)', !/Math\.random/.test(code));
  check('source: uses no Date.now / new Date (resume-safe clock)', !/Date\.now|new Date/.test(code));

  console.log(`\nWind: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
