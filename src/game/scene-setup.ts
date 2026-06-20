// Scene construction for SnowGlider: the Three.js scene/renderer/camera, the
// game-over overlay DOM, lighting, terrain, the avalanche system, trees, the
// snowman, snow particles, and the course/effects subsystems. Extracted from
// snowglider.ts as the one-shot `setupScene()` builder; the orchestrator calls it
// once and re-publishes the returned handles on `window` (publishGameGlobals stays
// in the coordinator). Mechanical move — construction order and side effects
// (DOM appends, scene.add, the eager window.* data globals) are unchanged.

import * as THREE from 'three';
import { Camera } from '../camera.js';
import { Snow } from '../snow.js';
import { Snowman } from '../snowman.js';
import { CourseModule } from '../course.js';
import { EffectsModule } from '../effects.js';
import { AvalancheSystem } from '../avalanche.js';
import { SnowTrails } from '../snowtracks.js';
import { SnowmanDebris } from '../debris.js';
import { AudioModule } from '../audio.js';
import { Sky } from '../sky.js';
import type { RockPosition } from '../mountains.js';
import type { TreePosition } from '../trees.js';

export const AVALANCHE_TRIGGER_DISTANCE = 80; // Trigger avalanche after traveling 80 units downhill

/**
 * Typed game state (Phase 3, issues #98/#84). Consolidates aliased mutable
 * module-scoped `let`s into one typed object — the real fix for the
 * shared-mutable-global aliasing that types alone can't catch (see
 * `ARCHITECTURE.md`, "What the type system won't catch"). The browser
 * suites still drive these by their original bare names via the `window.*`
 * accessor proxy in the coordinator (the proxy reads/writes `state.*`).
 *
 * Folded in so far:
 *  - PR 3.19 (pilot): the avalanche run-state.
 *  - PR 3.20: the run/scoring lifecycle (`startTime`, `bestTime`).
 *  - PR 3.22: the run-loop lifecycle flags (`gameActive`, `animationRunning`,
 *    `gameInitialized`).
 * The per-frame player physics state lives in the typed `player-state.ts` module
 * (PR 3.21); future PRs can fold more cohesive subsets in the same way.
 */
export interface GameState {
  avalanche: AvalancheSystem | null; // live avalanche system (null if module absent)
  snowTrails: SnowTrails | null;     // dynamic ski-trail / snow-accumulation visuals (#17)
  debris: SnowmanDebris | null;      // crash-shatter wipeout system (#53)
  avalancheTriggered: boolean;       // whether this run's avalanche has fired
  lastAvalancheZ: number;            // z the trigger distance is measured from
  startTime: number;                 // performance.now() at run start (timer origin)
  bestTime: number;                  // best finish time in seconds (Infinity = none yet)
  gameActive: boolean;               // true while a run is live (drives the loop + input)
  animationRunning: boolean;         // true while the requestAnimationFrame loop is running
  gameInitialized: boolean;          // true once the first run has been initialized
}

export function setupScene() {
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
  // (Adopted alongside the three.js r134 -> r160 -> 0.184 upgrade.)
  const THREECompat = THREE as any;
  THREECompat.ColorManagement.enabled = false;
  const scene = new THREE.Scene();
  // Sky background + distance fog are applied after the lights are set up
  // (see Sky.applyGradientSky below) so the gradient sky / horizon fog replace the
  // old flat `scene.background = Color(0x87CEEB)` (issue #2).
  // preserveDrawingBuffer keeps the back buffer readable after a frame so the
  // result screen's "Save image" share can capture it (src/share-card.ts).
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

  // --- Lighting ---
  // Intensities are pre-multiplied by Math.PI to preserve the original r134
  // brightness under three.js physically-correct lighting (forced on since the
  // r165 removal of `useLegacyLights`); see the renderer setup note above.
  //
  // A HemisphereLight (issue #18) is the scene fill: pale sky-blue from above, a
  // cooler snow-bounce from below. Unlike a uniform ambient it shades by surface
  // orientation, so the procedural snow/rock normal maps and slope shading (issue
  // #17) read instead of washing flat. A small ambient floor keeps nothing pure black.
  //
  // Snow-readability rebalance (issue #17 follow-up): the old split (directional
  // 0.8π vs. fill ≈0.5) cast such hard shadows on the bumpy terrain that every
  // mogul read as a grey band — the "grey lines" that survived the texture fix,
  // because they are terrain *shadows*, not a texture. Real deep powder under an
  // open sky is low-contrast: bright almost everywhere with soft shading. So the
  // hard sun is dialed down (0.8π → 0.5π) and the orientation-aware sky fill up
  // (hemi 0.45π → 0.62π, ambient 0.15π → 0.26π) — the slope still shapes, but the
  // shadows go gentle instead of grey. Peak white stays roughly the same.
  scene.add(new THREE.AmbientLight(0xffffff, 0.26 * Math.PI));
  scene.add(new THREE.HemisphereLight(0xdcebfb, 0xbcc7d4, 0.62 * Math.PI));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
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

  // --- Game state ---
  // The run-lifecycle flags (gameActive / animationRunning / gameInitialized) live
  // on the typed `state` object (GameState), alongside the avalanche and
  // run/scoring fields.
  const state: GameState = {
    avalanche: null,
    snowTrails: null,
    debris: null,
    avalancheTriggered: false,
    lastAvalancheZ: 0,
    startTime: 0,
    bestTime: Infinity, // overwritten by readStoredBestTime() in the coordinator, before any read
    gameActive: false,       // start inactive until the user clicks the start button
    animationRunning: false,
    gameInitialized: false,
  };

  // --- Initialize Avalanche System ---
  if (typeof AvalancheSystem !== 'undefined') {
    const av = new AvalancheSystem(scene, 120);
    av.setTerrainFunction(Snow.getTerrainHeight);
    state.avalanche = av;
    console.log("Avalanche system initialized");
  } else {
    console.warn("Avalanche module not loaded - avalanche feature disabled");
  }

  // --- Initialize dynamic ski trails / snow accumulation (#17) ---
  // Purely cosmetic; terrain-aware like the avalanche. Skis carve fading grooves
  // that fresh snow covers back over. Never touches physics/pos/velocity.
  const snowTrails = new SnowTrails(scene);
  snowTrails.setTerrainFunction(Snow.getTerrainHeight);
  state.snowTrails = snowTrails;

  // --- Initialize Snowman crash-shatter (#53) ---
  // The wipeout system. Constructed here so the coordinator can fire it from the
  // crash branch of showGameOver; it owns its own settle loop and is terrain-aware.
  const debris = new SnowmanDebris();
  debris.setTerrainFunction(Snow.getTerrainHeight);
  state.debris = debris;

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
  if (typeof CourseModule !== 'undefined') {
    try {
      CourseModule.init({
        scene: scene,
        getTerrainHeight: Snow.getTerrainHeight,
        createSnowman: Snowman.createSnowman,
        renderer: renderer,
        camera: camera
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

  return {
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
  };
}

export type SceneContext = ReturnType<typeof setupScene>;
