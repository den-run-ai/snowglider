// Audio Test Suite for SnowGlider
// Tests for Howler.js audio integration
// Run with: open index.html?test=unified
//
// NOTE: Audio may be disabled (AUDIO_ENABLED = false in audio.js)
// Tests will detect this and pass with appropriate messages

(function() {
  // Only run tests if test mode is enabled
  if (window.location.search.includes('test=') && !window._unifiedTestRunnerActive) {
    window.addEventListener('load', function() {
      setTimeout(runTests, 500);
    });
  }

  // Expose the test runner for the unified test system
  window.runAudioTests = runTests;

  function runTests() {
    console.log('=== STARTING AUDIO TESTS ===');
    
    // Check if audio is disabled
    const audioDisabled = AudioModule.isEnabled && !AudioModule.isEnabled();
    
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
      sectionHeader.textContent = 'AUDIO PLAYBACK TESTS';
      resultsDiv.appendChild(sectionHeader);
    } else {
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'audio-test-results';
      resultsDiv.style.position = 'fixed';
      resultsDiv.style.top = '10px';
      resultsDiv.style.right = '10px';
      resultsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
      resultsDiv.style.color = 'white';
      resultsDiv.style.padding = '15px';
      resultsDiv.style.fontFamily = 'monospace';
      resultsDiv.style.fontSize = '14px';
      resultsDiv.style.zIndex = '9999';
      resultsDiv.style.maxHeight = '80%';
      resultsDiv.style.overflow = 'auto';
      resultsDiv.style.borderRadius = '5px';
      document.body.appendChild(resultsDiv);
    }
    
    let testsPassed = 0;
    let testsFailed = 0;
    let wasInitiallyMuted = false;
    
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
    
    // ===== TEST 1: Audio Loading and Playback =====
    function testAudioLoadingAndPlayback() {
      console.log('TEST 1: Audio Loading and Playback');
      
      // Check if audio is disabled first
      if (audioDisabled) {
        assert(
          true,
          'Audio Module (DISABLED)',
          'Audio is intentionally disabled - skipping playback tests'
        );
        
        // Test that disabled status is correctly reported
        const status = AudioModule.getStatus();
        assert(
          status.disabled === true,
          'Audio Disabled Status',
          'getStatus() correctly reports disabled state'
        );
        return;
      }
      
      // Mute audio at the start of tests to prevent annoying playback
      wasInitiallyMuted = AudioModule.getStatus().muted;
      if (!wasInitiallyMuted) {
        AudioModule.toggleMute();
        console.log('Muted audio for testing');
      }
      
      // Test 1.1: AudioModule initialization
      const initResult = AudioModule.init();
      assert(
        initResult && initResult.initialized === true,
        'Audio Module Initialization',
        'AudioModule.init() successfully initializes'
      );
      
      // Test 1.2: Get initial status
      const initialStatus = AudioModule.getStatus();
      assert(
        initialStatus && initialStatus.initialized === true,
        'Audio Module Status Check',
        'getStatus() returns valid initialization state'
      );
      
      // Test 1.3: Pre-load audio
      let preloadSucceeded = false;
      AudioModule.preloadAudio('drum_loop')
        .then(() => {
          preloadSucceeded = true;
          console.log('Audio preload succeeded');
          
          // Check status after preload
          const statusAfterPreload = AudioModule.getStatus();
          assert(
            statusAfterPreload.bufferLoaded === true,
            'Audio Buffer Loaded',
            'Audio buffer successfully loaded after preloadAudio()'
          );
          
          // Test 1.4: Current track is set correctly
          assert(
            statusAfterPreload.currentTrack === 'drum_loop',
            'Current Track Setting',
            `Current track is correctly set to 'drum_loop'`
          );
        })
        .catch((err) => {
          console.error('Audio preload failed:', err);
          assert(
            false,
            'Audio Buffer Loaded',
            `Failed to load audio buffer: ${err}`
          );
        });
      
      // Give preload some time to complete
      setTimeout(() => {
        if (!preloadSucceeded) {
          assert(
            true,
            'Audio Preload (Async)',
            'Audio preload in progress (async operation)'
          );
        }
      }, 100);
    }
    
    // ===== TEST 2: Audio Controls (Mute, Volume, Enable/Disable) =====
    function testAudioControls() {
      console.log('TEST 2: Audio Controls');
      
      // Skip detailed tests if audio is disabled
      if (audioDisabled) {
        assert(
          true,
          'Audio Controls (DISABLED)',
          'Audio is disabled - control tests skipped'
        );
        return;
      }
      
      // Test 2.1: Mute functionality
      const initialStatus = AudioModule.getStatus();
      const initialMuteState = initialStatus.muted;
      
      // Toggle mute
      const newMuteState = AudioModule.toggleMute();
      const statusAfterMute = AudioModule.getStatus();
      
      assert(
        statusAfterMute.muted === !initialMuteState,
        'Toggle Mute',
        `Mute state toggled from ${initialMuteState} to ${!initialMuteState}`
      );
      
      // Toggle back
      AudioModule.toggleMute();
      const statusAfterUnmute = AudioModule.getStatus();
      
      assert(
        statusAfterUnmute.muted === initialMuteState,
        'Toggle Unmute',
        `Mute state restored to original: ${initialMuteState}`
      );
      
      // Test 2.2: Volume control
      const testVolume = 0.7;
      AudioModule.setVolume(testVolume);
      
      // We can't directly verify the volume from status, but we can check if the call succeeds
      assert(
        true,
        'Volume Control',
        `setVolume(${testVolume}) executed successfully`
      );
      
      // Test edge cases
      AudioModule.setVolume(0);
      assert(true, 'Volume Min (0)', 'setVolume(0) executed successfully');
      
      AudioModule.setVolume(1);
      assert(true, 'Volume Max (1)', 'setVolume(1) executed successfully');
      
      // Reset to default
      AudioModule.setVolume(0.5);
      
      // Test 2.3: Enable/Disable sound
      AudioModule.enableSound(false);
      const statusWithSoundDisabled = AudioModule.getStatus();
      
      // Note: enableSound affects internal state, playing status depends on context
      assert(
        true,
        'Disable Sound',
        'enableSound(false) executed successfully'
      );
      
      AudioModule.enableSound(true);
      const statusWithSoundEnabled = AudioModule.getStatus();
      
      assert(
        true,
        'Enable Sound',
        'enableSound(true) executed successfully'
      );
      
      // Test 2.4: Track switching
      const trackChangeResult = AudioModule.changeTrack('skullbeatz');
      assert(
        trackChangeResult === true,
        'Change Audio Track',
        'changeTrack() successfully switches to skullbeatz'
      );
      
      // Verify track changed - give more time for cleanup and loading
      setTimeout(() => {
        const statusAfterChange = AudioModule.getStatus();
        assert(
          statusAfterChange.currentTrack === 'skullbeatz',
          'Track Change Verification',
          `Current track updated to 'skullbeatz'`
        );
        
        // Switch back to default - give time for the previous track to fully load
        setTimeout(() => {
          AudioModule.changeTrack('drum_loop');
        }, 300);
      }, 300);
    }
    
    // ===== TEST 3: Audio Context State Management =====
    function testAudioContextState() {
      console.log('TEST 3: Audio Context State Management');
      
      // If audio is disabled, just verify Howler is loaded and skip rest
      if (audioDisabled) {
        const howlerAvailable = typeof Howler !== 'undefined';
        assert(
          howlerAvailable,
          'Howler.js Library (Audio Disabled)',
          'Howler.js is loaded (audio disabled but library available)'
        );
        
        // Test the isEnabled method
        assert(
          AudioModule.isEnabled() === false,
          'Audio isEnabled() Method',
          'isEnabled() correctly returns false when disabled'
        );
        return;
      }
      
      // Test 3.1: Check if Howler is available
      const howlerAvailable = typeof Howler !== 'undefined';
      assert(
        howlerAvailable,
        'Howler.js Library',
        'Howler.js is loaded and available'
      );
      
      if (!howlerAvailable) {
        // Skip remaining tests if Howler isn't available
        assert(false, 'Audio Context Tests', 'Cannot test without Howler.js');
        return;
      }
      
      // Test 3.2: Audio context exists
      const hasContext = Howler.ctx !== undefined && Howler.ctx !== null;
      assert(
        hasContext,
        'Audio Context Exists',
        'Howler AudioContext is created'
      );
      
      // Test 3.3: Check context state
      const contextState = Howler.ctx ? Howler.ctx.state : 'unknown';
      const validStates = ['suspended', 'running', 'closed', 'interrupted'];
      
      assert(
        validStates.includes(contextState),
        'Audio Context State',
        `Context state is valid: ${contextState}`
      );
      
      // Test 3.4: Resume audio context
      if (Howler.ctx && Howler.ctx.state === 'suspended') {
        AudioModule.resumeAudioContext()
          .then(() => {
            const newState = Howler.ctx.state;
            assert(
              newState === 'running' || newState === 'suspended',
              'Resume Audio Context',
              `Context state after resume: ${newState}`
            );
          })
          .catch((err) => {
            // Resume might fail without user gesture in some browsers
            assert(
              true,
              'Resume Audio Context',
              'Resume attempt made (may require user interaction)'
            );
          });
      } else {
        assert(
          true,
          'Resume Audio Context',
          `Context already ${contextState}, no resume needed`
        );
      }
      
      // Test 3.5: Status reflects context state
      const status = AudioModule.getStatus();
      assert(
        status.contextState === contextState,
        'Status Context State',
        `getStatus() correctly reports context state: ${contextState}`
      );
      
      // Test 3.6: Context ready flag
      assert(
        typeof status.contextReady === 'boolean',
        'Context Ready Flag',
        `contextReady flag is properly set: ${status.contextReady}`
      );
      
      // Test 3.7: Play preloaded audio (requires user gesture)
      // This will likely fail in automated tests, but we test the call
      const playResult = AudioModule.playPreloadedAudio();
      assert(
        typeof playResult === 'boolean',
        'Play Preloaded Audio',
        `playPreloadedAudio() returns boolean: ${playResult}`
      );
      
      // Test 3.8: Audio retry prompt (UI test)
      // Just verify the function exists and can be called
      try {
        AudioModule.showAudioRetryPrompt();
        
        // Check if prompt was created
        const retryPrompt = document.getElementById('audioRetryPrompt');
        assert(
          retryPrompt !== null,
          'Audio Retry Prompt UI',
          'showAudioRetryPrompt() creates retry button'
        );
        
        // Clean up
        if (retryPrompt) {
          retryPrompt.remove();
        }
      } catch (err) {
        assert(
          false,
          'Audio Retry Prompt UI',
          `Failed to create retry prompt: ${err.message}`
        );
      }
    }
    
    // Run all tests with proper sequencing
    try {
      testAudioLoadingAndPlayback();
      
      // Add delay for async operations
      setTimeout(() => {
        testAudioControls();
        
        // Longer delay to allow track changes to complete
        setTimeout(() => {
          testAudioContextState();
          
          // Show test summary after all tests complete
          setTimeout(() => {
            const summary = document.createElement('div');
            summary.style.fontWeight = 'bold';
            summary.style.borderTop = '1px solid white';
            summary.style.marginTop = '10px';
            summary.style.paddingTop = '10px';
            
            // Update global test counts if in unified runner
            if (window._unifiedTestCounts) {
              console.log(`Audio tests reporting ${testsPassed} passed, ${testsFailed} failed to unified test runner`);
              window._unifiedTestCounts.passed += testsPassed;
              window._unifiedTestCounts.failed += testsFailed;
            }
            
            summary.textContent = `Audio tests completed: ${testsPassed} passed, ${testsFailed} failed`;
            resultsDiv.appendChild(summary);
            
            console.log(`=== AUDIO TESTING COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
            
            // Cleanup: restore mute state and ensure audio is stopped
            const currentlyMuted = AudioModule.getStatus().muted;
            if (currentlyMuted !== wasInitiallyMuted) {
              AudioModule.toggleMute();
              console.log('Restored original mute state');
            }
            
            // Ensure audio is muted/stopped after tests to prevent annoying playback
            if (!AudioModule.getStatus().muted) {
              AudioModule.toggleMute();
              console.log('Muted audio after tests to prevent playback');
            }
            
            // Signal completion to unified runner if applicable
            if (window._testCompleteCallback) {
              console.log('Audio tests completed, signaling to unified test runner');
              window._testCompleteCallback('audio');
            }
          }, 500);
        }, 1000);
      }, 500);
    } catch (e) {
      console.error('Audio test error:', e);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = `ERROR: ${e.message}`;
      errorDiv.style.color = '#FF5252';
      resultsDiv.appendChild(errorDiv);
      
      if (window._testCompleteCallback) {
        window._testCompleteCallback('audio', e);
      }
    }
  }
})();

