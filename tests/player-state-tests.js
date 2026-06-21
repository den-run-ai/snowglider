/**
 * Unit tests for the typed player-physics state layer (src/player-state.ts, PR 3.21).
 *
 * Exercises the REAL Physics module against the REAL snowman.ts kernel to lock
 * the createPlayerState / resetPlayer / stepPlayer contract:
 *   - createPlayerState seeds the documented initial run state
 *   - resetPlayer restores the start-of-run state, mutating pos/velocity in place
 *   - stepPlayer keeps pos/velocity identity, writes the result's scalars back,
 *     and returns the per-frame result
 *   - coasting advances downhill (smoke test that the kernel is wired correctly)
 *
 * Run with the .js -> .ts resolve hook so player-state.ts's `import './snowman.js'`
 * maps to snowman.ts (Node strips the erasable types natively):
 *   node --import ./tests/loaders/register-ts-resolve.mjs tests/player-state-tests.js
 */

// Deterministic hill, mirroring the physics-invariant harness (no per-vertex noise).
function getTerrainHeight(x, z) {
  let y = 40 * Math.exp(-Math.sqrt(x * x + z * z) / 40);
  if (z < -30) y += (z + 30) * 0.12;
  return y;
}
function getTerrainGradient(x, z) {
  const eps = 0.1, h = getTerrainHeight(x, z);
  return { x: (getTerrainHeight(x + eps, z) - h) / eps, z: (getTerrainHeight(x, z + eps) - h) / eps };
}
function getDownhillDirection(x, z) {
  const g = getTerrainGradient(x, z);
  const d = { x: -g.x, z: -g.z };
  const len = Math.sqrt(d.x * d.x + d.z * d.z);
  return len ? { x: d.x / len, z: d.z / len } : { x: 0, z: 1 };
}

// snowman.ts reads window.location.search / window.treeCollisionRadius for its
// debug-logging + test-hook paths; provide the same minimal stub the harness uses.
global.window = global.window || { location: { search: '' } };

// Minimal THREE-free stand-ins for the Object3D the kernel mutates.
function fakeVec() {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
}
function fakeSnowman() {
  const ski = () => ({ position: fakeVec(), rotation: fakeVec() });
  const rotation = fakeVec(); rotation.y = Math.PI;
  return {
    position: fakeVec(),
    rotation,
    userData: {
      targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
      leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1
    }
  };
}
const cameraManager = { initialize() {} };
const NONE = { left: false, right: false, up: false, down: false, jump: false };

function stepDeps(snowman) {
  return {
    snowman, delta: 1 / 60, controls: NONE,
    getTerrainHeight, getTerrainGradient, getDownhillDirection,
    treePositions: [], rockPositions: [], gameActive: false, showGameOver() {}
  };
}

let pass = 0, fail = 0;
function runTest(name, fn) {
  try { fn(); console.log(`✅ PASS: ${name}`); pass++; }
  catch (e) { console.log(`❌ FAIL: ${name}\n   ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  const { Physics } = await import('../src/player-state.js');

  console.log('\n🏂 SNOWGLIDER PLAYER STATE TESTS (player-state.ts) 🏂');
  console.log('================================================\n');

  runTest('createPlayerState seeds the documented initial state', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    assert(p.pos.x === 0 && p.pos.z === -40, 'pos starts at (0,-40)');
    assert(p.pos.y === getTerrainHeight(0, -40), 'pos.y seeded from terrain');
    assert(p.velocity.x === 0 && p.velocity.z === 0, 'velocity starts at rest');
    assert(p.isInAir === false && p.verticalVelocity === 0, 'grounded, no vertical velocity');
    assert(p.jumpCooldown === 0 && p.airTime === 0 && p.lastTerrainHeight === 0, 'no jump cooldown / air time');
    assert(p.turnPhase === 0 && p.currentTurnDirection === 0 && p.turnChangeCooldown === 0, 'auto-turn cleared');
  });

  runTest('resetPlayer restores the start-of-run state in place', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    const posRef = p.pos, velRef = p.velocity;
    // Dirty every field.
    p.pos.x = 99; p.pos.z = -150; p.velocity.x = 7; p.velocity.z = -20;
    p.isInAir = true; p.verticalVelocity = 5; p.jumpCooldown = 1; p.airTime = 2;
    p.turnPhase = 9; p.currentTurnDirection = 1; p.turnChangeCooldown = 0.2;

    Physics.resetPlayer(p, fakeSnowman(), getTerrainHeight, cameraManager);

    assert(p.pos === posRef && p.velocity === velRef, 'pos/velocity reset in place (same identity)');
    assert(p.pos.x === 0 && p.pos.z === -15, 'reset to start (0,-15)');
    assert(p.velocity.x === 0 && p.velocity.z === -3, 'reset to initial gentle downhill velocity');
    assert(p.lastTerrainHeight === getTerrainHeight(0, -15), 'lastTerrainHeight seeded from start terrain');
    assert(p.isInAir === false && p.verticalVelocity === 0 && p.jumpCooldown === 0 && p.airTime === 0, 'air state cleared');
    assert(p.turnPhase === 0 && p.currentTurnDirection === 0 && p.turnChangeCooldown === 3.0, 'auto-turn reset (3s cooldown)');
  });

  runTest('stepPlayer keeps state identity and writes scalars back', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    Physics.resetPlayer(p, fakeSnowman(), getTerrainHeight, cameraManager);
    const posRef = p.pos, velRef = p.velocity;

    const result = Physics.stepPlayer(p, stepDeps(fakeSnowman()));

    assert(p.pos === posRef && p.velocity === velRef, 'state objects mutated in place, not replaced');
    assert(typeof result.currentSpeed === 'number', 'returns the per-frame result (currentSpeed)');
    // Scalars are written back from the result (single source of truth).
    assert(p.isInAir === result.isInAir, 'isInAir written back from result');
    assert(p.verticalVelocity === result.verticalVelocity, 'verticalVelocity written back');
    assert(p.lastTerrainHeight === result.lastTerrainHeight, 'lastTerrainHeight written back');
    assert(p.airTime === result.airTime, 'airTime written back');
    assert(p.jumpCooldown === result.jumpCooldown, 'jumpCooldown written back');
    assert(p.turnPhase === result.turnPhase, 'turnPhase written back');
    assert(p.currentTurnDirection === result.currentTurnDirection, 'currentTurnDirection written back');
    assert(p.turnChangeCooldown === result.turnChangeCooldown, 'turnChangeCooldown written back');
  });

  runTest('coasting advances downhill (kernel wired correctly)', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    Physics.resetPlayer(p, fakeSnowman(), getTerrainHeight, cameraManager);
    const startZ = p.pos.z;
    const snowman = fakeSnowman();
    for (let i = 0; i < 120; i++) Physics.stepPlayer(p, stepDeps(snowman));
    assert(p.pos.z < startZ, 'snowman moved downhill (-Z) under gravity');
    assert(Math.sqrt(p.velocity.x * p.velocity.x + p.velocity.z * p.velocity.z) > 0, 'picked up speed');
  });

  runTest('rock collision ends the run with a rock-specific reason', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    p.pos.x = 4;
    p.pos.z = -60;
    p.pos.y = getTerrainHeight(p.pos.x, p.pos.z);
    p.velocity.x = 0;
    p.velocity.z = 0;
    const rock = { x: p.pos.x, y: p.pos.y, z: p.pos.z, size: 1.5 };
    let reason = '';

    Physics.stepPlayer(p, {
      ...stepDeps(fakeSnowman()),
      rockPositions: [rock],
      gameActive: true,
      showGameOver(nextReason) { reason = nextReason; }
    });

    assert(reason === 'BANG!!! You hit a rock!', `expected rock crash reason, got "${reason}"`);
  });

  runTest('jumping high enough clears a rock hazard', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    p.pos.x = -3;
    p.pos.z = -70;
    const terrainY = getTerrainHeight(p.pos.x, p.pos.z);
    p.pos.y = terrainY + 2.0;
    p.velocity.x = 0;
    p.velocity.z = 0;
    p.isInAir = true;
    p.verticalVelocity = 6;
    p.lastTerrainHeight = terrainY;
    const rock = { x: p.pos.x, y: terrainY, z: p.pos.z, size: 1.5 };
    let reason = '';

    Physics.stepPlayer(p, {
      ...stepDeps(fakeSnowman()),
      rockPositions: [rock],
      gameActive: true,
      showGameOver(nextReason) { reason = nextReason; }
    });

    assert(reason === '', `expected jump clearance with no crash, got "${reason}"`);
  });

  runTest('a descending jump still clears a rock while above it', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    p.pos.x = -3;
    p.pos.z = -70;
    const terrainY = getTerrainHeight(p.pos.x, p.pos.z);
    p.pos.y = terrainY + 3.0;
    p.velocity.x = 0;
    p.velocity.z = 0;
    p.isInAir = true;
    p.verticalVelocity = -3; // past the apex, descending but still well above the rock
    p.lastTerrainHeight = terrainY;
    const rock = { x: p.pos.x, y: terrainY, z: p.pos.z, size: 1.5 };
    let reason = '';

    Physics.stepPlayer(p, {
      ...stepDeps(fakeSnowman()),
      rockPositions: [rock],
      gameActive: true,
      showGameOver(nextReason) { reason = nextReason; }
    });

    assert(reason === '', `expected descending-jump clearance with no crash, got "${reason}"`);
  });

  // Meaningful jumps (#47): a manual jump that lands on the same frame the player
  // crosses the finish must have its air score banked BEFORE the kernel's synchronous
  // finish check fires showGameOver (which builds the result screen). Guards the codex
  // P2 finding — without the in-step bankAirScore call the last jump would be missing
  // from the result. We assert the call ORDER (bank then finish), not just that both ran.
  runTest('air score banks before the finish check (finish-frame jump still counts)', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    const snowman = fakeSnowman();
    snowman.userData.playerJump = true;             // this air phase is a manual jump
    p.pos.x = 0;
    p.pos.z = -194.9;                               // one step above the finish (z < -195)
    p.pos.y = getTerrainHeight(0, p.pos.z) - 0.01;  // just below terrain => lands this frame
    p.velocity.x = 0;
    p.velocity.z = -22;                             // crosses the line this frame; aligned => CLEAN
    p.isInAir = true;
    p.verticalVelocity = 0;
    p.airTime = 1.5;                                // => airScoreDelta > 0
    p.lastTerrainHeight = getTerrainHeight(0, p.pos.z);

    const calls = [];
    let banked = 0;
    Physics.stepPlayer(p, {
      ...stepDeps(snowman),
      gameActive: true,
      bankAirScore(delta) { banked = delta; calls.push('bank'); },
      showGameOver(reason) { calls.push('finish:' + reason); }
    });

    assert(banked > 0, `expected a positive banked air score, got ${banked}`);
    assert(calls[0] === 'bank', `air score must bank before the finish; order was ${JSON.stringify(calls)}`);
    assert(calls.some(c => c.indexOf('finish:You reached the end') === 0),
      `expected the finish to fire this frame; calls were ${JSON.stringify(calls)}`);
  });

  // The same flag-gating must hold the other way: a NON-manual landing (playerJump
  // false) never banks an air score, even on the finish frame.
  runTest('a non-manual landing banks no air score', () => {
    const p = Physics.createPlayerState(getTerrainHeight);
    const snowman = fakeSnowman();
    snowman.userData.playerJump = false;            // auto-jump / hop landing
    p.pos.x = 0;
    p.pos.z = -70;
    p.pos.y = getTerrainHeight(0, p.pos.z) - 0.01;  // lands this frame
    p.velocity.x = 0;
    p.velocity.z = -16;
    p.isInAir = true;
    p.airTime = 1.5;
    p.lastTerrainHeight = getTerrainHeight(0, p.pos.z);

    let banked = 0;
    const result = Physics.stepPlayer(p, {
      ...stepDeps(snowman),
      bankAirScore(delta) { banked += delta; }
    });

    assert(banked === 0, `non-manual landing must not bank air score, banked ${banked}`);
    assert(result.landingQuality === null && result.airScoreDelta === 0, 'no grade / score on a non-manual landing');
  });

  console.log('\n================================================');
  console.log(`Tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
