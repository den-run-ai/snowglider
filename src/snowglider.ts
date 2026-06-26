// snowglider.ts - Orchestrator: scene/render/game loop wiring for SnowGlider.
//
// Phase 3.9 (issue #84): the orchestrator is the LAST module renamed `.js` -> `.ts`,
// after every leaf module was stable. The `@ts-check` pragma is gone (implied for a
// real `.ts` file) and the three `/** @type {any} */ (...)` JSDoc casts (the r160
// color-management / renderer opt-outs) are now `as any` casts — `.ts` does not
// honour JSDoc cast syntax. No behaviour change and no GameState refactor: the
// module-scoped state and its window accessors are unchanged. It still loads via the
// deferred dynamic import below (Vite resolves `./snowglider.js` -> `snowglider.ts`;
// the build emits a `dist/src/snowglider.js` chunk), and the puppeteer start-menu
// regression now matches the delayed `/src/snowglider.{js,ts}` request.
//
// --- Imports (Phase 2.9, issue #84) ---
// snowglider.js is the orchestrator and the LAST game module converted off the
// classic global-namespace model. three.js and every converted game module now
// come from real ES-module imports instead of the CDN global / window.* bridges.
//
// Loading: snowglider.js is pulled in by src/main.js via a *deferred dynamic
// import* (window.__loadSnowGliderOrchestrator), triggered by the classic
// script-loader only after audio.js + Auth are ready. That preserves the
// previous ordering (and the start-menu deferred-load behavior) while keeping
// snowglider.js inside the single bundled module graph — so it shares the same
// Snow/Snowman/Mountains/etc. instances as main.js instead of forking a second
// copy from the verbatim dist/src tree.
//
// Still read as globals (not yet ES modules): AuthModule/ScoresModule/
// firebaseModules (published onto window by the Firebase bootstrap). Those stay
// window.* reads until their own conversion.
import * as THREE from 'three';
import { Controls } from './controls.js';
import { Snow } from './snow.js';
import { Snowman } from './snowman.js';
import { rockCollisionRadius, ROCK_COLLISION_MIN_SIZE } from './mountains.js';
import { AudioModule } from './audio.js';
import { Sfx } from './sfx.js';
import { Diag } from './diagnostics.js';
import { CourseModule } from './course.js';
import { EffectsModule } from './effects.js';
import { Physics } from './player-state.js';
import { IntroModule, prefersReducedMotion, type IntroHandle } from './intro.js';
import { initializeGameStats, initializeControlsToggle, updateTimerDisplay } from './ui/hud.js';
import { readStoredBestTime, createShowGameOver } from './ui/result-overlay.js';
import { setupScene } from './game/scene-setup.js';
import { createMainLoop, FIXED_DT, MAX_SUBSTEPS } from './game/main-loop.js';
import { createLifecycle } from './game/lifecycle.js';
import { disposeGame } from './game/teardown.js';

// One AbortController owns every game-lifetime DOM listener — the keyboard/touch/resize
// handlers in Controls, plus those wired below and inside scene-setup/lifecycle (the §4
// listener-hygiene fix). Threading its `signal` into each addEventListener collapses the
// old "62 adds vs 2 removes" asymmetry to a single `abort()` in disposeGame — so unmount /
// dev-HMR doesn't leave duplicate handlers firing on stale state. Created before
// Controls.setupControls so its listeners join the same teardown.
const listenerAbort = new AbortController();

// Get keyboard controls from the Controls module (listeners tied to the teardown signal).
Controls.setupControls(listenerAbort.signal);

// --- Build the scene, objects, and subsystems (see game/scene-setup.ts) ---
// The orchestrator owns the run loop + the window.* publish; scene-setup owns the
// one-shot construction. Keep the whole context object (for disposeGame) and also
// destructure the handles the loop/lifecycle/proxies use.
const sceneContext = setupScene(listenerAbort.signal);
const {
  scene,
  renderer,
  camera,
  cameraManager,
  gameOverOverlay,
  gameOverDetail,
  restartButton,
  terrain,
  rockPositions,
  treePositions,
  snowman,
  snowSplash,
  state,
} = sceneContext;

// --- Snowman Position & Reset ---
// The per-frame player physics state lives in one typed PlayerState object
// (src/player-state.ts) instead of ~11 aliased module-scoped lets. `pos`/`velocity`
// are objects mutated in place and handed by reference to course/camera/snow/
// snowman, so keep by-identity aliases for those existing call sites; the
// reassigned scalars are accessed through `player.*` (and so is the window proxy)
// so writes are visible at a single source of truth.
const player = Physics.createPlayerState(Snow.getTerrainHeight);
const pos = player.pos;
const velocity = player.velocity;

// Persisted best loaded once at module eval (may prune an invalid stored entry).
// Score-time validation + best-time persistence live in ui/result-overlay.ts.
state.bestTime = readStoredBestTime();

// Initialize the stats display when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log("DOM content loaded, initializing game stats");
  initializeGameStats();
});

// Add best time to game over overlay
const bestTimeDisplay = document.createElement('p');
bestTimeDisplay.id = 'bestTimeDisplay';
bestTimeDisplay.textContent = state.bestTime !== Infinity ? `Best Time: ${state.bestTime.toFixed(2)}s` : 'No best time yet';
bestTimeDisplay.style.color = 'white';
bestTimeDisplay.style.fontFamily = 'Arial, sans-serif';
bestTimeDisplay.style.fontSize = '20px';
bestTimeDisplay.style.marginBottom = '20px';
gameOverOverlay.insertBefore(bestTimeDisplay, restartButton);

// --- Initial Camera Setup ---
// Initialize camera with the snowman's position and rotation
cameraManager.initialize(
  new THREE.Vector3(pos.x, pos.y, pos.z),
  new THREE.Euler(0, Math.PI, 0) // Snowman starts facing down the mountain (π radians)
);

// Crash-shatter wipeout (#53): fire the snowman break-up on a crash. Built here where
// scene/renderer/camera/snowman/velocity are in scope. Gated OFF under ?test= by
// default (so the existing browser/e2e suites that crash a lot are unaffected), but
// re-enabled by the explicit `window.testHooks.debrisEnabled` opt-in for the dedicated
// debris test. The shatter starts its own settle loop and repaints via the render
// callback, because the main animation loop has stopped (state.gameActive=false).
function triggerCrashShatter(_reason: string) {
  const debris = state.debris;
  if (!debris) return;
  // Off in automated environments by default: ?test= browser suites (window.isTestMode)
  // AND Playwright e2e (navigator.webdriver, which loads the game without ?test=). The
  // dedicated debris browser test re-enables it via the explicit window.testHooks.debrisEnabled
  // opt-in. Real players always get the wipeout.
  const automated = window.isTestMode || (typeof navigator !== 'undefined' && !!navigator.webdriver);
  const allowDebris = !automated || !!(window.testHooks && window.testHooks.debrisEnabled);
  if (!allowDebris) return;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  debris.shatter(scene, snowman, velocity, {
    reducedMotion: reduced,
    render: () => renderer.render(scene, camera)
  });
}

// Game-over / finish handling lives in ui/result-overlay.ts; the coordinator injects
// the run state and the overlay DOM nodes it still owns. Bound as a `const` here so
// it exists before the eager Snowman.addTestHooks(...) / window.showGameOver wiring
// below uses it.
const showGameOver = createShowGameOver({
  state,
  gameOverOverlay,
  gameOverDetail,
  restartButton,
  bestTimeDisplay,
  onCrash: triggerCrashShatter,
});

// --- Per-frame run loop (see game/main-loop.ts) ---
// Built after showGameOver (a loop dependency) exists. The loop owns `lastTime`;
// lifecycle code calls startLoop() to seed it and kick requestAnimationFrame.
// updateCamera/updateSnowman are re-published on window by publishGameGlobals below.
const { updateSnowman, updateCamera, startLoop, resetLoopState, handleResize } = createMainLoop({
  state,
  player,
  scene,
  camera,
  renderer,
  cameraManager,
  snowman,
  snowSplash,
  treePositions,
  rockPositions,
  showGameOver,
});
window.addEventListener('resize', handleResize, { signal: listenerAbort.signal });

// --- Physics / frame-rate diagnostics (see src/diagnostics.ts) ---
// A read-only telemetry observer the main loop feeds each frame (beside Sfx/Flex). It
// watches the dt the real device produces and the speed/step that ride on it, surfacing
// the frame-rate-dependence bug class fixed in PR #209 — runaway low-FPS speed, per-frame
// steps that exceed an obstacle's collision radius (tunnel risk), and NaN — live instead
// of only in the offline stress harnesses. Off under automation by default (so the test
// suites stay byte-identical); add ?debug to play with the live overlay, or call
// window.__snowgliderDiag.dump() to export a JSON trace for a bug report. The collision
// radius is the SMALLEST collidable obstacle radius the discrete point-vs-disk check
// guards — the min of the tree radius (collision.ts default 2.5u) and the smallest
// collidable rock radius (rockCollisionRadius(ROCK_COLLISION_MIN_SIZE) ≈ 1.69u). Using the
// tree radius alone would under-detect: a ~2u per-frame step can skip a small rock's disk
// while still reading as "no tunnel risk". The cap mirrors the loop's delta clamp.
//
// The `report` sink routes Diag's once-per-run BAD verdict + any uncaught error/rejection
// into the EXISTING Firebase Analytics pipeline (window.firebaseModules.logEvent, the same
// seam game_start/game_over/game_reset already use). Aggregated across real devices this is
// how the #209 class would surface in the wild — low-FPS sessions correlating with runaway
// speed / tunnel events — rather than as an unreproducible field report. Guarded exactly
// like the other logEvent call sites (modular SDK present, not file://) and wrapped so a
// telemetry failure can never throw into the game loop.
Diag.init(
  {
    // The loop ceilings a render frame at MAX_SUBSTEPS * FIXED_DT (the spiral-of-death
    // cap); a frame at that ceiling means the device dropped to/below 1/cap FPS — the
    // regime the #209 bug bit — so the clamped-frame detector keys off the same value.
    frameCapSec: MAX_SUBSTEPS * FIXED_DT,
    collisionRadius: Math.min(
      window.treeCollisionRadius || 2.5,
      rockCollisionRadius(ROCK_COLLISION_MIN_SIZE),
    ),
  },
  {
    report: (event, data) => {
      try {
        if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function' &&
            window.location.protocol !== 'file:') {
          window.firebaseModules.logEvent(event, data);
        }
      } catch (e) {
        console.log('Diag analytics skipped:', (e as Error).message);
      }
    },
  }
);

// --- Run lifecycle (see game/lifecycle.ts): reset / restart / camera toggle ---
// Built after the loop (restartGame uses startLoop). Re-publish the three hooks the
// touch handlers + controls.js drive by bare name, then wire the DOM controls.
const { resetSnowman, restartGame, toggleCameraView, initLifecycleUI } = createLifecycle({
  state,
  cameraManager,
  snowman,
  gameOverOverlay,
  restartButton,
  player,
  startLoop,
  resetLoopState,
  signal: listenerAbort.signal,
});
// Make reset/restart/toggle accessible globally for touch + keyboard handlers.
window.resetSnowman = resetSnowman;
window.restartGame = restartGame;
window.toggleCameraView = toggleCameraView;
initLifecycleUI();

// Make showGameOver accessible globally for test hooks
window.showGameOver = showGameOver;
// Initialize test hooks explicitly to ensure they're available immediately
// This is important for browser tests that run soon after page load
console.log("Initializing test hooks on startup");
Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);

// Read seam for the debris browser test: `state` is module-scoped and we add no new
// window.* bridge, so expose the debris-active flag on the existing window.testHooks
// surface (a deliberate test hook, like forceTreeCollision — not a module bridge).
if (!window.testHooks) window.testHooks = {};
window.testHooks.isDebrisActive = () => !!state.debris && state.debris.active;

// Initialize controls toggle when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log("DOM content loaded, initializing controls toggle");
  initializeControlsToggle();
});

// Teardown bookkeeping (dispose-audit plan §3 / Codex review): a guard flag plus the
// handles for the deferred first-start work, so disposeGame can cancel a pending intro /
// loading timer instead of letting its closure later start the loop and render against a
// disposed renderer + removed canvas.
let disposed = false;
let pendingStartTimer: ReturnType<typeof setTimeout> | null = null;
let activeIntro: IntroHandle | null = null;

// Activate the live run: flip the run-loop flags and kick off the animation loop.
// Factored out so the start button, the cinematic intro's completion, and the
// reduced-motion/automation fallback all hand off to the game loop identically.
function startGameplayLoop(showGetReady: boolean) {
  // After teardown, every deferred path (the intro's onComplete, the loading setTimeout)
  // that lands here must be inert — the renderer/canvas are gone. This is the single
  // choke point all loop-start paths funnel through, so one guard covers them all.
  if (disposed) return;
  state.gameActive = true;
  state.animationRunning = true;

  // Add game-active class to body for styling
  document.body.classList.add('game-active');

  // Start animation loop (the loop owns `lastTime`; startLoop seeds it — main-loop.ts)
  startLoop();

  // Show a "Get Ready" message a beat after the run begins (first start only)
  if (showGetReady) {
    setTimeout(() => {
      AudioModule.showMessage("Get Ready!", 1000);
    }, 1500);
  }
}

// Function to initialize the game with audio - called from the start button
// TODO: AUDIO DISABLED - Function name kept for compatibility, audio calls will be no-ops
window.initializeGameWithAudio = function() {
  console.log("Initializing game...");
  
  // TODO: AUDIO DISABLED - Audio context resume (will be no-op if disabled)
  // When re-enabling, verify this resume happens in user gesture context on mobile
  AudioModule.resumeAudioContext().then(() => {
    console.log("Audio context resume attempted");
  }).catch(err => {
    console.warn("Audio context resume attempt failed:", err);
  });
  
  // TODO: AUDIO DISABLED - Audio status monitoring
  // When re-enabling, this was meant to show retry UI if audio fails to start
  const checkAudioStatus = () => {
    const status = AudioModule.getStatus();
    
    // Skip check if audio is disabled
    if (status.disabled) {
      console.log('[AUDIO] Audio is disabled, skipping status check');
      return;
    }
    
    // If audio buffer is loaded and context is ready, but not playing 2 seconds after game start
    if (!status.playing && status.bufferLoaded && status.contextReady) {
      console.warn('[AUDIO] Ready but not playing — showing retry UI');
      AudioModule.showAudioRetryPrompt();
    } else if (status.contextState === 'interrupted' || status.contextState === 'suspended') {
      console.warn('[AUDIO] Context in unusual state:', status.contextState, '— showing retry UI');
      AudioModule.showAudioRetryPrompt();
    }
  };
  
  // Check audio status 2 seconds after game starts
  setTimeout(checkAudioStatus, 2000);
  
  // TODO: AUDIO DISABLED - Start audio (will show welcome message but skip music)
  AudioModule.startAudio();

  // Unlock the procedural sound-effects engine (#158). This runs in the start
  // button's user-gesture context, which is what mobile autoplay policy requires to
  // create/resume the Web Audio context. No-op under automation / without Web Audio.
  Sfx.unlock();

  // Reset the snowman to starting position
  resetSnowman();
  
  // Make sure test hooks are available
  Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
  
  // Make sure game stats and controls are properly initialized and visible
  initializeGameStats();
  initializeControlsToggle();
  
  // Initialize Game Stats
  const gameStatsContainer = document.getElementById('gameStatsContainer');
  if (gameStatsContainer) {
    console.log("Game start: ensuring stats are expanded");
    // Make sure stats are visible when game starts
    gameStatsContainer.classList.remove('collapsed');
    const toggleBtn = document.getElementById('toggleStats');
    if (toggleBtn) {
      toggleBtn.textContent = '▲';
    }
    
    // Update initial values
    updateTimerDisplay(state.gameActive, state.startTime);
  }
  
  // Initialize Controls
  const controlsInfo = document.getElementById('controlsInfo');
  if (controlsInfo) {
    console.log("Game start: ensuring controls are in right state");
    // Auto-collapse controls on smaller screens, expand on larger screens
    const shouldCollapse = window.innerWidth <= 480 || 
                           (window.innerWidth <= 768 && window.innerHeight <= 500);
    
    if (shouldCollapse) {
      controlsInfo.classList.add('collapsed');
      const toggleBtn = document.getElementById('toggleControls');
      if (toggleBtn) {
        toggleBtn.textContent = '▼';
      }
    } else {
      controlsInfo.classList.remove('collapsed');
      const toggleBtn = document.getElementById('toggleControls');
      if (toggleBtn) {
        toggleBtn.textContent = '▲';
      }
    }
  }
  
  // Hand off to the game loop. New for issue #51: on the first real start the
  // camera flies over the mountain first (IntroModule), turning the old blank
  // "Loading…" pause into a cinematic establishing shot. The fly-over is skipped —
  // and the original Loading/Get-Ready timing preserved byte-for-byte — for the
  // ?test= browser suites (window.isTestMode), automated runs (navigator.webdriver,
  // e.g. Playwright/Puppeteer), and prefers-reduced-motion, so no existing test is
  // perturbed and motion-sensitive players opt out. `?intro=force` plays it even
  // under automation (manual QA / a dedicated e2e); `?intro=off` disables it.
  const search = (typeof window !== 'undefined' && window.location) ? window.location.search : '';
  const forceIntro = search.includes('intro=force');
  const disableIntro = search.includes('intro=off');
  const automated = typeof navigator !== 'undefined' && navigator.webdriver === true;
  const skipIntro = disableIntro || (!forceIntro && (!!window.isTestMode || automated || prefersReducedMotion()));
  const playIntro = !skipIntro && !state.gameInitialized;

  if (playIntro) {
    // First real start: fly over the mountain, then drop into gameplay. The
    // fly-over settles into the live chase pose, so capture it from the camera
    // manager (resetSnowman already seated the snowman at the start gate above).
    state.gameInitialized = true;
    cameraManager.initialize(snowman.position, snowman.rotation);
    const endPosition = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    const endTarget = { x: snowman.position.x, y: snowman.position.y, z: snowman.position.z };
    // Hide the in-game HUD/buttons so the establishing shot reads cleanly (CSS
    // keys off `intro-active`); removed on completion/skip below.
    document.body.classList.add('intro-active');
    // Keep the handle so disposeGame can cut the fly-over short (cancelling its private
    // rAF) if an HMR reload / unmount happens mid-intro — otherwise its next frame would
    // call renderer.render on a disposed context. Its onComplete is guarded by `disposed`.
    activeIntro = IntroModule.play({
      camera,
      endPosition,
      endTarget,
      getTerrainHeight: Snow.getTerrainHeight,
      render: () => { renderer.render(scene, camera); },
      onComplete: () => {
        document.body.classList.remove('intro-active');
        // Re-seat the camera manager's smoothing at the settled pose, then run.
        cameraManager.initialize(snowman.position, snowman.rotation);
        // Start the run timer at the hand-off, not before the fly-over. resetSnowman()
        // (above) set state.startTime ~4 s ago; without this the cinematic's duration
        // would be added to the first run's time, splits, and any best-time/leaderboard
        // submission. The HUD/course/score all measure from state.startTime, so re-seat
        // it the instant gameplay actually begins. (The skip path keeps the original
        // timing — it activates synchronously after resetSnowman.)
        state.startTime = performance.now();
        startGameplayLoop(true);
      },
    });
  } else if (!state.gameInitialized) {
    // First start, but the cinematic is skipped (test/automation/reduced-motion):
    // reproduce the original short loading message + delayed activation exactly.
    AudioModule.showMessage("Loading game...", 1500);
    state.gameInitialized = true;
    // Track the timer so disposeGame can cancel it; startGameplayLoop is also
    // `disposed`-guarded, so this is belt-and-suspenders against a mid-delay teardown.
    pendingStartTimer = setTimeout(() => { pendingStartTimer = null; startGameplayLoop(true); }, 1800);
  } else {
    // Already initialized once: restart immediately.
    startGameplayLoop(false);
  }
  
  console.log("Game started successfully!");
  
  // Track game start in analytics if available
  try {
    if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
      window.firebaseModules.logEvent('game_start');
    }
  } catch (e) {
    console.log("Analytics tracking skipped:", (e as Error).message);
  }
  
  return true;
};

// --- Test/global bridge (Phase 2.9, issue #84) ---
// As an ES module, snowglider.js's top-level state and helpers are module-scoped
// rather than the implicit script globals the classic build exposed. The browser
// suites (camera/regression/tree/avalanche tests) still drive the live game by
// bare name — both reading AND reassigning these (e.g. `gameActive = true`,
// `verticalVelocity = 0`, `avalancheTriggered = true`) and mutating shared objects
// (`pos.x = …`, `avalanche.trigger(...)`). Re-publish them on `window` so those
// bare references resolve exactly as before: getters/setters proxy to the
// module-local bindings (a test's `gameActive = true` flows back here and the game
// loop observes it), and object/function refs are shared by identity. The hot loop
// keeps using the locals directly, so runtime behavior is unchanged.
// (resetSnowman/showGameOver/restartGame/toggleCameraView/initializeGameWithAudio
// and treePositions/terrainMesh/isTestMode are already published above.)
(function publishGameGlobals() {
  if (typeof window === 'undefined') return;
  const live: Record<string, PropertyDescriptor> = {
    // Mutable primitives the tests reassign — proxy reads and writes.
    // gameActive now lives on the typed `state` (GameState); the proxy backs the
    // bare handle with state.* so a test's `gameActive = true` flows to the live state.
    gameActive:         { get: () => state.gameActive,       set: (v) => { state.gameActive = v; } },
    // Player physics scalars now live on the typed `player` state (src/player-state.ts);
    // the proxy reads/writes player.* so test reassignments hit the live state.
    isInAir:            { get: () => player.isInAir,          set: (v) => { player.isInAir = v; } },
    verticalVelocity:   { get: () => player.verticalVelocity, set: (v) => { player.verticalVelocity = v; } },
    // jumpCooldown is reassigned by the gameplay suite (testJumpMechanics). It must
    // be republished like the others: now that browser-tests.js is an ES module
    // (strict mode), a bare `jumpCooldown = 0` assignment to an unpublished name
    // throws a ReferenceError instead of silently creating a sloppy-mode global
    // (issue #84).
    jumpCooldown:       { get: () => player.jumpCooldown,     set: (v) => { player.jumpCooldown = v; } },
    // Run/scoring + avalanche run-state now live on the typed `state` object.
    bestTime:           { get: () => state.bestTime,           set: (v) => { state.bestTime = v; } },
    startTime:          { get: () => state.startTime,          set: (v) => { state.startTime = v; } },
    avalancheTriggered: { get: () => state.avalancheTriggered, set: (v) => { state.avalancheTriggered = v; } },
    lastAvalancheZ:     { get: () => state.lastAvalancheZ,     set: (v) => { state.lastAvalancheZ = v; } },
    // Object/function refs the tests read or mutate (never reassign) — get-only.
    scene:              { get: () => scene },
    // Test-only read seam for the perf/draw-call budget spec (tests/e2e/perf-budget.spec.ts).
    // setupScene() builds a real WebGLRenderer, so renderer.info (render.calls,
    // memory.geometries/textures, programs.length) is only populated after a live
    // frame renders — unreachable from Node/jsdom. The Playwright spec reads it after
    // the loop is warm to guard draw-call/triangle/geometry budgets (no production
    // behavior change; consistent with the other live get-only handles here).
    renderer:           { get: () => renderer },
    camera:             { get: () => camera },
    cameraManager:      { get: () => cameraManager },
    snowman:            { get: () => snowman },
    velocity:           { get: () => velocity },
    pos:                { get: () => pos },
    avalanche:          { get: () => state.avalanche },
    snowSplash:         { get: () => snowSplash },
    terrain:            { get: () => terrain },
    // Live terrain sampler for the browser tests. camera.js imports the sampler
    // directly (window.getTerrainHeight* was dropped from production in 0781822),
    // but the deployed GitHub Pages artifact runs dist/index.html from Vite's
    // bundle while the verbatim-copied dist/tests/*.js import a *second* copy of
    // snow.js — whose heightMap is never populated by createTerrain and whose
    // per-vertex Math.random() noise differs anyway. testCameraAboveTerrain must
    // sample the same terrain instance the live camera clamps to, so republish the
    // bundled sampler here (test seam only) instead of importing a fork (issue #84).
    getTerrainHeight:   { get: () => Snow.getTerrainHeight },
    // Live Controls accessor for the gameplay suite. On the deployed Pages
    // artifact the verbatim-copied dist/tests/*.js import a *second* Controls
    // module instance, so `Controls.getControls().jump = true` in the test would
    // mutate a fork while the bundled updateSnowman reads this singleton. Publish
    // the live getControls so the test drives the same instance (issue #84).
    getControls:        { get: () => Controls.getControls },
    updateCamera:       { get: () => updateCamera },
    updateSnowman:      { get: () => updateSnowman }
  };
  for (const name of Object.keys(live)) {
    Object.defineProperty(window, name, { configurable: true, enumerable: false, ...live[name] });
  }
})();

// --- Teardown entry point (dispose-audit plan; see game/teardown.ts) ---
// One idempotent disposeGame() that stops the loop, frees every GPU resource the
// one-shot setupScene() allocated (scene sweep + subsystem disposes + tree pools),
// drops the renderer/WebGL context + canvas, and aborts the listener controller above.
// The run/restart flow is unchanged — this is a NEW path (unmount + dev-HMR), never
// on the reuse path. Published beside the other coordinator handles.
function disposeSnowGlider(): void {
  // Flip the guard FIRST so any deferred first-start callback that fires during/after
  // teardown (the intro's onComplete, the loading timer) short-circuits in
  // startGameplayLoop instead of starting a loop against a disposed renderer.
  disposed = true;
  if (pendingStartTimer !== null) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
  // Cut a still-running fly-over short: skip() cancels its private rAF (so no further
  // renderer.render on a dead context); its onComplete is now a no-op via the guard.
  if (activeIntro && !activeIntro.done) activeIntro.skip();
  activeIntro = null;
  // Stop the audio + SFX started in initializeGameWithAudio. They are module-level
  // resources (a looping <audio> + the Web Audio beds + the mute button) that
  // disposeGame's scene/renderer/listener teardown would otherwise leave running.
  AudioModule.teardown();
  Sfx.teardown();
  // Remove the subsystem HUD these modules append to document.body (#courseHud /
  // #courseFlash; the avalanche banner/meter/vignette) — they hold their own node +
  // state handles, so they self-clean here rather than via the scene/DOM sweep.
  CourseModule.teardown();
  EffectsModule.teardown();
  disposeGame(sceneContext, () => listenerAbort.abort());
}
window.disposeGame = disposeSnowGlider;

// Vite dev-HMR: release the previous instance before the module re-evaluates, so a
// hot edit doesn't stack WebGL contexts ("too many active contexts") or duplicate
// listeners. Stripped from production builds (Vite replaces import.meta.hot with
// undefined), so this is a dev-only safety net.
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeSnowGlider());
}

// If this is a test environment, auto-start the game
if (window.isTestMode) {
  console.log("Test mode detected, auto-starting game...");
  setTimeout(() => {
    // Hide the start button container
    const startContainer = document.getElementById('startGameContainer');
    if (startContainer) startContainer.style.display = 'none';
    
    // Show the game canvas
    document.getElementById('gameCanvas')!.style.display = 'block';

    // Initialize the game
    window.initializeGameWithAudio?.();
  }, 100);
}
