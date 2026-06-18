// Type-level twin of the `globals` block in eslint.config.js.
// Keep these two in lockstep: when a module gets typed, tighten the type here
// (and eventually remove the entry once it becomes a real ES-module import).
//
// Phase 1 strategy: start loose (`any` for not-yet-typed module namespaces),
// give the well-understood primitives real three.js types, and tighten per module.
import type * as THREE_NS from 'three';

declare global {
  // three.js r160, loaded as a CDN global (not an ES-module import yet).
  const THREE: typeof THREE_NS;

  /** Terrain height sampler injected via setTerrainFunction (see docs/ARCHITECTURE.md §4). */
  type TerrainHeightFn = (x: number, z: number) => number;

  // Game module namespaces — attached to the global scope by classic scripts.
  // Loose for now; tighten as each module is converted.
  //
  // IMPORTANT: a namespace is declared here ONLY while its defining module is not
  // yet `// @ts-check`ed. Once you @ts-check the file that defines it, its own
  // top-level `const`/`class` becomes the shared-script global, and keeping the
  // entry here causes "TS2451: Cannot redeclare". So: remove a module's entry
  // from this block in the same change that adds `// @ts-check` to that module.
  //   - avalanche.js: @ts-checked -> `Avalanche` lives in src/avalanche.js, not here.
  //   - audio.js:     @ts-checked -> `AudioModule` lives in src/audio.js, not here.
  // AuthModule/ScoresModule/CourseModule/Camera/Controls/EffectsModule stay:
  // auth.js/scores.js (and, as of PR 2.2/2.3/2.5/2.6, course.js/camera.js/
  // controls.js/effects.js) are ES modules — their `CourseModule`/`Camera`/
  // `Controls`/`EffectsModule`/etc. are module-scoped, not script globals — yet
  // the still-classic snowglider.js reads them by bare name (e.g.
  // `new Camera(scene)`, `Controls.setupControls()`, `EffectsModule.tickCamera`).
  // Keep them declared loose here until snowglider.js is converted (PR 2.9).
  // (Once a module's bare consumer is gone, drop its entry.)
  const AuthModule: any;
  const ScoresModule: any;
  const CourseModule: any;
  const Camera: any;
  const Controls: any;
  const EffectsModule: any;
  // trees.js (PR 2.4) is an ES module; `Trees` is module-scoped there, but the
  // still-classic snow.js reads it by bare name at eval. Kept until snow.js is
  // converted (same cluster).
  const Trees: any;
  // mountains.js (PR 2.7) + snow.js (cluster) are ES modules; `Mountains`/`Snow`
  // are module-scoped there, but bare consumers remain — trees.js/snow.js read
  // `Mountains`, and snowglider.js reads `Snow` — via the window bridges. Kept
  // until snowglider.js is converted (PR 2.9).
  const Mountains: any;
  const Snow: any;
  // snowman.js (PR 2.8) is an ES module; `Snowman` is module-scoped there, but
  // the still-classic snowglider.js reads it by bare name (`Snowman.createSnowman`).
  // Kept until snowglider.js is converted (PR 2.9).
  const Snowman: any;
  // Terrain samplers republished onto window by mountains.js (PR 2.7); read by
  // bare name in the converted snowman.js / camera.js / course.js. (Distinct from
  // the per-run `setTerrainFunction` seam.) Kept until snowglider.js is converted
  // (PR 2.9).
  const getTerrainHeight: TerrainHeightFn;
  const getTerrainGradient: (x: number, z: number) => { x: number; z: number };
  const getDownhillDirection: (x: number, z: number) => { x: number; z: number };

  // Howler.js globals (still listed in package.json / eslint; audio is native HTML5 now).
  const Howl: any;
  const Howler: any;

  // NOTE: snowglider.js (the orchestrator) is now @ts-checked too, so the shared
  // injected functions (`showGameOver`, `updateCamera`) and ALL the shared mutable
  // game state (`scene`, `snowman`, `velocity`, `pos`, `camera`, `cameraManager`,
  // `avalanche`, `gameActive`, `isInAir`, `startTime`, `bestTime`, …) are real
  // top-level `const`/`let` script-globals in src/snowglider.js — declaring any of
  // them here would be a TS2451 redeclare, so they are intentionally absent.
  // `resetSnowman`/`updateSnowman` are snowglider.js's OWN top-level wrapper
  // functions (script globals) — distinct from snowman.js's `Snowman.resetSnowman`/
  // `Snowman.updateSnowman`, which snowglider.js reaches via the namespace — so
  // they stay absent here too. The Phase 3 step is to replace these ad-hoc globals
  // with a typed GameState object; `TerrainHeightFn` (above) is kept for that work.

  // Classic scripts publish their namespaces onto window; allow those writes.
  // NOTE: `Snow` and `Camera` used to be *bare globals* (NOT window properties),
  // but as of the terrain cluster / PR 2.3 their defining files (snow.js,
  // camera.js) are ES modules that publish `window.Snow` / `window.Camera`
  // migration bridges, so they are listed below until their bare consumers
  // (snowglider.js) are converted (PR 2.9). mountains.js (PR 2.7) likewise
  // republishes the terrain samplers onto window.
  interface Window {
    AudioModule: any;
    AuthModule: any;
    Avalanche: any;
    Camera: any;
    Controls: any;
    CourseModule: any;
    EffectsModule: any;
    Mountains: any;
    Snow: any;
    getTerrainHeight?: (x: number, z: number) => number;
    getTerrainGradient?: (x: number, z: number) => { x: number; z: number };
    getDownhillDirection?: (x: number, z: number) => { x: number; z: number };
    ScoresModule: any;
    SnowGliderFirebase?: any;
    SnowGliderLocalAuth?: any;
    SnowGliderScriptLoader?: any;
    SnowGliderStartMenu?: any;
    Snowman: any;
    Trees: any;
    Utils: any;
    FIREBASE_MANUAL_INIT?: boolean;
    __FIREBASE_DEFAULTS__?: any; // set by auth.js to stop Firebase auto-init 404s
    // Cross-module/test handles published by snowglider.js (docs/ARCHITECTURE.md §3).
    terrainMesh?: any;
    treePositions?: any;
    isTestMode?: boolean;
    // Lifecycle/input callbacks snowglider.js publishes for controls.js + buttons.
    toggleCameraView?: () => unknown;
    resetSnowman?: (...args: any[]) => unknown;
    restartGame?: () => unknown;
    showGameOver?: (...args: any[]) => unknown;
    initializeGameWithAudio?: (...args: any[]) => unknown;
    // Test-only handles read/written by snowman.js test hooks + browser suites.
    testHooks?: any;
    treeCollisionRadius?: number;
    testTreeJumpingCheck?: boolean;
    testCollisionDetected?: boolean;
    _treeCheckLogged?: boolean;
    _testShowGameOverOverride?: (...args: any[]) => unknown;
    // Firebase modular SDK handle wired up in index.html (analytics, etc.).
    firebaseModules?: any;
  }
}

export {};
