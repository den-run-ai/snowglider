// test-hooks-tests.js
// Headless, c8-instrumented coverage for src/snowman/test-hooks.ts — the collision
// test hooks (forceTreeCollision / checkTreeCollision / checkExtendedTerrainCollision)
// that the browser collision suites install on window.testHooks.
//
// The browser suites only call a couple of these hooks on the happy path, leaving the
// jump-above-trees branch, the extended-terrain branches, and every showGameOver
// failure (catch) path uncovered on Codecov. We import the REAL module and drive each
// hook directly under jsdom. The module's only import is type-only, so it loads with
// no runtime dependencies; `isInAir` / `verticalVelocity` are ambient globals it reads,
// so we define them on `global` before calling the hooks.

'use strict';

const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  console.log('--- snowman/test-hooks.ts ---');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  global.window = dom.window;
  global.document = dom.window.document;
  // Ambient globals the jump-above-trees check reads.
  global.isInAir = false;
  global.verticalVelocity = 0;

  const { addTestHooks } = await import('../src/snowman/test-hooks.ts');

  // --- Install A: a working showGameOver (records the last reason) ---
  let lastReason = null;
  const goodShowGameOver = (reason) => { lastReason = reason; };
  const pos = { x: 0, y: 5, z: 0 };
  const getTerrainHeight = () => 5;
  addTestHooks(pos, goodShowGameOver, getTerrainHeight);
  check('addTestHooks installs the three collision hooks',
    typeof dom.window.testHooks.forceTreeCollision === 'function' &&
    typeof dom.window.testHooks.checkTreeCollision === 'function' &&
    typeof dom.window.testHooks.checkExtendedTerrainCollision === 'function');

  // forceTreeCollision -> success path
  check('forceTreeCollision calls showGameOver',
    dom.window.testHooks.forceTreeCollision() === true && /hit a tree/.test(lastReason));

  // checkTreeCollision -> normal collision path (repositions snowman onto the tree)
  lastReason = null;
  const normal = dom.window.testHooks.checkTreeCollision(12, -30);
  check('checkTreeCollision normal path detects + repositions',
    normal === true && pos.x === 12 && pos.z === -30 && /hit a tree/.test(lastReason));

  // checkTreeCollision -> jumping-test branch (window.testTreeJumpingCheck)
  lastReason = null;
  dom.window.testTreeJumpingCheck = true;
  const jumpTest = dom.window.testHooks.checkTreeCollision(1, -5);
  check('checkTreeCollision jumping-test branch resets flag + detects',
    jumpTest === true && dom.window.testTreeJumpingCheck === false && /ignoring jump/.test(lastReason));

  // checkTreeCollision -> jumping high above trees returns false (no collision)
  global.isInAir = true;
  global.verticalVelocity = 5;
  pos.y = 100; // well above tree.y (getTerrainHeight=5) + 5
  const jumpHigh = dom.window.testHooks.checkTreeCollision(0, -10);
  check('checkTreeCollision returns false when jumping high above trees', jumpHigh === false);
  global.isInAir = false;
  global.verticalVelocity = 0;

  // checkExtendedTerrainCollision -> no treePositions -> simulated collision
  lastReason = null;
  delete dom.window.treePositions;
  check('checkExtendedTerrainCollision simulates when no trees exist',
    dom.window.testHooks.checkExtendedTerrainCollision() === true && /extended terrain/.test(lastReason));

  // checkExtendedTerrainCollision -> trees exist but none in extended terrain (z >= -80)
  lastReason = null;
  dom.window.treePositions = [{ x: 1, y: 2, z: -10 }];
  check('checkExtendedTerrainCollision simulates when no extended-terrain trees',
    dom.window.testHooks.checkExtendedTerrainCollision() === true && /extended terrain/.test(lastReason));

  // checkExtendedTerrainCollision -> a tree IS in extended terrain (z < -80)
  lastReason = null;
  dom.window.treePositions = [{ x: 7, y: 3, z: -90 }];
  const ext = dom.window.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision uses an extended-terrain tree',
    ext === true && pos.x === 7 && pos.z === -90 && /extended terrain/.test(lastReason));

  // --- Install B: a throwing showGameOver to drive every catch/fallback path ---
  // Reinstalling reuses the existing window.testHooks object (covers the guard's
  // false branch). window.showGameOver takes precedence over the passed fn.
  dom.window.showGameOver = () => { throw new Error('showGameOver blew up'); };
  addTestHooks(pos, () => {}, getTerrainHeight);

  dom.window.testCollisionDetected = false;
  dom.window.testHooks.forceTreeCollision();
  check('forceTreeCollision catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  dom.window.testCollisionDetected = false;
  dom.window.testHooks.checkTreeCollision(2, -40);
  check('checkTreeCollision catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  dom.window.testCollisionDetected = false;
  dom.window.testTreeJumpingCheck = true;
  dom.window.testHooks.checkTreeCollision(2, -40);
  check('checkTreeCollision jumping-test catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  dom.window.testCollisionDetected = false;
  delete dom.window.treePositions;
  dom.window.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (no trees) catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  dom.window.testCollisionDetected = false;
  dom.window.treePositions = [{ x: 1, y: 2, z: -10 }];
  dom.window.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (no extended trees) catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  dom.window.testCollisionDetected = false;
  dom.window.treePositions = [{ x: 7, y: 3, z: -90 }];
  dom.window.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (extended tree) catch path sets testCollisionDetected', dom.window.testCollisionDetected === true);

  console.log(`\nTEST-HOOKS TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('test-hooks test crashed:', err);
  process.exit(1);
});
