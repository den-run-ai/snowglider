// audio.ts - Radically simplified audio using native HTML5 Audio
// ~100 lines max, single track, minimal state management
//
// Phase 2 (issue #84): converted off the classic global model. `AudioModule` is
// now `export`ed and loaded through the bundle entry (src/main.js) rather than
// the classic script-loader. This module uses no three.js, so there is no
// `import * as THREE`. Every consumer imports `AudioModule` directly now, so the
// previous `window.AudioModule` namespace bridge has been removed.
//
// Phase 3 (issue #84): renamed `.js` -> `.ts`, dropping the now-implied
// `// @ts-check` pragma and promoting the `AudioStatus` JSDoc typedef into a real
// `interface` plus typed fields/params. Every edit is type-only/erasable, so
// esbuild (Vite) and Node's native type-stripping run it exactly as before —
// behaviour is unchanged.
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
 * (Howler/AudioContext-era) fields that callers (snowglider.ts checkAudioStatus)
 * still probe — kept optional so those compat checks type-check and read as
 * undefined at runtime.
 */
interface AudioStatus {
  initialized: boolean;
  disabled: boolean;
  muted: boolean;
  playing: boolean;
  currentTrack?: string;
  bufferLoaded?: boolean;
  contextReady?: boolean;
  contextState?: string;
}

export const AudioModule = (function() {
  let audio: HTMLAudioElement | null = null;
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
  function createAudio(): HTMLAudioElement {
    if (audio) return audio;

    audio = new Audio(AUDIO_PATH);
    audio.loop = true;
    audio.volume = 0.5;

    audio.addEventListener('error', (e) => {
      const mediaEl = e.target as HTMLMediaElement;
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

    // Button UI is already updated by toggleMute().
    const handleToggle = () => { AudioModule.toggleMute(); };

    // Desktop / pointer devices.
    btn.addEventListener('click', handleToggle);

    // Mobile: the game registers a document-level `touchstart` handler that calls
    // preventDefault() (controls.ts), which suppresses the browser's synthesized
    // `click` for the tap — so the click listener above never fires on touch and
    // the button appears dead. Handle the tap explicitly here, mirroring the
    // reset/camera buttons. stopPropagation() keeps the document handler from also
    // reading the tap as a game control, and preventDefault() avoids a duplicate
    // synthesized click toggling mute back.
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleToggle();
    }, { passive: false });

    document.body.appendChild(btn);
  }

  function updateButtonUI(btn: HTMLElement) {
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Unmute' : 'Mute';
  }

  // Public API
  return {
    // _scene accepted (and ignored) for backward-compat with the old Three.js
    // Audio API surface; the native HTML5 implementation needs no scene.
    init: function(_scene?: unknown) {
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

      const el = createAudio();
      el.play().then(() => {
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

    setVolume: function(level: number) {
      if (!AUDIO_ENABLED || !audio) return;
      audio.volume = Math.max(0, Math.min(1, level));
    },

    enableSound: function(enable: boolean) {
      if (!AUDIO_ENABLED) return;
      if (enable && !muted && audio) {
        audio.play().catch(() => {});
      } else if (!enable && audio) {
        audio.pause();
      }
    },

    getStatus: function(): AudioStatus {
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

    // Compatibility stubs for existing code. preloadAudio accepts (and ignores) a
    // track name for parity with the old Howler API surface — the boot
    // script-loader still calls preloadAudio('drum_loop').
    preloadAudio: function(_track?: string) { return Promise.resolve(); },
    playPreloadedAudio: function() { return this.startAudio(); },
    resumeAudioContext: function() { return Promise.resolve(); },
    changeTrack: function() { return false; },
    addAudioListener: function(_listener?: unknown) {},
    showMessage: function(msg: string, duration = 3000) {
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

// The window.AudioModule bridge was removed (issue #84): every consumer now
// imports AudioModule directly — snowglider.ts (orchestrator), the boot
// script-loader, the start menu, and the audio browser test suite.
