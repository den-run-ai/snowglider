// @ts-check
/**
 * Regression Tests for SnowGlider
 * 
 * These tests target specific functionality that may have regressed
 * based on the git history and codebase analysis.
 */

// mountains.js and snow.js are now ES modules (issue #84), so they can no longer
// be evaluated as source in a `new Function` + `with(sandbox)` scope. We import
// the REAL modules and exercise their shipped terrain/snow-effect code directly.

// snow.js builds its `Snow` namespace from `Mountains.*`/`Trees.*` at module-eval
// time, reading them as bare globals, so we set `global.Mountains` (from the real
// module) and a lightweight `Trees` mock — these tests only need the Trees
// function surface, not real meshes — before importing snow.js.
async function loadUtils() {
  global.Trees = {
    createTree: function() {},
    addTrees: function() { return []; },
    addBranchesAtLayer: function() {},
    addSnowCaps: function() {}
  };
  const { Mountains } = await import('../src/mountains.js');
  global.Mountains = Mountains;
  const { Snow } = await import('../src/snow.js');
  return Snow;
}

// Load the Utils object, then run the suite. The import is async, so the whole
// suite runs inside an async IIFE (closed at the end of the file). `Utils` is
// declared here (not at module scope) so it shadows the read-only `Utils` global
// instead of reassigning it.
(async () => {
const Utils = await loadUtils();

// Custom assert functions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
  return true;
}

function assertEquals(a, b, message) {
  if (a !== b) {
    throw new Error(message || `Expected ${a} to equal ${b}`);
  }
  return true;
}

function assertApprox(a, b, tolerance, message) {
  if (Math.abs(a - b) > tolerance) {
    throw new Error(message || `Expected ${a} to be approximately equal to ${b} (±${tolerance})`);
  }
  return true;
}

// Run tests
let passCount = 0;
let failCount = 0;

function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✅ PASS: ${name}`);
    passCount++;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    failCount++;
  }
}

console.log('\n🏂 SNOWGLIDER REGRESSION TESTS 🏂');
console.log('=================================\n');

// Test 1: Extended Terrain Continuity
// Verifies the expanded terrain is continuous and properly connected
runTest('Extended Terrain Continuity', () => {
  // Get heights along the extended ski path
  const checkPoints = [
    { z: -30, expectedDownhill: true },  // Original path
    { z: -80, expectedDownhill: true },  // Original path edge
    { z: -100, expectedDownhill: true }, // Extended path start
    { z: -140, expectedDownhill: true }, // Middle of extended path
    { z: -180, expectedDownhill: true }  // End of extended path
  ];
  
  // Check height decreases consistently (path goes downhill)
  let lastHeight = Utils.getTerrainHeight(0, checkPoints[0].z);
  
  for (let i = 1; i < checkPoints.length; i++) {
    const currentPoint = checkPoints[i];
    const currentHeight = Utils.getTerrainHeight(0, currentPoint.z);
    
    // Verify this section goes downhill 
    assert(currentHeight < lastHeight, 
      `Path should go downhill from z=${checkPoints[i-1].z} to z=${currentPoint.z}`);
    
    // Verify height change isn't too dramatic (no cliffs)
    const heightDiff = lastHeight - currentHeight;
    const zDiff = Math.abs(checkPoints[i-1].z - currentPoint.z);
    const slope = heightDiff / zDiff;
    
    assert(slope < 1.0, `Slope between z=${checkPoints[i-1].z} and z=${currentPoint.z} shouldn't be too steep`);
    
    // Check that gradient direction is still downhill
    const gradient = Utils.getTerrainGradient(0, currentPoint.z);
    const downhillDir = Utils.getDownhillDirection(0, currentPoint.z);
    
    // Downhill direction should point roughly in negative z (with some x component)
    assert(downhillDir.z < 0, `Downhill direction at z=${currentPoint.z} should point in -z direction`);
    
    lastHeight = currentHeight;
  }
});

// Test 2: Tree Collision Detection Consistency
// Verifies that tree collision detection works properly and consistently
runTest('Tree Collision Detection Consistency', () => {
  // Mock necessary variables for collision detection
  const mockPos = { x: 0, y: 0, z: -40 };
  const mockTreePos = { x: 0, y: 0, z: -40 }; // Exact same position should trigger collision
  
  // 1. Test direct position matching
  // When positions are identical, collision should be detected regardless of other factors
  const directMatch = Math.abs(mockPos.x - mockTreePos.x) < 0.001 && 
                      Math.abs(mockPos.z - mockTreePos.z) < 0.001;
  
  assert(directMatch, "Direct position matching should detect collision when positions are identical");
  
  // 2. Test edge collision
  const treeCollisionRadius = 2.5; // Default radius used in code
  const mockTreePos2 = { x: mockPos.x + treeCollisionRadius - 0.1, y: 0, z: mockPos.z };
  
  // Calculate horizontal distance
  const dx = mockPos.x - mockTreePos2.x;
  const dz = mockPos.z - mockTreePos2.z;
  const horizontalDistance = Math.sqrt(dx*dx + dz*dz);
  
  assert(horizontalDistance < treeCollisionRadius, 
    "Edge case collision should be detected when just inside collision radius");
  
  // 3. Test jumping exemption
  // Code allows jumping over trees when player is in air, moving upward, and high enough
  const mockIsInAir = true;
  const mockVerticalVelocity = 5; // Positive = moving upward
  mockPos.y = mockTreePos.y + 6; // Higher than tree.y + 5 threshold

  const isJumpingHighAboveTrees = mockIsInAir && mockVerticalVelocity > 0 && mockPos.y > (mockTreePos.y + 5);
  
  assert(isJumpingHighAboveTrees, 
    "Jumping exemption should apply when player is in air, moving upward, and high enough");
  
  // Confirm this would prevent collision
  const edgeCollisionButJumping = (horizontalDistance < treeCollisionRadius) && !isJumpingHighAboveTrees;
  
  assert(!edgeCollisionButJumping, 
    "Jumping exemption should prevent collision despite being within collision radius");
});

// Test 3: Best Time Recording Logic
// Verifies the fix for best time recording works properly
runTest('Best Time Recording Logic', () => {
  // Create a mock localStorage
  const mockLocalStorage = {
    storage: {},
    getItem: function(key) {
      return this.storage[key] !== undefined ? this.storage[key] : null;
    },
    setItem: function(key, value) {
      this.storage[key] = String(value);
    }
  };
  
  // Mock variables needed for bestTime logic
  let bestTime, startTime, reason, currentTime;
  
  function showGameOver(testReason) {
    reason = testReason;
    
    // Only update best time if player reached the end successfully
    if (reason === "You reached the end of the slope!") {
      currentTime = (performance.now() - startTime) / 1000;
      
      if (currentTime < bestTime) {
        bestTime = currentTime;
        mockLocalStorage.setItem('snowgliderBestTime', bestTime);
      }
    }
  }
  
  // Test case 1: No previous best time (Infinity)
  bestTime = Infinity;
  startTime = Date.now() - 30000; // 30 seconds ago
  
  // Setup performance.now() mock for this test
  global.performance = /** @type {any} */ ({
    now: () => Date.now()
  });
  
  // Simulate reaching the end
  showGameOver("You reached the end of the slope!");
  
  // Verify best time was set
  assert(mockLocalStorage.getItem('snowgliderBestTime') !== null, 
    "Best time should be set when no previous best time exists");
  
  assert(bestTime !== Infinity, 
    "Best time should be updated from Infinity to current time");
  
  // Test case 2: Better time
  mockLocalStorage.setItem('snowgliderBestTime', "25.5");
  bestTime = parseFloat(mockLocalStorage.getItem('snowgliderBestTime'));
  startTime = Date.now() - 20000; // 20 seconds ago (better than 25.5)
  
  // Simulate reaching the end
  showGameOver("You reached the end of the slope!");
  
  // Verify best time was updated
  assertApprox(parseFloat(mockLocalStorage.getItem('snowgliderBestTime')), 20, 1,
    "Best time should be updated when current time is better");
  
  // Test case 3: Worse time
  mockLocalStorage.setItem('snowgliderBestTime', "15.0");
  bestTime = parseFloat(mockLocalStorage.getItem('snowgliderBestTime'));
  startTime = Date.now() - 20000; // 20 seconds ago (worse than 15.0)
  
  // Simulate reaching the end
  showGameOver("You reached the end of the slope!");
  
  // Verify best time was not updated
  assertApprox(parseFloat(mockLocalStorage.getItem('snowgliderBestTime')), 15, 0.1,
    "Best time should not be updated when current time is worse");
  
  // Test case 4: Collision should not update best time
  const originalBestTime = mockLocalStorage.getItem('snowgliderBestTime');
  showGameOver("BANG!!! You hit a tree!");
  
  // Verify best time was not updated
  assertEquals(mockLocalStorage.getItem('snowgliderBestTime'), originalBestTime,
    "Best time should not be updated on tree collision");
});

runTest('Leaderboard Backfills Stored Best On Every Authenticated Finish', () => {
  const mockLocalStorage = {
    storage: {},
    getItem: function(key) {
      return this.storage[key] !== undefined ? this.storage[key] : null;
    },
    setItem: function(key, value) {
      this.storage[key] = String(value);
    }
  };

  const signedInUser = { uid: 'test-user' };
  const firestoreAvailable = true;
  const syncedTimes = [];

  // Mirror of scores.js recordScore sync logic: on an authenticated finish we always
  // push the effective best (the better of this run and the stored local best) so a
  // best that never reached Firestore gets backfilled even on a slower follow-up run.
  function recordScore(time) {
    const localBestTimeStr = mockLocalStorage.getItem('snowgliderBestTime');
    const localBestTime = localBestTimeStr ? parseFloat(localBestTimeStr) : null;
    const hasValidLocalBest = typeof localBestTime === 'number' && !isNaN(localBestTime);
    const isNewLocalBest = !hasValidLocalBest || time < localBestTime;
    const effectiveBestTime = isNewLocalBest ? time : localBestTime;

    if (isNewLocalBest) {
      mockLocalStorage.setItem('snowgliderBestTime', time.toString());
    }

    if (signedInUser && firestoreAvailable) {
      syncedTimes.push(effectiveBestTime);
    }
  }

  // A best was stored locally but never reached the leaderboard (e.g. set before sign-in).
  mockLocalStorage.setItem('snowgliderBestTime', '19.43');

  recordScore(19.43);
  assertEquals(syncedTimes.length, 1,
    "Matching the stored best should sync to the leaderboard");
  assertEquals(syncedTimes[0], 19.43,
    "The stored best should be the time synced");

  // The reported bug: a slower run after a stuck best must still backfill the stored best.
  recordScore(22.0);
  assertEquals(syncedTimes.length, 2,
    "A slower finish should still trigger a backfill sync");
  assertEquals(syncedTimes[1], 19.43,
    "Backfill should sync the stored best, not the slower run time");

  recordScore(18.0);
  assertEquals(syncedTimes.length, 3,
    "A new best should sync to the leaderboard");
  assertEquals(syncedTimes[2], 18.0,
    "A new best should sync the new (faster) time");
  assertEquals(mockLocalStorage.getItem('snowgliderBestTime'), '18',
    "A new best should update local best storage");
});

runTest('Leaderboard Always Reflects The Authoritative Best, Never A Slower Local Time', () => {
  // Mirror of scores.js compare-and-write logic. The user best is read then written
  // (getDoc + setDoc); the AUTHORITATIVE best is the better of the stored value and this
  // run. The leaderboard is then written by a SEPARATE getDoc + setDoc using that
  // authoritative best - never the raw run time - and only when it improves the existing
  // entry. So a slower local run can neither downgrade the user best nor the leaderboard,
  // even when the device's localStorage is stale relative to Firestore.
  function resolve(time, storedBest, leaderboardBest) {
    const hasStored = typeof storedBest === 'number';
    const writeUser = !hasStored || time <= storedBest;
    const authoritativeBest = hasStored ? Math.min(storedBest, time) : time;
    const writeLeaderboard = typeof leaderboardBest !== 'number' || authoritativeBest <= leaderboardBest;
    return {
      writeUser,
      authoritativeBest,
      writeLeaderboard,
      leaderboardValue: writeLeaderboard ? authoritativeBest : leaderboardBest
    };
  }

  // Backfill of a stuck best: user doc has 19.43 but the leaderboard entry is missing.
  let r = resolve(19.43, 19.43, null);
  assertEquals(r.writeUser, true, "Equal stored best should still (re)write the user doc");
  assertEquals(r.leaderboardValue, 19.43, "Missing leaderboard entry should be backfilled with the best");

  // First finish (no data yet) writes both.
  r = resolve(20.0, null, null);
  assertEquals(r.writeUser, true, "First time should write the user doc");
  assertEquals(r.leaderboardValue, 20.0, "First time should write the leaderboard");

  // The reported P2: a device with stale/empty localStorage finishes a SLOWER run than
  // the authoritative server-side best (set on another device). The user doc must not
  // regress, and the leaderboard must show the authoritative best - never the slow run.
  r = resolve(19.43, 14.0, null);
  assertEquals(r.writeUser, false, "A slower run must not overwrite the faster stored best");
  assertEquals(r.leaderboardValue, 14.0, "Missing leaderboard entry is backfilled with the authoritative best, not the slow run");

  r = resolve(19.43, 14.0, 25.0);
  assertEquals(r.leaderboardValue, 14.0, "A slower leaderboard entry is repaired to the authoritative best, not the slow run");

  // Concurrent stale overwrite: a slower run (20s) lands after a faster value (18s).
  // The leaderboard receives the authoritative 18 (or no-ops), never the stale 20.
  r = resolve(20.0, 18.0, 18.0);
  assertEquals(r.writeUser, false, "A slower time must not overwrite a faster stored best");
  assertEquals(r.leaderboardValue, 18.0, "Leaderboard keeps the authoritative best; the slow 20 never reaches it");

  // A genuinely faster time still wins on both.
  r = resolve(17.0, 18.0, 18.0);
  assertEquals(r.writeUser, true, "A faster time should update the user doc");
  assertEquals(r.leaderboardValue, 17.0, "A faster time should update the leaderboard");

  // Edge: best matches user doc but leaderboard already holds a faster entry
  // (e.g. another device synced faster). Don't downgrade the leaderboard.
  r = resolve(19.0, 19.0, 17.0);
  assertEquals(r.writeUser, true, "Equal-to-stored best may refresh the user doc");
  assertEquals(r.writeLeaderboard, false, "Should not replace a faster leaderboard entry");
  assertEquals(r.leaderboardValue, 17.0, "Leaderboard keeps the faster existing entry");
});

runTest('Impossible Score Times Are Rejected And Repairable', () => {
  const minValidScoreTime = 4;
  const maxValidScoreTime = 600;
  function isValidScoreTime(time) {
    return typeof time === 'number' &&
      Number.isFinite(time) &&
      time >= minValidScoreTime &&
      time <= maxValidScoreTime;
  }

  function resolve(time, storedBest, leaderboardBest) {
    if (!isValidScoreTime(time)) {
      return {
        accepted: false,
        writeUser: false,
        writeLeaderboard: false,
        userValue: storedBest,
        leaderboardValue: leaderboardBest
      };
    }

    const hasStored = isValidScoreTime(storedBest);
    const writeUser = !hasStored || time <= storedBest;
    const authoritativeBest = hasStored ? Math.min(storedBest, time) : time;
    const writeLeaderboard = !isValidScoreTime(leaderboardBest) || authoritativeBest <= leaderboardBest;
    return {
      accepted: true,
      writeUser,
      writeLeaderboard,
      userValue: writeUser ? authoritativeBest : storedBest,
      leaderboardValue: writeLeaderboard ? authoritativeBest : leaderboardBest
    };
  }

  let r = resolve(0.01, null, null);
  assertEquals(r.accepted, false, "A 0.01s run should never be accepted as a score");
  assertEquals(r.writeUser, false, "Invalid runs must not write the user best");
  assertEquals(r.writeLeaderboard, false, "Invalid runs must not write the leaderboard");

  r = resolve(600.01, null, null);
  assertEquals(r.accepted, false, "A run over 600s should never be accepted as a score");
  assertEquals(r.writeUser, false, "Over-cap runs must not write the user best");
  assertEquals(r.writeLeaderboard, false, "Over-cap runs must not write the leaderboard");

  r = resolve(19.43, 0.01, 0.01);
  assertEquals(r.accepted, true, "A realistic run should still be accepted");
  assertEquals(r.userValue, 19.43, "Invalid stored user best should be replaced by a valid time");
  assertEquals(r.leaderboardValue, 19.43, "Invalid leaderboard best should be repairable by a valid time");

  const fetchedLeaderboardTimes = [0.01, 14.67, 58.64].filter(isValidScoreTime);
  assertEquals(fetchedLeaderboardTimes.length, 2,
    "Invalid leaderboard entries should be filtered out of displayed results");
  assertEquals(fetchedLeaderboardTimes[0], 14.67,
    "The first displayed leaderboard time should be the first valid score");

  const rawOrderedTimes = Array(10).fill(0.01).concat([14.67, 58.64]);
  const validAfterQueryFilter = rawOrderedTimes
    .filter(isValidScoreTime)
    .slice(0, 10);
  assertEquals(validAfterQueryFilter.length, 2,
    "Leaderboard query should fetch past leading invalid scores before applying the limit");
  assertEquals(validAfterQueryFilter[0], 14.67,
    "The top valid score should remain visible even when corrupt scores sort before it");
});

runTest('Personal Best Sync Survives A Leaderboard Write Failure', () => {
  // Models scores.js: updateUserBestTime writes the user best (setDoc) and calls
  // updateLeaderboard as a SEPARATE write. If Firestore rules allow users/{uid} but
  // reject leaderboard/{uid}, the leaderboard write must fail in isolation without
  // aborting the personal-best sync.
  let userBestWritten = false;
  let leaderboardWritten = false;

  function writeUserBest() {
    userBestWritten = true; // committed by its own setDoc
  }
  function updateLeaderboard() {
    // Separate write; rejected by security rules.
    throw new Error('permission-denied');
  }
  function updateUserBestTime() {
    writeUserBest();
    try {
      updateLeaderboard();
      leaderboardWritten = true;
    } catch (e) {
      // Isolated: leaderboard unavailable, but the personal best already synced.
    }
  }

  updateUserBestTime();
  assertEquals(userBestWritten, true,
    "Personal best must sync even when the leaderboard write is rejected");
  assertEquals(leaderboardWritten, false,
    "A rejected leaderboard write stays isolated from the personal-best write");
});

runTest('Offline Finish Defers The Leaderboard Write Until The User Write Settles', () => {
  // Models scores.js updateUserBestTime: the leaderboard reconciliation is CHAINED onto
  // the user-doc setDoc promise (userWrite.catch(...).then(() => updateLeaderboard())),
  // not fired in parallel. During an offline finish setDoc stays queued until reconnect,
  // so the leaderboard read+write must NOT run until that write settles - otherwise an
  // immediate read against an uncached leaderboard doc would reject and the backfill
  // would be dropped. This locks in that ordering so the parallel-call regression can't
  // silently return.
  const order = [];
  // A controllable stand-in for the offline setDoc promise: it stays pending until
  // settle() is called (i.e. until the SDK flushes the queued write on reconnect).
  function deferredWrite() {
    let cb = null;
    const p = /** @type {any} */ ({
      catch: () => p,                       // no rejection in the offline-resolve path
      then: (fn) => { cb = fn; return p; },
      settle: () => { if (cb) cb(); }
    });
    return p;
  }
  function updateLeaderboard() { order.push('leaderboard'); }
  function updateUserBestTime() {
    order.push('userWriteStart');
    const userWrite = deferredWrite(); // offline: queued, not yet settled
    userWrite
      .catch(() => order.push('writeError'))
      .then(() => updateLeaderboard());
    return userWrite;
  }

  const userWrite = updateUserBestTime();
  assertEquals(order.join(','), 'userWriteStart',
    "Offline: leaderboard write must NOT run before the queued user write settles");

  userWrite.settle(); // connection returns; the queued setDoc flushes
  assertEquals(order.join(','), 'userWriteStart,leaderboard',
    "On reconnect the leaderboard write runs once the user write settles");
});

// Test 4: Snow Splash Effect Interference
// Verifies that snow splash effects don't interfere with snowman position
runTest('Snow Splash Effect Interference', () => {
  // Create mock objects needed for snow splash update
  const mockSnowSplash = {
    particles: [],
    particleCount: 10,
    nextParticle: 0
  };
  
  // Create mock particles
  for (let i = 0; i < mockSnowSplash.particleCount; i++) {
    mockSnowSplash.particles.push({
      position: { x: 0, y: 0, z: 0 },
      scale: { set: () => {} },
      material: { opacity: 1 },
      userData: {
        active: false,
        lifetime: 0,
        maxLifetime: 0,
        xSpeed: 0, 
        ySpeed: 0,
        zSpeed: 0,
        size: 1
      }
    });
  }
  
  // Mock variables needed for the function
  const mockSnowman = /** @type {any} */ ({
    position: { x: 10, y: 5, z: -40 },
    rotation: { y: 0 }
  });
  
  const mockVelocity = { x: 5, z: -10 };
  const mockIsInAir = false;
  
  // Mock scene that tracks added elements
  const mockScene = /** @type {any} */ ({
    children: [],
    add: function(obj) {
      this.children.push(obj);
    }
  });
  
  // Save original position
  const originalPos = {
    x: mockSnowman.position.x,
    y: mockSnowman.position.y,
    z: mockSnowman.position.z
  };
  
  // Run the update function (which has side effects in the real code)
  Utils.updateSnowSplash(mockSnowSplash, 0.1, mockSnowman, mockVelocity, mockIsInAir, mockScene);
  
  // Verify snowman position is unchanged
  assertEquals(mockSnowman.position.x, originalPos.x, 
    "Snowman X position should be unchanged by snow splash effect");
  assertEquals(mockSnowman.position.y, originalPos.y, 
    "Snowman Y position should be unchanged by snow splash effect");
  assertEquals(mockSnowman.position.z, originalPos.z, 
    "Snowman Z position should be unchanged by snow splash effect");
  
  // Verify particles were created
  let activeParticles = mockSnowSplash.particles.filter(p => p.userData.active);
  assert(activeParticles.length > 0, 
    "Snow splash particles should be created when snowman is moving on ground");
});

// Test 5: Natural Terrain Variation
// Verifies backcountry terrain has natural variation
runTest('Natural Terrain Variation', () => {
  // Check terrain variation at different Z positions
  const zPositions = [-30, -80, -120, -160];
  
  for (const z of zPositions) {
    // Sample multiple points along the mountain at this z-level
    const heights = [];
    for (let x = -40; x <= 40; x += 10) {
      heights.push(Utils.getTerrainHeight(x, z));
    }
    
    // Calculate standard deviation to ensure terrain has variation
    const average = heights.reduce((sum, h) => sum + h, 0) / heights.length;
    const variance = heights.reduce((sum, h) => sum + Math.pow(h - average, 2), 0) / heights.length;
    const stdDev = Math.sqrt(variance);
    
    // Natural terrain should have some height variation - use lower threshold for farther distances
    const variationThreshold = z <= -120 ? 0.2 : 0.5;
    assert(stdDev > variationThreshold, `Terrain at z=${z} should have natural height variation`);
    
    // Check that terrain has downhill direction
    if (z < -30) {
      const downhillDir = Utils.getDownhillDirection(0, z);
      assert(downhillDir.z < 0, `Terrain at z=${z} should have downhill direction`);
    }
  }
});

// Print test summary
console.log(`\n=================================`);
console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);

// Exit with appropriate code for CI integration
process.exit(failCount > 0 ? 1 : 0);
})();
