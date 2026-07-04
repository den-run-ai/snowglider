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
   * @param {{x:number,y:number,z:number}} pos
   * @param {boolean} isInAir
   * @param {number} verticalVelocity
   */
  function frame(pos, isInAir, verticalVelocity) {
    let reason = null;
    detectCollisionsAndFinish({
      pos,
      isInAir,
      verticalVelocity,
      terrainHeightAtPosition: 0,
      treePositions: [tree],
      rockPositions: [],
      gameActive: true,
      showGameOver: (r) => { reason = r; }
    });
    return reason;
  }

  // Player horizontally inside the trunk radius (dist 1 < 2.5) for the airborne cases.
  const inside = (y) => ({ x: 1, y, z: 0 });

  // 1) The bug repro: DESCENDING (vv < 0) but high above the tree, overlapping the
  //    trunk radius. Must clear — this is the post-apex "coming down over it" frame.
  check('descending high above the tree clears it (no crash)',
    frame(inside(10), true, -5) === null);

  // 2) Rising high above the tree also clears it (unchanged behaviour).
  check('rising high above the tree clears it (no crash)',
    frame(inside(10), true, 5) === null);

  // 3) Airborne but BELOW the clearance height (y < tree.y + 5) while overlapping the
  //    trunk radius: that is clipping the tree, so it still crashes.
  check('airborne but too low over the trunk still crashes',
    /tree/i.test(String(frame(inside(3), true, -5))));

  // 4) On the ground, overlapping the trunk radius: crash (grounded hit).
  check('grounded inside the trunk radius crashes',
    /tree/i.test(String(frame(inside(0), false, 0))));

  // 5) Landing AWAY from the trunk (dist 3 > 2.5 radius), descending onto the terrain:
  //    no tree collision — the core "land clear of the trunk" guarantee.
  check('descending clear of the trunk radius does not crash',
    frame({ x: 3, y: 0, z: 0 }, false, -5) === null);

  console.log('\n================================================');
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
