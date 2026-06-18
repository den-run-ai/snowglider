// @ts-check
// audio.js - Radically simplified audio using native HTML5 Audio
// ~100 lines max, single track, minimal state management
//
// Phase 2 (issue #84): converted off the classic global model. `AudioModule` is
// now `export`ed and loaded through the bundle entry (src/main.js) rather than
// the classic script-loader. This module uses no three.js, so there is no
// `import * as THREE`. The `window.AudioModule` assignment below is kept so the
// still-window consumers (snowglider.js bare reads, start-menu.js, and the
// classic audio-tests browser suite) keep working until they import it directly.
//
// Design principles:
// 1. Native HTML5 Audio element - no library dependencies
// 2. Single track only (drum_loop) - no track switching complexity
// 3. Only 2 state variables - muted and initialized
// 4. No pre-loading - load when user clicks play
// 5. No visibility change handling - let browser manage it
// 6. No retry prompts - if it doesn't work, it doesn't work
//
// To disable: Set AUDIO_ENABLED = false

const AUDIO_ENABLED = true;

/**
 * Status object returned by getStatus(). The native HTML5 implementation only
 * populates the first fields; bufferLoaded/contextReady/contextState are legacy
 * (Howler/AudioContext-era) fields that callers (snowglider.js checkAudioStatus)
 * still probe — kept optional so those compat checks type-check and read as
 * undefined at runtime.
 * @typedef {Object} AudioStatus
 * @property {boolean} initialized
 * @property {boolean} disabled
 * @property {boolean} muted
 * @property {boolean} playing
 * @property {string} [currentTrack]
 * @property {boolean} [bufferLoaded]
 * @property {boolean} [contextReady]
 * @property {string} [contextState]
 */

export const AudioModule = (function() {
  let audio = null;
  let muted = false;
  let initialized = false;
  
  const AUDIO_PATH = 'assets/drum_loop_are_you_heaven.wav';
  
  // Load mute preference from localStorage
  function loadPreferences() {
    const stored = localStorage.getItem('snowgliderMuted');
    if (stored !== null) {
      muted = stored === 'true';
    }
  }
  
  // Save mute preference
  function savePreferences() {
    localStorage.setItem('snowgliderMuted', String(muted));
  }
  
  // Create the audio element
  function createAudio() {
    if (audio) return audio;
    
    audio = new Audio(AUDIO_PATH);
    audio.loop = true;
    audio.volume = 0.5;
    
    audio.addEventListener('error', (e) => {
      const mediaEl = /** @type {HTMLMediaElement} */ (e.target);
      console.warn('[Audio] Load error:', mediaEl?.error?.message || 'unknown');
    });
    
    return audio;
  }
  
  // Create minimal UI - just a mute button
  function createUI() {
    if (!AUDIO_ENABLED) return;
    if (document.getElementById('audioControlBtn')) return;
    
    const btn = document.createElement('button');
    btn.id = 'audioControlBtn';
    btn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 1000;
      width: 40px; height: 40px; border-radius: 50%;
      border: none; background: rgba(0,0,0,0.6); color: white;
      font-size: 20px; cursor: pointer;
    `;
    updateButtonUI(btn);
    
    btn.addEventListener('click', () => {
      AudioModule.toggleMute();
      // Button UI is already updated by toggleMute()
    });
    
    document.body.appendChild(btn);
  }
  
  function updateButtonUI(btn) {
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Unmute' : 'Mute';
  }
  
  // Public API
  return {
    // _scene accepted (and ignored) for backward-compat with the old Three.js
    // Audio API surface; the native HTML5 implementation needs no scene.
    init: function(_scene) {
      if (!AUDIO_ENABLED) return { initialized: false, disabled: true };
      if (initialized) return { initialized: true };
      
      loadPreferences();
      initialized = true;
      console.log('[Audio] Initialized (simplified)');
      return { initialized: true };
    },
    
    setupUI: function() {
      if (!AUDIO_ENABLED) return;
      createUI();
    },
    
    startAudio: function() {
      if (!AUDIO_ENABLED || muted) return false;
      
      createAudio();
      audio.play().then(() => {
        console.log('[Audio] Playing');
      }).catch((e) => {
        console.warn('[Audio] Play failed:', e.message);
      });
      return true;
    },
    
    toggleMute: function() {
      if (!AUDIO_ENABLED) return false;
      
      muted = !muted;
      savePreferences();
      
      if (audio) {
        if (muted) {
          audio.pause();
        } else {
          audio.play().catch(() => {});
        }
      }
      
      // Update button if exists
      const btn = document.getElementById('audioControlBtn');
      if (btn) updateButtonUI(btn);
      
      return muted;
    },
    
    setVolume: function(level) {
      if (!AUDIO_ENABLED || !audio) return;
      audio.volume = Math.max(0, Math.min(1, level));
    },
    
    enableSound: function(enable) {
      if (!AUDIO_ENABLED) return;
      if (enable && !muted && audio) {
        audio.play().catch(() => {});
      } else if (!enable && audio) {
        audio.pause();
      }
    },
    
    /** @returns {AudioStatus} */
    getStatus: function() {
      if (!AUDIO_ENABLED) {
        return { initialized: false, disabled: true, muted: true, playing: false };
      }
      return {
        initialized,
        disabled: false,
        muted,
        playing: audio ? !audio.paused : false,
        currentTrack: 'drum_loop'
      };
    },
    
    isEnabled: function() {
      return AUDIO_ENABLED;
    },
    
    // Compatibility stubs for existing code
    preloadAudio: function() { return Promise.resolve(); },
    playPreloadedAudio: function() { return this.startAudio(); },
    resumeAudioContext: function() { return Promise.resolve(); },
    changeTrack: function() { return false; },
    addAudioListener: function(_listener) {},
    showMessage: function(msg, duration = 3000) {
      // Keep message functionality
      const div = document.createElement('div');
      div.textContent = msg;
      div.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(0,0,0,0.7); color: white; padding: 20px 30px;
        border-radius: 10px; font-size: 24px; z-index: 3000;
      `;
      document.body.appendChild(div);
      setTimeout(() => div.remove(), duration);
    },
    showAudioRetryPrompt: function() {}
  };
})();

// Backward-compat global export for the still-window consumers (snowglider.js
// reads `AudioModule` by bare name; start-menu.js + audio-tests use window.AudioModule).
if (typeof window !== 'undefined') {
  /** @type {any} */ (window).AudioModule = AudioModule;
}
