// audio.js - Handle game audio using Howler.js for better mobile compatibility
//
// TODO: AUDIO DISABLED - Troubleshooting needed for mobile and desktop issues
// Issues observed:
// - Mobile: Audio context suspension, interrupted states, iOS silent switch handling
// - Desktop: Intermittent playback failures, context state management issues
// - Cross-platform: User gesture requirements not consistently met
//
// Key areas to investigate when re-enabling:
// 1. AudioContext state management (suspended, interrupted, running)
// 2. User gesture timing for audio unlock
// 3. Howler.js HTML5 mode vs Web Audio API mode
// 4. Visibility change handling when app goes to background
// 5. Pre-loading vs lazy loading strategies
//
// To re-enable audio: Set AUDIO_ENABLED = true and test thoroughly on:
// - iOS Safari (check silent switch behavior)
// - Android Chrome
// - Desktop Chrome, Firefox, Safari
//
const AUDIO_ENABLED = false; // TODO: Set to true when audio issues are resolved

// AudioModule - Global module for managing game audio
const AudioModule = (function() {
  // Private variables
  let music = null;
  let audioFiles = {
    'drum_loop': { path: './assets/drum_loop_are_you_heaven.wav' },
    'skullbeatz': { path: './assets/skullbeatz_bad_cat.mp3' }
  };
  let currentAudio = 'drum_loop';
  let isMuted = false;
  let isInitialized = false;
  let soundEnabled = true;
  let hasPlayedAudio = false;
  let startupMessage = null;
  let audioInitialized = false; // Flag for context state
  let audioLoaded = false;      // Flag for buffer loaded
  
  // TODO: Early exit if audio is disabled - all public methods will be no-ops
  if (!AUDIO_ENABLED) {
    console.log("[AUDIO] Audio is DISABLED. Set AUDIO_ENABLED = true in audio.js to re-enable.");
  }
  
  // Private methods
  function initAudio(scene) {
    if (isInitialized) {
      return {
        initialized: true
      };
    }
    
    console.log("Initializing audio system with Howler.js");
    
    // Check local storage for previous sound settings
    const storedMute = localStorage.getItem('snowgliderMuted');
    if (storedMute !== null) {
      isMuted = storedMute === 'true';
    }
    
    // Always default to drum_loop if no stored preference or if we're initializing for the first time
    const storedAudio = localStorage.getItem('snowgliderAudioTrack');
    if (storedAudio !== null && audioFiles[storedAudio]) {
      currentAudio = storedAudio;
    } else {
      currentAudio = 'drum_loop'; // Ensure drum_loop is the default
      localStorage.setItem('snowgliderAudioTrack', 'drum_loop'); // Save the default preference
    }
    
    isInitialized = true;
    
    return {
      initialized: true
    };
  }
  
  // Function to create and show a startup message
  function showStartupMessage(message, duration = 3000) {
    // Remove any existing message
    if (startupMessage) {
      document.body.removeChild(startupMessage);
    }
    
    // Create the message element
    startupMessage = document.createElement('div');
    startupMessage.textContent = message;
    startupMessage.style.position = 'fixed';
    startupMessage.style.top = '50%';
    startupMessage.style.left = '50%';
    startupMessage.style.transform = 'translate(-50%, -50%)';
    startupMessage.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    startupMessage.style.color = 'white';
    startupMessage.style.padding = '20px 30px';
    startupMessage.style.borderRadius = '10px';
    startupMessage.style.fontSize = '24px';
    startupMessage.style.fontFamily = 'Arial, sans-serif';
    startupMessage.style.zIndex = '3000';
    startupMessage.style.opacity = '0';
    startupMessage.style.transition = 'opacity 0.5s ease-in-out';
    
    // Add to the document
    document.body.appendChild(startupMessage);
    
    // Fade in
    setTimeout(() => {
      startupMessage.style.opacity = '1';
    }, 10);
    
    // Fade out and remove after duration
    setTimeout(() => {
      startupMessage.style.opacity = '0';
      setTimeout(() => {
        if (startupMessage && startupMessage.parentNode) {
          document.body.removeChild(startupMessage);
          startupMessage = null;
        }
      }, 500);
    }, duration);
  }
  
  // Function to wait for user interaction to unlock audio context
  async function startAudioExperience() {
    // Howler.js handles audio context automatically, but we can force resume
    if (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'suspended') {
      try {
        await Howler.ctx.resume();
        console.log("AudioContext resumed via Howler!");
        audioInitialized = true;
      } catch (e) {
        console.error("Error resuming AudioContext:", e);
        return;
      }
    } else if (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'running') {
      audioInitialized = true;
    }

    // Now you can play the sound (if loaded)
    if (audioLoaded && !isMuted && soundEnabled && music && !music.playing()) {
      console.log("Playing sound after interaction");
      music.play();
      hasPlayedAudio = true;
    }
  }

  function loadAudio(audioName) {
    if (!isInitialized || !audioFiles[audioName]) return;
    
    try {
      // Stop and unload current audio completely
      if (music) {
        if (music.playing()) {
          music.stop();
        }
        music.unload();
        music = null;
      }
      
      // Reset audio loaded flag
      audioLoaded = false;
      
      // Load and set the audio
      const audioInfo = audioFiles[audioName];
      
      // Fix paths for GitHub Pages compatibility - try both with and without './'
      let audioPath = audioInfo.path;
      if (audioPath.startsWith('./')) {
        audioPath = audioPath.substring(2);
      }
      
      console.log("Loading audio track:", audioName, "from path:", audioPath);
      
      // Show loading status in UI if needed
      updateUI();
      
      // Create Howl instance
      music = new Howl({
        src: [audioPath],
        html5: true, // Force HTML5 Audio for better mobile compatibility
        loop: true,
        volume: 0.5,
        onload: function() {
          console.log("Audio loaded successfully:", audioName);
          currentAudio = audioName;
          localStorage.setItem('snowgliderAudioTrack', audioName);
          
          // Mark buffer as loaded
          audioLoaded = true;
          
          // Only play if not muted, sound is enabled, and audio context is initialized
          if (!isMuted && soundEnabled && audioInitialized) {
            music.play();
            hasPlayedAudio = true;
            console.log("Audio is now playing:", audioName);
          } else {
            console.log("Audio loaded but waiting for context initialization or unmute");
          }
          
          // Update UI
          updateUI();
        },
        onloaderror: function(id, err) {
          console.error("Error loading audio track:", audioName, err);
          
          // Try alternative audio if this one failed
          if (audioName === 'drum_loop' && audioFiles['skullbeatz']) {
            console.log("Trying fallback audio track...");
            setTimeout(() => loadAudio('skullbeatz'), 500);
          } else if (audioName === 'skullbeatz' && audioFiles['drum_loop']) {
            console.log("Trying fallback audio track...");
            setTimeout(() => loadAudio('drum_loop'), 500);
          }
        },
        onplayerror: function(id, err) {
          console.error("Error playing audio:", err);
          // Try to unlock audio on next user interaction
          music.once('unlock', function() {
            console.log("Audio unlocked, attempting to play");
            music.play();
          });
        }
      });
    } catch (e) {
      console.error("Error in loadAudio function:", e.message, e.stack);
    }
  }
  
  // New function to pre-load audio without playing
  function preloadAudio(audioName) {
    if (!isInitialized || !audioFiles[audioName]) return Promise.reject('Not initialized');
    
    return new Promise((resolve, reject) => {
      // Stop and unload current audio completely
      if (music) {
        if (music.playing()) {
          music.stop();
        }
        music.unload();
        music = null;
      }
      
      // Reset audio loaded flag
      audioLoaded = false;
      
      const audioInfo = audioFiles[audioName];
      let audioPath = audioInfo.path;
      if (audioPath.startsWith('./')) {
        audioPath = audioPath.substring(2);
      }
      
      // Apply cache-busting
      audioPath = withVersion(audioPath);
      
      console.log("Pre-loading audio track:", audioName, "from path:", audioPath);
      
      // Create Howl instance but don't play yet
      music = new Howl({
        src: [audioPath],
        html5: true, // Force HTML5 Audio for better mobile compatibility
        loop: true,
        volume: 0.5,
        preload: true,
        onload: function() {
          currentAudio = audioName;
          audioLoaded = true;
          
          console.log("Audio pre-loaded successfully:", audioName);
          resolve();
        },
        onloaderror: function(id, err) {
          console.error("Error pre-loading audio track:", audioName, err);
          reject(err);
        }
      });
    });
  }
  
  // New function to play pre-loaded audio (must be called in user gesture)
  function playPreloadedAudio() {
    if (!audioLoaded) {
      console.warn("Audio not loaded yet, cannot play");
      return false;
    }
    
    if (isMuted || !soundEnabled) {
      console.log("Audio muted or sound disabled");
      return false;
    }
    
    if (!audioInitialized && typeof Howler !== 'undefined' && Howler.ctx) {
      // Try to resume context
      if (Howler.ctx.state === 'suspended') {
        Howler.ctx.resume().then(() => {
          console.log("Audio context resumed in playPreloadedAudio");
          audioInitialized = true;
        }).catch(e => {
          console.error("Failed to resume audio context:", e);
        });
      } else if (Howler.ctx.state === 'running') {
        audioInitialized = true;
      }
    }
    
    if (music && !music.playing()) {
      try {
        music.play();
        hasPlayedAudio = true;
        console.log("Pre-loaded audio now playing");
        return true;
      } catch (e) {
        console.error("Error playing pre-loaded audio:", e);
        return false;
      }
    }
    
    return false;
  }
  
  // Helper: add cache-busting to asset URLs
  function withVersion(url) {
    try {
      const build = document.querySelector('meta[name="build-id"]')?.content || Date.now();
      const u = new URL(url, location.href);
      if (!u.searchParams.has('v')) u.searchParams.set('v', build);
      return u.href;
    } catch { 
      return url; 
    }
  }
  
  // NEW: visible retry UI
  function showAudioRetryPrompt() {
    if (document.getElementById('audioRetryPrompt')) return;

    const prompt = document.createElement('button');
    prompt.id = 'audioRetryPrompt';
    Object.assign(prompt.style, {
      position: 'fixed', 
      bottom: '80px', 
      right: '20px', 
      zIndex: '1002',
      padding: '10px 14px', 
      borderRadius: '8px', 
      border: '0',
      background: 'rgba(255,165,0,0.95)', 
      color: '#111',
      fontSize: '14px', 
      boxShadow: '0 2px 8px rgba(0,0,0,.2)', 
      cursor: 'pointer',
      fontFamily: 'Arial, sans-serif',
      fontWeight: 'bold'
    });

    const maybeInterrupted = 
      (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'interrupted'); // WebKit-specific
    prompt.textContent = maybeInterrupted
      ? '🔇 Tap to enable audio (check iPhone silent switch)'
      : '🔇 Tap to enable audio';

    prompt.addEventListener('click', async () => {
      try {
        const st1 = (typeof Howler !== 'undefined' && Howler.ctx) ? Howler.ctx.state : 'unknown';
        console.log('[AUDIO] Retry button clicked, context state:', st1);
        
        if (st1 !== 'running' && typeof Howler !== 'undefined' && Howler.ctx) {
          await Howler.ctx.resume();
          console.log('[AUDIO] Context resumed via retry, new state:', Howler.ctx.state);
        }
        
        const ok = playPreloadedAudio();
        if (ok) {
          prompt.remove();
          showStartupMessage('Audio enabled! 🎵', 2000);
        } else {
          prompt.textContent = '🔇 Audio still unavailable';
          setTimeout(() => {
            if (prompt.parentNode) prompt.remove();
          }, 3000);
        }
      } catch (e) {
        console.error('[AUDIO] Retry failed:', e);
        prompt.textContent = 'Audio unavailable';
        setTimeout(() => {
          if (prompt.parentNode) prompt.remove();
        }, 3000);
      }
    });

    document.body.appendChild(prompt);
    
    // Auto-hide after 10 seconds
    setTimeout(() => {
      if (prompt.parentNode) {
        prompt.remove();
      }
    }, 10000);
  }
  
  function toggleMute() {
    isMuted = !isMuted;
    
    if (isMuted) {
      // User wants to mute, pause any playing audio
      if (music && music.playing()) {
        music.pause();
      }
    } else {
      // User wants to unmute, try to play if not already playing
      if (music && !music.playing() && soundEnabled) {
        // Check if audio context is suspended and resume if needed
        if (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'suspended') {
          console.log("toggleMute: Audio context suspended, attempting to resume");
          Howler.ctx.resume().then(() => {
            console.log("toggleMute: Audio context resumed successfully");
            audioInitialized = true;
            if (music && !music.playing()) {
              music.play();
              hasPlayedAudio = true;
            }
          }).catch(e => {
            console.error("toggleMute: Failed to resume audio context:", e);
          });
        } else {
          // Context is already running, just play
          music.play();
          hasPlayedAudio = true;
        }
      }
    }
    
    // Save preference
    localStorage.setItem('snowgliderMuted', isMuted);
    
    // Update UI
    updateUI();
    
    return isMuted;
  }
  
  function updateUI() {
    const audioButton = document.getElementById('audioControlBtn');
    const audioSelect = document.getElementById('audioSelect');
    
    if (audioButton) {
      // Simple mute/unmute button
      audioButton.innerHTML = isMuted ? '🔇' : '🔊';
      audioButton.title = isMuted ? 'Unmute' : 'Mute';
      audioButton.style.width = '40px';
      audioButton.style.padding = '';
    }
    
    if (audioSelect) {
      audioSelect.value = currentAudio;
    }
  }
  
  function createAudioUI() {
    // Check if elements already exist (to avoid duplication)
    const existingButton = document.getElementById('audioControlBtn');
    if (existingButton) return;
    
    // Create audio control button - use CSS from index.html
    const audioButton = document.createElement('button');
    audioButton.id = 'audioControlBtn';
    audioButton.innerHTML = isMuted ? '🔇' : '🔊';
    audioButton.title = isMuted ? 'Unmute' : 'Mute';
    
    // Create audio select dropdown - use CSS from index.html
    const audioSelect = document.createElement('select');
    audioSelect.id = 'audioSelect';
    audioSelect.style.display = 'none'; // Initially hidden
    
    // Add options
    for (const [key, audio] of Object.entries(audioFiles)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key === 'drum_loop' ? 'Drum Loop' : 'Skullbeatz';
      audioSelect.appendChild(option);
    }
    
    // Set current selection
    audioSelect.value = currentAudio;
    
    // Add to DOM directly
    document.body.appendChild(audioButton);
    document.body.appendChild(audioSelect);
    
    // Add visibility change listener to handle audio suspension/resumption
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        // Tab/Window hidden - Howler usually handles muting, but we can force mute if needed
        // For now, we rely on Howler's auto-suspend behavior
        console.log("App hidden: Audio might be suspended by browser");
      } else {
        // Tab/Window visible again - Force resume if suspended
        console.log("App visible: Checking audio context state");
        if (typeof Howler !== 'undefined' && Howler.ctx && (Howler.ctx.state === 'suspended' || Howler.ctx.state === 'interrupted')) {
          // Try to resume - note this might still fail until next user interaction on some browsers
          Howler.ctx.resume().then(() => {
            console.log("AudioContext resumed on visibility change");
            // If we were playing before, ensure we are playing now
            if (soundEnabled && !isMuted && music && !music.playing()) {
               music.play();
            }
          }).catch(e => {
             console.warn("Could not auto-resume on visibility change (waiting for interaction):", e);
          });
        }
      }
    });

    // Event listeners
    // Click for mute/unmute
    audioButton.addEventListener('click', toggleMute);
    
    // Change track when selection changes
    audioSelect.addEventListener('change', function() {
      const selected = this.value;
      loadAudio(selected);
    });
    
    // Desktop hover behavior
    audioButton.addEventListener('mouseenter', function() {
      audioSelect.style.display = 'block';
    });
    
    audioSelect.addEventListener('mouseleave', function() {
      audioSelect.style.display = 'none';
    });
    
    // Simple toggle for mobile
    audioButton.addEventListener('touchend', function(e) {
      // Simple toggle for mobile - if select is visible, hide it and toggle mute
      // If select is hidden, show it
      if (audioSelect.style.display === 'block') {
        audioSelect.style.display = 'none';
        toggleMute();
      } else {
        audioSelect.style.display = 'block';
        e.preventDefault(); // Prevent immediate toggle
      }
    }, { passive: false });
  }
  
  // Public API
  // TODO: All methods check AUDIO_ENABLED and return early if disabled
  return {
    init: function(scene) {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] init() - Audio disabled, skipping initialization");
        return { initialized: false, disabled: true };
      }
      const result = initAudio(scene);
      return result;
    },
    setupUI: function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] setupUI() - Audio disabled, skipping UI setup");
        return;
      }
      createAudioUI();
      updateUI();
      
      // Add event listeners for unlocking audio on first user interaction
      const unlockAudio = () => {
        startAudioExperience();
        // Don't remove these listeners immediately since some browsers need multiple interactions
      };
      
      // Add to multiple event types to ensure we catch the first interaction
      document.addEventListener('click', unlockAudio, { passive: true });
      document.addEventListener('touchstart', unlockAudio, { passive: true });
      document.addEventListener('keydown', unlockAudio, { passive: true });
    },
    preloadAudio: function(audioName) {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] preloadAudio() - Audio disabled, skipping preload");
        return Promise.resolve(); // Return resolved promise so callers don't break
      }
      return preloadAudio(audioName);
    },
    playPreloadedAudio: function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] playPreloadedAudio() - Audio disabled");
        return false;
      }
      return playPreloadedAudio();
    },
    showAudioRetryPrompt: function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] showAudioRetryPrompt() - Audio disabled");
        return;
      }
      showAudioRetryPrompt();
    },
    toggleMute: function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] toggleMute() - Audio disabled");
        return false;
      }
      return toggleMute();
    },
    changeTrack: function(trackName) {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] changeTrack() - Audio disabled");
        return false;
      }
      if (audioFiles[trackName]) {
        loadAudio(trackName);
        return true;
      }
      return false;
    },
    startAudio: function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] startAudio() - Audio disabled, showing welcome message only");
        // Still show welcome message even with audio disabled
        showStartupMessage("Welcome to SnowGlider!", 2000);
        return false;
      }
      // This is the main function to call after user interaction
      if (!isInitialized) {
        console.error("Audio system not initialized. Call init() first.");
        return false;
      }
      
      // Try to initialize audio context first
      startAudioExperience();
      
      // Show a welcome message
      showStartupMessage("Welcome to SnowGlider!", 2000);
      
      // Load the current audio track
      loadAudio(currentAudio);
      return true;
    },
    setVolume: function(level) {
      if (!AUDIO_ENABLED) return;
      if (music) {
        music.volume(Math.max(0, Math.min(1, level)));
      }
    },
    enableSound: function(enable) {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] enableSound() - Audio disabled");
        return;
      }
      soundEnabled = enable;
      if (enable && !isMuted && music) {
        // Check context state before playing
        if (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'suspended') {
           console.log("enableSound: Context suspended, attempting resume");
           startAudioExperience().then(() => {
             if (!music.playing()) {
               music.play();
               hasPlayedAudio = true;
             }
           });
        } else if (!music.playing() && (audioInitialized || (typeof Howler !== 'undefined' && Howler.ctx && Howler.ctx.state === 'running'))) {
          music.play();
          hasPlayedAudio = true;
        } else if (!audioInitialized) {
          // If trying to enable sound but context not initialized,
          // try to resume it (this will require user interaction)
          startAudioExperience();
        }
      } else if (!enable && music && music.playing()) {
        music.pause();
      }
    },
    getStatus: function() {
      // TODO: Return disabled status when audio is off
      if (!AUDIO_ENABLED) {
        return {
          initialized: false,
          disabled: true,
          currentTrack: null,
          muted: true,
          playing: false,
          hasPlayedBefore: false,
          contextReady: false,
          bufferLoaded: false,
          contextState: 'disabled'
        };
      }
      return {
        initialized: isInitialized,
        currentTrack: currentAudio,
        muted: isMuted,
        playing: music ? music.playing() : false,
        hasPlayedBefore: hasPlayedAudio,
        contextReady: audioInitialized,
        bufferLoaded: audioLoaded,
        contextState: (typeof Howler !== 'undefined' && Howler.ctx) ? Howler.ctx.state : 'unknown'
      };
    },
    addAudioListener: function(camera) {
      if (!AUDIO_ENABLED) return;
      // Not needed with Howler.js - it handles audio context internally
      console.log("addAudioListener: Not needed with Howler.js");
    },
    showMessage: function(message, duration) {
      // TODO: Keep message functionality even when audio disabled
      showStartupMessage(message, duration);
    },
    // New method to explicitly request audio context resume
    resumeAudioContext: async function() {
      if (!AUDIO_ENABLED) {
        console.log("[AUDIO] resumeAudioContext() - Audio disabled");
        return Promise.resolve();
      }
      return startAudioExperience();
    },
    // TODO: Add method to check if audio is enabled (useful for UI decisions)
    isEnabled: function() {
      return AUDIO_ENABLED;
    }
  };
})();

// Expose the module globally
window.AudioModule = AudioModule;
