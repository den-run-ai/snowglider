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
  
  // Private methods
  function initAudio(scene) {
    if (isInitialized) return;
    
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
    
    const storedAudio = localStorage.getItem('snowgliderAudioTrack');
    if (storedAudio !== null && audioFiles[storedAudio]) {
      currentAudio = storedAudio;
    }
    
    // Load the initial audio file
    loadAudio(currentAudio);
    
    isInitialized = true;
    
    return {
      listener: audioListener,
      music: music
    };
  }
  
  function loadAudio(audioName) {
    if (!isInitialized || !audioFiles[audioName]) return;
    
    // Stop current audio if playing
    if (music.isPlaying) {
      music.stop();
    }
    
    // Load and set the audio
    const audioInfo = audioFiles[audioName];
    audioLoader.load(
      audioInfo.path,
      function(buffer) {
        music.setBuffer(buffer);
        music.setLoop(true);
        music.setVolume(0.5);
        
        if (soundEnabled && !isMuted) {
          music.play();
        }
        
        currentAudio = audioName;
        localStorage.setItem('snowgliderAudioTrack', audioName);
        
        // Update UI if exists
        updateUI();
      },
      function(xhr) {
        // Progress
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
      },
      function(err) {
        // Error
        console.error('Error loading audio:', err);
      }
    );
  }
  
  function toggleMute() {
    isMuted = !isMuted;
    
    if (isMuted) {
      if (music && music.isPlaying) {
        music.pause();
      }
    } else {
      if (music && !music.isPlaying && soundEnabled) {
        music.play();
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
      audioButton.innerHTML = isMuted ? '🔇' : '🔊';
      audioButton.title = isMuted ? 'Unmute' : 'Mute';
    }
    
    if (audioSelect) {
      audioSelect.value = currentAudio;
    }
  }
  
  function createAudioUI() {
    // Create audio control button
    const audioButton = document.createElement('button');
    audioButton.id = 'audioControlBtn';
    audioButton.innerHTML = isMuted ? '🔇' : '🔊';
    audioButton.title = isMuted ? 'Unmute' : 'Mute';
    
    audioButton.addEventListener('click', function() {
      toggleMute();
    });
    
    // Create audio select dropdown
    const audioSelect = document.createElement('select');
    audioSelect.id = 'audioSelect';
    
    // Add options
    for (const [key, audio] of Object.entries(audioFiles)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key === 'drum_loop' ? 'Drum Loop' : 'Skullbeatz';
      audioSelect.appendChild(option);
    }
    
    // Set current selection
    audioSelect.value = currentAudio;
    
    // Add change event
    audioSelect.addEventListener('change', function() {
      const selected = this.value;
      loadAudio(selected);
    });
    
    // Add to DOM
    document.body.appendChild(audioButton);
    document.body.appendChild(audioSelect);
    
    // Show audio select when hovering over the audio button
    audioButton.addEventListener('mouseenter', function() {
      audioSelect.style.display = 'block';
    });
    
    // Hide select when mouse leaves both elements
    audioSelect.addEventListener('mouseleave', function(e) {
      // Check if we're not moving to the audio button
      if (!audioButton.contains(e.relatedTarget)) {
        audioSelect.style.display = 'none';
      }
    });
    
    audioButton.addEventListener('mouseleave', function(e) {
      // Check if we're not moving to the select
      if (!audioSelect.contains(e.relatedTarget)) {
        audioSelect.style.display = 'none';
      }
    });
    
    // For mobile touch events
    audioButton.addEventListener('touchend', function(e) {
      if (audioSelect.style.display === 'none' || audioSelect.style.display === '') {
        audioSelect.style.display = 'block';
        e.preventDefault(); // Prevent immediate toggle
      } else {
        audioSelect.style.display = 'none';
        toggleMute();
      }
    }, { passive: false });
  }
  
  // Public API
  return {
    init: function(scene) {
      return initAudio(scene);
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
    setVolume: function(level) {
      if (music) {
        music.setVolume(Math.max(0, Math.min(1, level)));
      }
    },
    enableSound: function(enable) {
      soundEnabled = enable;
      if (enable && !isMuted && music) {
        music.play();
      } else if (!enable && music) {
        music.pause();
      }
    },
    getStatus: function() {
      return {
        initialized: isInitialized,
        currentTrack: currentAudio,
        muted: isMuted,
        playing: music ? music.isPlaying : false
      };
    },
    addAudioListener: function(camera) {
      if (audioListener && camera) {
        camera.add(audioListener);
      }
    }
  };
})();

// Expose the module globally
window.AudioModule = AudioModule;