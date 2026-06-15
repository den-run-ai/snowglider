/**
 * Avalanche system tests for SnowGlider
 */

// Mock THREE.js objects for testing
const mockTHREE = {
  Object3D: class {
    constructor() {
      this.position = { x: 0, y: 0, z: 0, set: function(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.rotation = { x: 0, y: 0, z: 0, set: function(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.scale = { setScalar: function() {} };
      this.matrix = {};
    }
    updateMatrix() {}
  },
  IcosahedronGeometry: class {
    dispose() {}
  },
  MeshStandardMaterial: class {
    dispose() {}
  },
  InstancedMesh: class {
    constructor() {
      this.instanceMatrix = { setUsage: function() {}, needsUpdate: false };
      this.castShadow = false;
      this.receiveShadow = false;
    }
    setMatrixAt() {}
  },
  DynamicDrawUsage: 35048
};

// Set up global THREE mock
global.THREE = mockTHREE;

// Mock scene
const mockScene = {
  children: [],
  add: function(obj) { this.children.push(obj); },
  remove: function(obj) { 
    const idx = this.children.indexOf(obj);
    if (idx > -1) this.children.splice(idx, 1);
  }
};

// Simple AvalancheSystem implementation for testing (mirrors avalanche.js logic)
class TestAvalancheSystem {
  constructor(scene, count = 120) {
    this.scene = scene;
    this.count = count;
    this.active = false;
    this.getTerrainHeight = null;
    
    // Physics data arrays
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    
    // Initialize sizes
    for (let i = 0; i < count; i++) {
      this.sizes[i] = 0.8; // Default size for testing
    }
  }
  
  setTerrainFunction(fn) {
    this.getTerrainHeight = fn;
  }
  
  trigger(playerPos) {
    this.active = true;
    
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      
      // Spawn behind player (uphill)
      const angle = (Math.random() - 0.5) * Math.PI * 0.6;
      const dist = 25 + Math.random() * 15;
      
      this.positions[idx]     = playerPos.x + Math.sin(angle) * dist;
      this.positions[idx + 1] = playerPos.y + 8 + Math.random() * 6;
      this.positions[idx + 2] = playerPos.z + dist * Math.cos(angle);
      
      // Velocity toward player (downhill)
      this.velocities[idx]     = (Math.random() - 0.5) * 2;
      this.velocities[idx + 1] = 0;
      this.velocities[idx + 2] = -(8 + Math.random() * 4);
      
      this.sizes[i] = 0.4 + Math.random() * 1.2;
    }
  }
  
  update(dt) {
    if (!this.active) return;
    
    const gravity = 18;
    
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      
      // Apply gravity
      this.velocities[idx + 1] -= gravity * dt;
      
      // Update positions
      this.positions[idx]     += this.velocities[idx] * dt;
      this.positions[idx + 1] += this.velocities[idx + 1] * dt;
      this.positions[idx + 2] += this.velocities[idx + 2] * dt;
      
      // Ground collision
      let floorY = 0;
      if (this.getTerrainHeight) {
        floorY = this.getTerrainHeight(this.positions[idx], this.positions[idx + 2]);
      }
      
      if (this.positions[idx + 1] < floorY + this.sizes[i]) {
        this.positions[idx + 1] = floorY + this.sizes[i];
        this.velocities[idx + 1] *= -0.25;
      }
    }
  }
  
  checkBurial(playerPos, hitRadius = 2) {
    if (!this.active) return false;
    
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const dx = this.positions[idx] - playerPos.x;
      const dy = this.positions[idx + 1] - playerPos.y;
      const dz = this.positions[idx + 2] - playerPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const threshold = hitRadius + this.sizes[i];
      
      if (distSq < threshold * threshold) {
        return true;
      }
    }
    return false;
  }
  
  getClosestDistance(playerPos) {
    if (!this.active) return Infinity;
    
    let minDist = Infinity;
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const dx = this.positions[idx] - playerPos.x;
      const dz = this.positions[idx + 2] - playerPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }
  
  hasPassed(playerPos) {
    if (!this.active) return false;
    
    let passedCount = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      if (this.positions[idx + 2] < playerPos.z - 10) {
        passedCount++;
      }
    }
    return passedCount > this.count * 0.8;
  }
  
  reset() {
    this.active = false;
  }
}

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

console.log('\n🏔️ SNOWGLIDER AVALANCHE TESTS 🏔️');
console.log('==================================\n');

// Test 1: Avalanche Initialization
runTest('Avalanche Initialization', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 50);
  
  assertEquals(avalanche.count, 50, 'Avalanche should have specified count');
  assertEquals(avalanche.active, false, 'Avalanche should start inactive');
  assert(avalanche.positions instanceof Float32Array, 'Positions should be Float32Array');
  assert(avalanche.velocities instanceof Float32Array, 'Velocities should be Float32Array');
});

// Test 2: Terrain Function Connection
runTest('Terrain Function Connection', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  
  const mockTerrainFn = (x, z) => x * 0.1 + z * 0.1;
  avalanche.setTerrainFunction(mockTerrainFn);
  
  assert(avalanche.getTerrainHeight !== null, 'Terrain function should be set');
  assertApprox(avalanche.getTerrainHeight(10, 20), 3, 0.01, 'Terrain function should work');
});

// Test 3: Avalanche Trigger
runTest('Avalanche Trigger', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 20);
  const playerPos = { x: 0, y: 10, z: -50 };
  
  assertEquals(avalanche.active, false, 'Should start inactive');
  
  avalanche.trigger(playerPos);
  
  assertEquals(avalanche.active, true, 'Should be active after trigger');
  
  // Check that boulders are spawned behind player (positive Z offset)
  let behindCount = 0;
  for (let i = 0; i < avalanche.count; i++) {
    if (avalanche.positions[i * 3 + 2] > playerPos.z) {
      behindCount++;
    }
  }
  assert(behindCount > avalanche.count * 0.8, 'Most boulders should spawn behind player');
});

// Test 4: Avalanche Physics Update
runTest('Avalanche Physics Update', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  avalanche.setTerrainFunction(() => 0); // Flat terrain
  
  avalanche.trigger({ x: 0, y: 10, z: -50 });
  
  // Store initial positions
  const initialZ = [];
  for (let i = 0; i < avalanche.count; i++) {
    initialZ.push(avalanche.positions[i * 3 + 2]);
  }
  
  // Update for several frames
  for (let i = 0; i < 10; i++) {
    avalanche.update(0.016); // ~60fps
  }
  
  // Check that boulders moved downhill (negative Z)
  let movedDownhill = 0;
  for (let i = 0; i < avalanche.count; i++) {
    if (avalanche.positions[i * 3 + 2] < initialZ[i]) {
      movedDownhill++;
    }
  }
  assert(movedDownhill > avalanche.count * 0.8, 'Most boulders should move downhill');
});

// Test 5: Burial Detection
runTest('Burial Detection (Collision)', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  
  // Manually place a boulder at the player position
  avalanche.active = true;
  avalanche.positions[0] = 0;  // x
  avalanche.positions[1] = 5;  // y
  avalanche.positions[2] = -50; // z
  avalanche.sizes[0] = 1;
  
  // Player at same position
  const playerAtBoulder = { x: 0, y: 5, z: -50 };
  assert(avalanche.checkBurial(playerAtBoulder), 'Should detect burial when player at boulder');
  
  // Player far away
  const playerFarAway = { x: 100, y: 5, z: 100 };
  assert(!avalanche.checkBurial(playerFarAway), 'Should not detect burial when player far away');
});

// Test 6: Closest Distance Calculation
runTest('Closest Distance Calculation', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 3);
  
  avalanche.active = true;
  // Place all boulders at known positions
  avalanche.positions[0] = 10; avalanche.positions[1] = 0; avalanche.positions[2] = 0;
  avalanche.positions[3] = 20; avalanche.positions[4] = 0; avalanche.positions[5] = 0;
  avalanche.positions[6] = 30; avalanche.positions[7] = 0; avalanche.positions[8] = 0;
  
  const playerPos = { x: 0, y: 0, z: 0 };
  const closest = avalanche.getClosestDistance(playerPos);
  
  assertApprox(closest, 10, 0.1, 'Closest distance should be 10');
});

// Test 7: Avalanche Passed Detection
runTest('Avalanche Passed Detection', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  
  avalanche.active = true;
  // Place all boulders far ahead of player (downhill)
  for (let i = 0; i < avalanche.count; i++) {
    avalanche.positions[i * 3 + 2] = -100; // Far downhill
  }
  
  const playerPos = { x: 0, y: 0, z: -50 };
  assert(avalanche.hasPassed(playerPos), 'Should detect avalanche has passed');
  
  // Reset and place boulders behind player
  for (let i = 0; i < avalanche.count; i++) {
    avalanche.positions[i * 3 + 2] = -30; // Behind player
  }
  assert(!avalanche.hasPassed(playerPos), 'Should not detect passed when boulders behind');
});

// Test 8: Avalanche Reset
runTest('Avalanche Reset', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  
  avalanche.trigger({ x: 0, y: 10, z: -50 });
  assertEquals(avalanche.active, true, 'Should be active after trigger');
  
  avalanche.reset();
  assertEquals(avalanche.active, false, 'Should be inactive after reset');
});

// Test 9: No Burial When Inactive
runTest('No Burial When Inactive', () => {
  const avalanche = new TestAvalancheSystem(mockScene, 10);
  
  // Place boulder at player position but don't activate
  avalanche.positions[0] = 0;
  avalanche.positions[1] = 5;
  avalanche.positions[2] = -50;
  avalanche.sizes[0] = 1;
  
  const playerPos = { x: 0, y: 5, z: -50 };
  assert(!avalanche.checkBurial(playerPos), 'Should not detect burial when avalanche inactive');
});

// Test 10: Distance Trigger Integration
runTest('Distance Trigger Logic', () => {
  // Simulate the trigger logic from snowglider.js
  const startZ = -15;
  const triggerDistance = 80;
  let avalancheTriggered = false;
  let lastAvalancheZ = startZ;
  
  // Simulate player moving downhill
  const positions = [-15, -30, -50, -80, -100];
  
  for (const posZ of positions) {
    const distanceTraveled = lastAvalancheZ - posZ;
    
    if (!avalancheTriggered && distanceTraveled > triggerDistance) {
      avalancheTriggered = true;
    }
  }
  
  assert(avalancheTriggered, 'Avalanche should trigger after traveling 80 units');
});

// Print test summary
console.log(`\n==================================`);
console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);

// Exit with appropriate code for CI integration
process.exit(failCount > 0 ? 1 : 0);
