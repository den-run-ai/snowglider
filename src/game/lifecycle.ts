// Run lifecycle for SnowGlider: reset (new run), restart (after game over), camera
// view toggle, and the DOM controls that drive them (reset button, camera-toggle
// button, restart button). Extracted from snowglider.ts as `createLifecycle(deps)`;
// the coordinator injects the scene handles + run/player state and re-publishes
// reset/restart/toggle on `window`. Mechanical move — behavior is unchanged.

import { Controls } from '../controls.js';
import { getDifficultyConfig } from '../difficulty.js';
import { Snow } from '../snow.js';
import { Flex } from '../snowman-flex.js';
import { AudioModule } from '../audio.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { CourseModule } from '../course.js';
import { EffectsModule } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import { updateTimerDisplay } from '../ui/hud.js';
import type { SceneContext } from './scene-setup.js';

export interface LifecycleDeps extends
  Pick<SceneContext, 'state' | 'cameraManager' | 'snowman' | 'gameOverOverlay' | 'restartButton'> {
  player: PlayerState;
  startLoop: () => void;
  // Reseed the loop's per-run carry-over (accumulator, interpolation window, last result)
  // to the freshly-reset spawn. resetSnowman runs WITHOUT startLoop on the in-game Reset
  // button (the loop keeps running), so it must reseed here or the stale pre-reset position
  // leaks into the render lerp and the first diagnostics step.
  resetLoopState: () => void;
  // If the run's locked tier no longer matches the tier the scene was built for (the finish
  // "Play again on" picker switched it), reload to rebuild the scene for it and return true so
  // restartGame bails. Wired by the coordinator (snowglider.ts); omitted by the lifecycle unit
  // test, where restartGame keeps its old, reload-free behavior.
  maybeReloadForRunTier?: () => boolean;
  // Optional AbortSignal tying the game-lifetime DOM listeners wired in initLifecycleUI
  // (reset / camera-toggle / restart buttons) to disposeGame's teardown. Omitted by the
  // lifecycle unit test, which never tears down.
  signal?: AbortSignal;
}

export function createLifecycle(deps: LifecycleDeps) {
  const { state, cameraManager, snowman, gameOverOverlay, restartButton, player, startLoop, resetLoopState, maybeReloadForRunTier, signal } = deps;
  const pos = player.pos;
  // Listener options for the game-lifetime button handlers below: thread the teardown
  // signal when supplied so disposeGame can remove them, else live for the page.
  const listenerOpts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  const touchOpts: AddEventListenerOptions = signal ? { passive: false, signal } : { passive: false };

  function resetSnowman() {
    // Reset the snowman + player physics state (position, velocity, camera, and the
    // air/auto-turn scalars) to the start of a run.
    Physics.resetPlayer(player, snowman, Snow.getTerrainHeight, cameraManager);

    // Snap the cosmetic flex layer (squash/jiggle/head-bob) back to a neutral pose so a
    // new run starts clean (issue #53). Purely visual; no physics impact.
    Flex.reset(snowman);

    // Clear any crash-shatter wipeout: dispose its (debris-owned) fragments and re-show
    // the snowman, so a restart always begins with a clean, visible snowman (#53).
    if (state.debris) state.debris.reset();

    // Clear ski trails so a new run starts on a fresh, untracked slope (#17).
    if (state.snowTrails) state.snowTrails.reset();

    // Reset avalanche system
    const avalanche = state.avalanche;
    if (avalanche) {
      avalanche.reset();
      state.avalancheTriggered = false;
      state.lastAvalancheZ = pos.z; // Reset to starting position
      state.dodgeAwarded = false;   // a new run's slide re-arms the dodge bonus (JP-3)
    }

    // Reset keyboard controls
    Controls.resetControls();

    // Per-tier jump availability (workstream A): sync the touch surface to the run's
    // tier. `state.difficulty` is locked before every reset — the coordinator sets it
    // from the start-screen pick before its initial resetSnowman(), and the finish
    // "Play again on" picker updates it before restartGame() reaches here — so this
    // single call site covers first start, restart, and the in-game Reset button.
    // The kernel's `tuning.manualJump` gate stays the physics source of truth; this
    // only stops the touch UI advertising a dead verb (e.g. on Bunny).
    Controls.setJumpEnabled(getDifficultyConfig(state.difficulty).ski.manualJump);

    // Reseed the loop's per-run carry-over to the spawn position resetPlayer() just set.
    // The in-game Reset button keeps the loop running (no startLoop), so without this the
    // stale pre-reset downhill position would leak into the next frame's render lerp (a
    // visible camera/snowman jump) and into its first diagnostics step (a huge
    // maxSubstepStep false tunnel-risk sample). Must run after resetPlayer().
    resetLoopState();

    // Reset the physics/frame-rate telemetry: resetPlayer() above teleported the player
    // back to spawn (z=-15), so without this the first frame of the new run would read as
    // a huge prev->cur step (old finish position -> spawn) and be falsely flagged as a
    // collision tunnel-through, permanently marking the run BAD. A no-op under automation.
    Diag.reset();

    state.startTime = performance.now(); // Reset the timer when starting a new run
    updateTimerDisplay(state.gameActive, state.startTime);

    // Reset course (gates/splits/ghost) and effects (avalanche UI, FOV, shake) for the new run
    if (CourseModule) CourseModule.reset();
    if (EffectsModule) EffectsModule.reset();

    // Track game reset in Analytics if available
    try {
      // Only try to use analytics when properly initialized with modular SDK
      if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function' && window.location.protocol !== 'file:') {
        // Using the direct logEvent function
        window.firebaseModules.logEvent('game_reset');
      }
    } catch (e) {
      console.log("Analytics tracking skipped:", (e as Error).message);
    }
  }

  function restartGame() {
    // The finish "Play again on" picker can switch tiers; if it did, the built scene no longer
    // matches, so reload to reshape it for the new tier (the run resumes automatically after).
    // Bail here so we don't start a run against the scene that's about to be torn down.
    if (maybeReloadForRunTier && maybeReloadForRunTier()) return;
    gameOverOverlay.style.display = 'none';
    state.gameActive = true;

    // Clear the finish result panel from the previous run, if present.
    const oldResult = document.getElementById('courseResult');
    if (oldResult && oldResult.parentNode) oldResult.parentNode.removeChild(oldResult);

    // Add game-active class to body for styling
    document.body.classList.add('game-active');

    // Show and reset game stats
    const gameStatsContainer = document.getElementById('gameStatsContainer');
    if (gameStatsContainer) {
      gameStatsContainer.classList.remove('collapsed');
      const toggleBtn = document.getElementById('toggleStats');
      if (toggleBtn) {
        toggleBtn.textContent = '▲';
      }
    }

    resetSnowman();

    // Initialize camera with the snowman's position and rotation
    cameraManager.initialize(snowman.position, snowman.rotation);

    // Resume the background music for the new run (audio is ENABLED — see audio.ts;
    // this is a no-op only if AUDIO_ENABLED is ever set false there).
    if (AudioModule) {
      AudioModule.enableSound(true);
    }

    // Restart the SFX ambient bed (idempotent). The restart button is a user gesture,
    // so resuming the Web Audio context here is allowed on mobile (#158).
    Sfx.unlock();

    // Reset animation if it was stopped
    if (!state.animationRunning) {
      state.animationRunning = true;
      startLoop();
    }
  }

  // Toggle between first-person and third-person camera views
  function toggleCameraView() {
    // Call the camera manager's toggle method
    const newMode = cameraManager.toggleCameraMode();

    // Reset camera initialization with current snowman position and rotation
    cameraManager.initialize(snowman.position, snowman.rotation);

    // Update the camera mode text in the controls info. Target the camera row by a
    // stable id (not :last-child) so appending more control items after it — e.g. the
    // Ski Techniques rows — can't make the toggle rewrite the wrong row.
    const viewControlItem = document.querySelector('#cameraViewControl');
    if (viewControlItem) {
      const keyBadge = viewControlItem.querySelector('.key-badge');
      const textSpan = viewControlItem.querySelector('span:last-child');

      if (keyBadge && textSpan) {
        keyBadge.textContent = 'V';
        textSpan.textContent = `Toggle ${newMode === 'thirdPerson' ? 'Normal' : 'Chase'} View`;
      }
    }

    // Update the toggle button text
    const cameraToggleBtn = document.getElementById('cameraToggleBtn');
    if (cameraToggleBtn) {
      cameraToggleBtn.textContent = `Toggle ${newMode === 'thirdPerson' ? 'Normal' : 'Chase'} View`;
    }

    // Return the new mode (useful for tests)
    return newMode;
  }

  // Wire the DOM controls that drive the lifecycle: the reset button, the
  // camera-toggle button (created + appended here), and the restart button.
  function initLifecycleUI() {
    // Initialize controls but don't reset the snowman yet
    document.getElementById('resetBtn')!.addEventListener('click', resetSnowman, listenerOpts);

    // Add camera toggle button
    const cameraToggleBtn = document.createElement('button');
    cameraToggleBtn.id = 'cameraToggleBtn';
    cameraToggleBtn.textContent = 'Toggle Chase View';
    cameraToggleBtn.style.position = 'absolute';
    cameraToggleBtn.style.bottom = '20px';
    cameraToggleBtn.style.left = '170px'; // Position it next to reset button
    cameraToggleBtn.style.padding = '15px 20px';
    cameraToggleBtn.style.border = 'none';
    cameraToggleBtn.style.borderRadius = '8px';
    cameraToggleBtn.style.backgroundColor = '#4a69bd'; // Different color from reset button
    cameraToggleBtn.style.color = 'white';
    cameraToggleBtn.style.cursor = 'pointer';
    cameraToggleBtn.style.fontSize = '16px';
    cameraToggleBtn.style.setProperty('-webkit-tap-highlight-color', 'rgba(255, 255, 255, 0.5)');
    cameraToggleBtn.style.touchAction = 'manipulation'; // Removes delay on mobile devices
    cameraToggleBtn.style.userSelect = 'none';

    // Add both click and touchend events to ensure cross-platform compatibility
    cameraToggleBtn.addEventListener('click', toggleCameraView, listenerOpts);
    cameraToggleBtn.addEventListener('touchend', function(event) {
      event.preventDefault();
      toggleCameraView();
    }, touchOpts);

    document.body.appendChild(cameraToggleBtn);

    // Add event listener to restart button
    restartButton.addEventListener('click', restartGame, listenerOpts);
  }

  return { resetSnowman, restartGame, toggleCameraView, initLifecycleUI };
}
