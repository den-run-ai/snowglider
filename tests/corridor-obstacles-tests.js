// @ts-check
/**
 * Unit tests for D3.2c obstacle corridor-keying — the collision-hazard rule that keeps
 * the run navigable (mountains/rocks.ts `rockIsCollisionHazard`). It's a pure function
 * of (x, z, size) that reads the run's active centerline, so the cleared collidable
 * corridor follows the winding line for Black and collapses to today's centered ±5
 * corridor for the straight tiers.
 *
 * Pins the contracts D3.2c promises:
 *   - NO active line ⇒ clearance is centered on x=0 exactly as today (Bunny/Blue).
 *   - active line ⇒ the cleared corridor FOLLOWS the line: a rock ON the line is never a
 *     hazard (corridor passable), a rock well OFF the line is (running straight is punishing).
 *   - the on-line corridor is clear of collidable rocks for the whole winding run.
 *   - the rock-gate pinch offset sits OUTSIDE the cleared corridor (so pinches frame the
 *     line without blocking it).
 *
 * Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/corridor-obstacles-tests.js
 */

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e instanceof Error ? e.message : String(e)}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  const { rockIsCollisionHazard, rockCollisionRadius, ROCK_COLLISION_MIN_SIZE } =
    await import('../src/mountains/rocks.js');
  const { Trees } = await import('../src/mountains/trees.js');
  const { courseLineFor, setActiveCourseLine } = await import('../src/course-line.js');
  const { getDifficultyConfig } = await import('../src/difficulty.js');

  console.log('\n🪨  SNOWGLIDER CORRIDOR-OBSTACLE TESTS (D3.2c) 🪨');
  console.log('================================================\n');

  const black = getDifficultyConfig('black');
  const line = courseLineFor(black);
  // z column clear of the spawn pocket (around x=0, z=-15) where the line winds.
  const zSamples = [];
  for (let z = -40; z >= -190; z -= 5) zSamples.push(z);

  const SIZE = 2.0; // a collidable rock (>= ROCK_COLLISION_MIN_SIZE)
  assert(SIZE >= ROCK_COLLISION_MIN_SIZE, 'test rock size is collidable');

  runTest('no active line ⇒ clearance centered on x=0 exactly as today (Blue guardrail)', () => {
    setActiveCourseLine(null);
    for (const z of zSamples) {
      assert(rockIsCollisionHazard(0, z, SIZE) === false, `on-center rock not a hazard at z=${z}`);
      assert(rockIsCollisionHazard(12, z, SIZE) === true, `off-center rock IS a hazard at z=${z}`);
      assert(rockIsCollisionHazard(-12, z, SIZE) === true, `off-center(-) rock IS a hazard at z=${z}`);
    }
  });

  runTest('sub-minimum rocks are never hazards (decorative), with or without a line', () => {
    setActiveCourseLine(null);
    assert(rockIsCollisionHazard(12, -90, ROCK_COLLISION_MIN_SIZE - 0.01) === false, 'tiny rock decorative');
    setActiveCourseLine(line);
    assert(rockIsCollisionHazard(line.laneX(-90) + 12, -90, ROCK_COLLISION_MIN_SIZE - 0.01) === false, 'tiny rock decorative (line)');
  });

  runTest('active line ⇒ the cleared corridor FOLLOWS the line (on-line clear, off-line hazard)', () => {
    setActiveCourseLine(line);
    for (const z of zSamples) {
      const cx = line.laneX(z);
      assert(rockIsCollisionHazard(cx, z, SIZE) === false, `on-line rock not a hazard at z=${z}`);
      assert(rockIsCollisionHazard(cx + 12, z, SIZE) === true, `off-line(+) rock IS a hazard at z=${z}`);
      assert(rockIsCollisionHazard(cx - 12, z, SIZE) === true, `off-line(-) rock IS a hazard at z=${z}`);
    }
  });

  runTest('corridor passability: the whole on-line corridor is clear of collidable rocks', () => {
    setActiveCourseLine(line);
    for (const z of zSamples) {
      const cx = line.laneX(z);
      // Anywhere within the ±5 collidable corridor of the line is never a hazard, any size.
      for (const dx of [-4, -2, 0, 2, 4]) {
        for (const size of [1.5, 2.5, 3.5]) {
          assert(rockIsCollisionHazard(cx + dx, z, size) === false,
            `corridor clear at dx=${dx}, size=${size}, z=${z}`);
        }
      }
    }
  });

  runTest('rock-gate pinch offset (8) sits OUTSIDE the cleared corridor (frames, not blocks)', () => {
    // PINCH_EDGE = 8 in rocks.ts. For a pinch rock (size 2.2) the clearance is
    // PATH_HALF_WIDTH(5) + rockCollisionRadius(2.2); 8 must exceed it so the on-line path
    // stays open while the pinch rock is a real hazard if you drift wide.
    const PINCH_EDGE = 8;
    const PINCH_SIZE = 2.2;
    const clearance = 5 + rockCollisionRadius(PINCH_SIZE);
    assert(PINCH_EDGE > clearance, `pinch edge ${PINCH_EDGE} clears corridor ${clearance.toFixed(2)}`);
    setActiveCourseLine(line);
    for (const pz of [-42, -78, -126, -168]) {
      const cx = line.laneX(pz);
      assert(rockIsCollisionHazard(cx + PINCH_EDGE, pz, PINCH_SIZE) === true, `+pinch is a hazard at z=${pz}`);
      assert(rockIsCollisionHazard(cx - PINCH_EDGE, pz, PINCH_SIZE) === true, `-pinch is a hazard at z=${pz}`);
      assert(rockIsCollisionHazard(cx, pz, PINCH_SIZE) === false, `line between the pinch stays clear at z=${pz}`);
    }
  });

  runTest('tree corridor lane: no active line ⇒ nothing culled (Bunny/Blue byte-identical)', () => {
    setActiveCourseLine(null);
    for (const z of zSamples) {
      for (const x of [0, 3, 6, 12, -12]) {
        assert(Trees.treeInCorridorLane(x, z) === false, `no line ⇒ never in-lane at x=${x}, z=${z}`);
      }
    }
  });

  runTest('tree corridor lane: culls within PERPENDICULAR clearance of the winding line', () => {
    setActiveCourseLine(line);
    for (const z of zSamples) {
      const cx = line.laneX(z);
      // |tangent.z| = 1/sqrt(1+slope^2): 1 on straight sections, < 1 where the line turns. The
      // horizontal edge of the 3u perpendicular clearance is therefore 3 / |tangent.z|.
      const tz = Math.abs(line.tangent(z).z);
      const edge = 3 / tz;
      assert(Trees.treeInCorridorLane(cx, z) === true, `on-line tree culled at z=${z}`);
      assert(Trees.treeInCorridorLane(cx + edge - 0.4, z) === true,
        `inside perp clearance culled at z=${z} (|tz|=${tz.toFixed(2)})`);
      assert(Trees.treeInCorridorLane(cx + edge + 0.4, z) === false,
        `outside perp clearance kept at z=${z} (|tz|=${tz.toFixed(2)})`);
    }
  });

  runTest('tree corridor lane: clearance widens on steep turns (perpendicular, regression)', () => {
    // The naive horizontal `|x-lane| < 3` left a tree 3u to the side of a steep turn only ~1.6u
    // from the actual path — inside the 2.5u collision radius. Measuring perpendicular to the
    // curve culls it. Find the steepest sampled section (smallest |tangent.z|) and prove it.
    setActiveCourseLine(line);
    let steepZ = zSamples[0], minTz = 1;
    for (const z of zSamples) {
      const tz = Math.abs(line.tangent(z).z);
      if (tz < minTz) { minTz = tz; steepZ = z; }
    }
    assert(minTz < 0.9, `the Black line has a genuinely steep section (min |tangent.z|=${minTz.toFixed(3)})`);
    const cx = line.laneX(steepZ);
    assert(Trees.treeInCorridorLane(cx + 3, steepZ) === true,
      `steep-turn tree at +3 horizontal culled (perp ${(3 * minTz).toFixed(2)}u < 3) at z=${steepZ}`);
  });

  setActiveCourseLine(null); // leave clean for any later importer

  console.log('\n================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
