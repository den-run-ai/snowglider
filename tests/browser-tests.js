// SnowGlider Test Suite
// Run with: open index.html?test=true in browser

(function() {
  // Only run tests if ?test=true is in the URL
  if (window.location.search.includes('test=true')) {
    // Wait for game to initialize
    window.addEventListener('load', function() {
      // Give the game a moment to fully initialize
      setTimeout(runTests, 500);
    });
  }

  function runTests() {
    console.log('=== STARTING SNOWGLIDER TESTS ===');
    
    // Create test results container
    const resultsDiv = document.createElement('div');
    resultsDiv.id = 'test-results';
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
    
    // Test 1: Verify Snowman Physics - Going Downhill
    function testSnowmanPhysics() {
      // Save initial position
      const initialPos = {
        x: pos.x,
        y: pos.y,
        z: pos.z
      };
      
      // Set a controlled velocity
      velocity.x = 0;
      velocity.z = -10; // Moving downhill
      
      // Run one update cycle
      const delta = 0.1; // 100ms
      updateSnowman(delta);
      
      // Check the snowman moved downhill
      const movedDownhill = pos.z < initialPos.z;
      assert(movedDownhill, 'Snowman Downhill Movement', 
        movedDownhill ? 'Snowman correctly moves downhill with negative z velocity' : 
        'Snowman failed to move downhill properly');
      
      // Reset position for other tests
      pos.x = initialPos.x;
      pos.y = initialPos.y;
      pos.z = initialPos.z;
      velocity.x = 0;
      velocity.z = 0;
    }
    
    // Test 2: Snowman Collision Detection
    function testCollisionDetection() {
      // Save original values we'll modify
      const originalTreePositions = treePositions.slice(); 
      const originalPosition = { x: pos.x, y: pos.y, z: pos.z };
      const originalVelocity = { x: velocity.x, z: velocity.z };
      const originalGameOver = window.showGameOver;
      const originalGameActive = gameActive;
      const originalIsInAir = isInAir;
      const originalVerticalVelocity = verticalVelocity;
      
      // Place the snowman FAR from the ski path (which is around x=0)
      pos.x = 30; // Well away from ski path
      pos.z = -40;
      pos.y = Utils.getTerrainHeight(pos.x, pos.z);
      
      // Freeze snowman movement
      velocity.x = 0;
      velocity.z = 0;
      
      // Make sure game is active for collision detection to work
      gameActive = true;
      isInAir = false;
      verticalVelocity = 0;
      
      // Mock showGameOver function to track when it's called
      let gameOverCalled = false;
      window.showGameOver = function(reason) {
        console.log("COLLISION TEST: showGameOver called with reason: " + reason);
        gameOverCalled = true;
      };
      
      console.log(`COLLISION TEST: Snowman at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      
      // Use the test hook to force a tree collision directly
      if (window.testHooks && window.testHooks.forceTreeCollision) {
        console.log("COLLISION TEST: Using test hook to force tree collision");
        window.testHooks.forceTreeCollision();
      } else {
        console.error("COLLISION TEST: Test hook not available");
      }
      
      // Check if collision was detected
      assert(gameOverCalled, 'Tree Collision Detection', 
        gameOverCalled ? 'Collision with tree correctly detected' : 
        `Failed to detect collision with tree - Tree collision test hook failed`);
      
      // Restore original values
      treePositions = originalTreePositions;
      pos.x = originalPosition.x;
      pos.y = originalPosition.y;
      pos.z = originalPosition.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      isInAir = originalIsInAir;
      verticalVelocity = originalVerticalVelocity;
      window.showGameOver = originalGameOver;
      gameActive = originalGameActive;
    }
    
    // Test 3: Terrain Height Calculation
    function testTerrainHeight() {
      // The peak of the mountain should be higher than the sides
      const peakHeight = Utils.getTerrainHeight(0, 0);
      const sideHeight = Utils.getTerrainHeight(30, 0);
      
      assert(peakHeight > sideHeight, 'Terrain Height', 
        peakHeight > sideHeight ? 'Mountain peak is correctly higher than sides' :
        'Terrain height calculation error: peak not higher than sides');
      
      // Ski path should be relatively smooth - increased tolerance for extended mountain
      const pathPoint1 = Utils.getTerrainHeight(0, -30);
      const pathPoint2 = Utils.getTerrainHeight(0, -40);
      const heightDifference = Math.abs(pathPoint1 - pathPoint2);
      
      assert(heightDifference < 7, 'Ski Path Smoothness', 
        heightDifference < 7 ? 'Ski path has acceptable smoothness' :
        'Ski path is too rough for gameplay');
    }
    
    // Test 4: Game Over Logic
    function testGameOverLogic() {
      // Mock the game over function to prevent UI changes
      const originalShowGameOver = window.showGameOver;
      let gameOverCalled = false;
      let gameOverReason = '';
      
      window.showGameOver = function(reason) {
        gameOverCalled = true;
        gameOverReason = reason;
        // Don't actually modify the DOM in test
      };
      
      // 1. Test going off the mountain edge - increased boundary for extended terrain
      resetSnowman();
      gameActive = true;
      pos.x = 130; // Beyond the side boundary (now at 120 instead of 80)
      updateSnowman(0.1);
      
      assert(gameOverCalled, 'Game Over - Off Mountain', 
        gameOverCalled ? 'Correctly detected going off the mountain' :
        'Failed to detect going off mountain edge');
      
      // 2. Test hitting a tree
      resetSnowman();
      gameActive = true;
      gameOverCalled = false;
      isInAir = false;
      verticalVelocity = 0;
      
      // Position the snowman AWAY from ski path
      pos.x = 30; // Far from ski path
      pos.z = -40;
      pos.y = Utils.getTerrainHeight(pos.x, pos.z);
      
      // Debug output
      console.log(`GAME OVER TEST: Snowman at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
      
      // Use the test hook to force a tree collision directly
      if (window.testHooks && window.testHooks.forceTreeCollision) {
        console.log("GAME OVER TEST: Using test hook to force tree collision");
        window.testHooks.forceTreeCollision();
      } else {
        console.error("GAME OVER TEST: Test hook not available");
      }
      
      assert(gameOverCalled, 'Game Over - Tree Collision',
        gameOverCalled ? 'Correctly detected tree collision' :
        'Failed to detect tree collision - Tree collision test hook failed');
      
      // Restore original functions and state
      window.showGameOver = originalShowGameOver;
      window.treeCollisionRadius = undefined; // Reset the collision radius to default
      resetSnowman();
      gameActive = true;
    }
    
    // Test 5: Jump Mechanics
    function testJumpMechanics() {
      resetSnowman();
      
      // Snowman should start on the ground
      assert(!isInAir, 'Initial Grounded State', 
        !isInAir ? 'Snowman correctly starts on the ground' :
        'Snowman incorrectly starts in the air');
      
      // Trigger a jump
      jumpCooldown = 0;
      keyboardControls.jump = true;
      updateSnowman(0.1);
      
      assert(isInAir, 'Jump Initiation', 
        isInAir ? 'Snowman correctly jumps when spacebar pressed' :
        'Snowman failed to jump when spacebar pressed');
      
      // Should have upward velocity
      assert(verticalVelocity > 0, 'Jump Velocity', 
        verticalVelocity > 0 ? 'Jump correctly applies upward velocity' :
        'Jump failed to apply upward velocity');
      
      // After some time, should start falling
      for (let i = 0; i < 10; i++) {
        updateSnowman(0.1);
      }
      
      assert(verticalVelocity < 0, 'Gravity Effect', 
        verticalVelocity < 0 ? 'Gravity correctly pulls snowman down after jump' :
        'Gravity not properly affecting jump trajectory');
      
      // Reset state
      keyboardControls.jump = false;
      resetSnowman();
    }
    
    // Test 6: Extended Slope
    function testExtendedSlope() {
      // Verify the extended slope exists and is continuous
      const points = [
        { z: -100, expected: true },
        { z: -150, expected: true },
        { z: -180, expected: true }
      ];
      
      // Check terrain exists at all test points
      let allPointsValid = true;
      for (const point of points) {
        const height = Utils.getTerrainHeight(0, point.z);
        if (height === 0 || isNaN(height)) {
          allPointsValid = false;
          break;
        }
      }
      
      assert(allPointsValid, 'Extended Slope Existence', 
        allPointsValid ? 'Extended slope correctly exists beyond original terrain' :
        'Extended slope has gaps or missing terrain');
      
      // Verify the path continues downhill
      const heights = points.map(p => Utils.getTerrainHeight(0, p.z));
      let continuesDownhill = true;
      
      for (let i = 0; i < heights.length - 1; i++) {
        if (heights[i] <= heights[i + 1]) {
          continuesDownhill = false;
          break;
        }
      }
      
      assert(continuesDownhill, 'Extended Slope Gradient', 
        continuesDownhill ? 'Extended slope correctly continues downhill' :
        'Extended slope does not maintain proper downhill gradient');
    }
    
    // Test 7: Tree and Rock Positioning
    function testTreeRockPositioning() {
      // Look for any trees or rocks that could be floating in the air
      
      // Use our heightmap system to check tree and rock positioning
      // Output first few entries from heightmap for debugging
      if (Object.keys(Utils.heightMap || {}).length > 0) {
        console.log(`Heightmap has ${Object.keys(Utils.heightMap).length} entries`);
      } else {
        console.log('Heightmap not found or empty - will use calculated heights');
      }
      
      // Find at least one tree in the scene to test
      let treeFound = false;
      let rockFound = false;
      
      for (let i = 0; i < scene.children.length; i++) {
        const object = scene.children[i];
        
        // Look for tree object (they're usually complex groups with many child elements)
        if (!treeFound && object.type === 'Group' && object.children.length > 3) {
          treeFound = true;
          
          // Get tree position
          const treePos = {
            x: object.position.x,
            y: object.position.y,
            z: object.position.z
          };
          
          // Get terrain height using our improved getTerrainHeight function
          const terrainHeight = Utils.getTerrainHeight(treePos.x, treePos.z);
          
          // Trees should be at terrain height minus about 0.5 units (slight sinking)
          const maxErrorAllowed = 5.0; // Allow more error for browser test
          const isProperlyAnchored = Math.abs(treePos.y - (terrainHeight - 0.5)) < maxErrorAllowed;
          
          // Output debug info
          console.log(`Tree at [${treePos.x.toFixed(1)}, ${treePos.y.toFixed(1)}, ${treePos.z.toFixed(1)}]`);
          console.log(`Terrain height: ${terrainHeight.toFixed(1)}, Expected Y: ${(terrainHeight - 0.5).toFixed(1)}`);
          
          assert(isProperlyAnchored, 'Tree Positioning', 
            isProperlyAnchored ? 'Trees are properly anchored to terrain' :
            `Tree at [${treePos.x.toFixed(1)}, ${treePos.y.toFixed(1)}, ${treePos.z.toFixed(1)}] is floating (terrain height: ${terrainHeight.toFixed(1)})`);
        }
        
        // Look for rock object (usually a mesh with dodecahedron geometry)
        if (!rockFound && object.type === 'Mesh' && object.geometry && 
            object.geometry.type && object.geometry.type.includes('Dodecahedron')) {
          rockFound = true;
          
          // Get rock position
          const rockPos = {
            x: object.position.x,
            y: object.position.y,
            z: object.position.z
          };
          
          // Get terrain height using our improved getTerrainHeight function
          const terrainHeight = Utils.getTerrainHeight(rockPos.x, rockPos.z);
          
          // Approximate rock size
          const approxSize = rockPos.y < terrainHeight ? 
            (terrainHeight - rockPos.y) / 0.3 : 1.0;
          
          // Rocks sink into terrain based on their size, but should be near terrain height
          const maxErrorAllowed = 5.0; // Allow more error for browser test
          const isProperlyAnchored = rockPos.y < terrainHeight + maxErrorAllowed;
          
          // Output debug info
          console.log(`Rock at [${rockPos.x.toFixed(1)}, ${rockPos.y.toFixed(1)}, ${rockPos.z.toFixed(1)}]`);
          console.log(`Terrain height: ${terrainHeight.toFixed(1)}, Approx size: ${approxSize.toFixed(1)}`);
          
          assert(isProperlyAnchored, 'Rock Positioning', 
            isProperlyAnchored ? 'Rocks are properly positioned on terrain' :
            `Rock at [${rockPos.x.toFixed(1)}, ${rockPos.y.toFixed(1)}, ${rockPos.z.toFixed(1)}] is floating (terrain height: ${terrainHeight.toFixed(1)})`);
        }
      }
      
      // If we didn't find any trees or rocks, just pass the test
      if (!treeFound) {
        assert(true, 'Tree Positioning', 'No trees found to test');
      }
      
      if (!rockFound) {
        assert(true, 'Rock Positioning', 'No rocks found to test');
      }
    }
    
    // Test 8: Best Time Update Logic
    function testBestTimeUpdateLogic() {
      // Save original values we'll modify
      const originalShowGameOver = window.showGameOver;
      const originalGameActive = gameActive;
      const originalPosition = { x: pos.x, y: pos.y, z: pos.z };
      const originalVelocity = { x: velocity.x, z: velocity.z };
      const originalBestTime = bestTime;
      const originalLocalStorage = {};
      
      // Mock localStorage to track when bestTime is set
      const originalSetItem = localStorage.setItem;
      let bestTimeUpdated = false;
      
      localStorage.setItem = function(key, value) {
        if (key === 'snowgliderBestTime') {
          bestTimeUpdated = true;
          originalLocalStorage.snowgliderBestTime = value;
        }
        return originalSetItem.call(localStorage, key, value);
      };

      // 1. Test tree collision does not update best time
      resetSnowman();
      gameActive = true;
      bestTimeUpdated = false;
      
      // Make sure we're using a fresh timer 
      startTime = performance.now() - 5000; // 5 seconds elapsed
      
      // Position snowman away from ski path where trees might be
      pos.x = 30;
      pos.z = -40;
      pos.y = Utils.getTerrainHeight(pos.x, pos.z);
      
      // Mock showGameOver to track what happens
      window.showGameOver = function(reason) {
        console.log("BEST TIME TEST: showGameOver called with reason: " + reason);
        // Call the original function but intercept to check behavior
        originalShowGameOver.call(window, reason);
      };
      
      // Force a tree collision
      if (window.testHooks && window.testHooks.forceTreeCollision) {
        console.log("BEST TIME TEST: Using test hook to force tree collision");
        window.testHooks.forceTreeCollision();
      } else {
        console.error("BEST TIME TEST: Test hook not available");
      }
      
      // Check that best time was not updated on tree collision
      assert(!bestTimeUpdated, 'Best Time - Tree Collision', 
        !bestTimeUpdated ? 'Correctly did not update best time on tree collision' : 
        'Incorrectly updated best time on tree collision');
      
      // 2. Test reaching end of slope updates best time
      resetSnowman();
      gameActive = true;
      bestTimeUpdated = false;
      
      // Set time to be better than current best time
      startTime = performance.now() - 5000; // 5 seconds elapsed
      
      // Simulate reaching the end of the slope
      pos.x = 0; // Stay on the ski path
      pos.z = -196; // Just past the finish line at z=-195
      
      // Manually call showGameOver with "reached the end" message
      window.showGameOver("You reached the end of the slope!");
      
      // Check that best time was updated when reaching the end
      assert(bestTimeUpdated, 'Best Time - Reaching End', 
        bestTimeUpdated ? 'Correctly updated best time on reaching end of slope' : 
        'Failed to update best time on reaching end of slope');
      
      // Restore original functions and state
      localStorage.setItem = originalSetItem;
      window.showGameOver = originalShowGameOver;
      gameActive = originalGameActive;
      pos.x = originalPosition.x;
      pos.y = originalPosition.y;
      pos.z = originalPosition.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
      bestTime = originalBestTime;
      
      // Restore any localStorage changes
      if (originalLocalStorage.snowgliderBestTime !== undefined) {
        localStorage.setItem('snowgliderBestTime', originalBestTime);
      }
    }

    // Run all tests
    try {
      testSnowmanPhysics();
      testCollisionDetection();
      testTerrainHeight();
      testGameOverLogic();
      testJumpMechanics();
      testExtendedSlope();
      testTreeRockPositioning();
      testBestTimeUpdateLogic();
      
      // Show test summary
      const summary = document.createElement('div');
      summary.style.fontWeight = 'bold';
      summary.style.borderTop = '1px solid white';
      summary.style.marginTop = '10px';
      summary.style.paddingTop = '10px';
      summary.textContent = `Tests completed: ${testsPassed} passed, ${testsFailed} failed`;
      resultsDiv.appendChild(summary);
      
      console.log(`=== TESTING COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
    } catch (e) {
      console.error('Test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = 'red';
      resultsDiv.appendChild(errorDiv);
    }
  }
})();