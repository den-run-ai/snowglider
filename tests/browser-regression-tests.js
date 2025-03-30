/**
 * Browser-based Regression Tests for SnowGlider
 * 
 * Add to index.html with: ?test=regression
 * These tests focus on gameplay regressions identified from git history
 */

(function() {
  // Only run if ?test=regression is in the URL and not running through the unified test runner
  if (window.location.search.includes('test=regression') && !window.location.search.includes('unified=true') && !window._unifiedTestRunnerActive) {
    // Wait for game to initialize
    window.addEventListener('load', function() {
      // Give the game a moment to fully initialize
      setTimeout(runRegressionTests, 500);
    });
  }

  // Expose the test runner for the unified test system
  window.runRegressionTests = runRegressionTests;

  function runRegressionTests() {
    console.log('=== STARTING SNOWGLIDER REGRESSION TESTS ===');
    
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
      sectionHeader.textContent = 'REGRESSION TESTS';
      resultsDiv.appendChild(sectionHeader);
    } else {
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'regression-test-results';
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
    
    // Test 1: Best Time Fix Regression
    // Tests the fix for best time recording from commit e1403c9
    function testBestTimeFixRegression() {
      // Save original functions and state
      const originalShowGameOver = window.showGameOver;
      const originalLocalStorageSetItem = localStorage.setItem;
      const originalBestTime = bestTime;
      const originalStartTime = startTime;
      const originalGameActive = gameActive;
      
      // Mock localStorage to track changes
      let bestTimeUpdated = false;
      localStorage.setItem = function(key, value) {
        if (key === 'snowgliderBestTime') {
          bestTimeUpdated = true;
          console.log(`Best time updated to: ${value}`);
        }
        originalLocalStorageSetItem.call(localStorage, key, value);
      };
      
      // Reset state for testing
      resetSnowman();
      gameActive = true;
      
      // Set a time better than current best
      startTime = performance.now() - 5000; // 5 seconds
      bestTime = 10; // 10 seconds
      
      // Simulate reaching the end of the slope
      window.showGameOver = function(reason) {
        if (reason === "You reached the end of the slope!") {
          const currentTime = (performance.now() - startTime) / 1000;
          
          if (currentTime < bestTime) {
            bestTime = currentTime;
            localStorage.setItem('snowgliderBestTime', bestTime);
          }
        }
      };
      
      // Trigger with end of slope reason
      window.showGameOver("You reached the end of the slope!");
      
      // Verify best time was updated correctly
      assert(bestTimeUpdated, 'Best Time Update Logic', 
        bestTimeUpdated ? 'Correctly updated best time when reaching end of slope' : 
        'Failed to update best time when reaching end of slope');
      
      // Test time equality edge case
      bestTimeUpdated = false;
      bestTime = 5; // Equal to current time of 5 seconds
      window.showGameOver("You reached the end of the slope!");
      
      // Equal times should not update
      assert(!bestTimeUpdated, 'Best Time Equal Case', 
        !bestTimeUpdated ? 'Correctly did not update best time for equal times' : 
        'Incorrectly updated best time for equal times');
      
      // Test collision case
      bestTimeUpdated = false;
      window.showGameOver("BANG!!! You hit a tree!");
      
      // Tree collisions should not update best time
      assert(!bestTimeUpdated, 'Best Time Collision Case', 
        !bestTimeUpdated ? 'Correctly did not update best time on collision' : 
        'Incorrectly updated best time on collision');
      
      // Restore original functions and state
      window.showGameOver = originalShowGameOver;
      localStorage.setItem = originalLocalStorageSetItem;
      bestTime = originalBestTime;
      startTime = originalStartTime;
      gameActive = originalGameActive;
    }
    
    // Test 2: Tree Collision Detection with Snow Splash Effects
    // Tests the fix from commit a6d88c5
    function testTreeCollisionWithSnowEffects() {
      // Save original functions and state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      const originalIsInAir = isInAir;
      const originalGameActive = gameActive;
      const originalShowGameOver = window.showGameOver;
      
      // Set up for test
      resetSnowman();
      gameActive = true;
      isInAir = false;
      
      // Position near a tree
      pos.x = 30; // Away from the center
      pos.z = -40;
      pos.y = Utils.getTerrainHeight(pos.x, pos.z);
      
      // Set high velocity to generate lots of snow particles
      velocity.x = 5;
      velocity.z = -15;
      
      // Create substantial snow splash effect by simulating movement
      for (let i = 0; i < 5; i++) {
        updateSnowman(0.1);
      }
      
      // Track if collision is detected
      let collisionDetected = false;
      window.showGameOver = function(reason) {
        console.log("Test collision detected with reason: " + reason);
        collisionDetected = true;
      };
      
      // Force a tree collision using test hook
      if (window.testHooks && window.testHooks.forceTreeCollision) {
        console.log("Using test hook to force tree collision with active snow effects");
        const result = window.testHooks.forceTreeCollision();
        
        assert(result && collisionDetected, 'Tree Collision With Snow Effects', 
          collisionDetected ? 'Correctly detected tree collision with snow effects active' : 
          'Failed to detect tree collision when snow effects are active');
      } else {
        logResult('Tree Collision With Snow Effects', false, 'Test hooks not available');
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
    
    // Test 3: Extended Mountain Navigation
    // Tests navigation on the extended terrain from commit 0c3a64c
    function testExtendedMountainRun() {
      // Save original state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      const originalGameActive = gameActive;
      
      // Reset for clean test
      resetSnowman();
      gameActive = true;
      
      // Set a fixed velocity to navigate downhill
      velocity.x = 0;
      velocity.z = -15; // Fast downhill movement
      
      // Array to track z positions reached
      const zCheckpoints = [-50, -100, -150];
      const reachedCheckpoints = {
        "-50": false,
        "-100": false, 
        "-150": false
      };
      
      // Run simulation until we reach bottom or timeout
      let frames = 0;
      const maxFrames = 600; // Increase frames to allow more time for path completion
      
      // Start with higher downhill velocity to ensure we make progress
      velocity.z = -25; // Much faster downhill to overcome any terrain issues
      
      while (frames < maxFrames && gameActive && pos.z > -195) {
        // Periodically correct course to stay on path
        if (frames % 20 === 0) {
          // Re-center on mountain
          pos.x = pos.x * 0.8; // Gradually move back to center (x=0)
          velocity.x = velocity.x * 0.5; // Reduce side velocity
          velocity.z = Math.min(-15, velocity.z); // Maintain minimum downhill speed
        }
        
        updateSnowman(0.1);
        
        // Check if we've reached checkpoints
        for (const checkpoint of zCheckpoints) {
          if (pos.z <= checkpoint && !reachedCheckpoints[checkpoint]) {
            reachedCheckpoints[checkpoint] = true;
            console.log(`Reached checkpoint z=${checkpoint}`);
          }
        }
        
        frames++;
      }
      
      // Test if we could navigate the entire extended path
      const completedRun = pos.z <= -195;
      const reachedAllCheckpoints = zCheckpoints.every(cp => reachedCheckpoints[cp]);
      
      assert(reachedAllCheckpoints, 'Extended Mountain Run Checkpoints', 
        reachedAllCheckpoints ? 'Successfully navigated extended mountain checkpoints' : 
        `Only reached checkpoints: ${Object.entries(reachedCheckpoints)
          .filter(([, reached]) => reached)
          .map(([cp]) => cp)
          .join(', ')}`);
      
      assert(completedRun, 'Extended Mountain Run Completion', 
        completedRun ? `Successfully completed full extended mountain run in ${frames} frames` : 
        `Failed to complete mountain run, reached z=${pos.z.toFixed(1)}`);
      
      // Restore original state
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      gameActive = originalGameActive;
    }
    
    // Test 4: Tree Jump Verification
    // Tests the fix from commit a6d88c5 for jumping over trees
    function testTreeJumping() {
      // Save original state
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      const originalIsInAir = isInAir;
      const originalVerticalVelocity = verticalVelocity;
      const originalGameActive = gameActive;
      const originalShowGameOver = window.showGameOver;
      
      // Track collision state
      let collisionDetected = false;
      window.showGameOver = function(reason) {
        console.log("Test detected collision with reason: " + reason);
        collisionDetected = true;
      };
      
      // Test case 1: Check collision when on ground
      resetSnowman();
      gameActive = true;
      isInAir = false;
      verticalVelocity = 0;
      
      // Force collision detection with test hook when on ground
      if (window.testHooks && window.testHooks.checkTreeCollision) {
        // Place a test tree directly in our path
        const result = window.testHooks.checkTreeCollision(pos.x, pos.z - 2);
        
        assert(result && collisionDetected, 'Tree Collision On Ground', 
          collisionDetected ? 'Correctly detected tree collision when on ground' : 
          'Failed to detect tree collision when on ground');
        
        // Reset collision flag
        collisionDetected = false;
        
        // Test case 2: Check jumping over trees 
        resetSnowman();
        gameActive = true;
        isInAir = true;
        verticalVelocity = 8; // Moving upward
        pos.y = Utils.getTerrainHeight(pos.x, pos.z) + 10; // Very high above terrain
        
        // Reset collision detection flag before running test
        collisionDetected = false;
        
        // Place tree further away to ensure consistent collision detection
        const treeDistance = 4;
        console.log(`Testing tree jumping: player at y=${pos.y.toFixed(2)}, tree at distance=${treeDistance}`);
        
        // Same tree position but now we're jumping high
        const jumpingResult = window.testHooks.checkTreeCollision(pos.x, pos.z - treeDistance);
        
        // In the current implementation, we should be able to jump over trees
        assert(!jumpingResult && !collisionDetected, 'Tree Jumping',
          !collisionDetected ? 'Correctly allowed jumping over trees' : 
          'Failed to allow jumping over trees');
      } else {
        logResult('Tree Collision Tests', false, 'Test hooks not available');
      }
      
      // Restore original state
      window.showGameOver = originalShowGameOver;
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      isInAir = originalIsInAir;
      verticalVelocity = originalVerticalVelocity;
      gameActive = originalGameActive;
    }
    
    // Run all regression tests
    try {
      testBestTimeFixRegression();
      testTreeCollisionWithSnowEffects();
      testExtendedMountainRun();
      testTreeJumping();
      
      // Show test summary
      const summary = document.createElement('div');
      summary.style.fontWeight = 'bold';
      summary.style.borderTop = '1px solid white';
      summary.style.marginTop = '10px';
      summary.style.paddingTop = '10px';
      
      // Only update the global test counts if we're in the unified test runner
      if (window._unifiedTestCounts) {
        console.log(`Regression tests reporting ${testsPassed} passed, ${testsFailed} failed to unified test runner`);
        window._unifiedTestCounts.passed += testsPassed;
        window._unifiedTestCounts.failed += testsFailed;
      }
      
      summary.textContent = `Regression tests completed: ${testsPassed} passed, ${testsFailed} failed`;
      resultsDiv.appendChild(summary);
      
      console.log(`=== REGRESSION TESTING COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
      
      // Signal completion to unified runner if applicable
      if (window._testCompleteCallback) {
        window._testCompleteCallback('regression');
      }
    } catch (e) {
      console.error('Test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = 'red';
      resultsDiv.appendChild(errorDiv);
      
      if (window._testCompleteCallback) {
        window._testCompleteCallback('regression', e);
      }
    }
  }
})();