/**
 * Browser Tree Collision Tests for SnowGlider
 * 
 * These tests specifically focus on the tree collision detection issues
 * that have been identified in the git history.
 * 
 * Run with: open index.html?test=trees
 */

(function() {
  // Only run if ?test=trees is in the URL and not running through the unified test runner
  if (window.location.search.includes('test=trees') && !window.location.search.includes('unified=true') && !window._unifiedTestRunnerActive) {
    // Wait for game to initialize
    window.addEventListener('load', function() {
      // Give the game a moment to fully initialize
      setTimeout(runTreeTests, 500);
    });
  }
  
  // Expose the test runner for the unified test system
  window.runTreeTests = runTreeTests;
  
  function runTreeTests() {
    console.log('=== STARTING SNOWGLIDER TREE COLLISION TESTS ===');
    
    // Create or use test results container
    let resultsDiv;
    if (window._unifiedTestResults) {
      resultsDiv = window._unifiedTestResults;
      
      // Add section header
      const sectionHeader = document.createElement('div');
      sectionHeader.style.fontWeight = 'bold';
      sectionHeader.style.fontSize = '16px';
      sectionHeader.style.marginTop = '15px';
      sectionHeader.style.marginBottom = '10px';
      sectionHeader.style.borderBottom = '1px solid white';
      sectionHeader.textContent = 'TREE COLLISION TESTS';
      resultsDiv.appendChild(sectionHeader);
    } else {
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'tree-test-results';
      resultsDiv.style.position = 'absolute';
      resultsDiv.style.top = '10px';
      resultsDiv.style.left = '10px';
      resultsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
      resultsDiv.style.color = 'white';
      resultsDiv.style.padding = '10px';
      resultsDiv.style.fontFamily = 'monospace';
      resultsDiv.style.fontSize = '14px';
      resultsDiv.style.zIndex = '9999';
      resultsDiv.style.maxHeight = '80%';
      resultsDiv.style.overflow = 'auto';
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
    
    // Test 1: Tree Position Array Verification
    // This test verifies that treePositions array accurately represents all trees in the scene
    function testTreePositionArray() {
      // Count visual trees in the scene
      let visualTrees = 0;
      for (let i = 0; i < scene.children.length; i++) {
        const object = scene.children[i];
        if (object.type === 'Group' && object.children.length > 3) {
          visualTrees++;
        }
      }
      
      // Count trees in collision array
      const collisionTrees = treePositions.length;
      
      console.log(`Visual trees in scene: ${visualTrees}`);
      console.log(`Trees in collision array: ${collisionTrees}`);
      
      // Check if counts are reasonably close
      const maxDifference = Math.max(visualTrees, collisionTrees) * 0.1; // Allow 10% difference
      const difference = Math.abs(visualTrees - collisionTrees);
      
      assert(difference <= maxDifference, 'Tree Count Consistency', 
        difference <= maxDifference ? 
        `Tree counts match within tolerance: ${visualTrees} visual, ${collisionTrees} collision` : 
        `Tree counts differ too much: ${visualTrees} visual, ${collisionTrees} collision`);
    }
    
    // Test 2: Extended Terrain Tree Collision
    // This test verifies that trees in the extended terrain area (z < -80) can be collided with
    function testExtendedTerrainTreeCollision() {
      // Save original state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      const originalGameActive = gameActive;
      const originalShowGameOver = window.showGameOver;
      
      // Track if collision is detected
      let collisionDetected = false;
      window.showGameOver = function(reason) {
        console.log(`TEST: showGameOver called with reason: ${reason}`);
        collisionDetected = true;
      };
      
      resetSnowman();
      gameActive = true;
      
      // Look for trees in the extended terrain area
      const extendedTrees = treePositions.filter(tree => tree.z < -80);
      console.log(`Found ${extendedTrees.length} trees in extended terrain area (z < -80)`);
      
      if (extendedTrees.length === 0) {
        assert(false, 'Extended Terrain Trees', 'No trees found in extended terrain area (z < -80)');
      } else {
        // Test collision with a tree in the extended area
        const testTree = extendedTrees[0];
        console.log(`Testing collision with tree at (${testTree.x.toFixed(2)}, ${testTree.z.toFixed(2)})`);
        
        // Position snowman at the tree
        pos.x = testTree.x;
        pos.z = testTree.z;
        pos.y = testTree.y;
        isInAir = false;
        verticalVelocity = 0;
        
        // Run one update cycle
        updateSnowman(0.1);
        
        // Check if collision was detected
        assert(collisionDetected, 'Extended Terrain Tree Collision', 
          collisionDetected ? 
          `Successfully detected collision with tree at z=${testTree.z.toFixed(1)} - FIX APPLIED!` : 
          `Failed to detect collision with tree at z=${testTree.z.toFixed(1)} - FIX NOT APPLIED`);
      }
      
      // Restore original state
      window.showGameOver = originalShowGameOver;
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      gameActive = originalGameActive;
    }
    
    // Test 3: Test Hook Consistency
    // This test verifies that the tree collision test hooks work correctly
    function testCollisionTestHooks() {
      // Save original state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalGameActive = gameActive;
      const originalShowGameOver = window.showGameOver;
      
      resetSnowman();
      gameActive = true;
      
      // Track if collision is detected
      let forceCollisionDetected = false;
      let checkCollisionDetected = false;
      
      window.showGameOver = function(reason) {
        console.log(`TEST HOOK: showGameOver called with reason: ${reason}`);
        if (reason.includes('tree')) {
          if (testingForce) forceCollisionDetected = true;
          else checkCollisionDetected = true;
        }
      };
      
      // Test 3.1: forceTreeCollision test hook
      let testingForce = true;
      if (window.testHooks && window.testHooks.forceTreeCollision) {
        window.testHooks.forceTreeCollision();
        
        assert(forceCollisionDetected, 'Force Tree Collision Hook', 
          forceCollisionDetected ? 
          'forceTreeCollision test hook correctly triggered collision' : 
          'forceTreeCollision test hook failed to trigger collision');
      } else {
        assert(false, 'Force Tree Collision Hook', 'forceTreeCollision test hook not available');
      }
      
      // Test 3.2: checkTreeCollision test hook
      testingForce = false;
      if (window.testHooks && window.testHooks.checkTreeCollision) {
        // Place a test tree exactly at the snowman's position
        window.testHooks.checkTreeCollision(pos.x, pos.z);
        
        assert(checkCollisionDetected, 'Check Tree Collision Hook', 
          checkCollisionDetected ? 
          'checkTreeCollision test hook correctly detected collision' : 
          'checkTreeCollision test hook failed to detect collision');
        
        // Test jumping over trees
        checkCollisionDetected = false;
        isInAir = true;
        verticalVelocity = 5; // Moving upward
        pos.y = Utils.getTerrainHeight(pos.x, pos.z) + 6; // 6 units above terrain
        
        // The test hook doesn't implement jumping over trees, so it should still detect collision
        window.testHooks.checkTreeCollision(pos.x, pos.z);
        
        assert(checkCollisionDetected, 'Check Tree Collision Hook (Jumping)', 
          checkCollisionDetected ? 
          'checkTreeCollision correctly ignored jumping exemption (by design)' : 
          'checkTreeCollision incorrectly handled jumping exemption');
        
        // Restore normal jumping state
        isInAir = false;
        verticalVelocity = 0;
      } else {
        assert(false, 'Check Tree Collision Hook', 'checkTreeCollision test hook not available');
      }
      
      // Restore original state
      window.showGameOver = originalShowGameOver;
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      gameActive = originalGameActive;
    }
    
    // Test 4: Tree Positioning with Snow Splash Effects
    // This test verifies that the snow splash effects don't affect tree collision detection
    function testTreeCollisionWithSnowSplash() {
      // Save original state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      const originalIsInAir = isInAir;
      const originalGameActive = gameActive;
      const originalShowGameOver = window.showGameOver;
      
      resetSnowman();
      gameActive = true;
      isInAir = false;
      
      // Find a tree to collide with
      let testTree = null;
      for (let i = 0; i < treePositions.length; i++) {
        if (Math.abs(treePositions[i].x) >= 20) { // Away from ski path
          testTree = treePositions[i];
          break;
        }
      }
      
      if (!testTree) {
        assert(false, 'Snow Splash Tree Collision', 'No suitable tree found for testing');
      } else {
        // Position snowman near the tree
        pos.x = testTree.x;
        pos.z = testTree.z;
        pos.y = Utils.getTerrainHeight(pos.x, pos.z);
        
        // Set high velocity to generate lots of snow particles
        velocity.x = 5;
        velocity.z = -15;
        
        // Track if collision is detected
        let collisionDetected = false;
        window.showGameOver = function(reason) {
          console.log(`SNOW TEST: showGameOver called with reason: ${reason}`);
          if (reason.includes('tree')) {
            collisionDetected = true;
          }
        };
        
        // Run animation cycle with snow particles active
        for (let i = 0; i < 5; i++) {
          // Create substantial snow splash effect
          Utils.updateSnowSplash(snowSplash, 0.1, snowman, velocity, isInAir, scene);
          
          // Ensure snowman position is properly restored in animation loop
          snowman.position.set(pos.x, pos.y, pos.z);
          
          // Run update cycle
          updateSnowman(0.1);
          
          if (collisionDetected) break;
        }
        
        assert(collisionDetected, 'Snow Splash Tree Collision', 
          collisionDetected ? 
          'Correctly detected tree collision with snow splash effects active' : 
          'Failed to detect tree collision with snow splash effects active');
      }
      
      // Restore original state
      window.showGameOver = originalShowGameOver;
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      isInAir = originalIsInAir;
      gameActive = originalGameActive;
    }
    
    // Run all tests
    try {
      testTreePositionArray();
      testExtendedTerrainTreeCollision();
      testCollisionTestHooks();
      testTreeCollisionWithSnowSplash();
      
      // Show test summary
      const summary = document.createElement('div');
      summary.style.fontWeight = 'bold';
      summary.style.borderTop = '1px solid white';
      summary.style.marginTop = '10px';
      summary.style.paddingTop = '10px';
      
      // Only update the global test counts if we're in the unified test runner
      if (window._unifiedTestCounts) {
        console.log(`Tree tests reporting ${testsPassed} passed, ${testsFailed} failed to unified test runner`);
        window._unifiedTestCounts.passed += testsPassed;
        window._unifiedTestCounts.failed += testsFailed;
      }
      
      summary.textContent = `Tree tests completed: ${testsPassed} passed, ${testsFailed} failed`;
      resultsDiv.appendChild(summary);
      
      console.log(`=== TREE TESTING COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
      
      // Signal completion to unified runner if applicable
      if (window._testCompleteCallback) {
        window._testCompleteCallback('tree');
      }
    } catch (e) {
      console.error('Test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = 'red';
      resultsDiv.appendChild(errorDiv);
      
      if (window._testCompleteCallback) {
        window._testCompleteCallback('tree', e);
      }
    }
  }
})();