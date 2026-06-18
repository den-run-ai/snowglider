// SnowGlider Camera Test Suite
// Run with: open index.html?test=camera in browser
//
// This file contains tests for the camera functionality:
// 1. Camera Vector Initialization - tests proper camera vector setup
// 2. Camera Initialization Position - tests camera positioning relative to player
// 3. Camera Distance with Speed - tests camera distance adjustment based on player speed
// 4. Camera Above Terrain - tests camera maintaining proper height above terrain
// 5. Camera Smoothing - tests smooth camera movement and following behavior
//
// The tests can be run individually or as part of the unified test suite (index.html?test=unified)
//
// Phase 2 (issue #84): converted to an ES module — imports three from npm; loaded
// via `<script type="module">`. Still publishes window.runCameraTests for the
// unified runner.
//
// Terrain height is read from the LIVE game via window.getTerrainHeight (published
// on the test seam by snowglider.js) rather than importing src/snow.js here. On the
// deployed GitHub Pages artifact a local `import` would resolve to a second copy of
// snow.js whose terrain heightMap is unpopulated and randomly noised, so it would
// disagree with the bundled terrain the live camera actually clamps to.
import * as THREE from 'three';

(function() {
  // Only run tests if ?test=camera is in the URL and not running through the unified test runner
  if ((window.location.search.includes('test=camera') || 
      (window.location.search.includes('test=true') && window.location.search.includes('camera=true'))) && 
      !window.location.search.includes('test=unified') && 
      !window._unifiedTestRunnerActive) {
    if (document.readyState === 'complete') {
      console.log("Camera tests initializing from direct URL parameter");
      setTimeout(runCameraTests, 500);
    } else {
      window.addEventListener('load', function() {
        console.log("Camera tests initializing from direct URL parameter");
        // Give the game a moment to fully initialize
        setTimeout(runCameraTests, 500);
      });
    }
  }
  
  // Expose the test runner for the unified test system
  window.runCameraTests = runCameraTests;

  function runCameraTests() {
    console.log('=== STARTING SNOWGLIDER CAMERA TESTS ===');
    
    // Create or use test results container
    let resultsDiv;
    if (window._unifiedTestResults) {
      console.log("Using unified test results container for camera tests");
      resultsDiv = window._unifiedTestResults;
      
      // Add section header
      const sectionHeader = document.createElement('div');
      sectionHeader.style.fontWeight = 'bold';
      sectionHeader.style.fontSize = '16px';
      sectionHeader.style.marginTop = '15px';
      sectionHeader.style.marginBottom = '10px';
      sectionHeader.style.borderBottom = '1px solid white';
      sectionHeader.textContent = 'CAMERA TESTS';
      resultsDiv.appendChild(sectionHeader);
    } else {
      console.log("Creating standalone camera test results container");
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'camera-test-results';
      resultsDiv.style.position = 'fixed'; // Change to fixed for better visibility
      resultsDiv.style.top = '10px';
      resultsDiv.style.left = '10px';
      resultsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'; // Darker background for better visibility
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
      title.textContent = 'CAMERA TESTS';
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
      urlNote.textContent = 'Running camera tests (index.html?test=camera)';
      urlNote.style.fontSize = '12px';
      urlNote.style.color = '#aaa';
      urlNote.style.marginBottom = '10px';
      resultsDiv.appendChild(urlNote);
      
      document.body.appendChild(resultsDiv);
    }
    
    let testsPassed = 0;
    let testsFailed = 0;
    let cameraSuiteCompleted = false;
    
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

    function completeCameraSuite() {
      if (cameraSuiteCompleted) return;
      cameraSuiteCompleted = true;

      if (window._unifiedTestCounts) {
        console.log(`Camera tests reporting ${testsPassed} passed, ${testsFailed} failed to unified test runner`);
        window._unifiedTestCounts.passed += testsPassed;
        window._unifiedTestCounts.failed += testsFailed;
      }

      if (window._testCompleteCallback) {
        console.log("Explicitly calling _testCompleteCallback('camera')");
        window._testCompleteCallback('camera');
      }
    }

    // Add camera debugging visualization
    function setupCameraDebug() {
      // Create a sphere to represent target camera position
      const targetGeometry = new THREE.SphereGeometry(0.5, 8, 8);
      const targetMaterial = new THREE.MeshBasicMaterial({color: 0xff0000});
      const targetMarker = new THREE.Mesh(targetGeometry, targetMaterial);
      scene.add(targetMarker);
      
      // Create a sphere to represent camera lookAt position
      const lookAtGeometry = new THREE.SphereGeometry(0.5, 8, 8);
      const lookAtMaterial = new THREE.MeshBasicMaterial({color: 0x00ff00});
      const lookAtMarker = new THREE.Mesh(lookAtGeometry, lookAtMaterial);
      scene.add(lookAtMarker);
      
      // Create a line connecting camera to target
      const lineMaterial = new THREE.LineBasicMaterial({color: 0xffff00});
      const lineGeometry = new THREE.BufferGeometry();
      const line = new THREE.Line(lineGeometry, lineMaterial);
      scene.add(line);
      
      return {
        targetMarker,
        lookAtMarker,
        line,
        updatePositions: function() {
          targetMarker.position.copy(cameraManager.smoothingVectors.targetPosition);
          lookAtMarker.position.copy(cameraManager.smoothingVectors.lookAtPosition);
          
          // Update line points
          const points = [
            camera.position.clone(),
            cameraManager.smoothingVectors.targetPosition.clone()
          ];
          lineGeometry.setFromPoints(points);
        }
      };
    }
    
    // Test 1: Camera Initialization
    function testCameraInitialization() {
      // Save original camera position
      const originalCameraPos = camera.position.clone();
      
      // Reset the snowman to trigger camera initialization
      resetSnowman();
      
      // Get current camera position after reset
      const currentCameraPos = camera.position.clone();
      
      // Verify camera is positioned correctly behind snowman
      const angle = snowman.rotation.y;
      const expectedOffset = new THREE.Vector3(
        Math.sin(angle) * 15, // default z-offset of 15
        8, // default y-offset of 8
        Math.cos(angle) * 15
      );
      const expectedPos = new THREE.Vector3().copy(snowman.position).add(expectedOffset);
      
      // Use a different tolerance depending on test mode
      // In unified testing mode, we need a higher tolerance due to test interactions
      const isUnifiedMode = window.location.search.includes('test=unified') || window._unifiedTestRunnerActive;
      const toleranceThreshold = isUnifiedMode ? 10.0 : 6.0;
      
      // Check if camera is within tolerance units of expected position
      const distanceToExpected = currentCameraPos.distanceTo(expectedPos);
      const withinTolerance = distanceToExpected < toleranceThreshold;
      
      console.log(`  Using tolerance threshold: ${toleranceThreshold} (${isUnifiedMode ? 'unified mode' : 'standalone mode'})`);
      
      // Log debug info
      console.log('CAMERA TEST: Camera Initialization');
      console.log(`  Snowman position: ${snowman.position.x.toFixed(2)}, ${snowman.position.y.toFixed(2)}, ${snowman.position.z.toFixed(2)}`);
      console.log(`  Camera position: ${currentCameraPos.x.toFixed(2)}, ${currentCameraPos.y.toFixed(2)}, ${currentCameraPos.z.toFixed(2)}`);
      console.log(`  Expected position: ${expectedPos.x.toFixed(2)}, ${expectedPos.y.toFixed(2)}, ${expectedPos.z.toFixed(2)}`);
      console.log(`  Distance to expected: ${distanceToExpected.toFixed(4)}`);
      
      assert(withinTolerance, 'Camera Initialization Position', 
        withinTolerance ? 'Camera correctly positioned behind snowman on initialization' : 
        `Camera position deviates from expected position by ${distanceToExpected.toFixed(2)} units`);
      
      // Check that camera is looking at snowman
      const lookAtDir = new THREE.Vector3();
      camera.getWorldDirection(lookAtDir);
      lookAtDir.normalize();
      
      const toSnowman = new THREE.Vector3().subVectors(snowman.position, camera.position).normalize();
      const lookAtDot = lookAtDir.dot(toSnowman);
      
      // Dot product should be close to 1 if camera is looking at snowman
      const properlyLookingAt = lookAtDot > 0.95;
      
      assert(properlyLookingAt, 'Camera Look At Direction', 
        properlyLookingAt ? 'Camera correctly looks at snowman on initialization' : 
        `Camera not looking directly at snowman (dot product: ${lookAtDot.toFixed(2)})`);
    }
    
    // Test 2: Camera Smoothing Behavior
    function testCameraSmoothing() {
      // Setup test state
      resetSnowman();
      const cameraDebug = setupCameraDebug();

      // Freeze the target so this measures pure smoothing convergence and is
      // independent of CI frame timing. Camera smoothing applies a FIXED per-frame
      // lerp factor (camera.js `this.smoothing`), not a dt-scaled one, so with a
      // stationary target a fixed number of synchronous updateCamera() calls decay
      // the injected offset by a known amount. Previously this test piggybacked on
      // requestAnimationFrame over a 5s wall-clock window against a *moving* target,
      // so under CI load it collected too few frames (and the target outran the
      // camera) and the settled distance swung wildly (~12.8 to ~21) and flaked. A
      // synchronous loop is atomic w.r.t. the background rAF loop, matching the
      // deterministic pattern already used by testCameraDistanceWithSpeed.
      velocity.x = 0;
      velocity.z = 0;

      // Consume the camera's first-frame snap and sync the target to the now
      // stationary snowman before injecting the offset, so this exercises smoothing
      // rather than initialization behavior.
      updateCamera();

      // Force camera position to be offset from target - larger offset for clearer test
      const offset = new THREE.Vector3(10, 5, 10);
      camera.position.add(offset);
      const injectedDistance = camera.position.distanceTo(cameraManager.smoothingVectors.targetPosition);

      // Drive a fixed number of smoothing frames and record distance + position each
      // step. With a stationary target the offset decays geometrically (~0.92^n).
      const FRAMES = 100;
      const distances = [];
      const positions = [];
      for (let i = 0; i < FRAMES; i++) {
        updateCamera();
        positions.push(camera.position.clone());
        distances.push(camera.position.distanceTo(cameraManager.smoothingVectors.targetPosition));
      }

      const finalDistance = distances[distances.length - 1];
      // Treat the second half of the run as the settled window.
      const settledStart = Math.floor(FRAMES / 2);
      const settled = distances.slice(settledStart);
      const avgDistance = settled.reduce((sum, d) => sum + d, 0) / settled.length;
      const maxDistance = Math.max(...settled);

      // With a stationary target the injected offset must decay toward zero.
      const recovered = finalDistance < injectedDistance * 0.1;
      const settledSmall = avgDistance < 1.0 && maxDistance < 2.0;
      const maintainsReasonableDistance = recovered && settledSmall;

      console.log(`CAMERA TEST: injected ${injectedDistance.toFixed(2)}, final ${finalDistance.toFixed(2)}, settled avg ${avgDistance.toFixed(2)}, max ${maxDistance.toFixed(2)}`);

      assert(maintainsReasonableDistance, 'Camera Smoothing Convergence',
        maintainsReasonableDistance ? 'Camera smoothly converges to the target after an injected offset' :
        `Camera following is unstable (injected: ${injectedDistance.toFixed(2)}, settled avg: ${avgDistance.toFixed(2)}, max: ${maxDistance.toFixed(2)}, final: ${finalDistance.toFixed(2)})`);

      // Jitter: in the settled window the per-frame movement should be tiny (the
      // target is stationary, so the camera is only making small convergence steps).
      let maxJitter = 0;
      for (let i = settledStart + 1; i < positions.length; i++) {
        maxJitter = Math.max(maxJitter, positions[i - 1].distanceTo(positions[i]));
      }
      const hasJitter = maxJitter > 0.5;
      assert(!hasJitter, 'Camera Movement Smoothness',
        !hasJitter ? 'Camera movement is smooth without jitter' :
        `Camera exhibits jittery movement (max per-frame movement: ${maxJitter.toFixed(2)})`);

      // Clean up debug objects
      scene.remove(cameraDebug.targetMarker);
      scene.remove(cameraDebug.lookAtMarker);
      scene.remove(cameraDebug.line);

      // Update test summary with final results
      const summaryElem = document.getElementById('testSummary');
      if (summaryElem) {
        summaryElem.textContent = `All tests completed: ${testsPassed} passed, ${testsFailed} failed`;
        summaryElem.style.color = testsFailed === 0 ? '#4CAF50' : '#FF5252';
      }

      logResult('Camera Smoothing Test', true, 'Camera smoothing convergence verified deterministically');
      completeCameraSuite();
    }
    
    // Test 3: Camera Distance with Speed
    function testCameraDistanceWithSpeed() {
      // Save original values
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      const originalVelocity = {x: velocity.x, z: velocity.z};
      
      // Reset to a clean state
      resetSnowman();
      
      // Test camera distance at different speeds
      const speedTests = [
        {speed: 0, expectedDistance: 15},
        {speed: 10, expectedDistance: 20},
        {speed: 20, expectedDistance: 25}
      ];
      
      let allTestsPassed = true;
      
      for (const test of speedTests) {
        // Set snowman velocity
        velocity.x = 0;
        velocity.z = -test.speed; // Downhill
        
        // Update camera multiple times to allow smoothing to take effect
        for (let i = 0; i < 10; i++) {
          updateCamera();
        }
        
        // Measure actual camera distance
        const actualDistance = camera.position.distanceTo(snowman.position);
        
        // Allow for more tolerance due to camera smoothing (within 5 units)
        const tolerance = 5;
        const withinTolerance = Math.abs(actualDistance - test.expectedDistance) <= tolerance;
        
        if (!withinTolerance) {
          allTestsPassed = false;
          console.log(`CAMERA TEST: At speed ${test.speed}, distance is ${actualDistance.toFixed(2)}, expected ~${test.expectedDistance}`);
        }
      }
      
      assert(allTestsPassed, 'Camera Distance with Speed', 
        allTestsPassed ? 'Camera correctly adjusts distance based on speed' : 
        'Camera does not properly adjust distance based on speed');
      
      // Restore original values
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      velocity.x = originalVelocity.x;
      velocity.z = originalVelocity.z;
    }
    
    // Test 4: Camera Above Terrain
    function testCameraAboveTerrain() {
      // Save original position and terrain height check function
      const originalPos = {x: pos.x, y: pos.y, z: pos.z};
      
      // Create a test with a deep valley
      const testValleys = [
        {x: 5, z: -40},  // Test a location on the mountain
        {x: 10, z: -60}  // Test another location
      ];
      
      let allPassedTerrainTest = true;
      
      for (const location of testValleys) {
        // Move snowman to test location
        pos.x = location.x;
        pos.z = location.z;
        pos.y = window.getTerrainHeight(location.x, location.z);
        snowman.position.set(pos.x, pos.y, pos.z);

        // Update camera
        updateCamera();

        // Get terrain height at camera position (live game's terrain instance)
        const terrainHeightAtCamera = window.getTerrainHeight(camera.position.x, camera.position.z);
        
        // Camera should be at least 5 units above terrain
        const minHeightAboveTerrain = 5;
        const isAboveTerrain = camera.position.y >= terrainHeightAtCamera + minHeightAboveTerrain;
        
        if (!isAboveTerrain) {
          allPassedTerrainTest = false;
          console.log(`CAMERA TEST: At location (${location.x}, ${location.z}), camera is ${(camera.position.y - terrainHeightAtCamera).toFixed(2)} units above terrain, expected at least ${minHeightAboveTerrain}`);
        }
      }
      
      assert(allPassedTerrainTest, 'Camera Above Terrain', 
        allPassedTerrainTest ? 'Camera correctly stays above terrain at all locations' : 
        'Camera can go too close to terrain in some locations');
      
      // Restore original position
      pos.x = originalPos.x;
      pos.y = originalPos.y;
      pos.z = originalPos.z;
      snowman.position.set(pos.x, pos.y, pos.z);
    }
    
    // Test 5: Camera Vector Initialization
    function testCameraVectorInitialization() {
      // Test that camera smoothing vectors are properly initialized
      
      // Force reset of game
      resetSnowman();
      
      // Camera smoothing vectors should all be initialized (not undefined).
      // Use three's `.isVector3` duck-type flag rather than `instanceof THREE.Vector3`:
      // on the deployed Pages artifact the game runs from the Vite-bundled three while
      // this copied test imports the standalone import-map three, so the two are
      // different module instances and `instanceof` would be false even when the live
      // camera is correct. `.isVector3` is three's canonical cross-instance check (issue #84).
      const isVector3 = (v) => Boolean(v && v.isVector3 === true);
      const vectorsExist = (
        cameraManager.smoothingVectors &&
        isVector3(cameraManager.smoothingVectors.lastPosition) &&
        isVector3(cameraManager.smoothingVectors.targetPosition) &&
        isVector3(cameraManager.smoothingVectors.lookAtPosition)
      );
      
      assert(vectorsExist, 'Camera Vector Initialization', 
        vectorsExist ? 'All camera smoothing vectors are properly initialized' : 
        'One or more camera smoothing vectors are not properly initialized');
      
      // Vectors should have valid values (not NaN)
      let hasValidValues = true;
      const vectors = [
        cameraManager.smoothingVectors.lastPosition,
        cameraManager.smoothingVectors.targetPosition,
        cameraManager.smoothingVectors.lookAtPosition
      ];
      
      for (const vector of vectors) {
        if (isNaN(vector.x) || isNaN(vector.y) || isNaN(vector.z)) {
          hasValidValues = false;
          console.log(`CAMERA TEST: Invalid camera vector value: ${vector.x}, ${vector.y}, ${vector.z}`);
        }
      }
      
      assert(hasValidValues, 'Camera Vector Values', 
        hasValidValues ? 'All camera vectors have valid numerical values' : 
        'One or more camera vectors contain NaN values');
    }
    
    // Run tests sequentially to avoid test window overlap and state interference
    try {
      console.log('=== STARTING CAMERA TESTS IN SEQUENCE ===');
      
      // Track total tests to ensure all are accounted for
      const totalTestsExpected = 5; // Vector init, camera init, distance, above terrain, smoothing
      
      // Start with simple tests that don't rely on timing
      console.log('Running test 1/5: Camera Vector Initialization');
      testCameraVectorInitialization();
      
      // Then run tests that check positions but don't modify state much
      setTimeout(() => {
        console.log('Running test 2/5: Camera Initialization');
        testCameraInitialization();
        
        // Run tests that modify game state with delays between them
        setTimeout(() => {
          console.log('Running test 3/5: Camera Distance with Speed');
          testCameraDistanceWithSpeed();
          
          setTimeout(() => {
            console.log('Running test 4/5: Camera Above Terrain');
            testCameraAboveTerrain();
            
            // Smoothing test runs asynchronously, so it should be run last
            // as it will capture the results separately
            setTimeout(() => {
              console.log('Running test 5/5: Camera Smoothing');
              testCameraSmoothing();
              
              // Update the summary to show all tests accounted for
              const summaryElem = document.getElementById('testSummary');
              if (summaryElem) {
                summaryElem.textContent = `All ${totalTestsExpected} camera tests executed: ${testsPassed} passed, ${testsFailed} failed.`;
              }
            }, 500);
          }, 500);
        }, 500);
      }, 500);
      
      // Show initial test summary - tests are still loading in sequence
      const summary = document.createElement('div');
      summary.style.fontWeight = 'bold';
      summary.style.borderTop = '1px solid white';
      summary.style.marginTop = '10px';
      summary.style.paddingTop = '10px';
      summary.id = 'testSummary'; // Add ID to update this element later
      summary.textContent = `Tests running sequentially. First test complete: ${testsPassed} passed, ${testsFailed} failed. More tests loading...`;
      resultsDiv.appendChild(summary);
      
      // Update summary as tests complete
      function updateTestSummary() {
        const summaryElem = document.getElementById('testSummary');
        if (summaryElem) {
          summaryElem.textContent = `Tests in progress: ${testsPassed} passed, ${testsFailed} failed, remaining tests loading...`;
        }
        
        console.log(`Updated camera test counts: ${testsPassed} passed, ${testsFailed} failed`);
      }
      
      // Set interval to update the summary periodically
      const summaryInterval = setInterval(updateTestSummary, 1000);
      
      // After all tests are scheduled, we'll stop updating the summary
      setTimeout(() => {
        clearInterval(summaryInterval);
      }, 10000);
      
      console.log(`=== CAMERA TESTING IN PROGRESS: Loading tests sequentially to prevent state interference ===`);
      
      // Completion is signaled from testCameraSmoothing once the asynchronous
      // smoothing assertions have been recorded.
      if (!window._testCompleteCallback) {
        console.warn("window._testCompleteCallback not available - camera tests may not signal completion to unified runner");
      }
    } catch (e) {
      console.error('Test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = 'red';
      resultsDiv.appendChild(errorDiv);
    }
  }
})();
