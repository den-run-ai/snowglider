// @ts-check
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
/**
 * @param {string} name
 * @param {boolean} condition
 */
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}

async function main() {
  console.log('--- snowman/test-hooks.ts ---');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
  // jsdom's DOMWindow / the test-only window flags don't line up with the strict
  // `Window` global under exactOptionalPropertyTypes, and the ambient `isInAir` /
  // `verticalVelocity` are declared `const` (readable by src, not writable on
  // globalThis). The test also flips boolean window flags (testTreeJumpingCheck,
  // testCollisionDetected) that the module under test mutates back — TS's control-flow
  // narrowing can't see those cross-boundary writes and flags the comparisons. So we
  // drive both the global object and the window through `any` views: the documented
  // seam for the test-only globals the module reads/writes (plan §3.3).
  /** @type {any} */
  const g = globalThis;
  /** @type {any} */
  const w = dom.window;
  g.window = w;
  g.document = w.document;
  // Ambient globals the jump-above-trees check reads.
  g.isInAir = false;
  g.verticalVelocity = 0;

  const { addTestHooks } = await import('../src/snowman/test-hooks.ts');

  // --- Install A: a working showGameOver (records the last reason) ---
  // '' is the "no reason yet" sentinel (kept a string so the regex .test() calls below
  // never see null; the hooks always overwrite it before each assertion).
  let lastReason = '';
  /** @type {import('../src/snowman/index.js').ShowGameOverFn} */
  const goodShowGameOver = (reason) => { lastReason = reason; };
  const pos = { x: 0, y: 5, z: 0 };
  const getTerrainHeight = () => 5;
  addTestHooks(pos, goodShowGameOver, getTerrainHeight);
  check('addTestHooks installs the three collision hooks',
    typeof w.testHooks.forceTreeCollision === 'function' &&
    typeof w.testHooks.checkTreeCollision === 'function' &&
    typeof w.testHooks.checkExtendedTerrainCollision === 'function');

  // forceTreeCollision -> success path
  check('forceTreeCollision calls showGameOver',
    w.testHooks.forceTreeCollision() === true && /hit a tree/.test(lastReason));

  // checkTreeCollision -> normal collision path (repositions snowman onto the tree)
  lastReason = '';
  const normal = w.testHooks.checkTreeCollision(12, -30);
  check('checkTreeCollision normal path detects + repositions',
    normal === true && pos.x === 12 && pos.z === -30 && /hit a tree/.test(lastReason));

  // checkTreeCollision -> jumping-test branch (window.testTreeJumpingCheck)
  lastReason = '';
  w.testTreeJumpingCheck = true;
  const jumpTest = w.testHooks.checkTreeCollision(1, -5);
  check('checkTreeCollision jumping-test branch resets flag + detects',
    jumpTest === true && w.testTreeJumpingCheck === false && /ignoring jump/.test(lastReason));

  // checkTreeCollision -> jumping high above trees returns false (no collision)
  g.isInAir = true;
  g.verticalVelocity = 5;
  pos.y = 100; // well above tree.y (getTerrainHeight=5) + 5
  const jumpHigh = w.testHooks.checkTreeCollision(0, -10);
  check('checkTreeCollision returns false when jumping high above trees', jumpHigh === false);
  g.isInAir = false;
  g.verticalVelocity = 0;

  // checkExtendedTerrainCollision -> no treePositions -> simulated collision
  lastReason = '';
  delete w.treePositions;
  check('checkExtendedTerrainCollision simulates when no trees exist',
    w.testHooks.checkExtendedTerrainCollision() === true && /extended terrain/.test(lastReason));

  // checkExtendedTerrainCollision -> trees exist but none in extended terrain (z >= -80)
  lastReason = '';
  w.treePositions = [{ x: 1, y: 2, z: -10 }];
  check('checkExtendedTerrainCollision simulates when no extended-terrain trees',
    w.testHooks.checkExtendedTerrainCollision() === true && /extended terrain/.test(lastReason));

  // checkExtendedTerrainCollision -> a tree IS in extended terrain (z < -80)
  lastReason = '';
  w.treePositions = [{ x: 7, y: 3, z: -90 }];
  const ext = w.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision uses an extended-terrain tree',
    ext === true && pos.x === 7 && pos.z === -90 && /extended terrain/.test(lastReason));

  // --- Install B: a throwing showGameOver to drive every catch/fallback path ---
  // Reinstalling reuses the existing window.testHooks object (covers the guard's
  // false branch). window.showGameOver takes precedence over the passed fn.
  w.showGameOver = () => { throw new Error('showGameOver blew up'); };
  addTestHooks(pos, () => {}, getTerrainHeight);

  w.testCollisionDetected = false;
  w.testHooks.forceTreeCollision();
  check('forceTreeCollision catch path sets testCollisionDetected', w.testCollisionDetected === true);

  w.testCollisionDetected = false;
  w.testHooks.checkTreeCollision(2, -40);
  check('checkTreeCollision catch path sets testCollisionDetected', w.testCollisionDetected === true);

  w.testCollisionDetected = false;
  w.testTreeJumpingCheck = true;
  w.testHooks.checkTreeCollision(2, -40);
  check('checkTreeCollision jumping-test catch path sets testCollisionDetected', w.testCollisionDetected === true);

  w.testCollisionDetected = false;
  delete w.treePositions;
  w.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (no trees) catch path sets testCollisionDetected', w.testCollisionDetected === true);

  w.testCollisionDetected = false;
  w.treePositions = [{ x: 1, y: 2, z: -10 }];
  w.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (no extended trees) catch path sets testCollisionDetected', w.testCollisionDetected === true);

  w.testCollisionDetected = false;
  w.treePositions = [{ x: 7, y: 3, z: -90 }];
  w.testHooks.checkExtendedTerrainCollision();
  check('checkExtendedTerrainCollision (extended tree) catch path sets testCollisionDetected', w.testCollisionDetected === true);

  console.log(`\nTEST-HOOKS TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('test-hooks test crashed:', err);
  process.exit(1);
});
