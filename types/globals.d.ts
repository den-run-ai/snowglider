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
  //   - trees.js:     @ts-checked -> `Trees` + `getTerrainHeight`/`getTerrainGradient`
  //                   (top-level fns) live in src/trees.js, not here.
  //   - effects.js:   @ts-checked -> `EffectsModule` lives in src/effects.js, not here.
  //   - snow.js:      @ts-checked -> `Snow` + `Utils` live in src/snow.js, not here.
  //   - mountains.js: @ts-checked -> `Mountains` lives in src/mountains.js, not here.
  //   - snowman.js:   @ts-checked -> `Snowman` + `resetSnowman`/`updateSnowman`
  //                   (top-level fns) live in src/snowman.js, not here.
  //   - audio.js:     @ts-checked -> `AudioModule` lives in src/audio.js, not here.
  // AuthModule/ScoresModule/CourseModule/Camera/Controls stay: auth.js/scores.js
  // (and, as of PR 2.2/2.3/2.5, course.js/camera.js/controls.js) are ES modules —
  // their `CourseModule`/`Camera`/`Controls`/etc. are module-scoped, not script
  // globals — yet the still-classic snowglider.js reads them by bare name (e.g.
  // `new Camera(scene)`, `Controls.setupControls()`). Keep them declared loose
  // here until snowglider.js is converted (PR 2.9). (Once a module's bare consumer
  // is gone, drop its entry.)
  const AuthModule: any;
  const ScoresModule: any;
  const CourseModule: any;
  const Camera: any;
  const Controls: any;

  // Howler.js globals (still listed in package.json / eslint; audio is native HTML5 now).
  const Howl: any;
  const Howler: any;

  // NOTE: snowglider.js (the orchestrator) is now @ts-checked too, so the shared
  // injected functions (`showGameOver`, `updateCamera`) and ALL the shared mutable
  // game state (`scene`, `snowman`, `velocity`, `pos`, `camera`, `cameraManager`,
  // `avalanche`, `gameActive`, `isInAir`, `startTime`, `bestTime`, …) are real
  // top-level `const`/`let` script-globals in src/snowglider.js — declaring any of
  // them here would be a TS2451 redeclare, so they are intentionally absent.
  // `getTerrainHeight`/`resetSnowman`/`updateSnowman` likewise live in trees.js /
  // snowman.js. The Phase 3 step is to replace these ad-hoc globals with a typed
  // GameState object; `TerrainHeightFn` (above) is kept for that work.

  // Classic scripts publish their namespaces onto window; allow those writes.
  // NOTE: per docs/ARCHITECTURE.md §3, `Snow` is a *bare global* and is NOT a
  // window property (only `window.Utils` aliases `Snow`), so it is intentionally
  // absent here. `Camera` used to be a bare global too, but as of PR 2.3 camera.js
  // is an ES module that publishes a `window.Camera` migration bridge, so it is
  // listed below until its bare consumer (snowglider.js) is converted (PR 2.9).
  interface Window {
    AudioModule: any;
    AuthModule: any;
    Avalanche: any;
    Camera: any;
    Controls: any;
    CourseModule: any;
    EffectsModule: any;
    Mountains: any;
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
