// Run lifecycle for SnowGlider: reset (new run), restart (after game over), camera
// view toggle, and the DOM controls that drive them (reset button, camera-toggle
// button, restart button). Extracted from snowglider.ts as `createLifecycle(deps)`;
// the coordinator injects the scene handles + run/player state and re-publishes
// reset/restart/toggle on `window`. Mechanical move — behavior is unchanged.

import { Controls } from '../controls.js';
import { getDifficultyConfig } from '../difficulty.js';
import { Snow } from '../snow.js';
import { Flex } from '../snowman-flex.js';
import { Expression } from '../snowman-expression.js';
import { AudioModule } from '../audio.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { CourseModule } from '../course.js';
import { EffectsModule } from '../effects.js';
import { Physics, type PlayerState } from '../player-state.js';
import { updateTimerDisplay } from '../ui/hud.js';
import { setupCollapsiblePanel } from '../ui/collapsible-panel.js';
import { usesOrbitControls, type CameraMode } from '../camera.js';
import type { SceneContext } from './scene-setup.js';

// Radians the Q/E keys and tray arrows rotate the orbit per press.
const ORBIT_KEY_STEP = Math.PI / 12; // 15°
// Zoom multipliers for a single key/button/wheel step (in = closer, out = farther).
const ZOOM_IN_STEP = 0.88;
const ZOOM_OUT_STEP = 1.14;
// Mouse-drag orbit sensitivity (radians per pixel) for yaw and pitch.
const DRAG_YAW_SENS = 0.006;
const DRAG_PITCH_SENS = 0.004;

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

    // Snap the facial expression (mouth/brows/eyes) back to the neutral relaxed-smile
    // face too, so a new run starts from a clean expression (issue #364). Purely visual.
    Expression.reset(snowman);

    // Clear any crash-shatter wipeout: dispose its (debris-owned) fragments and re-show
    // the snowman, so a restart always begins with a clean, visible snowman (#53).
    if (state.debris) state.debris.reset();

    // Clear ski trails so a new run starts on a fresh, untracked slope (#17).
    if (state.snowTrails) state.snowTrails.reset();

    // Reset the persistent snow-depth field to full powder so a new run begins on a
    // pristine, un-packed slope (#246).
    if (state.snowDepth) state.snowDepth.reset();

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

  // Friendly label for each camera mode, shown on the controls row + toggle button.
  function cameraModeLabel(mode: CameraMode): string {
    switch (mode) {
      case 'auto': return 'Auto';
      case 'follow': return 'Follow';
      case 'orbit': return 'Orbit 360°';
      case 'firstPerson': return 'First Person';
      case 'cameraman': return 'Cameraman';
      case 'drone': return 'Drone';
      default: return String(mode);
    }
  }

  // Reflect the active camera mode across the controls-guide row, the toggle button,
  // and the camera tray's pressed state. Safe to call when any of those are absent.
  function syncCameraModeUi(mode: CameraMode) {
    const label = cameraModeLabel(mode);

    // Update the camera mode text in the controls info. Target the camera row by a
    // stable id (not :last-child) so appending more control items after it — e.g. the
    // Ski Techniques rows — can't make the toggle rewrite the wrong row.
    const viewControlItem = document.querySelector('#cameraViewControl');
    if (viewControlItem) {
      const keyBadge = viewControlItem.querySelector('.key-badge');
      const textSpan = viewControlItem.querySelector('span:last-child');
      if (keyBadge && textSpan) {
        keyBadge.textContent = 'V';
        textSpan.textContent = `Camera: ${label}`;
      }
    }

    // Update the toggle button text
    const cameraToggleBtn = document.getElementById('cameraToggleBtn');
    if (cameraToggleBtn) {
      cameraToggleBtn.textContent = `Camera: ${label}`;
    }

    // Highlight the active mode chip in the camera tray, and disable the orbit/zoom widgets
    // in the modes that ignore manual view controls (first person + the cinematic follows).
    const orbitControls = usesOrbitControls(mode);
    document.querySelectorAll<HTMLElement>('#cameraControls [data-cam-mode]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-cam-mode') === mode ? 'true' : 'false');
    });
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#cameraControls [data-cam-orbit], #cameraControls [data-cam-zoom]')
      .forEach((el) => { el.disabled = !orbitControls; });
  }

  // Cycle the camera mode (V key / toggle button): advance the mode, re-seat the
  // camera for it, and refresh the UI. Returns the new mode (useful for tests).
  function toggleCameraView() {
    const newMode = cameraManager.toggleCameraMode();
    // Reset camera initialization with current snowman position and rotation
    cameraManager.initialize(snowman.position, snowman.rotation);
    syncCameraModeUi(newMode);
    return newMode;
  }

  // Jump straight to a named mode (camera tray chips).
  function selectCameraMode(mode: CameraMode) {
    const newMode = cameraManager.setMode(mode);
    cameraManager.initialize(snowman.position, snowman.rotation);
    syncCameraModeUi(newMode);
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
    cameraToggleBtn.textContent = 'Camera: Auto';
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

    // Build the camera tray (mode chips + 360° orbit slider + zoom) and wire the
    // keyboard / mouse-wheel / mouse-drag view controls.
    initCameraControls();

    // Reflect the camera's starting mode (Auto) on the freshly-built widgets.
    syncCameraModeUi(cameraManager.mode);

    // Add event listener to restart button
    restartButton.addEventListener('click', restartGame, listenerOpts);
  }

  // Build the on-screen camera tray and wire desktop keyboard / wheel / drag controls.
  // Everything registered here threads the teardown `signal` (via listenerOpts /
  // touchOpts) so disposeGame removes it; the tray node is removed by teardown.ts.
  function initCameraControls() {
    if (typeof document === 'undefined' || !document.body) return;

    const tray = document.createElement('div');
    tray.id = 'cameraControls';

    // Collapsible header (matches the Game Controls / Game Stats HUD panels): a title
    // plus a ▲/▼ toggle. setupCollapsiblePanel() below wires the click / touch / swipe
    // collapse behavior and toggles the `collapsed` class on the tray. The mode chips
    // and orbit/zoom rows live in a content wrapper that the class hides.
    const header = document.createElement('div');
    header.id = 'cameraControlsHeader';
    const title = document.createElement('h3');
    title.textContent = '🎥 Camera';
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'toggleCamera';
    toggleBtn.type = 'button';
    toggleBtn.textContent = '▲';
    toggleBtn.setAttribute('aria-label', 'Toggle camera options');
    header.append(title, toggleBtn);
    tray.appendChild(header);

    const content = document.createElement('div');
    content.id = 'cameraControlsContent';
    tray.appendChild(content);

    // Mode chips: Auto / Follow / Orbit / FP / Cameraman / Drone.
    const modes: Array<{ mode: CameraMode; label: string; title: string }> = [
      { mode: 'auto', label: 'Auto', title: 'Auto — smart camera that adapts to speed and turns' },
      { mode: 'follow', label: 'Follow', title: 'Follow — classic chase view behind the snowman' },
      { mode: 'orbit', label: 'Orbit', title: 'Orbit — free 360° camera you control' },
      { mode: 'firstPerson', label: 'FP', title: 'First person — over-the-head view' },
      { mode: 'cameraman', label: 'Cam', title: 'Cameraman — cinematic ski-film chase; low, close, side-trailing' },
      { mode: 'drone', label: 'Drone', title: 'Drone — cinematic aerial chase; high, far, slowly circling' },
    ];
    const modeRow = document.createElement('div');
    modeRow.className = 'cam-row';
    for (const { mode, label, title } of modes) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute('data-cam-mode', mode);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => selectCameraMode(mode), listenerOpts);
      btn.addEventListener('touchend', (e) => { e.preventDefault(); selectCameraMode(mode); }, touchOpts);
      modeRow.appendChild(btn);
    }
    content.appendChild(modeRow);

    // Orbit row: ⟲  [0–360° slider]  ⟳  ⊙(recenter).
    const orbitRow = document.createElement('div');
    orbitRow.className = 'cam-row';
    const orbitLeft = makeIconButton('⟲', 'Orbit left (Q)', () => nudgeOrbit(-ORBIT_KEY_STEP));
    orbitLeft.setAttribute('data-cam-orbit', 'left');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '360';
    slider.value = '0';
    slider.step = '1';
    slider.id = 'cameraOrbitSlider';
    slider.title = 'Orbit angle (0–360°)';
    slider.setAttribute('data-cam-orbit', 'slider');
    slider.addEventListener('input', () => {
      const deg = Number(slider.value);
      cameraManager.setOrbitYaw((deg * Math.PI) / 180);
    }, listenerOpts);
    const orbitRight = makeIconButton('⟳', 'Orbit right (E)', () => nudgeOrbit(ORBIT_KEY_STEP));
    orbitRight.setAttribute('data-cam-orbit', 'right');
    const recenterBtn = makeIconButton('⊙', 'Recenter behind snowman (C)', () => { cameraManager.recenter(); syncOrbitSlider(); });
    recenterBtn.setAttribute('data-cam-orbit', 'recenter');
    orbitRow.append(orbitLeft, slider, orbitRight, recenterBtn);
    content.appendChild(orbitRow);

    // Zoom row: −  Zoom  +.
    const zoomRow = document.createElement('div');
    zoomRow.className = 'cam-row';
    const zoomOut = makeIconButton('−', 'Zoom out (− / wheel)', () => cameraManager.adjustZoom(ZOOM_OUT_STEP));
    zoomOut.setAttribute('data-cam-zoom', 'out');
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'cam-zoom-label';
    zoomLabel.textContent = 'Zoom';
    const zoomIn = makeIconButton('+', 'Zoom in (+ / wheel)', () => cameraManager.adjustZoom(ZOOM_IN_STEP));
    zoomIn.setAttribute('data-cam-zoom', 'in');
    zoomRow.append(zoomOut, zoomLabel, zoomIn);
    content.appendChild(zoomRow);

    document.body.appendChild(tray);

    // Wire the collapse toggle / header tap / horizontal swipe, reusing the shared HUD
    // panel behavior. No resetListeners / small-screen auto-collapse: the tray is a
    // fresh node each game and its only listeners live on this subtree (header/button),
    // so teardown's removal of #cameraControls disposes them — no window-level leak.
    setupCollapsiblePanel({
      name: 'camera',
      containerId: 'cameraControls',
      toggleButtonId: 'toggleCamera',
      headerId: 'cameraControlsHeader',
    });

    // These window-level listeners only steer the camera during a LIVE run. Gating on
    // state.gameActive keeps them inert on the start / about / leaderboard menu, the
    // loading window, and the game-over overlay — so, e.g., the wheel handler never
    // preventDefault()s a scroll on a tall start screen (codex review, PR #306).

    // --- Keyboard: Q/E orbit, C recenter, +/- zoom (movement + V live in controls.ts) ---
    const handleCameraKey = (event: KeyboardEvent) => {
      if (!state.gameActive) return;
      // Orbit/zoom apply only in the modes that honor manual view controls; ignore these
      // keys in first person and the cinematic follows (the wheel/drag paths and the tray
      // widgets do too — codex review, PR #306; cinematic modes issue #315).
      if (!usesOrbitControls(cameraManager.mode)) return;
      // Don't hijack typing in form fields (e.g. the orbit slider has focus).
      const target = event.target as Element | null;
      if (target && typeof (target as HTMLElement).closest === 'function' &&
          target.closest('input, textarea, select')) return;
      switch (event.key) {
        case 'q': case 'Q': nudgeOrbit(-ORBIT_KEY_STEP); break;
        case 'e': case 'E': nudgeOrbit(ORBIT_KEY_STEP); break;
        case 'c': case 'C':
          if (!event.repeat) { cameraManager.recenter(); syncOrbitSlider(); }
          break;
        case '+': case '=': cameraManager.adjustZoom(ZOOM_IN_STEP); break;
        case '-': case '_': cameraManager.adjustZoom(ZOOM_OUT_STEP); break;
        default: return;
      }
    };
    window.addEventListener('keydown', handleCameraKey, listenerOpts);

    // --- Mouse wheel: zoom the third-person rig (ignored over scrollable UI / FP) ---
    const handleWheel = (event: WheelEvent) => {
      if (!state.gameActive) return; // never swallow scroll on the menus / game-over screen
      if (!usesOrbitControls(cameraManager.mode)) return;
      const target = event.target as Element | null;
      if (target && typeof (target as HTMLElement).closest === 'function' &&
          target.closest('#controlsGuide, #controlsContainer, #gameOverOverlay, #cameraControls')) return;
      event.preventDefault();
      cameraManager.adjustZoom(event.deltaY > 0 ? ZOOM_OUT_STEP : ZOOM_IN_STEP);
    };
    window.addEventListener('wheel', handleWheel, signal ? { passive: false, signal } : { passive: false });

    // --- Mouse drag: orbit the third-person rig (left-drag on the canvas only) ---
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const handlePointerDown = (event: PointerEvent) => {
      if (!state.gameActive) return; // only orbit during a live run
      if (event.pointerType !== 'mouse' || event.button !== 0) return; // mouse-drag only; touch = steering
      if (!usesOrbitControls(cameraManager.mode)) return;
      const target = event.target as Element | null;
      if (target && typeof (target as HTMLElement).closest === 'function' &&
          target.closest('button, a, input, select, textarea, label, [role="button"], #controlsGuide, #controlsContainer, #gameOverOverlay, #cameraControls, #gameStatsContainer, #authContainer')) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      cameraManager.orbit(-dx * DRAG_YAW_SENS, -dy * DRAG_PITCH_SENS);
      syncOrbitSlider();
    };
    const endDrag = () => { dragging = false; };
    window.addEventListener('pointerdown', handlePointerDown, listenerOpts);
    window.addEventListener('pointermove', handlePointerMove, listenerOpts);
    window.addEventListener('pointerup', endDrag, listenerOpts);
    window.addEventListener('pointercancel', endDrag, listenerOpts);
  }

  // Nudge the orbit yaw by a keyboard/button step and keep the slider in sync.
  function nudgeOrbit(dYaw: number) {
    cameraManager.orbit(dYaw);
    syncOrbitSlider();
  }

  // Push the camera's current orbit yaw back onto the 0–360° slider (wraps to 0..360).
  function syncOrbitSlider() {
    const slider = document.getElementById('cameraOrbitSlider') as HTMLInputElement | null;
    if (!slider) return;
    let deg = (cameraManager.orbitYaw * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    slider.value = String(Math.round(deg));
  }

  // Small square icon button for the camera tray, sharing the tray's CSS styling.
  function makeIconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = glyph;
    btn.title = title;
    btn.addEventListener('click', onClick, listenerOpts);
    btn.addEventListener('touchend', (e) => { e.preventDefault(); onClick(); }, touchOpts);
    return btn;
  }

  return { resetSnowman, restartGame, toggleCameraView, selectCameraMode, initLifecycleUI };
}
