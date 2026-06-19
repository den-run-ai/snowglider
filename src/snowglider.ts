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
import { Camera } from './camera.js';
import { Controls } from './controls.js';
import { Snow } from './snow.js';
import { Snowman } from './snowman.js';
import { CourseModule } from './course.js';
import { EffectsModule, type ShakeOffset } from './effects.js';
import { AvalancheSystem } from './avalanche.js';
import { AudioModule } from './audio.js';
import { Physics } from './physics.js';
import { Sky } from './sky.js';
import type { RockPosition } from './mountains.js';
import type { TreePosition } from './trees.js';
import { setupCollapsiblePanel } from './ui/collapsible-panel.js';

// Get keyboard controls from the Controls module
Controls.setupControls();

// --- Scene, Renderer and Camera ---
// three.js enables color management (r152+) and physically-correct lights
// (r155+ default) out of the box, both of which would shift SnowGlider's colors
// and brightness. We preserve the original r134 look:
//  - Color: opt out of color management so authored hex colors render as-is.
//  - Lighting: r165 REMOVED the `useLegacyLights` escape hatch, so the renderer
//    is now always physically-correct. Physically-correct lighting divides the
//    diffuse term by π, so the directional/ambient intensities are pre-multiplied
//    by Math.PI at their definitions below to reproduce the legacy brightness.
// Adopting modern color/lighting is a deliberate later change.
// (See docs/THREEJS_UPGRADE.md, Stage B.)
const THREECompat = THREE as any;
THREECompat.ColorManagement.enabled = false;
const scene = new THREE.Scene();
// Sky background + distance fog are applied after the lights are set up
// (see Sky.applyGradientSky below) so the gradient sky / horizon fog replace the
// old flat `scene.background = Color(0x87CEEB)` (issue #2).
const renderer = new THREE.WebGLRenderer({ antialias: true });
(renderer as any).outputColorSpace = THREECompat.LinearSRGBColorSpace;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// Update to assign renderer to a specific div with an ID
const rendererContainer = document.createElement('div');
rendererContainer.id = 'gameCanvas';
document.body.appendChild(rendererContainer);
rendererContainer.appendChild(renderer.domElement);

// Initialize camera manager
const cameraManager = new Camera(scene);
// Use the camera manager's camera for rendering
const camera = cameraManager.getCamera();

// Create game over overlay
const gameOverOverlay = document.createElement('div');
gameOverOverlay.id = 'gameOverOverlay';
gameOverOverlay.style.position = 'fixed';
gameOverOverlay.style.top = '0';
gameOverOverlay.style.left = '0';
gameOverOverlay.style.width = '100%';
gameOverOverlay.style.height = '100%';
gameOverOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
gameOverOverlay.style.display = 'flex';
gameOverOverlay.style.flexDirection = 'column';
gameOverOverlay.style.alignItems = 'center';
gameOverOverlay.style.justifyContent = 'center';
gameOverOverlay.style.zIndex = '1000';
gameOverOverlay.style.display = 'none'; // Initially hidden

// Game over message
const gameOverMessage = document.createElement('h1');
gameOverMessage.id = 'gameOverMessage';
gameOverMessage.textContent = 'GAME OVER';
gameOverMessage.style.color = 'white';
gameOverMessage.style.fontFamily = 'Arial, sans-serif';
gameOverMessage.style.fontSize = '48px';
gameOverMessage.style.marginBottom = '20px';
gameOverOverlay.appendChild(gameOverMessage);

// Detailed message (shows reason for game over)
const gameOverDetail = document.createElement('p');
gameOverDetail.id = 'gameOverDetail';
gameOverDetail.textContent = '';
gameOverDetail.style.color = 'white';
gameOverDetail.style.fontFamily = 'Arial, sans-serif';
gameOverDetail.style.fontSize = '24px';
gameOverDetail.style.marginBottom = '30px';
gameOverOverlay.appendChild(gameOverDetail);

// Restart button
const restartButton = document.createElement('button');
restartButton.textContent = 'RESTART';
restartButton.style.padding = '15px 30px';
restartButton.style.fontSize = '22px';
restartButton.style.backgroundColor = '#ff4136';
restartButton.style.color = 'white';
restartButton.style.border = 'none';
restartButton.style.borderRadius = '8px';
restartButton.style.cursor = 'pointer';
restartButton.style.minWidth = '200px';
restartButton.style.setProperty('-webkit-tap-highlight-color', 'rgba(255, 255, 255, 0.5)');
restartButton.style.touchAction = 'manipulation'; // Removes delay on mobile devices
restartButton.style.userSelect = 'none';
restartButton.addEventListener('mouseenter', () => {
  restartButton.style.backgroundColor = '#ff725c';
});
restartButton.addEventListener('mouseleave', () => {
  restartButton.style.backgroundColor = '#ff4136';
});
gameOverOverlay.appendChild(restartButton);

// Add to document
document.body.appendChild(gameOverOverlay);

// --- Initialize audio early, but don't start playing until user interaction ---
// TODO: AUDIO DISABLED - These calls will be no-ops when AUDIO_ENABLED = false in audio.js
// When re-enabling audio, verify:
// 1. init() is called before any other audio operations
// 2. setupUI() creates the mute button and track selector
// 3. Audio context is properly managed on mobile devices
AudioModule.init(scene);
// Make sure to attach audio listener to the camera
AudioModule.addAudioListener(camera);
// Set up the audio UI (will be skipped if audio disabled)
AudioModule.setupUI();

// --- Game state ---
// The run-lifecycle flags (gameActive / animationRunning / gameInitialized) live
// on the typed `state` object defined below (GameState), alongside the avalanche
// and run/scoring fields.

// --- Lighting ---
// Intensities are pre-multiplied by Math.PI to preserve the original r134
// brightness under three.js physically-correct lighting (forced on since the
// r165 removal of `useLegacyLights`); see the renderer setup note above.
scene.add(new THREE.AmbientLight(0xffffff, 0.5 * Math.PI));
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
directionalLight.position.set(50, 100, 50);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
scene.add(directionalLight);

// --- Sky & fog ---
// Preetham atmospheric sky + sun, with horizon-tinted distance fog (issue #2).
// The sun direction is the directional light's position so the visible sun and
// the cast shadows agree. (Sky.applyGradientSky is a lighter-weight fallback.)
Sky.applyAtmosphericSky(scene, directionalLight.position);

// --- Create main game objects ---
// Store terrain in a global for precise object positioning
const terrainResult = Snow.createTerrain(scene);
const terrain = terrainResult.terrain;
const rockPositions: RockPosition[] = terrainResult.rockPositions;
// Store terrain reference in global for later object placement
window.terrainMesh = terrain;

// --- Initialize Avalanche System ---
/**
 * Typed game state (Phase 3, issues #98/#84). Consolidates aliased mutable
 * module-scoped `let`s into one typed object — the real fix for the
 * shared-mutable-global aliasing that types alone can't catch (see
 * `TYPESCRIPT_MIGRATION.md`, "What TypeScript will not catch"). The browser
 * suites still drive these by their original bare names via the `window.*`
 * accessor proxy below (the proxy reads/writes `state.*`).
 *
 * Folded in so far:
 *  - PR 3.19 (pilot): the avalanche run-state.
 *  - PR 3.20: the run/scoring lifecycle (`startTime`, `bestTime`).
 *  - PR 3.22: the run-loop lifecycle flags (`gameActive`, `animationRunning`,
 *    `gameInitialized`).
 * The per-frame player physics state lives in the typed `physics.ts` module
 * (PR 3.21); future PRs can fold more cohesive subsets in the same way.
 */
interface GameState {
  avalanche: AvalancheSystem | null; // live avalanche system (null if module absent)
  avalancheTriggered: boolean;       // whether this run's avalanche has fired
  lastAvalancheZ: number;            // z the trigger distance is measured from
  startTime: number;                 // performance.now() at run start (timer origin)
  bestTime: number;                  // best finish time in seconds (Infinity = none yet)
  gameActive: boolean;               // true while a run is live (drives the loop + input)
  animationRunning: boolean;         // true while the requestAnimationFrame loop is running
  gameInitialized: boolean;          // true once the first run has been initialized
}
const state: GameState = {
  avalanche: null,
  avalancheTriggered: false,
  lastAvalancheZ: 0,
  startTime: 0,
  bestTime: Infinity, // overwritten by readStoredBestTime() below, before any read
  gameActive: false,       // start inactive until the user clicks the start button
  animationRunning: false,
  gameInitialized: false,
};
const AVALANCHE_TRIGGER_DISTANCE = 80; // Trigger avalanche after traveling 80 units downhill

if (typeof AvalancheSystem !== 'undefined') {
  const av = new AvalancheSystem(scene, 120);
  av.setTerrainFunction(Snow.getTerrainHeight);
  state.avalanche = av;
  console.log("Avalanche system initialized");
} else {
  console.warn("Avalanche module not loaded - avalanche feature disabled");
}

// We can't call Snow.addTrees directly, so let's create a global array
let treePositions: TreePosition[] = [];

// Instead of duplicating the tree placement logic, use Snow.addTrees
// and store its returned positions for collision detection
function addTreesWithPositions(scene: THREE.Scene) {
  // The addTrees function in Snow now handles all tree placement and rendering
  // It returns an array of all tree positions that we can use for collision detection
  
  // Extended range to match mountains.js implementation
  // Using the same ranges as in mountains.js:
  // - Z range from -180 to 80 (extended run)
  // - X range from -100 to 100 (wider area)
  
  // Let Snow.addTrees handle the actual tree creation and return positions
  return Snow.addTrees(scene);
}

// Call it and store the positions
treePositions = addTreesWithPositions(scene);

// Ensure all tree positions are included in collision detection by logging the range
console.log(`Tree positions array has ${treePositions.length} trees for collision detection`);
if (treePositions.length > 0) {
  // Log the ranges to verify coverage
  const zMin = Math.min(...treePositions.map(t => t.z));
  const zMax = Math.max(...treePositions.map(t => t.z));
  const xMin = Math.min(...treePositions.map(t => t.x));
  const xMax = Math.max(...treePositions.map(t => t.x));
  console.log(`Tree collision ranges - X: ${xMin.toFixed(1)} to ${xMax.toFixed(1)}, Z: ${zMin.toFixed(1)} to ${zMax.toFixed(1)}`);
}

// Set up window.treePositions for test hooks to access
window.treePositions = treePositions;
window.rockPositions = rockPositions;
console.log(`Rock positions array has ${rockPositions.length} large rocks for collision detection`);

// Create a global flag to control test behavior
window.isTestMode = window.location.search.includes('test');

const snowman = Snowman.createSnowman(scene);
Snow.createSnowflakes(scene);

// Create snow splash particle system for ski effects using sprites
// like the snowflakes for better visibility
const snowSplash = Snow.createSnowSplash();

// --- Initialize course (gates, splits, ghost racing) and effects (avalanche UI, juice) ---
let lastTechnique = 'glide';
if (typeof CourseModule !== 'undefined') {
  try {
    CourseModule.init({
      scene: scene,
      getTerrainHeight: Snow.getTerrainHeight,
      createSnowman: Snowman.createSnowman
    });
    console.log("Course module initialized (gates, splits, ghost)");
  } catch (e) {
    console.warn("Course module init failed:", (e as Error).message);
  }
}
if (typeof EffectsModule !== 'undefined') {
  try {
    EffectsModule.init();
    console.log("Effects module initialized (avalanche warning, camera juice)");
  } catch (e) {
    console.warn("Effects module init failed:", (e as Error).message);
  }
}

// --- Snowman Position & Reset ---
// The per-frame player physics state lives in one typed PlayerState object
// (src/physics.ts) instead of ~11 aliased module-scoped lets. `pos`/`velocity`
// are objects mutated in place and handed by reference to course/camera/snow/
// snowman, so keep by-identity aliases for those existing call sites; the
// reassigned scalars are accessed through `player.*` (and so is the window proxy)
// so writes are visible at a single source of truth.
const player = Physics.createPlayerState(Snow.getTerrainHeight);
const pos = player.pos;
const velocity = player.velocity;

// Add timer and best time tracking (state.startTime / state.bestTime)
const MIN_VALID_SCORE_TIME = 4;
const MAX_VALID_SCORE_TIME = 600;

function isValidScoreTime(time: number) {
  if (window.ScoresModule && typeof window.ScoresModule.isValidScoreTime === 'function') {
    return window.ScoresModule.isValidScoreTime(time);
  }
  return typeof time === 'number' &&
    Number.isFinite(time) &&
    time >= MIN_VALID_SCORE_TIME &&
    time <= MAX_VALID_SCORE_TIME;
}

function readStoredBestTime() {
  const storedBestTime = localStorage.getItem('snowgliderBestTime');
  if (!storedBestTime) {
    return Infinity;
  }

  const parsedBestTime = parseFloat(storedBestTime);
  if (isValidScoreTime(parsedBestTime)) {
    return parsedBestTime;
  }

  console.warn("Ignoring invalid stored best time:", storedBestTime);
  localStorage.removeItem('snowgliderBestTime');
  return Infinity;
}

// Persisted best loaded once at module eval (may prune an invalid stored entry).
state.bestTime = readStoredBestTime();

// Initialize game stats functionality
function initializeGameStats() {
  const bestTimeElement = document.getElementById('bestTimeValue');
  if (bestTimeElement) {
    bestTimeElement.textContent = state.bestTime !== Infinity ? `${state.bestTime.toFixed(2)}s` : '--';
  }

  // Game stats panel collapse/swipe behavior (shared with the Controls panel).
  setupCollapsiblePanel({
    name: 'game stats',
    containerId: 'gameStatsContainer',
    toggleButtonId: 'toggleStats',
    headerId: 'gameStatsHeader',
  });
}

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

function resetSnowman() {
  // Reset the snowman + player physics state (position, velocity, camera, and the
  // air/auto-turn scalars) to the start of a run.
  Physics.resetPlayer(player, snowman, Snow.getTerrainHeight, cameraManager);

  // Reset avalanche system
  const avalanche = state.avalanche;
  if (avalanche) {
    avalanche.reset();
    state.avalancheTriggered = false;
    state.lastAvalancheZ = pos.z; // Reset to starting position
  }
  
  // Reset keyboard controls
  Controls.resetControls();
  
  state.startTime = performance.now(); // Reset the timer when starting a new run
  updateTimerDisplay();
  
  // Reset course (gates/splits/ghost) and effects (avalanche UI, FOV, shake) for the new run
  lastTechnique = 'glide';
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
// Make resetSnowman accessible globally for touch handler
window.resetSnowman = resetSnowman;

// Initialize controls but don't reset the snowman yet
document.getElementById('resetBtn')!.addEventListener('click', resetSnowman);

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
cameraToggleBtn.addEventListener('click', toggleCameraView);
cameraToggleBtn.addEventListener('touchend', function(event) {
  event.preventDefault();
  toggleCameraView();
}, { passive: false });

document.body.appendChild(cameraToggleBtn);

// --- Update Snowman: Physics-based Movement ---
function updateSnowman(delta: number) {
  // We no longer need to add test hooks every frame as they're set up at initialization
  // and after resets. This improves performance.
  const activeShowGameOver = typeof window.showGameOver === 'function'
    ? window.showGameOver
    : showGameOver;
  
  // Advance the player one frame. Physics.stepPlayer wraps Snowman.updateSnowman
  // (the unchanged physics kernel) and writes the mutated scalars back into the
  // typed `player` state, returning the per-frame result for the HUD/camera.
  const result = Physics.stepPlayer(player, {
    snowman,
    delta,
    controls: Controls.getControls(),
    getTerrainHeight: Snow.getTerrainHeight,
    getTerrainGradient: Snow.getTerrainGradient,
    getDownhillDirection: Snow.getDownhillDirection,
    treePositions,
    rockPositions,
    gameActive: state.gameActive,
    showGameOver: activeShowGameOver
  });

  // Update game stats display
  // Format speed with color based on value
  const speed = result.currentSpeed.toFixed(1);
  let speedColor = '#FFFFFF'; // Default white
  
  // Color code speed (green for slow, yellow for medium, red for fast)
  if (result.currentSpeed > 20) {
    speedColor = '#FF5252'; // Red for fast
  } else if (result.currentSpeed > 12) {
    speedColor = '#FFD700'; // Yellow for medium
  } else if (result.currentSpeed > 5) {
    speedColor = '#4CAF50'; // Green for good speed
  }
  
  // Update individual stat elements
  const speedElement = document.getElementById('speedValue');
  if (speedElement) {
    speedElement.textContent = speed;
    speedElement.style.color = speedColor;
  }
  
  const positionElement = document.getElementById('positionValue');
  if (positionElement) {
    positionElement.textContent = `${pos.x.toFixed(0)},${pos.z.toFixed(0)}`;
  }
  
  const groundElement = document.getElementById('groundStatus');
  if (groundElement) {
    if (player.isInAir) {
      groundElement.innerHTML = '🚀 JUMP!';
      groundElement.style.color = '#00FFFF';
    } else {
      // Reflect the active ski technique so skill is legible in the HUD.
      const techMap: Record<string, { txt: string; color: string }> = {
        parallel: { txt: '🎿 Parallel', color: '#00d2ff' },
        carve:    { txt: '🎿 Carving',  color: '#55efc4' },
        hop:      { txt: '🦘 Hop turn', color: '#fab1a0' },
        skid:     { txt: '💨 Skidding', color: '#ffeaa7' },
        snowplow: { txt: '🍕 Snowplow', color: '#74b9ff' },
        tuck:     { txt: '🏎️ Tuck',     color: '#ff7675' },
        glide:    { txt: '⛷️ Ground',   color: '#AAFFAA' }
      };
      const t = techMap[result.technique] || techMap.glide;
      groundElement.innerHTML = t.txt;
      groundElement.style.color = t.color;
    }
  }
  lastTechnique = result.technique;

  // Camera shake on a meaningful landing (scales with time spent aloft).
  if (result.justLanded && result.landingForce > 0.25 && EffectsModule) {
    EffectsModule.addShake(Math.min(1.2, result.landingForce * 0.6));
  }
  
  // Update timer in the updateTimerDisplay function which is called separately
}

// --- Update Camera: Follow the Snowman ---
function updateCamera() {
  // Simply delegate to the camera manager
  cameraManager.update(
    snowman.position,
    snowman.rotation,
    velocity,
    Snow.getTerrainHeight
  );
}

// --- Initial Camera Setup ---
// Initialize camera with the snowman's position and rotation
cameraManager.initialize(
  new THREE.Vector3(pos.x, pos.y, pos.z),
  new THREE.Euler(0, Math.PI, 0) // Snowman starts facing down the mountain (π radians)
);

// --- Animation Loop ---
let lastTime = 0;
function animate(time: number) {
  if (state.gameActive) {
    requestAnimationFrame(animate);
    const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
    lastTime = time;
    
    // Only set up test hooks if they're missing
    if (!window.testHooks) {
      console.log("Test hooks missing in animation loop, reinstalling");
      // addTestHooks(pos, showGameOver, getTerrainHeight) — matches the two other
      // call sites; the stray `gameActive` arg here was a latent bug (it landed in
      // the getTerrainHeight slot), surfaced by the type-checker.
      Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
    }
    
    updateSnowman(delta);
    Snow.updateSnowflakes(delta, pos, scene);
    
    // --- Course progress: split timing, progress HUD, ghost racing ---
    if (CourseModule) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      CourseModule.update(pos, elapsed, snowman);
    }
    
    // --- Avalanche Logic ---
    const avalanche = state.avalanche;
    if (avalanche) {
      // Trigger avalanche based on distance traveled (simple geometric trigger)
      // Player starts at z=-15 and moves in -Z direction (downhill)
      const distanceTraveled = state.lastAvalancheZ - pos.z;
      
      if (!state.avalancheTriggered && distanceTraveled > AVALANCHE_TRIGGER_DISTANCE) {
        avalanche.trigger(snowman.position);
        state.avalancheTriggered = true;
        console.log("Avalanche triggered! Distance traveled:", distanceTraveled.toFixed(1));
      }
      
      // Update avalanche physics
      avalanche.update(delta);
      
      // Check for burial (collision with avalanche)
      if (avalanche.checkBurial(snowman.position)) {
        showGameOver("Buried by avalanche!");
      }
      
      // Reset avalanche if it has passed the player (survived!)
      if (state.avalancheTriggered && avalanche.hasPassed(snowman.position)) {
        console.log("Avalanche passed - player survived!");
        avalanche.reset();
        state.avalancheTriggered = false;
        state.lastAvalancheZ = pos.z; // Reset trigger point for potential next avalanche
      }
      
      // Telegraph the threat: banner, "distance behind you" meter, vignette, shake.
      if (EffectsModule) {
        const avActive = state.avalancheTriggered && avalanche.active;
        const avDist = avActive ? avalanche.getClosestDistance(snowman.position) : Infinity;
        EffectsModule.updateAvalanche(avActive, avDist);
      }
    }
    
    // Save player position before snow splash effect updates
    const playerPosBefore = { 
      x: snowman.position.x, 
      y: snowman.position.y, 
      z: snowman.position.z 
    };
    
    // Update snow splash particles - pass all required parameters
    Snow.updateSnowSplash(snowSplash, delta, snowman, velocity, player.isInAir, scene);
    
    // Ensure snowman position wasn't affected by particles
    snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);
    
    updateCamera();
    updateTimerDisplay(); // Update the timer display
    
    // Camera juice: speed-based FOV + shake. Apply for the render only, then revert
    // the positional offset so the camera manager's own smoothing stays clean.
    let _shake: ShakeOffset | null = null;
    if (EffectsModule) {
      const spd = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
      _shake = EffectsModule.tickCamera(camera, delta, spd);
    }
    renderer.render(scene, camera);
    if (_shake) {
      camera.position.x -= _shake.x;
      camera.position.y -= _shake.y;
      camera.position.z -= _shake.z;
    }
  } else if (state.animationRunning) {
    state.animationRunning = false;
  }
}

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
  cameraManager.handleResize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function getSignedInUser() {
  const authModule = window.AuthModule;
  if (!authModule) {
    return null;
  }

  try {
    return authModule.getCurrentUser?.() || authModule.getAuthState?.()?.user || null;
  } catch (error) {
    console.warn("Unable to read auth state:", error);
    return null;
  }
}

function removeLoginPrompt() {
  const loginPrompt = document.getElementById('loginPrompt');
  if (loginPrompt) {
    loginPrompt.remove();
  }
}

// Add these functions for game over handling
// Expose showGameOver on window for test mocking
function showGameOver(reason: string) {
  // Allow tests to intercept showGameOver calls
  if (window._testShowGameOverOverride) {
    window._testShowGameOverOverride(reason);
    return;
  }
  state.gameActive = false;

  // Capture the best time BEFORE the finish branch updates it, so the result
  // screen can report the delta and whether this run set a new record.
  const previousBest = state.bestTime;

  // Measure the finish elapsed ONCE and reuse it for both the best-time/score path
  // and CourseModule.onFinish(). Otherwise a second performance.now() taken after the
  // DOM/localStorage/score work could read later: a sub-millisecond personal best
  // would be saved as a new record while the course screen sees elapsed >= previousBest,
  // skips persisting the new ghost/splits, and shows a time that disagrees with the score.
  const finishTime = (performance.now() - state.startTime) / 1000;
  const hasValidFinishTime = isValidScoreTime(finishTime);

  // Remove game-active class from body for styling
  document.body.classList.remove('game-active');
  
  gameOverDetail.textContent = reason;
  removeLoginPrompt();

  // TODO: AUDIO DISABLED - Pause audio on game over (will be no-op if disabled)
  if (AudioModule) {
    AudioModule.enableSound(false);
  }
  
  // Hide or collapse game stats container on game over
  const gameStatsContainer = document.getElementById('gameStatsContainer');
  if (gameStatsContainer) {
    // Option 1: Collapse the stats
    gameStatsContainer.classList.add('collapsed');
    const toggleBtn = document.getElementById('toggleStats');
    if (toggleBtn) {
      toggleBtn.textContent = '▼';
    }
    
    // Option 2 (alternative): Hide the stats completely
    // gameStatsContainer.style.display = 'none';
  }
  
  // Only update times if player reached the end successfully
  if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
    const currentTime = finishTime;
    const isNewBestTime = currentTime < state.bestTime;
    const canRecordScore = window.AuthModule && typeof window.AuthModule.recordScore === 'function';

    // Record the score whenever the leaderboard API is available (it handles its own
    // auth + persistence); otherwise fall back to persisting a new local best.
    if (canRecordScore) {
      window.AuthModule.recordScore(currentTime);
    } else if (isNewBestTime) {
      localStorage.setItem('snowgliderBestTime', String(currentTime));
    }

    // Show appropriate message based on time
    if (isNewBestTime) {
      state.bestTime = currentTime;
      bestTimeDisplay.textContent = `New Best Time: ${state.bestTime.toFixed(2)}s`;
      bestTimeDisplay.style.color = '#ffff00'; // Highlight new record

      // Update the best time in the game stats window too
      const bestTimeElement = document.getElementById('bestTimeValue');
      if (bestTimeElement) {
        bestTimeElement.textContent = `${state.bestTime.toFixed(2)}s`;
        bestTimeElement.style.color = '#ffff00'; // Highlight new record
      }
    } else {
      bestTimeDisplay.textContent = `Your Time: ${currentTime.toFixed(2)}s (Best: ${state.bestTime.toFixed(2)}s)`;
      bestTimeDisplay.style.color = 'white';
    }
    
    // Show login prompt if not logged in
    if (!getSignedInUser()) {
      const loginPrompt = document.createElement('p');
      loginPrompt.textContent = 'Log in to save your score and see the leaderboard!';
      loginPrompt.style.color = '#4285F4';
      loginPrompt.style.fontStyle = 'italic';
      loginPrompt.style.margin = '10px 0';
      
      // Insert before restart button
      if (!document.getElementById('loginPrompt')) {
        loginPrompt.id = 'loginPrompt';
        gameOverOverlay.insertBefore(loginPrompt, restartButton);
      }
    }
    
    // Track successful run in Analytics
    try {
      // Only try to use analytics when properly initialized with modular SDK
      if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
        // Using the direct logEvent function
        window.firebaseModules.logEvent('complete_game', {
          time: currentTime
        });
      }
    } catch (e) {
      console.log("Analytics tracking skipped:", (e as Error).message);
    }
  } else if (reason === "You reached the end of the slope!") {
    console.warn("Finish reached with invalid elapsed time; score not recorded:", finishTime);
    bestTimeDisplay.textContent = state.bestTime !== Infinity ?
      `Best Time: ${state.bestTime.toFixed(2)}s` :
      'No best time yet';
    bestTimeDisplay.style.color = 'white';
  } else {
    // For failures (tree collision, falling, etc.), don't record or update best time
    bestTimeDisplay.textContent = state.bestTime !== Infinity ? `Best Time: ${state.bestTime.toFixed(2)}s` : 'No best time yet';
    bestTimeDisplay.style.color = 'white';
    
    // Track game over reason in Analytics
    try {
      // Only try to use analytics when properly initialized with modular SDK
      if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
        // Using the direct logEvent function
        window.firebaseModules.logEvent('game_over', {
          reason: reason
        });
      }
    } catch (e) {
      console.log("Analytics tracking skipped:", (e as Error).message);
    }
  }
  
  // Get leaderboard if user is logged in
  if (getSignedInUser()) {
    // Get the leaderboard element
    const leaderboardElement = document.getElementById('leaderboard');
    
    // Add to game over overlay if not already there
    if (leaderboardElement && leaderboardElement.parentNode !== gameOverOverlay) {
      gameOverOverlay.insertBefore(leaderboardElement, restartButton);
      leaderboardElement.style.display = 'block';
    }
    
    // Display leaderboard
    window.AuthModule.displayLeaderboard();
  }
  
  // Build the result screen (splits + medal) on a finish; otherwise just clear
  // the live HUD/effects. The panel is inserted above the restart button.
  if (CourseModule) {
    const staleResult = document.getElementById('courseResult');
    if (staleResult && staleResult.parentNode) staleResult.parentNode.removeChild(staleResult);
    
    if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
      try {
        const panel = CourseModule.onFinish(finishTime, previousBest);
        if (panel) gameOverOverlay.insertBefore(panel, restartButton);
      } catch (e) {
        console.warn("Result screen failed:", (e as Error).message);
      }
    } else {
      CourseModule.hideHud();
    }
  }
  if (EffectsModule) EffectsModule.reset();
  
  gameOverOverlay.style.display = 'flex';
}

function restartGame() {
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
    
    // Reset colors for best time display
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.style.color = ''; // Reset to default color
    }
  }
  
  resetSnowman();
  
  // Initialize camera with the snowman's position and rotation
  cameraManager.initialize(snowman.position, snowman.rotation);
  
  // TODO: AUDIO DISABLED - Resume audio (will be no-op if disabled)
  if (AudioModule) {
    AudioModule.enableSound(true);
  }
  
  // Reset animation if it was stopped
  if (!state.animationRunning) {
    state.animationRunning = true;
    lastTime = performance.now();
    animate(lastTime);
  }
}
// Make restartGame accessible globally for touch handler
window.restartGame = restartGame;

// Make showGameOver accessible globally for test hooks
window.showGameOver = showGameOver;

// Toggle between first-person and third-person camera views
function toggleCameraView() {
  // Call the camera manager's toggle method
  const newMode = cameraManager.toggleCameraMode();
  
  // Reset camera initialization with current snowman position and rotation
  cameraManager.initialize(snowman.position, snowman.rotation);
  
  // Update the camera mode text in the controls info
  const viewControlItem = document.querySelector('#controlsContent .control-item:last-child');
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

// Make toggleCameraView accessible globally for the keyboard handler in controls.js
window.toggleCameraView = toggleCameraView;

// Add test hook functions for tree collision testing
function addTestHooks(
  pos: { x: number; y: number; z: number },
  showGameOver: (reason: string) => void,
  getTerrainHeight: TerrainHeightFn
) {
  console.log("Snowman.addTestHooks called - setting up test hooks");
  
  if (!window.testHooks) {
    window.testHooks = {};
  }
  
  // Add a force collision function that can be called by tests
  window.testHooks.forceTreeCollision = function() {
    console.log("TEST: forceTreeCollision hook called");
    
    // Create a direct function reference to ensure it works
    const directShowGameOver = window.showGameOver || showGameOver;
    
    // Call the function directly to ensure it works
    console.log("TEST: Forcing tree collision (direct call)");
    try {
      directShowGameOver("BANG!!! You hit a tree!");
      console.log("TEST: Successfully called showGameOver");
    } catch (error) {
      console.error("TEST ERROR: Failed to call showGameOver:", error);
      // As a fallback, just simulate the collision for the test
      window.testCollisionDetected = true;
    }
    
    return true;
  };
  
  // Other test hooks and functionality...
}

// Initialize test hooks explicitly to ensure they're available immediately
// This is important for browser tests that run soon after page load
console.log("Initializing test hooks on startup");
Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);

// Add event listener to restart button
restartButton.addEventListener('click', restartGame);

// Function to initialize controls toggle
function initializeControlsToggle() {
  // Controls panel collapse/swipe behavior (shared with the Game Stats panel).
  // Resets stale listeners and auto-collapses on small screens — this is invoked
  // more than once (DOMContentLoaded + initializeGameWithAudio).
  setupCollapsiblePanel({
    name: 'controls',
    containerId: 'controlsInfo',
    toggleButtonId: 'toggleControls',
    headerId: 'controlsHeader',
    resetListeners: true,
    autoCollapseOnSmallScreens: true,
  });
}

// Initialize controls toggle when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log("DOM content loaded, initializing controls toggle");
  initializeControlsToggle();
});

// Update timer display during gameplay
function updateTimerDisplay() {
  if (state.gameActive) {
    const currentTime = (performance.now() - state.startTime) / 1000;

    // Update the current time element in game stats
    const currentTimeElement = document.getElementById('currentTime');
    if (currentTimeElement) {
      currentTimeElement.textContent = `${currentTime.toFixed(2)}s`;
    }

    // Keep best time updated
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.textContent = state.bestTime !== Infinity ? `${state.bestTime.toFixed(2)}s` : '--';
    }
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
    updateTimerDisplay();
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
  
  // Display a short loading message if this is the first initialization
  if (!state.gameInitialized) {
    // Show a loading indicator while THREE.js initializes
    AudioModule.showMessage("Loading game...", 1500);
    state.gameInitialized = true;

    // Short delay to allow for visual transition
    setTimeout(() => {
      // Activate the game after a short delay for visual feedback
      state.gameActive = true;
      state.animationRunning = true;

      // Add game-active class to body for styling
      document.body.classList.add('game-active');

      // Start animation loop
      lastTime = performance.now();
      animate(lastTime);

      // Show a "Get Ready" message
      setTimeout(() => {
        AudioModule.showMessage("Get Ready!", 1000);
      }, 1500);
    }, 1800);
  } else {
    // If already initialized once, just restart immediately
    state.gameActive = true;
    state.animationRunning = true;
    
    // Add game-active class to body for styling
    document.body.classList.add('game-active');
    
    // Start animation loop
    lastTime = performance.now();
    animate(lastTime);
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
    // Player physics scalars now live on the typed `player` state (src/physics.ts);
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
