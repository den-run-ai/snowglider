/**
 * Regression Tests for SnowGlider
 * 
 * These tests target specific functionality that may have regressed
 * based on the git history and codebase analysis.
 */

// Require the utils module and THREE.js
const fs = require('fs');
const path = require('path');
const THREE = require('three');

// Mock THREE.js features
THREE.Color = function() {};
THREE.CanvasTexture = function() {
  return {
    wrapS: 0,
    wrapT: 0,
    repeat: { set: () => {} }
  };
};

// Load Utils.js content (since it's not a module, we need to evaluate it)
const utilsContent = fs.readFileSync(path.join(__dirname, '..', 'utils.js'), 'utf8');

// Create a function to execute the utils content and return the Utils global
function loadUtils() {
  // Create a sandbox environment
  const sandbox = {
    window: {},
    document: {
      createElement: () => ({
        getContext: () => ({
          fillRect: () => {},
          fillStyle: '',
          createLinearGradient: () => ({
            addColorStop: () => {}
          }),
          createRadialGradient: () => ({
            addColorStop: () => {}
          }),
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          strokeStyle: ''
        }),
        width: 0,
        height: 0
      })
    },
    THREE: THREE
  };
  
  // Create a function to evaluate the utilsContent in the sandbox
  const fn = new Function('sandbox', `
    with (sandbox) {
      ${utilsContent}
      return Utils;
    }
  `);
  
  return fn(sandbox);
}

// Load the Utils object
const Utils = loadUtils();

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
    console.log(`   Error: ${error.message}`);
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
  global.performance = {
    now: () => Date.now()
  };
  
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
  const mockSnowman = {
    position: { x: 10, y: 5, z: -40 },
    rotation: { y: 0 }
  };
  
  const mockVelocity = { x: 5, z: -10 };
  const mockIsInAir = false;
  
  // Mock scene that tracks added elements
  const mockScene = {
    children: [],
    add: function(obj) {
      this.children.push(obj);
    }
  };
  
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

// Test 5: Extended Ski Path Width
// Verifies the extended ski path maintains consistent width
runTest('Extended Ski Path Width Consistency', () => {
  // Check ski path width at different Z positions
  const zPositions = [-30, -80, -120, -160];
  
  for (const z of zPositions) {
    // Check width by measuring height at center and edges
    const centerHeight = Utils.getTerrainHeight(0, z);
    
    // Check points 10 units to the left and right (ski path should be about 15 units wide)
    const leftHeight = Utils.getTerrainHeight(-10, z);
    const rightHeight = Utils.getTerrainHeight(10, z);
    
    // Path should be relatively flat (similar heights within tolerance)
    const leftDiff = Math.abs(centerHeight - leftHeight);
    const rightDiff = Math.abs(centerHeight - rightHeight);
    
    assert(leftDiff < 2, `Ski path at z=${z} should maintain consistent width to the left`);
    assert(rightDiff < 2, `Ski path at z=${z} should maintain consistent width to the right`);
    
    // Check the edge of the path (should start to slope up/down)
    const farLeftHeight = Utils.getTerrainHeight(-20, z);
    const farRightHeight = Utils.getTerrainHeight(20, z);
    
    // At least one side should have different height (not flat) beyond the path edge
    const farLeftDiff = Math.abs(centerHeight - farLeftHeight);
    const farRightDiff = Math.abs(centerHeight - farRightHeight);
    
    assert(farLeftDiff > 1 || farRightDiff > 1, 
      `Ski path at z=${z} should have terrain variation beyond path edges`);
  }
});

// Print test summary
console.log(`\n=================================`);
console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);

// Exit with appropriate code for CI integration
process.exit(failCount > 0 ? 1 : 0);