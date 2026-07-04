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
import { Snowman, SKI_TOP_SHEET } from '../snowman.js';
import { CourseModule } from '../course.js';
import { EffectsModule } from '../effects.js';
import { AvalancheSystem } from '../avalanche.js';
import { SnowTrails } from '../snowtracks.js';
import { SnowDepthField } from '../mountains/snow-depth.js';
import { SnowmanDebris } from '../debris.js';
import { AudioModule } from '../audio.js';
import { Sky } from '../sky.js';
import { configureSunShadow } from './sun-shadow.js';
import type { RockPosition } from '../mountains.js';
import type { TreePosition } from '../trees.js';
import { readStoredDifficulty, getDifficultyConfig, BLUE_AVALANCHE, type Difficulty } from '../difficulty.js';
import { courseLineFor, setActiveCourseLine } from '../course-line.js';
import { createScenery, type ScenerySystem } from '../scenery/scenery.js';
import { scenerySeedFor } from '../scenery/scenery-budget.js';

// The shipped Blue avalanche numbers, re-exported from the difficulty spine so there is
// ONE source of truth (difficulty.ts BLUE_AVALANCHE). The winnability harness reads these
// for its Blue gates; the LIVE run reads the ACTIVE tier's `avalanche` block (below), so a
// non-Blue tier fires its own earlier/faster/heavier slide.
export const AVALANCHE_TRIGGER_DISTANCE = BLUE_AVALANCHE.triggerDistance; // 80 — Blue's shipped trigger
export const AVALANCHE_BOULDER_COUNT = BLUE_AVALANCHE.boulderCount;       // 120 — Blue's shipped boulder count

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
  snowDepth: SnowDepthField | null;  // persistent snow-depth field: packed ski lines + refill (#246)
  debris: SnowmanDebris | null;      // crash-shatter wipeout system (#53)
  scenery: ScenerySystem | null;     // background scenery: distant, non-interactive world (#320)
  avalancheTriggered: boolean;       // whether this run's avalanche has fired
  lastAvalancheZ: number;            // z the trigger distance is measured from
  dodgeAwarded: boolean;             // this slide's once-only dodge bonus already paid (JP-3)
  startTime: number;                 // performance.now() at run start (timer origin)
  bestTime: number;                  // best finish time in seconds (Infinity = none yet)
  gameActive: boolean;               // true while a run is live (drives the loop + input)
  animationRunning: boolean;         // true while the requestAnimationFrame loop is running
  gameInitialized: boolean;          // true once the first run has been initialized
  difficulty: Difficulty;            // selected tier for this run (re-read from storage at run start)
  builtDifficulty: Difficulty;       // tier the terrain corridor/mesh (and later gates/obstacles/
                                     // avalanche) were baked from at scene build; a run-start
                                     // mismatch triggers a reload so the scene matches the run
}

/**
 * Build the scene, renderer, camera, DOM overlays, and every game subsystem once.
 *
 * @param signal optional AbortSignal that ties the game-lifetime DOM listeners
 *   created here (the restart button's hover handlers) to `disposeGame`'s teardown —
 *   aborting it removes them. Omitted by callers that never tear down (e.g. tests).
 */
export function setupScene(signal?: AbortSignal) {
  // Publish the test-mode flag FIRST: subsystems built during scene construction
  // gate on it (the EZ evergreen forest keeps the stylized trees for the `?test=`
  // browser suites — issue #282 PR 3), so assigning it after tree creation (its
  // old home further down) would hand those suites the player default instead.
  window.isTestMode = window.location.search.includes('test');

  // Listener options that wire game-lifetime handlers to the teardown AbortSignal
  // when one is supplied (undefined => the listener simply lives for the page).
  const listenerOpts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
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
  THREE.ColorManagement.enabled = false;
  const scene = new THREE.Scene();
  // Sky background + distance fog are applied after the lights are set up
  // (see Sky.applyGradientSky below) so the gradient sky / horizon fog replace the
  // old flat `scene.background = Color(0x87CEEB)` (issue #2).
  // The result screen's "Save image" share reads the canvas back to a PNG
  // (src/share-card.ts). It re-renders one fresh frame immediately before the
  // read (same tick, no yield), so the back buffer is still valid then — we do
  // NOT need `preserveDrawingBuffer: true`, which would tax every frame by
  // blocking present-path optimizations just for that occasional capture.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // Render at the device pixel ratio (capped at 2) so the scene is crisp on
  // HiDPI/Retina displays instead of soft; the cap keeps the framebuffer — and
  // GPU cost — bounded on 3x phone screens.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
  // `safe center` keeps the contents centered when they fit, but falls back to
  // top-alignment when they're taller than the viewport instead of clipping the
  // overflow off both ends (the flex-centering overflow trap). Combined with the
  // vertical scroll below, this keeps the whole stack — crucially the RESTART
  // button at the bottom — reachable on short screens or when the finish result
  // panel + expanded share menu make the overlay taller than the viewport.
  gameOverOverlay.style.justifyContent = 'safe center';
  // Allow the overlay itself to scroll when its contents overflow, so nothing
  // (GAME OVER header, result panel, RESTART) becomes unreachable.
  gameOverOverlay.style.overflowY = 'auto';
  gameOverOverlay.style.boxSizing = 'border-box';
  gameOverOverlay.style.padding = '24px 16px';
  gameOverOverlay.style.setProperty('-webkit-overflow-scrolling', 'touch');
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
  restartButton.id = 'restartButton';
  restartButton.textContent = 'RESTART';
  restartButton.style.padding = '15px 30px';
  restartButton.style.fontSize = '22px';
  // Never let the flex column squeeze the primary "get out of here" control.
  restartButton.style.flexShrink = '0';
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
  }, listenerOpts);
  restartButton.addEventListener('mouseleave', () => {
    restartButton.style.backgroundColor = '#ff4136';
  }, listenerOpts);
  gameOverOverlay.appendChild(restartButton);

  // Add to document
  document.body.appendChild(gameOverOverlay);

  // --- Initialize audio early, but don't start playing until user interaction ---
  // Audio is ENABLED (AUDIO_ENABLED = true in audio.ts — the simplified native HTML5
  // <audio> implementation; docs/CHANGELOG.md has the Three.js → Howler → native
  // history). init() must run before any other audio operation and setupUI() creates
  // the mute button; both early-exit if AUDIO_ENABLED is ever set false.
  AudioModule.init(scene);
  // Howler-era compat stub (a no-op on the native implementation), kept so this
  // call-order-sensitive block reads the same as the old flow.
  AudioModule.addAudioListener(camera);
  // Set up the audio UI (the mute button; skipped if audio is disabled)
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
  // Warm midday key (issue #17 palette / completion-plan PR-V3): the SNOW_RENDERING.md
  // core principle is warm sun + cool skylight (sunlit snow ≈ #FFF6E6). With near-white
  // snow albedo the sunlit warmth can only come from the LIGHT, so the directional key
  // is a slightly-desaturated warm white (#FFF4E6) instead of pure 0xffffff. Peak white
  // on flats is unaffected — the hemisphere+ambient fill already saturates flats to
  // white, so the warm key only tints the midtones/shadowed pitches (the sun cycle
  // captures this as its midday dirColor endpoint). The cool fill (hemisphere/ambient)
  // is untouched, keeping the warm-sun/cool-shadow relationship true at every phase.
  const directionalLight = new THREE.DirectionalLight(0xfff4e6, 0.5 * Math.PI);
  directionalLight.position.set(50, 100, 50);
  directionalLight.castShadow = true;
  scene.add(directionalLight);
  // Player-following sun shadow (issue #18): the default DirectionalLight shadow box is a
  // ±5 volume at the origin, so the snowman (spawns at z=-15, skis downhill) sat outside it
  // and cast no contact shadow for the whole run. Widen + bias the frustum here; the main
  // loop re-aims the light + target at the player each frame (game/sun-shadow.ts). The
  // target must be in the scene for Three.js to orient the shadow camera toward it.
  configureSunShadow(directionalLight, renderer);
  scene.add(directionalLight.target);

  // --- Sky & fog ---
  // Preetham atmospheric sky + sun, with horizon-tinted distance fog (issue #2),
  // plus the Tier 3 golden-hour↔midday sun cycle (#163). The directional light's
  // current position/colour/intensity (set just above) are captured as the static
  // midday endpoint, then the cycle drives it (so the visible sun and cast shadows
  // track together) and the sky/fog; it is advanced by `Sky.update(delta)` in the
  // main loop and freezes at the captured midday under prefers-reduced-motion. The
  // HemisphereLight/AmbientLight are intentionally not handed to the cycle — it must
  // not touch the snow's cool-shadow fill. (Sky.applyGradientSky is a fallback.)
  Sky.applyAtmosphericSky(scene, directionalLight);

  // --- Difficulty line + corridor ("the line is the difficulty") ---
  // Build the run's centerline ONCE and share that single instance: register it as the
  // active line (D3.2c — the gates and obstacle field read it via activeLaneX) and hand
  // the SAME instance to the terrain corridor (D3.2b — walls banked onto it). Straight
  // tiers (Bunny/Blue, curviness 0) resolve to `null` everywhere ⇒ gates at x=0, today's
  // obstacle placement, and today's exact terrain — the byte-identical guardrail.
  //
  // setupScene is one-shot (terrain/gates/obstacles are built once, never rebuilt on
  // restart — see game/teardown.ts), so all of this is fixed at scene build from
  // `builtDifficulty`. If the player locks a DIFFERENT tier for the run (the start-screen
  // picker, or the finish "Play again on" picker) it would not match; rather than rebuild
  // in place (a large, leak-prone teardown) the coordinator reloads on that mismatch
  // (maybeReloadForRunTier) so setupScene re-runs for the locked tier — see snowglider.ts.
  const builtDifficulty = readStoredDifficulty();
  const runConfig = getDifficultyConfig(builtDifficulty);
  const courseLine = runConfig.line.curviness > 0 ? courseLineFor(runConfig) : null;
  setActiveCourseLine(courseLine);
  Snow.setTerrainCorridor(
    courseLine && runConfig.terrain ? { line: courseLine, params: runConfig.terrain } : null
  );
  // Sculpted kickers on the line (JP-6): each ramp's lateral center resolves from the
  // SAME courseLine instance the corridor banks onto, so kickers sit on the channel
  // floor. Tiers without `features` clear them ⇒ byte-identical terrain (both calls
  // reset the height cache; this runs before createTerrain like the corridor above).
  Snow.setTerrainKickers(runConfig.features ?? null, courseLine);

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
    snowDepth: null,
    debris: null,
    scenery: null,
    avalancheTriggered: false,
    lastAvalancheZ: 0,
    dodgeAwarded: false,
    startTime: 0,
    bestTime: Infinity, // overwritten by readStoredBestTime() in the coordinator, before any read
    gameActive: false,       // start inactive until the user clicks the start button
    animationRunning: false,
    gameInitialized: false,
    difficulty: builtDifficulty, // remembered pick; re-read at each run start
    builtDifficulty,             // the tier the scene above was built for (corridor/mesh)
  };

  // --- Initialize Avalanche System ---
  // Per-tier slide (D3.2d): Bunny is OFF (enabled:false ⇒ the system builds but stays inert,
  // so window.avalanche + the lifecycle reset path stay valid), Blue is today's exact slide
  // (byte-identical), Black fires earlier/faster/heavier. The tier's `avalanche` block is the
  // single source; `enabled` gates the trigger in main-loop.ts. Built once from
  // `builtDifficulty` like the corridor above — if the run locks a different tier, the
  // coordinator reloads (maybeReloadForRunTier) so this rebuilds for it, not stays stale.
  if (typeof AvalancheSystem !== 'undefined') {
    const avc = runConfig.avalanche;
    const av = new AvalancheSystem(scene, avc.boulderCount, {
      enabled: avc.enabled,
      triggerDistance: avc.triggerDistance,
      slideSpeedBase: avc.slideSpeedBase,
      slideSpeedJitter: avc.slideSpeedJitter,
    });
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

  // --- Persistent snow-depth field (#246, PR 2: driven, not yet rendered) ---
  // The skis pack this [0..1] depth grid into lasting ski lines that fresh snow refills;
  // the main loop drives it off the same grounded/moving trigger as the ski trails. PR 2
  // wires the seam only — the field carries NO GPU texture yet, so nothing changes on
  // screen (a later PR samples it into the terrain material). Purely cosmetic data:
  // never touches physics/pos/velocity/heightMap.
  state.snowDepth = new SnowDepthField();

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

  // --- Background scenery (#320) ---
  // Built AFTER the gameplay-critical collision arrays (treePositions/rockPositions)
  // above, so scenery can never be mistaken for an obstacle source. It composes the
  // distant, non-interactive alpine world (ridges, valley, decorative belts, cliffs,
  // props, ambient life) and is render-only / collision-neutral / physics-neutral /
  // Math.random-stream-neutral / teardown-safe. Keyed off `builtDifficulty` like the
  // rest of the one-shot scene build (a run locked on a different tier reloads via
  // maybeReloadForRunTier). PR 1 wires the empty seam; later PRs push visual layers in.
  state.scenery = createScenery(scene, {
    terrain,
    getTerrainHeight: Snow.getTerrainHeight,
    courseLine,
    difficulty: builtDifficulty,
    seed: scenerySeedFor(builtDifficulty),
  });

  // (window.isTestMode is published at the top of setupScene, before any
  // subsystem that gates on it is built.)

  // Ski top sheets are themed per tier (cosmetic; the default keeps the shipped red).
  // Keyed off `builtDifficulty` like everything else setupScene builds — a run locked
  // on a different tier reloads via maybeReloadForRunTier, so this never goes stale.
  const snowman = Snowman.createSnowman(scene, { skiTopSheet: SKI_TOP_SHEET[builtDifficulty] });
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
        camera: camera,
        // Lets the result screen stamp the run's tier; reads the live GameState so
        // it reflects the difficulty chosen for the run that just finished.
        getDifficulty: () => state.difficulty
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
    directionalLight,
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
