/**
 * Unified Test Runner for SnowGlider
 * 
 * Runs all tests in a single window with a unified UI.
 * Run with: open index.html?test=unified
 */

(function() {
  // Only run if ?test=unified is in the URL
  if (window.location.search.includes('test=unified')) {
    // Set a flag to prevent other test runners from initializing
    window._unifiedTestRunnerActive = true;
    
    // Wait for game to initialize
    window.addEventListener('load', function() {
      // Give the game a moment to fully initialize
      setTimeout(initializeUnifiedTestRunner, 500);
    });
  }
  
  function initializeUnifiedTestRunner() {
    console.log('=== INITIALIZING UNIFIED TEST RUNNER ===');
    
    // Create the unified test results container
    const resultsDiv = document.createElement('div');
    resultsDiv.id = 'unified-test-results';
    resultsDiv.style.position = 'fixed';
    resultsDiv.style.top = '10px';
    resultsDiv.style.left = '10px';
    resultsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
    resultsDiv.style.color = 'white';
    resultsDiv.style.padding = '15px';
    resultsDiv.style.fontFamily = 'monospace';
    resultsDiv.style.fontSize = '14px';
    resultsDiv.style.zIndex = '99999';
    resultsDiv.style.width = '85%';
    resultsDiv.style.maxHeight = '90%';
    resultsDiv.style.overflow = 'auto';
    resultsDiv.style.borderRadius = '5px';
    resultsDiv.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.5)';
    document.body.appendChild(resultsDiv);
    
    // Add title
    const title = document.createElement('div');
    title.textContent = 'SNOWGLIDER UNIFIED TEST SUITE';
    title.style.fontSize = '20px';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '10px';
    title.style.textAlign = 'center';
    title.style.borderBottom = '2px solid white';
    title.style.paddingBottom = '10px';
    resultsDiv.appendChild(title);
    
    // Add description
    const description = document.createElement('div');
    description.textContent = 'Running all test suites in sequence...';
    description.style.marginBottom = '20px';
    description.style.marginTop = '10px';
    description.style.fontSize = '16px';
    description.style.color = '#aaa';
    resultsDiv.appendChild(description);
    
    // Expose the results div for test runners to use
    window._unifiedTestResults = resultsDiv;
    
    // Initialize test tracking
    window._unifiedTestCounts = {
      passed: 0,
      failed: 0,
      completed: []
    };
    
    // The test suites to run
    const testSuites = [
      { name: 'controls', runner: window.runControlsTests, started: false, completed: false },
      { name: 'camera', runner: window.runCameraTests, started: false, completed: false },
      { name: 'gameplay', runner: window.runGameTests, started: false, completed: false },
      { name: 'tree', runner: window.runTreeTests, started: false, completed: false },
      { name: 'regression', runner: window.runRegressionTests, started: false, completed: false }
    ];
    
    // Callback for tests to signal completion
    window._testCompleteCallback = function(testName, error) {
      console.log(`Test suite "${testName}" has completed${error ? ' with error' : ''}`);
      
      // Mark the test suite as completed
      const testSuite = testSuites.find(suite => suite.name === testName);
      if (testSuite) {
        testSuite.completed = true;
        window._unifiedTestCounts.completed.push(testName);
      }
      
      // Update summary
      updateSummary();
      
      // Check if all test suites have completed
      if (testSuites.every(suite => suite.completed)) {
        console.log('All test suites have completed');
        finalizeTests();
      } else {
        // Find the index of the completed test
        const completedIndex = testSuites.findIndex(suite => suite.name === testName);
        console.log(`Completed test "${testName}" at index ${completedIndex}`);
        
        // Fix for name mismatch: Check if 'gameplay' was the completed test (from browser-tests.js)
        if (testName === 'gameplay' || testName === 'game') {
          console.log('Game tests completed, starting tree tests next');
          const treeTestIndex = testSuites.findIndex(suite => suite.name === 'tree');
          if (treeTestIndex >= 0 && !testSuites[treeTestIndex].started) {
            startTestSuite(testSuites[treeTestIndex]);
            return;
          }
        }
        
        // Start the next test suite in sequence
        if (completedIndex >= 0 && completedIndex < testSuites.length - 1) {
          const nextTestSuite = testSuites[completedIndex + 1];
          if (!nextTestSuite.started) {
            console.log(`Starting next test in sequence: ${nextTestSuite.name}`);
            startTestSuite(nextTestSuite);
          } else {
            console.log(`Next test ${nextTestSuite.name} already started`);
            // Try to find any test that hasn't been started yet
            const notStartedTest = testSuites.find(suite => !suite.started);
            if (notStartedTest) {
              console.log(`Starting not-yet-started test: ${notStartedTest.name}`);
              startTestSuite(notStartedTest);
            }
          }
        } else {
          console.log(`No next test available after ${testName} (index ${completedIndex})`);
          // Check if any test hasn't been started yet
          const notStartedTest = testSuites.find(suite => !suite.started);
          if (notStartedTest) {
            console.log(`Found an unstarted test: ${notStartedTest.name}`);
            startTestSuite(notStartedTest);
          }
        }
      }
    };
    
    // Add test summary section
    const summaryDiv = document.createElement('div');
    summaryDiv.id = 'unified-test-summary';
    summaryDiv.style.marginTop = '20px';
    summaryDiv.style.padding = '10px';
    summaryDiv.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    summaryDiv.style.borderRadius = '5px';
    resultsDiv.appendChild(summaryDiv);
    
    function updateSummary() {
      const summary = document.getElementById('unified-test-summary');
      if (summary) {
        const completedCount = window._unifiedTestCounts.completed.length;
        const totalCount = testSuites.length;
        
        // Log current test counts for debugging
        console.log(`UPDATE SUMMARY: ${completedCount}/${totalCount} suites completed, ${window._unifiedTestCounts.passed} passed, ${window._unifiedTestCounts.failed} failed`);
        console.log(`Completed test suites: ${window._unifiedTestCounts.completed.join(', ')}`);
        
        // Check if camera tests are missing
        const cameraPassed = window._unifiedTestCounts.completed.includes('camera') ? "Included" : "Not yet included";
        
        summary.innerHTML = `
          <div style="font-weight:bold;margin-bottom:5px;">TEST SUMMARY (${completedCount}/${totalCount} suites completed)</div>
          <div>Total Tests Passed: <span style="color:#4CAF50;font-weight:bold;">${window._unifiedTestCounts.passed}</span></div>
          <div>Total Tests Failed: <span style="color:#FF5252;font-weight:bold;">${window._unifiedTestCounts.failed}</span></div>
          <div style="margin-top:5px;font-size:12px;">Completed suites: ${window._unifiedTestCounts.completed.join(', ')}</div>
          <div style="margin-top:10px;font-size:12px;color:#aaa;">Running tests sequentially to prevent state interference</div>
        `;
      }
    }
    
    function finalizeTests() {
      // Update the final summary
      const summary = document.getElementById('unified-test-summary');
      if (summary) {
        const allPassed = window._unifiedTestCounts.failed === 0;
        
        summary.style.backgroundColor = allPassed ? 'rgba(76, 175, 80, 0.2)' : 'rgba(255, 82, 82, 0.2)';
        summary.style.borderTop = allPassed ? '2px solid #4CAF50' : '2px solid #FF5252';
        
        // Log detailed final test stats for debugging
        console.log('=== FINAL UNIFIED TEST RESULTS ===');
        console.log(`Total passed: ${window._unifiedTestCounts.passed}`);
        console.log(`Total failed: ${window._unifiedTestCounts.failed}`);
        
        // List all the test suites that ran
        console.log(`Completed suites (${window._unifiedTestCounts.completed.length}/${testSuites.length}):`);
        
        // Create a detailed status report for each test suite
        testSuites.forEach(suite => {
          const status = suite.completed ? 'COMPLETED' : suite.started ? 'STARTED BUT NOT COMPLETED' : 'NOT STARTED';
          console.log(`- ${suite.name}: ${status}`);
        });
        console.log('=== END TEST RESULTS ===');
        
        // We should have run all test suites
        const ranAllSuites = window._unifiedTestCounts.completed.length === testSuites.length;
        
        summary.innerHTML = `
          <div style="font-weight:bold;margin-bottom:10px;">ALL TESTS COMPLETED</div>
          <div style="font-size:18px;margin-bottom:5px;">
            ${allPassed ? '✓ ALL TESTS PASSED' : `✗ ${window._unifiedTestCounts.failed} TESTS FAILED`}
          </div>
          <div>Total Tests Passed: <span style="color:#4CAF50;font-weight:bold;">${window._unifiedTestCounts.passed}</span></div>
          <div>Total Tests Failed: <span style="color:#FF5252;font-weight:bold;">${window._unifiedTestCounts.failed}</span></div>
          <div style="margin-top:5px;">Completed Suites: <span style="font-weight:bold;">${window._unifiedTestCounts.completed.join(', ')}</span></div>
          ${ranAllSuites ? '' : '<div style="color:#FF9800;font-weight:bold;">Warning: Not all test suites completed</div>'}
          <div style="margin-top:15px;font-size:12px;color:#aaa;">Test execution completed at ${new Date().toLocaleTimeString()}</div>
        `;
      }
      
      // Update the title and description
      title.textContent = 'SNOWGLIDER TESTS COMPLETED';
      description.textContent = window._unifiedTestCounts.failed === 0 ? 
        'All tests passed successfully!' : 
        `Test run completed with ${window._unifiedTestCounts.failed} failures.`;
      description.style.color = window._unifiedTestCounts.failed === 0 ? '#4CAF50' : '#FF5252';
    }
    
    function startTestSuite(testSuite) {
      console.log(`Starting test suite: ${testSuite.name}`);
      
      // Log the state of all test suites for debugging
      console.log('Current test suite status:');
      testSuites.forEach(suite => {
        console.log(`- ${suite.name}: started=${suite.started}, completed=${suite.completed}`);
      });
      
      // Check if the runner function exists
      if (typeof testSuite.runner !== 'function') {
        console.error(`Test runner for "${testSuite.name}" is not a function. Type: ${typeof testSuite.runner}`);
        console.log(`Available global functions:`, Object.keys(window).filter(key => typeof window[key] === 'function' && key.includes('run')));
        
        // Mark as completed with error and move to next test
        testSuite.started = true;
        window._testCompleteCallback(testSuite.name, new Error('Test runner is not a function'));
        return;
      }
      
      testSuite.started = true;
      
      // Add a longer delay to ensure previous tests have a chance to clean up
      setTimeout(() => {
        try {
          // Add a notice about which test is starting
          const testStartNotice = document.createElement('div');
          testStartNotice.style.marginTop = '15px';
          testStartNotice.style.marginBottom = '5px';
          testStartNotice.style.fontSize = '14px';
          testStartNotice.style.color = '#4CAF50';
          testStartNotice.textContent = `Starting "${testSuite.name}" test suite...`;
          window._unifiedTestResults.appendChild(testStartNotice);
          
          // Run the test suite
          console.log(`Executing test runner for ${testSuite.name}`);
          testSuite.runner();
          
          // Safety check in case test runner doesn't call the completion callback
          if (testSuite.name === 'camera') {
            console.log("Adding extra safety timeout for camera tests (15 seconds)");
            setTimeout(() => {
              if (!testSuite.completed) {
                console.log(`⚠️ Safety check: ${testSuite.name} test did not complete within expected time`);
                
                // Check if tests are actually running but just didn't signal completion
                const cameraCounts = window._unifiedTestCounts;
                if (cameraCounts && (cameraCounts.passed > 0 || cameraCounts.failed > 0)) {
                  console.log(`Found camera test results (${cameraCounts.passed} passed, ${cameraCounts.failed} failed) but completion wasn't signaled`);
                }
                
                // Force completion
                window._testCompleteCallback(testSuite.name, new Error('Test timed out'));
              }
            }, 15000); // Allow more time for the camera test to complete on its own first
          }
        } catch (error) {
          console.error(`Error running test suite ${testSuite.name}:`, error);
          window._testCompleteCallback(testSuite.name, error);
        }
      }, 2000); // Increased delay for better separation
    }
    
    // Add a close button
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
    
    // Start the first test suite
    updateSummary();
    startTestSuite(testSuites[0]);
  }
})();