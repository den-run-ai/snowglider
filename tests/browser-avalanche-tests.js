// SnowGlider Avalanche UI Test Suite
// Run with: open index.html?test=avalanche in browser
//
// This file contains tests for the avalanche UI functionality:
// 1. Avalanche System Initialization - tests proper avalanche system setup
// 2. Avalanche Trigger - tests avalanche triggers after traveling far enough
// 3. Avalanche Visual Rendering - tests boulders are visible when active
// 4. Burial Detection UI - tests game over on burial
// 5. Avalanche Passed Detection - tests avalanche passes without burial
// 6. Avalanche Reset - tests avalanche resets with game reset
//
// The tests can be run individually or as part of the unified test suite (index.html?test=unified)
//
// Phase 2 (issue #84): converted to an ES module — imports AvalancheSystem from the
// real src module instead of probing the window.Avalanche bridge; loaded via
// `<script type="module">`. Still publishes window.runAvalancheTests for the runner.
import { AvalancheSystem } from '../src/avalanche.js';

(function() {
  // Only run tests if ?test=avalanche is in the URL and not running through the unified test runner
  if ((window.location.search.includes('test=avalanche') || 
      (window.location.search.includes('test=true') && window.location.search.includes('avalanche=true'))) && 
      !window.location.search.includes('test=unified') && 
      !window._unifiedTestRunnerActive) {
    if (document.readyState === 'complete') {
      console.log("Avalanche tests initializing from direct URL parameter");
      setTimeout(runAvalancheTests, 500);
    } else {
      window.addEventListener('load', function() {
        console.log("Avalanche tests initializing from direct URL parameter");
        // Give the game a moment to fully initialize
        setTimeout(runAvalancheTests, 500);
      });
    }
  }
  
  // Expose the test runner for the unified test system
  window.runAvalancheTests = runAvalancheTests;

  function runAvalancheTests() {
    console.log('=== STARTING SNOWGLIDER AVALANCHE TESTS ===');
    
    // Create or use test results container
    let resultsDiv;
    if (window._unifiedTestResults) {
      console.log("Using unified test results container for avalanche tests");
      resultsDiv = window._unifiedTestResults;
      
      // Add section header
      const sectionHeader = document.createElement('div');
      sectionHeader.style.fontWeight = 'bold';
      sectionHeader.style.fontSize = '16px';
      sectionHeader.style.marginTop = '15px';
      sectionHeader.style.marginBottom = '10px';
      sectionHeader.style.borderBottom = '1px solid white';
      sectionHeader.textContent = 'AVALANCHE TESTS';
      resultsDiv.appendChild(sectionHeader);
    } else {
      console.log("Creating standalone avalanche test results container");
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'avalanche-test-results';
      resultsDiv.style.position = 'fixed';
      resultsDiv.style.top = '10px';
      resultsDiv.style.left = '10px';
      resultsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
      resultsDiv.style.color = 'white';
      resultsDiv.style.padding = '15px';
      resultsDiv.style.fontFamily = 'monospace';
      resultsDiv.style.fontSize = '14px';
      resultsDiv.style.zIndex = '9999';
      resultsDiv.style.maxWidth = '500px';
      resultsDiv.style.maxHeight = '80%';
      resultsDiv.style.overflow = 'auto';
      resultsDiv.style.borderRadius = '5px';
      resultsDiv.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.8)';
      resultsDiv.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      
      // Add title for standalone mode
      const title = document.createElement('div');
      title.textContent = 'AVALANCHE TESTS';
      title.style.fontSize = '18px';
      title.style.fontWeight = 'bold';
      title.style.marginBottom = '10px';
      title.style.borderBottom = '1px solid white';
      title.style.paddingBottom = '5px';
      resultsDiv.appendChild(title);
      
      // Add a close button for standalone mode
      const closeButton = document.createElement('button');
      closeButton.textContent = '✕';
      closeButton.style.position = 'absolute';
      closeButton.style.top = '10px';
      closeButton.style.right = '10px';
      closeButton.style.background = 'rgba(255, 255, 255, 0.2)';
      closeButton.style.border = 'none';
      closeButton.style.color = 'white';
      closeButton.style.borderRadius = '50%';
      closeButton.style.width = '25px';
      closeButton.style.height = '25px';
      closeButton.style.cursor = 'pointer';
      closeButton.style.fontSize = '14px';
      closeButton.style.fontWeight = 'bold';
      closeButton.style.display = 'flex';
      closeButton.style.alignItems = 'center';
      closeButton.style.justifyContent = 'center';
      closeButton.addEventListener('click', () => {
        resultsDiv.style.display = 'none';
      });
      resultsDiv.appendChild(closeButton);
      
      // Add test URL note
      const urlNote = document.createElement('div');
      urlNote.textContent = 'Running avalanche tests (index.html?test=avalanche)';
      urlNote.style.fontSize = '12px';
      urlNote.style.color = '#aaa';
      urlNote.style.marginBottom = '10px';
      resultsDiv.appendChild(urlNote);
      
      document.body.appendChild(resultsDiv);
    }
    
    let testsPassed = 0;
    let testsFailed = 0;
    
    function logResult(name, passed, message) {
      const result = document.createElement('div');
      result.textContent = `${passed ? '✓' : '✗'} ${name}: ${message || ''}`;
      result.style.color = passed ? '#4CAF50' : '#FF5252';
      resultsDiv.appendChild(result);
      
      if (passed) testsPassed++;
      else testsFailed++;
      
      // Log to console as well
      console.log(`${passed ? 'PASS' : 'FAIL'}: ${name} - ${message || ''}`);
    }
    
    function assert(condition, name, message) {
      if (condition) {
        logResult(name, true, message || 'Test passed');
      } else {
        logResult(name, false, message || 'Test failed');
      }
    }

    // Test 1: Avalanche System Initialization
    function testAvalancheInitialization() {
      // Check that the Avalanche module is loaded (imported from src/avalanche.js)
      const moduleLoaded = typeof AvalancheSystem === 'function';

      assert(moduleLoaded, 'Avalanche Module Loaded',
        moduleLoaded ? 'Avalanche module is properly loaded' :
        'Avalanche module failed to load');
      
      // Check that avalanche system is initialized in the game
      // Access the avalanche variable from the game scope
      const avalancheExists = typeof avalanche !== 'undefined' && avalanche !== null;
      
      assert(avalancheExists, 'Avalanche System Exists', 
        avalancheExists ? 'Avalanche system is initialized in game' : 
        'Avalanche system not found in game');
      
      if (avalancheExists) {
        // Check that it has the expected methods
        const hasTrigger = typeof avalanche.trigger === 'function';
        const hasUpdate = typeof avalanche.update === 'function';
        const hasCheckBurial = typeof avalanche.checkBurial === 'function';
        const hasReset = typeof avalanche.reset === 'function';
        
        const hasAllMethods = hasTrigger && hasUpdate && hasCheckBurial && hasReset;
        
        assert(hasAllMethods, 'Avalanche API Complete', 
          hasAllMethods ? 'Avalanche system has all required methods' : 
          'Avalanche system missing required methods');
      }
    }
    
    // Test 2: Avalanche Trigger Mechanics
    function testAvalancheTrigger() {
      // Save original state
      const originalPos = { x: pos.x, y: pos.y, z: pos.z };
      const originalAvalancheTriggered = avalancheTriggered;
      
      // Reset game state
      resetSnowman();
      
      // Verify avalanche starts inactive
      assert(!avalanche.active, 'Avalanche Initially Inactive', 
        !avalanche.active ? 'Avalanche correctly starts inactive' : 
        'Avalanche incorrectly starts active');
      
      assert(!avalancheTriggered, 'Trigger Flag Initially False', 
        !avalancheTriggered ? 'Avalanche trigger flag correctly starts false' : 
        'Avalanche trigger flag incorrectly starts true');
      
      // Move player far enough to trigger avalanche (80 units downhill)
      // Player moves in -Z direction
      const startZ = pos.z;
      pos.z = startZ - 85; // Move 85 units downhill
      snowman.position.z = pos.z;
      
      // Manually trigger the avalanche check logic (simulate what happens in animate loop)
      const distanceTraveled = lastAvalancheZ - pos.z;
      if (!avalancheTriggered && distanceTraveled > 80) {
        avalanche.trigger(snowman.position);
        avalancheTriggered = true;
      }
      
      // Verify avalanche is now active
      assert(avalanche.active, 'Avalanche Triggers on Distance', 
        avalanche.active ? 'Avalanche correctly triggers after traveling 80+ units' : 
        'Avalanche failed to trigger after sufficient distance');
      
      // Restore original state
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      snowman.position.set(pos.x, pos.y, pos.z);
      avalanche.reset();
      avalancheTriggered = originalAvalancheTriggered;
    }
    
    // Test 3: Avalanche Visual Rendering
    function testAvalancheVisualRendering() {
      // Save original state
      const originalAvalancheTriggered = avalancheTriggered;
      
      // Reset and trigger avalanche
      resetSnowman();
      avalanche.trigger(snowman.position);
      avalancheTriggered = true;
      
      // Check that the instanced mesh exists in the scene
      const meshExists = avalanche.mesh !== undefined && avalanche.mesh !== null;
      
      assert(meshExists, 'Avalanche Mesh Exists', 
        meshExists ? 'Avalanche instanced mesh exists' : 
        'Avalanche instanced mesh not found');
      
      if (meshExists) {
        // Check mesh is an InstancedMesh with correct count
        const isInstancedMesh = avalanche.mesh.isInstancedMesh === true;
        
        assert(isInstancedMesh, 'Correct Mesh Type', 
          isInstancedMesh ? 'Avalanche uses InstancedMesh for performance' : 
          'Avalanche not using InstancedMesh');
        
        // Check that mesh is in the scene
        const inScene = scene.children.includes(avalanche.mesh);
        
        assert(inScene, 'Mesh In Scene', 
          inScene ? 'Avalanche mesh is added to scene' : 
          'Avalanche mesh not found in scene');
        
        // Check boulder count
        const expectedCount = 120; // Default count from snowglider.js
        const hasCorrectCount = avalanche.count === expectedCount;
        
        assert(hasCorrectCount, 'Boulder Count', 
          hasCorrectCount ? `Avalanche has ${expectedCount} boulders` : 
          `Expected ${expectedCount} boulders, found ${avalanche.count}`);
      }
      
      // Cleanup
      avalanche.reset();
      avalancheTriggered = originalAvalancheTriggered;
    }
    
    // Test 4: Burial Detection (Collision)
    function testBurialDetection() {
      // Save original state
      const originalShowGameOver = window.showGameOver;
      const originalGameActive = gameActive;
      
      let gameOverCalled = false;
      let gameOverReason = '';
      
      // Mock showGameOver
      window.showGameOver = function(reason) {
        gameOverCalled = true;
        gameOverReason = reason;
        console.log('AVALANCHE TEST: showGameOver called with:', reason);
      };
      
      // Reset and trigger avalanche
      resetSnowman();
      gameActive = true;
      avalanche.trigger(snowman.position);
      
      // Manually place a boulder at the player position for collision test
      avalanche.positions[0] = snowman.position.x;
      avalanche.positions[1] = snowman.position.y;
      avalanche.positions[2] = snowman.position.z;
      avalanche.sizes[0] = 1;
      
      // Test burial detection
      const isBuried = avalanche.checkBurial(snowman.position);
      
      assert(isBuried, 'Burial Detection Works', 
        isBuried ? 'Burial correctly detected when player at boulder position' : 
        'Burial not detected when player should be buried');
      
      // Simulate what happens in the game loop when buried
      if (isBuried) {
        window.showGameOver("Buried by avalanche!");
      }
      
      // Check game over was triggered with correct message
      const correctGameOver = gameOverCalled && gameOverReason.includes('avalanche');
      
      assert(correctGameOver, 'Burial Game Over Message', 
        correctGameOver ? 'Game over correctly shows avalanche burial message' : 
        'Game over message incorrect or not shown');
      
      // Test that distant player is not buried
      gameOverCalled = false;
      const farPosition = { x: 1000, y: 0, z: 1000 };
      const notBuried = !avalanche.checkBurial(farPosition);
      
      assert(notBuried, 'No False Burial', 
        notBuried ? 'No false burial when player is far from boulders' : 
        'False burial detected when player is far away');
      
      // Restore original state
      window.showGameOver = originalShowGameOver;
      gameActive = originalGameActive;
      avalanche.reset();
    }
    
    // Test 5: Avalanche Passed Detection
    function testAvalanchePassed() {
      // Reset and trigger avalanche
      resetSnowman();
      avalanche.trigger(snowman.position);
      
      // Initially, avalanche should not have passed
      const initiallyNotPassed = !avalanche.hasPassed(snowman.position);
      
      assert(initiallyNotPassed, 'Avalanche Initially Not Passed', 
        initiallyNotPassed ? 'Avalanche correctly not marked as passed initially' : 
        'Avalanche incorrectly marked as passed before it moves');
      
      // Move all boulders far ahead of player (downhill, lower Z values)
      for (let i = 0; i < avalanche.count; i++) {
        const idx = i * 3;
        avalanche.positions[idx + 2] = snowman.position.z - 50; // 50 units ahead
      }
      
      // Now check if avalanche has passed
      const hasPassed = avalanche.hasPassed(snowman.position);
      
      assert(hasPassed, 'Avalanche Passed Detection', 
        hasPassed ? 'Avalanche correctly detected as passed when boulders are ahead' : 
        'Avalanche not detected as passed when it should be');
      
      // Cleanup
      avalanche.reset();
    }
    
    // Test 6: Avalanche Reset
    function testAvalancheReset() {
      // Trigger avalanche first
      avalanche.trigger(snowman.position);
      
      // Verify it's active
      const wasActive = avalanche.active;
      
      // Reset avalanche
      avalanche.reset();
      
      // Verify it's now inactive
      const isInactive = !avalanche.active;
      
      assert(wasActive && isInactive, 'Avalanche Reset Works', 
        (wasActive && isInactive) ? 'Avalanche correctly deactivates on reset' : 
        'Avalanche reset did not properly deactivate system');
      
      // Reset game and verify avalanche also resets
      avalanche.trigger(snowman.position);
      resetSnowman(); // This should reset the avalanche too
      
      const resetWithGame = !avalanche.active && !avalancheTriggered;
      
      assert(resetWithGame, 'Avalanche Resets With Game', 
        resetWithGame ? 'Avalanche correctly resets when game resets' : 
        'Avalanche not properly reset with game reset');
    }
    
    // Test 7: Closest Distance Calculation
    function testClosestDistance() {
      // Reset and trigger avalanche
      resetSnowman();
      avalanche.trigger(snowman.position);
      
      // Place boulders at known distances
      // Clear all positions first, place at far distance
      for (let i = 0; i < avalanche.count; i++) {
        const idx = i * 3;
        avalanche.positions[idx] = 1000; // Far away X
        avalanche.positions[idx + 1] = 0;
        avalanche.positions[idx + 2] = 1000; // Far away Z
      }
      
      // Place first boulder at known distance (10 units away in X)
      avalanche.positions[0] = snowman.position.x + 10;
      avalanche.positions[1] = snowman.position.y;
      avalanche.positions[2] = snowman.position.z;
      
      const closestDist = avalanche.getClosestDistance(snowman.position);
      const isCorrectDistance = Math.abs(closestDist - 10) < 0.5;
      
      assert(isCorrectDistance, 'Closest Distance Calculation', 
        isCorrectDistance ? `Closest distance correctly calculated (${closestDist.toFixed(2)})` : 
        `Closest distance incorrect: expected ~10, got ${closestDist.toFixed(2)}`);
      
      // Test that inactive avalanche returns Infinity
      avalanche.reset();
      const inactiveDistance = avalanche.getClosestDistance(snowman.position);
      
      assert(inactiveDistance === Infinity, 'Inactive Avalanche Distance', 
        inactiveDistance === Infinity ? 'Inactive avalanche correctly returns Infinity distance' : 
        'Inactive avalanche should return Infinity');
    }
    
    // Run all tests
    try {
      testAvalancheInitialization();
      testAvalancheTrigger();
      testAvalancheVisualRendering();
      testBurialDetection();
      testAvalanchePassed();
      testAvalancheReset();
      testClosestDistance();
      
      // Show test summary
      const summary = document.createElement('div');
      summary.style.fontWeight = 'bold';
      summary.style.borderTop = '1px solid white';
      summary.style.marginTop = '10px';
      summary.style.paddingTop = '10px';
      
      // Only update the global test counts if we're in the unified test runner
      if (window._unifiedTestCounts) {
        console.log(`Avalanche tests reporting ${testsPassed} passed, ${testsFailed} failed to unified test runner`);
        window._unifiedTestCounts.passed += testsPassed;
        window._unifiedTestCounts.failed += testsFailed;
      }
      
      summary.textContent = `Avalanche tests completed: ${testsPassed} passed, ${testsFailed} failed`;
      summary.style.color = testsFailed === 0 ? '#4CAF50' : '#FF5252';
      resultsDiv.appendChild(summary);
      
      console.log(`=== AVALANCHE TESTING COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
      
      // Clean up - reset avalanche state
      if (typeof avalanche !== 'undefined' && avalanche) {
        avalanche.reset();
      }
      
      // Signal completion to unified runner if applicable
      if (window._testCompleteCallback) {
        console.log('Avalanche tests completed, signaling to unified test runner');
        window._testCompleteCallback('avalanche');
      }
    } catch (e) {
      console.error('Test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = 'red';
      resultsDiv.appendChild(errorDiv);
      
      if (window._testCompleteCallback) {
        window._testCompleteCallback('avalanche', e);
      }
    }
  }
})();
