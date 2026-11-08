// @ts-check
/**
 * Unit tests for the descent centerline (src/course-line.ts) — the single seeded
 * source of truth every difficulty consumer reads for "where is the safe line?".
 *
 * The module is plain-number Catmull-Rom over seed-jittered control points (no THREE,
 * no DOM), so the whole thing runs headlessly here. Covers the contracts the later
 * D3.2 sub-PRs (terrain corridor / gates / obstacles / winnability) depend on:
 *   - Blue + Bunny are STRAIGHT: laneX ≡ 0, tangent ≡ (0,-1), heading ≡ 0 — the
 *     byte-identical guarantee for the classic course.
 *   - Black actually winds (a left/right serpentine), but stays bounded to ±amplitude.
 *   - the line is pinned to x=0 at the start + finish gates.
 *   - it is deterministic for a fixed seed and seed-sensitive (so seed 1003 ⇒ one
 *     shared Black course, and a different seed is a different course).
 *   - the lane span still matches the shipped course geometry (no silent drift).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/course-line-tests.js
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
  const CL = await import('../src/course-line.js');
  const D = await import('../src/difficulty.js');
  const { FINISH_Z } = await import('../src/snowman/collision.js');
  const {
    createCourseLine, courseLineFor, LANE_Z_TOP, LANE_Z_BOTTOM,
    setActiveCourseLine, getActiveCourseLine, activeLaneX,
  } = CL;

  console.log('\n🎿 SNOWGLIDER COURSE-LINE TESTS (course-line.ts) 🎿');
  console.log('==================================================\n');

  // A dense column of sample depths spanning the run (and a little past each end).
  const zSamples = [];
  for (let z = LANE_Z_TOP + 5; z >= LANE_Z_BOTTOM - 5; z -= 2) zSamples.push(z);

  const blue = courseLineFor(D.getDifficultyConfig('blue'));
  const bunny = courseLineFor(D.getDifficultyConfig('bunny'));
  const black = courseLineFor(D.getDifficultyConfig('black'));
  const blackParams = D.getDifficultyConfig('black').line;

  runTest('lane span matches the shipped course (no silent drift)', () => {
    // LANE_Z_TOP mirrors course.ts START_Z (-15) and LANE_Z_BOTTOM mirrors the finish.
    assert(LANE_Z_TOP === -15, `LANE_Z_TOP ${LANE_Z_TOP} !== course START_Z (-15)`);
    assert(LANE_Z_BOTTOM === FINISH_Z, `LANE_Z_BOTTOM ${LANE_Z_BOTTOM} !== collision FINISH_Z ${FINISH_Z}`);
  });

  runTest('Blue is straight: laneX ≡ 0, tangent ≡ (0,-1), heading ≡ 0', () => {
    assert(blue.controlsX.every((x) => x === 0), 'Blue control points are all 0');
    for (const z of zSamples) {
      assert(Object.is(blue.laneX(z), 0), `Blue laneX(${z}) is exactly 0`);
      const t = blue.tangent(z);
      assert(t.x === 0 && t.z === -1, `Blue tangent(${z}) is (0,-1)`);
      assert(blue.heading(z) === 0, `Blue heading(${z}) is 0`);
    }
  });

  runTest('Bunny is straight too (easy tier keeps the fall line)', () => {
    for (const z of zSamples) assert(Object.is(bunny.laneX(z), 0), `Bunny laneX(${z}) is exactly 0`);
  });

  runTest('Black winds: a left/right serpentine away from center', () => {
    let maxAbs = 0, signChanges = 0, prevSign = 0;
    for (const z of zSamples) {
      const x = black.laneX(z);
      maxAbs = Math.max(maxAbs, Math.abs(x));
      const s = Math.sign(x);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) signChanges++;
      if (s !== 0) prevSign = s;
    }
    assert(maxAbs > 1, `Black actually leaves center (max |laneX| = ${maxAbs.toFixed(2)})`);
    assert(signChanges >= 2, `Black crosses the fall line repeatedly (sign changes = ${signChanges})`);
  });

  runTest('Black stays bounded to ±amplitude (the corridor never widens past the bound)', () => {
    for (const z of zSamples) {
      const x = black.laneX(z);
      assert(Math.abs(x) <= blackParams.amplitude + 1e-9,
        `|laneX(${z})| = ${Math.abs(x).toFixed(3)} exceeds amplitude ${blackParams.amplitude}`);
    }
  });

  runTest('the line is pinned to x=0 at the start and finish gates', () => {
    near(black.laneX(LANE_Z_TOP), 0, 1e-9, 'centered at the start gate');
    near(black.laneX(LANE_Z_BOTTOM), 0, 1e-9, 'centered at the finish gate');
  });

  runTest('Black tangent is a unit vector pointing downhill', () => {
    for (const z of zSamples) {
      const t = black.tangent(z);
      near(Math.hypot(t.x, t.z), 1, 1e-9, `unit tangent at ${z}`);
      assert(t.z < 0, `tangent points downhill (-z) at ${z}`);
    }
  });

  runTest('deterministic for a fixed seed (seed 1003 ⇒ one shared Black course)', () => {
    const a = courseLineFor(D.getDifficultyConfig('black'));
    const b = courseLineFor(D.getDifficultyConfig('black'));
    assert(a.controlsX.length === b.controlsX.length, 'same control count');
    a.controlsX.forEach((x, i) => near(x, b.controlsX[i], 0, `control ${i} identical`));
    for (const z of zSamples) near(a.laneX(z), b.laneX(z), 0, `laneX(${z}) identical across builds`);
  });

  runTest('seed-sensitive: a different seed is a different course', () => {
    const params = D.getDifficultyConfig('black').line;
    const seedA = createCourseLine({ seed: 1003, ...params });
    const seedB = createCourseLine({ seed: 1003 + 1, ...params });
    const differs = zSamples.some((z) => Math.abs(seedA.laneX(z) - seedB.laneX(z)) > 1e-6);
    assert(differs, 'changing the seed changes the line somewhere');
  });

  runTest('curviness 0 forces a straight line regardless of amplitude / control points', () => {
    const flat = createCourseLine({ seed: 1003, curviness: 0, amplitude: 30, controlPoints: 6 });
    for (const z of zSamples) assert(Object.is(flat.laneX(z), 0), `flat laneX(${z}) is exactly 0`);
  });

  // --- Active-line registry (the run's shared centerline; D3.2c consumers read it) ---
  runTest('activeLaneX is exactly 0 with no active line (straight-tier byte-identical seam)', () => {
    setActiveCourseLine(null);
    assert(getActiveCourseLine() === null, 'no active line by default');
    for (const z of zSamples) assert(Object.is(activeLaneX(z), 0), `activeLaneX(${z}) is exactly 0`);
  });

  runTest('setActiveCourseLine wires activeLaneX to follow the line, and clears back to 0', () => {
    setActiveCourseLine(black);
    assert(getActiveCourseLine() === black, 'getActiveCourseLine returns the set line');
    for (const z of zSamples) near(activeLaneX(z), black.laneX(z), 0, `activeLaneX == line.laneX at ${z}`);
    setActiveCourseLine(null);
    for (const z of zSamples) assert(Object.is(activeLaneX(z), 0), `cleared activeLaneX(${z}) is 0`);
  });

  runTest('gate-on-line: checkpoint gate x = activeLaneX(CHECKPOINT_Z) alternates L/R', () => {
    // The shipped checkpoint depths (course.ts CHECKPOINT_Z); gates read activeLaneX here.
    const CHECKPOINT_Z = [-60, -105, -150];
    setActiveCourseLine(black);
    const xs = CHECKPOINT_Z.map((z) => activeLaneX(z));
    for (let i = 0; i < xs.length; i++) {
      assert(Math.abs(xs[i]) <= blackParams.amplitude + 1e-9, `gate ${i} within amplitude`);
    }
    // The winding line puts consecutive gates on opposite sides (a turn rhythm).
    let sawSignFlip = false;
    for (let i = 1; i < xs.length; i++) {
      if (Math.sign(xs[i]) !== 0 && Math.sign(xs[i - 1]) !== 0 && Math.sign(xs[i]) !== Math.sign(xs[i - 1])) {
        sawSignFlip = true;
      }
    }
    assert(sawSignFlip, `gates alternate sides (xs = ${xs.map((v) => v.toFixed(1)).join(', ')})`);
    setActiveCourseLine(null); // leave clean for any later importer
  });

  console.log('\n==================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
