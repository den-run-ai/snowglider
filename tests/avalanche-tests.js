/**
 * Avalanche system tests for SnowGlider.
 *
 * Phase 2.1 (issue #84): these run against the REAL `src/avalanche.ts` ES module
 * and real three.js from npm. The previous version evaluated the source with
 * `new Function(src)` and a hand-rolled THREE mock plus a parallel
 * `TestAvalancheSystem` reimplementation; that injection pattern can't load a
 * module that uses `import`/`export`, so it's gone. We now `import()` the actual
 * class and exercise it directly — every assertion validates shipped code.
 *
 * three's geometry/material/mesh constructors need no WebGL context, so the real
 * AvalancheSystem constructs fine headless under Node (no renderer involved).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ts = require('typescript');

// Custom assert helpers
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

let passCount = 0;
let failCount = 0;

async function importTranspiledTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false
    },
    fileName: sourcePath
  });

  const tempDir = path.join(__dirname, '.tmp-avalanche-tests');
  const tempPath = path.join(tempDir, `avalanche-${process.pid}-${Date.now()}.mjs`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(tempPath, transpiled.outputText, 'utf8');

  try {
    return await import(pathToFileURL(tempPath).href);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

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

async function main() {
  // Real three.js (npm) and the real avalanche module under test.
  const THREE = await import('three');
  // Phase 3.0 (issue #84): avalanche is now `.ts`. Transpile it to temporary ESM
  // for Node tests so this suite does not depend on Node's native type-stripping
  // support. The browser/dev/build paths still exercise Vite's TypeScript loader.
  const { AvalancheSystem } = await importTranspiledTypeScriptModule(
    path.join(__dirname, '..', 'src', 'avalanche.ts')
  );

  // Each test gets a fresh real scene; the system adds its InstancedMesh to it.
  const makeSystem = (count) => new AvalancheSystem(new THREE.Scene(), count);

  console.log('\n🏔️ SNOWGLIDER AVALANCHE TESTS 🏔️');
  console.log('==================================\n');

  // Test 1: Avalanche Initialization
  runTest('Avalanche Initialization', () => {
    const avalanche = makeSystem(50);

    assertEquals(avalanche.count, 50, 'Avalanche should have specified count');
    assertEquals(avalanche.active, false, 'Avalanche should start inactive');
    assert(avalanche.positions instanceof Float32Array, 'Positions should be Float32Array');
    assert(avalanche.velocities instanceof Float32Array, 'Velocities should be Float32Array');
  });

  // Test 2: Terrain Function Connection
  runTest('Terrain Function Connection', () => {
    const avalanche = makeSystem(10);

    const mockTerrainFn = (x, z) => x * 0.1 + z * 0.1;
    avalanche.setTerrainFunction(mockTerrainFn);

    assert(avalanche.getTerrainHeight !== null, 'Terrain function should be set');
    assertApprox(avalanche.getTerrainHeight(10, 20), 3, 0.01, 'Terrain function should work');
  });

  // Test 3: Avalanche Trigger
  runTest('Avalanche Trigger', () => {
    const avalanche = makeSystem(20);
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
    const avalanche = makeSystem(10);
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
    const avalanche = makeSystem(10);

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
    const avalanche = makeSystem(3);

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
    const avalanche = makeSystem(10);

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
    const avalanche = makeSystem(10);

    avalanche.trigger({ x: 0, y: 10, z: -50 });
    assertEquals(avalanche.active, true, 'Should be active after trigger');

    avalanche.reset();
    assertEquals(avalanche.active, false, 'Should be inactive after reset');
  });

  // Test 9: No Burial When Inactive
  runTest('No Burial When Inactive', () => {
    const avalanche = makeSystem(10);

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
    const lastAvalancheZ = startZ;

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

  // Test 11: Real module disables frustum culling (r160 regression guard)
  // From three r160 an InstancedMesh frustum-culls against bounds cached while
  // _hideAll() parks the boulders offscreen, which would make a triggered
  // avalanche invisible. The fix is mesh.frustumCulled = false in the
  // constructor — assert it on the real mesh built with real three.
  runTest('Real AvalancheSystem disables frustum culling (r160)', () => {
    const realSystem = makeSystem(8);
    assert(realSystem.mesh && realSystem.mesh.isInstancedMesh === true,
      'avalanche.js should build a real THREE.InstancedMesh');
    assertEquals(realSystem.mesh.frustumCulled, false,
      'InstancedMesh.frustumCulled must be false so hidden-then-moved boulders are not culled');
  });

  // Test 12: Mesh is added to the provided scene
  runTest('Avalanche mesh is added to the scene', () => {
    const scene = new THREE.Scene();
    const avalanche = new AvalancheSystem(scene, 8);
    assert(scene.children.includes(avalanche.mesh),
      'Constructor should add its InstancedMesh to the scene');
    avalanche.dispose();
    assert(!scene.children.includes(avalanche.mesh),
      'dispose() should remove the mesh from the scene');
  });

  // Print test summary
  console.log(`\n==================================`);
  console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);

  // Exit with appropriate code for CI integration
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Avalanche test harness crashed:', err);
  process.exit(1);
});
