// @ts-check
/**
 * Tree jump-over collision regression tests (headless, against the REAL module).
 *
 * Guards the fix for "jump over a tree and land clear of the trunk" on black/expert
 * lines: the tree clearance must be HEIGHT-BASED ONLY (airborne + high enough above
 * the tree base), NOT gated on upward motion. Requiring verticalVelocity > 0 meant a
 * tree could only be cleared on the way UP, so any jump whose descending arc still
 * overlapped the trunk radius crashed even while the snowman was well above the tree
 * — exactly the case a player sees after the jump apex, coming down away from the
 * trunk. Mirrors the rock clearance in collision.ts.
 *
 * Exercises the actual detectCollisionsAndFinish from src/snowman/collision.ts
 * (the ts-resolve loader maps the `.js` specifier to the `.ts` source).
 */

// Minimal window shim: collision.ts reads window.location.search (kept free of
// "test" so we hit the real production path, not the test-mode shortcuts) and the
// optional window.treeCollisionRadius override (left unset => default 2.5).
globalThis.window = /** @type {any} */ ({ location: { search: '' } });

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`✅ PASS: ${name}`); }
  else { failed++; console.log(`❌ FAIL: ${name}`); }
}

async function run() {
  console.log('\n🏂 SNOWGLIDER TREE JUMP-OVER COLLISION TESTS 🏂');
  console.log('================================================\n');

  const { detectCollisionsAndFinish } = await import('../src/snowman/collision.js');

  // Constant terrain at height 0; one tree at the origin (base y = 0). A tree is
  // cleared once pos.y > tree.y + 5, i.e. above y = 5.
  const tree = { x: 0, y: 0, z: 0, scale: 1 };

  /**
   * Run one collision frame and report whether it ended the run (and why).
   * The clearance is intentionally height-based only (the fix), so collision.ts no
   * longer takes verticalVelocity — the rising/descending framing below is about the
   * PHYSICAL frame being modelled (before vs after the jump apex), which the clearance
   * no longer distinguishes. That is exactly what these cases prove.
   * @param {{x:number,y:number,z:number}} pos
   * @param {boolean} isInAir
   */
  function frame(pos, isInAir) {
    /** @type {string|null} */
    let reason = null;
    detectCollisionsAndFinish({
      pos,
      isInAir,
      terrainHeightAtPosition: 0,
      treePositions: [tree],
      rockPositions: [],
      gameActive: true,
      showGameOver: (r) => { reason = r; }
    });
    return reason;
  }

  /**
   * Like frame(), but also captures this frame's airborne obstacle clears (JP-2).
   * @param {{x:number,y:number,z:number}} pos
   * @param {boolean} isInAir
   */
  function frameWithClears(pos, isInAir) {
    /** @type {string|null} */
    let reason = null;
    /** @type {{type:string,key:string}[]} */
    let clears = [];
    detectCollisionsAndFinish({
      pos,
      isInAir,
      terrainHeightAtPosition: 0,
      treePositions: [tree],
      rockPositions: [],
      gameActive: true,
      showGameOver: (r) => { reason = r; },
      onObstaclesCleared: (c) => { clears = clears.concat(c); }
    });
    return { reason, clears };
  }

  // Player horizontally inside the trunk radius (dist 1 < 2.5) for the airborne cases.
  const inside = (y) => ({ x: 1, y, z: 0 });

  // 1) The bug repro: a DESCENDING (post-apex) frame high above the tree, overlapping
  //    the trunk radius. Must clear — under the old verticalVelocity > 0 gate this
  //    crashed; height-based clearance lets it sail over.
  check('high above the tree while descending clears it (no crash)',
    frame(inside(10), true) === null);

  // 2) A rising (pre-apex) frame high above the tree also clears it (unchanged).
  check('high above the tree while rising clears it (no crash)',
    frame(inside(10), true) === null);

  // 3) Airborne but BELOW the clearance height (y < tree.y + 5) while overlapping the
  //    trunk radius: that is clipping the tree, so it still crashes.
  check('airborne but too low over the trunk still crashes',
    /tree/i.test(String(frame(inside(3), true))));

  // 4) On the ground, overlapping the trunk radius: crash (grounded hit).
  check('grounded inside the trunk radius crashes',
    /tree/i.test(String(frame(inside(0), false))));

  // 5) Landing AWAY from the trunk (dist 3 > 2.5 radius), descending onto the terrain:
  //    no tree collision — the core "land clear of the trunk" guarantee.
  check('descending clear of the trunk radius does not crash',
    frame({ x: 3, y: 0, z: 0 }, false) === null);

  // --- Exact-center clearance (#398) -------------------------------------------
  // The exact x/z match used to return a hit BEFORE the airborne clearance check,
  // so a jump arcing directly over the trunk center crashed despite clearing the
  // tree — the one horizontal line the height-based clearance didn't cover.

  // 6) Directly above the trunk center, airborne and high: clears (old code crashed).
  const overCenter = frameWithClears({ x: 0, y: 10, z: 0 }, true);
  check('exact-center pass high above the tree clears it (no crash)',
    overCenter.reason === null);

  // 7) ... and the suppressed pass is a scored clear, recorded exactly once.
  check('exact-center airborne clear is recorded once (JP-2)',
    overCenter.clears.length === 1 &&
    overCenter.clears[0]?.type === 'tree' && overCenter.clears[0]?.key === 't0');

  // 8) Exact-center but airborne BELOW the clearance height: still a crash.
  check('exact-center airborne but too low still crashes',
    /tree/i.test(String(frame({ x: 0, y: 3, z: 0 }, true))));

  // 9) Exact-center on the ground: still a crash (the direct-hit fast path).
  check('exact-center grounded hit still crashes',
    /tree/i.test(String(frame({ x: 0, y: 0, z: 0 }, false))));

  console.log('\n================================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
