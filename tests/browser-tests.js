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
      const originalGameOver = window.showGameOver;
      
      resetSnowman();
      
      // Mock showGameOver function
      let gameOverCalled = false;
      let gameOverReason = '';
      window.showGameOver = function(reason) {
        gameOverCalled = true;
        gameOverReason = reason;
        // Don't actually modify UI during tests
      };
      
      // Place snowman in a specific position
      pos.x = 10;
      pos.z = -40;
      pos.y = Utils.getTerrainHeight(pos.x, pos.z);
      
      // Add a tree right on top of the snowman position
      treePositions = [{ x: pos.x, y: pos.y, z: pos.z }];
      
      // Run the update cycle, which should detect the collision immediately
      updateSnowman(0.1);
      
      // Check if collision was detected via showGameOver
      assert(gameOverCalled, 'Tree Collision Detection', 
        gameOverCalled ? 'Collision with tree correctly detected' : 
        'Failed to detect collision with tree');
      
      // Restore original values
      treePositions = originalTreePositions;
      pos.x = originalPosition.x;
      pos.y = originalPosition.y;
      pos.z = originalPosition.z;
      window.showGameOver = originalGameOver;
      resetSnowman();
    }
    
    // Test 3: Terrain Height Calculation
    function testTerrainHeight() {
      // The peak of the mountain should be higher than the sides
      const peakHeight = Utils.getTerrainHeight(0, 0);
      const sideHeight = Utils.getTerrainHeight(30, 0);
      
      assert(peakHeight > sideHeight, 'Terrain Height', 
        peakHeight > sideHeight ? 'Mountain peak is correctly higher than sides' :
        'Terrain height calculation error: peak not higher than sides');
      
      // Ski path should be relatively smooth
      const pathPoint1 = Utils.getTerrainHeight(0, -30);
      const pathPoint2 = Utils.getTerrainHeight(0, -40);
      const heightDifference = Math.abs(pathPoint1 - pathPoint2);
      
      assert(heightDifference < 5, 'Ski Path Smoothness', 
        heightDifference < 5 ? 'Ski path has acceptable smoothness' :
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
      
      // 1. Test going off the mountain edge
      resetSnowman();
      gameActive = true;
      pos.x = 90; // Beyond the side boundary
      updateSnowman(0.1);
      
      assert(gameOverCalled, 'Game Over - Off Mountain', 
        gameOverCalled ? 'Correctly detected going off the mountain' :
        'Failed to detect going off mountain edge');
      
      // 2. Test hitting a tree
      resetSnowman();
      gameActive = true;
      gameOverCalled = false;
      
      // Position the snowman where a tree is
      const mockTree = { x: 0, y: 0, z: 0 };
      treePositions = [mockTree];
      pos.x = mockTree.x;
      pos.z = mockTree.z;
      updateSnowman(0.1);
      
      assert(gameOverCalled, 'Game Over - Tree Collision',
        gameOverCalled ? 'Correctly detected tree collision' :
        'Failed to detect tree collision');
      
      // Restore original functions and state
      window.showGameOver = originalShowGameOver;
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
    
    // Run all tests
    try {
      testSnowmanPhysics();
      testCollisionDetection();
      testTerrainHeight();
      testGameOverLogic();
      testJumpMechanics();
      
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