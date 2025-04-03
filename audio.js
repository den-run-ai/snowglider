// audio.js - Handle game audio using Three.js audio system

// AudioModule - Global module for managing game audio
const AudioModule = (function() {
  // Private variables
  let audioListener;
  let music = null;
  let audioFiles = {
    'drum_loop': { path: './assets/drum_loop_are_you_heaven.wav', type: 'audio/wav' },
    'skullbeatz': { path: './assets/skullbeatz_bad_cat.mp3', type: 'audio/mp3' }
  };
  let currentAudio = 'drum_loop';
  let isMuted = false;
  let isInitialized = false;
  let audioLoader;
  let soundEnabled = true;
  let hasPlayedAudio = false;
  let startupMessage = null;
  
  // Private methods
  function initAudio(scene) {
    if (isInitialized) return;
    
    console.log("Initializing audio system");
    
    // Create an audio listener and add it to the camera
    audioListener = new THREE.AudioListener();
    
    // Create audio loader
    audioLoader = new THREE.AudioLoader();
    
    // Add listener to the scene camera
    if (scene.camera) {
      scene.camera.add(audioListener);
    } else {
      // If no camera directly on scene, find the camera
      scene.traverse(object => {
        if (object instanceof THREE.Camera) {
          object.add(audioListener);
          return;
        }
      });
    }
    
    // Create the music source
    music = new THREE.Audio(audioListener);
    
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
      listener: audioListener,
      music: music
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
  
  function loadAudio(audioName) {
    if (!isInitialized || !audioFiles[audioName]) return;
    
    try {
      // Stop current audio if playing
      if (music.isPlaying) {
        music.stop();
      }
      
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
      
      audioLoader.load(
        audioPath,
        function(buffer) {
          try {
            music.setBuffer(buffer);
            music.setLoop(true);
            music.setVolume(0.5);
            
            currentAudio = audioName;
            localStorage.setItem('snowgliderAudioTrack', audioName);
            
            // Only play if not muted and sound is enabled
            if (!isMuted && soundEnabled) {
              music.play();
              hasPlayedAudio = true;
              console.log("Audio is now playing:", audioName);
            }
            
            // Update UI
            updateUI();
          } catch (e) {
            console.error("Error setting up audio buffer:", e.message, e.stack);
          }
        },
        function(xhr) {
          // Progress
          console.log((xhr.loaded / xhr.total * 100) + '% loaded');
        },
        function(err) {
          // Error handler
          console.error("Error loading audio track:", audioName, err);
          
          // Try alternative audio if this one failed
          if (audioName === 'drum_loop' && audioFiles['skullbeatz']) {
            console.log("Trying fallback audio track...");
            setTimeout(() => loadAudio('skullbeatz'), 500);
          } else if (audioName === 'skullbeatz' && audioFiles['drum_loop']) {
            console.log("Trying fallback audio track...");
            setTimeout(() => loadAudio('drum_loop'), 500);
          }
        }
      );
    } catch (e) {
      console.error("Error in loadAudio function:", e.message, e.stack);
    }
  }
  
  function toggleMute() {
    isMuted = !isMuted;
    
    if (isMuted) {
      // User wants to mute, pause any playing audio
      if (music && music.isPlaying) {
        music.pause();
      }
    } else {
      // User wants to unmute, try to play if not already playing
      if (music && !music.isPlaying && soundEnabled) {
        music.play();
        hasPlayedAudio = true;
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
  return {
    init: function(scene) {
      const result = initAudio(scene);
      return result;
    },
    setupUI: function() {
      createAudioUI();
      updateUI();
    },
    toggleMute: toggleMute,
    changeTrack: function(trackName) {
      if (audioFiles[trackName]) {
        loadAudio(trackName);
        return true;
      }
      return false;
    },
    startAudio: function() {
      // This is the main function to call after user interaction
      if (!isInitialized) {
        console.error("Audio system not initialized. Call init() first.");
        return false;
      }
      
      // Show a welcome message
      showStartupMessage("Welcome to SnowGlider!", 2000);
      
      // Load the current audio track
      loadAudio(currentAudio);
      return true;
    },
    setVolume: function(level) {
      if (music) {
        music.setVolume(Math.max(0, Math.min(1, level)));
      }
    },
    enableSound: function(enable) {
      soundEnabled = enable;
      if (enable && !isMuted && music) {
        if (!music.isPlaying) {
          music.play();
          hasPlayedAudio = true;
        }
      } else if (!enable && music && music.isPlaying) {
        music.pause();
      }
    },
    getStatus: function() {
      return {
        initialized: isInitialized,
        currentTrack: currentAudio,
        muted: isMuted,
        playing: music ? music.isPlaying : false,
        hasPlayedBefore: hasPlayedAudio
      };
    },
    addAudioListener: function(camera) {
      if (audioListener && camera) {
        camera.add(audioListener);
      }
    },
    showMessage: function(message, duration) {
      showStartupMessage(message, duration);
    }
  };
})();

// Expose the module globally
window.AudioModule = AudioModule;