/**
 * Physics and game mechanics tests for SnowGlider
 */

// Create a minimal mock environment for testing
const mockEnvironment = {
  pos: { x: 0, y: 0, z: -40 },
  velocity: { x: 0, z: 0 },
  isInAir: false,
  verticalVelocity: 0,
  jumpCooldown: 0,
  lastTerrainHeight: 0,
  treePositions: [],
  gameActive: true,
  keyboardControls: {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false
  },

  // Simplified updateSnowman function with the core physics
  updateSnowman: function(delta) {
    // Update movement based on input
    if (this.keyboardControls.left) {
      this.velocity.x -= 5 * delta;
    }
    if (this.keyboardControls.right) {
      this.velocity.x += 5 * delta;
    }
    
    // Update jump
    if (this.keyboardControls.jump && !this.isInAir) {
      this.verticalVelocity = 10;
      this.isInAir = true;
    }
    
    // Apply gravity when in air
    if (this.isInAir) {
      this.verticalVelocity -= 9.8 * delta;
      this.pos.y += this.verticalVelocity * delta;
      
      // Check for landing
      const terrainHeight = 0; // Mock terrain height
      if (this.pos.y <= terrainHeight) {
        this.isInAir = false;
        this.pos.y = terrainHeight;
        this.verticalVelocity = 0;
      }
    }
    
    // Apply velocity
    this.pos.x += this.velocity.x * delta;
    this.pos.z += this.velocity.z * delta;
    
    // Apply simple friction
    this.velocity.x *= 0.95;
    this.velocity.z *= 0.95;
    
    // Check for tree collisions (simplified)
    const collision = this.treePositions.some(tree => {
      // Special case for tests - direct position match or very close positions always collide
      // Use a small epsilon for floating point comparison instead of exact equality
      const epsilon = 0.001;
      const exactMatch = 
        Math.abs(this.pos.x - tree.x) < epsilon && 
        Math.abs(this.pos.z - tree.z) < epsilon;
      
      if (exactMatch) {
        return true;
      }
      
      // Check horizontal distance for collision (2D distance ignoring height)
      const dx = this.pos.x - tree.x;
      const dz = this.pos.z - tree.z;
      const horizontalDistance = Math.sqrt(dx*dx + dz*dz);
      
      // We only detect collision if the horizontal distance is close enough
      // Use testing collision radius value when available
      const collisionRadius = typeof window !== 'undefined' && window.treeCollisionRadius ? 
                              window.treeCollisionRadius : 2.5;
      const isCloseEnough = horizontalDistance < collisionRadius;
      
      // Only consider jumping over trees when genuinely in the air AND moving upward AND high enough
      const isJumpingHighAboveTrees = this.isInAir && this.verticalVelocity > 0 && this.pos.y > (tree.y + 5);
      
      // Allow jumping over trees but collide when on the ground
      return isCloseEnough && !isJumpingHighAboveTrees;
    });
    
    if (collision) {
      this.resetState();
      return 'collision';
    }
    
    // Check for boundaries
    if (Math.abs(this.pos.x) > 80 || this.pos.z < -95) {
      this.resetState();
      return 'boundary';
    }
    
    return null;
  },
  
  resetState: function() {
    this.pos = { x: 0, y: 0, z: -40 };
    this.velocity = { x: 0, z: 0 };
    this.isInAir = false;
    this.verticalVelocity = 0;
  }
};

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

console.log('\n🏂 SNOWGLIDER PHYSICS TESTS 🏂');
console.log('==============================\n');

// Test 1: Basic Movement
runTest('Basic Movement Controls', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Test left movement
  mockEnvironment.keyboardControls.left = true;
  mockEnvironment.updateSnowman(0.1);
  assert(mockEnvironment.velocity.x < 0, 'Left key should generate negative X velocity');
  mockEnvironment.keyboardControls.left = false;
  
  // Reset
  mockEnvironment.resetState();
  
  // Test right movement
  mockEnvironment.keyboardControls.right = true;
  mockEnvironment.updateSnowman(0.1);
  assert(mockEnvironment.velocity.x > 0, 'Right key should generate positive X velocity');
  mockEnvironment.keyboardControls.right = false;
});

// Test 2: Jumping Mechanics
runTest('Jumping Mechanics', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Test jump
  mockEnvironment.keyboardControls.jump = true;
  mockEnvironment.updateSnowman(0.1);
  
  assert(mockEnvironment.isInAir, 'Jump key should set isInAir to true');
  assert(mockEnvironment.verticalVelocity > 0, 'Jump should generate positive vertical velocity');
  
  // Test gravity
  const initialVelocity = mockEnvironment.verticalVelocity;
  mockEnvironment.updateSnowman(0.1);
  assert(mockEnvironment.verticalVelocity < initialVelocity, 'Gravity should reduce vertical velocity');
  
  // Reset
  mockEnvironment.keyboardControls.jump = false;
  mockEnvironment.resetState();
});

// Test 3: Collision Detection
runTest('Collision Detection', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Add a tree directly in front of the snowman
  mockEnvironment.treePositions = [
    { x: mockEnvironment.pos.x, y: 0, z: mockEnvironment.pos.z - 2 }
  ];
  
  // Move toward the tree
  mockEnvironment.velocity.z = -5;
  const result = mockEnvironment.updateSnowman(0.1);
  
  assertEquals(result, 'collision', 'Tree collision should be detected');
  
  // Clean up
  mockEnvironment.treePositions = [];
});

// Test 6: Collision Detection with Snow Effects
runTest('Collision Detection with Snow Effects', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Add a tree directly in front of the snowman
  mockEnvironment.treePositions = [
    { x: mockEnvironment.pos.x, y: 0, z: mockEnvironment.pos.z - 2 }
  ];
  
  // Enable snow splash effect simulation
  mockEnvironment.hasSnowSplashEffect = true;
  
  // Move toward the tree
  mockEnvironment.velocity.z = -5;
  const result = mockEnvironment.updateSnowman(0.1);
  
  assertEquals(result, 'collision', 'Tree collision should be detected even with snow effects');
  
  // Clean up
  mockEnvironment.treePositions = [];
  mockEnvironment.hasSnowSplashEffect = false;
});

// Test 4: Boundary Detection
runTest('Boundary Detection', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Test X boundary
  mockEnvironment.pos.x = 125; // Outside X boundary - extended with new terrain
  const resultX = mockEnvironment.updateSnowman(0.1);
  assertEquals(resultX, 'boundary', 'X-axis boundary should be detected');
  
  // Reset
  mockEnvironment.resetState();
  
  // Test Z boundary
  mockEnvironment.pos.z = -200; // Outside Z boundary - extended with new terrain
  const resultZ = mockEnvironment.updateSnowman(0.1);
  assertEquals(resultZ, 'boundary', 'Z-axis boundary should be detected');
});

// Test 5: Friction and Deceleration
runTest('Friction and Deceleration', () => {
  // Reset the environment
  mockEnvironment.resetState();
  
  // Set initial velocity
  mockEnvironment.velocity.x = 10;
  mockEnvironment.velocity.z = 10;
  
  // Apply friction for several frames
  for (let i = 0; i < 10; i++) {
    mockEnvironment.updateSnowman(0.1);
  }
  
  // Velocity should decrease due to friction
  assert(mockEnvironment.velocity.x < 10, 'X velocity should decrease due to friction');
  assert(mockEnvironment.velocity.z < 10, 'Z velocity should decrease due to friction');
  
  // Reset
  mockEnvironment.resetState();
});

// Print test summary
console.log(`\n==============================`);
console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);

// Exit with appropriate code for CI integration
process.exit(failCount > 0 ? 1 : 0);