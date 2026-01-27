// Audio Test Suite for SnowGlider
// Tests for simplified native HTML5 Audio implementation
// Run with: open index.html?test=unified or index.html?test=audio

(function() {
  if (window.location.search.includes('test=') && !window._unifiedTestRunnerActive) {
    // Check if document already loaded (since script may be added dynamically)
    if (document.readyState === 'complete') {
      setTimeout(runTests, 500);
    } else {
      window.addEventListener('load', function() {
        setTimeout(runTests, 500);
      });
    }
  }

  window.runAudioTests = runTests;

  function runTests() {
    console.warn('=== STARTING AUDIO TESTS ===');
    
    const audioDisabled = AudioModule.isEnabled && !AudioModule.isEnabled();
    
    let resultsDiv;
    if (window._unifiedTestResults) {
      resultsDiv = window._unifiedTestResults;
      const sectionHeader = document.createElement('div');
      sectionHeader.style.fontWeight = 'bold';
      sectionHeader.style.fontSize = '16px';
      sectionHeader.style.marginTop = '15px';
      sectionHeader.style.marginBottom = '10px';
      sectionHeader.style.borderBottom = '1px solid white';
      sectionHeader.textContent = 'AUDIO TESTS (Simplified)';
      resultsDiv.appendChild(sectionHeader);
    } else {
      resultsDiv = document.createElement('div');
      resultsDiv.id = 'audio-test-results';
      resultsDiv.style.cssText = `
        position: fixed; top: 10px; right: 10px;
        background: rgba(0,0,0,0.8); color: white; padding: 15px;
        font-family: monospace; font-size: 14px; z-index: 9999;
        max-height: 80%; overflow: auto; border-radius: 5px;
      `;
      document.body.appendChild(resultsDiv);
    }
    
    let testsPassed = 0;
    let testsFailed = 0;
    
    function assert(condition, name, message) {
      const result = document.createElement('div');
      result.textContent = `${condition ? '✓' : '✗'} ${name}: ${message || ''}`;
      result.style.color = condition ? '#4CAF50' : '#FF5252';
      resultsDiv.appendChild(result);
      
      if (condition) testsPassed++;
      else testsFailed++;
      
      console.warn(`${condition ? 'PASS' : 'FAIL'}: ${name} - ${message || ''}`);
    }
    
    // TEST 1: Basic Module Tests
    function testBasicModule() {
      console.warn('TEST 1: Basic Module');
      
      // Test isEnabled
      assert(
        typeof AudioModule.isEnabled === 'function',
        'isEnabled Method',
        'AudioModule.isEnabled() exists'
      );
      
      if (audioDisabled) {
        assert(true, 'Audio Disabled', 'Audio intentionally disabled - basic tests only');
        const status = AudioModule.getStatus();
        assert(status.disabled === true, 'Disabled Status', 'getStatus() reports disabled');
        return;
      }
      
      // Test init
      const initResult = AudioModule.init();
      assert(
        initResult && initResult.initialized === true,
        'Module Init',
        'AudioModule.init() returns initialized: true'
      );
      
      // Test getStatus
      const status = AudioModule.getStatus();
      assert(
        status && status.initialized === true,
        'Status Check',
        'getStatus() returns valid state'
      );
      
      assert(
        typeof status.muted === 'boolean',
        'Muted State',
        `muted is boolean: ${status.muted}`
      );
      
      assert(
        status.currentTrack === 'drum_loop',
        'Current Track',
        'Default track is drum_loop'
      );
    }
    
    // TEST 2: Mute/Unmute
    function testMuteToggle() {
      console.warn('TEST 2: Mute Toggle');
      
      if (audioDisabled) {
        assert(true, 'Mute (Disabled)', 'Skipped - audio disabled');
        return;
      }
      
      const initialMuted = AudioModule.getStatus().muted;
      
      // Toggle mute
      AudioModule.toggleMute();
      const afterToggle = AudioModule.getStatus().muted;
      assert(
        afterToggle !== initialMuted,
        'Toggle Mute',
        `Muted changed from ${initialMuted} to ${afterToggle}`
      );
      
      // Toggle back
      AudioModule.toggleMute();
      const restored = AudioModule.getStatus().muted;
      assert(
        restored === initialMuted,
        'Toggle Restore',
        `Muted restored to ${restored}`
      );
    }
    
    // TEST 3: Volume Control
    function testVolumeControl() {
      console.warn('TEST 3: Volume Control');
      
      if (audioDisabled) {
        assert(true, 'Volume (Disabled)', 'Skipped - audio disabled');
        return;
      }
      
      // Just verify calls don't throw
      try {
        AudioModule.setVolume(0);
        AudioModule.setVolume(1);
        AudioModule.setVolume(0.5);
        assert(true, 'Volume Control', 'setVolume() calls succeed');
      } catch (e) {
        assert(false, 'Volume Control', `Error: ${e.message}`);
      }
    }
    
    // TEST 4: Compatibility Stubs
    function testCompatibilityStubs() {
      console.warn('TEST 4: Compatibility Stubs');
      
      // These methods exist for backward compatibility
      const stubs = [
        'preloadAudio',
        'playPreloadedAudio', 
        'resumeAudioContext',
        'changeTrack',
        'addAudioListener',
        'showMessage',
        'showAudioRetryPrompt'
      ];
      
      stubs.forEach(method => {
        assert(
          typeof AudioModule[method] === 'function',
          `Stub: ${method}`,
          'Method exists for compatibility'
        );
      });
      
      // preloadAudio should return a promise
      const result = AudioModule.preloadAudio('drum_loop');
      assert(
        result instanceof Promise,
        'preloadAudio Promise',
        'Returns Promise for compatibility'
      );
    }
    
    // TEST 5: UI Creation
    function testUICreation() {
      console.warn('TEST 5: UI Creation');
      
      if (audioDisabled) {
        assert(true, 'UI (Disabled)', 'Skipped - audio disabled');
        return;
      }
      
      AudioModule.setupUI();
      
      const btn = document.getElementById('audioControlBtn');
      assert(
        btn !== null,
        'Audio Button Created',
        'Mute button added to DOM'
      );
      
      if (btn) {
        assert(
          btn.textContent === '🔇' || btn.textContent === '🔊',
          'Button Icon',
          `Button shows correct icon: ${btn.textContent}`
        );
      }
    }
    
    // TEST 6: Message Display
    function testMessageDisplay() {
      console.warn('TEST 6: Message Display');
      
      try {
        AudioModule.showMessage('Test message', 100);
        assert(true, 'Show Message', 'showMessage() executes without error');
      } catch (e) {
        assert(false, 'Show Message', `Error: ${e.message}`);
      }
    }
    
    // Run all tests
    try {
      testBasicModule();
      testMuteToggle();
      testVolumeControl();
      testCompatibilityStubs();
      testUICreation();
      testMessageDisplay();
      
      // Summary
      setTimeout(() => {
        const summary = document.createElement('div');
        summary.style.fontWeight = 'bold';
        summary.style.borderTop = '1px solid white';
        summary.style.marginTop = '10px';
        summary.style.paddingTop = '10px';
        
        if (window._unifiedTestCounts) {
          window._unifiedTestCounts.passed += testsPassed;
          window._unifiedTestCounts.failed += testsFailed;
        }
        
        summary.textContent = `Audio tests: ${testsPassed} passed, ${testsFailed} failed`;
        resultsDiv.appendChild(summary);
        
        console.warn(`=== AUDIO TESTS COMPLETE: ${testsPassed} passed, ${testsFailed} failed ===`);
        
        if (window._testCompleteCallback) {
          window._testCompleteCallback('audio');
        }
      }, 200);
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
