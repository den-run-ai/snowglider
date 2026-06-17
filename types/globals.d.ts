// Type-level twin of the `globals` block in eslint.config.js.
// Keep these two in lockstep: when a module gets typed, tighten the type here
// (and eventually remove the entry once it becomes a real ES-module import).
//
// Phase 1 strategy: start loose (`any` for not-yet-typed module namespaces),
// give the well-understood primitives real three.js types, and tighten per module.
import type * as THREE_NS from 'three';

declare global {
  // three.js r160. As of PR 2.10 the CDN UMD <script> global is gone — three is
  // single-sourced from npm (every src module `import`s it; main.js bridges
  // `window.THREE`). Kept declared as an ambient global in lockstep with
  // eslint.config.js for the still-classic browser-test scripts (camera-tests.js)
  // that read it bare; drop once those tests become ES modules.
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
  // As of PR 2.9, snowglider.js is itself an ES module that *imports* camera.js/
  // controls.js/course.js/effects.js/snow.js/snowman.js, so the bare-name globals
  // `Camera`/`Controls`/`CourseModule`/`EffectsModule`/`Snow`/`Snowman` have no
  // remaining consumer and were dropped here (their window.* bridges live on in
  // the Window interface below until the classic loader is retired, PR 2.10).
  // AuthModule/ScoresModule stay: auth.js/scores.js publish them onto window and
  // they're still referenced loosely.
  const AuthModule: any;
  const ScoresModule: any;
  // trees.js (PR 2.4) is an ES module; `Trees` is module-scoped there, but
  // snow.js reads it by bare name at eval (via the window bridge). Kept until
  // snow.js stops reading it bare.
  const Trees: any;
  // mountains.js (PR 2.7) is an ES module; `Mountains` is module-scoped there,
  // but snow.js (and trees.js) read it by bare name at eval via the window bridge.
  // Kept until those bare reads are removed.
  const Mountains: any;
  // Terrain samplers republished onto window by mountains.js (PR 2.7). Kept as a
  // loose ambient global for the window bridge; the converted modules take them as
  // parameters rather than reading these names. (Distinct from the per-run
  // `setTerrainFunction` seam.)
  const getTerrainHeight: TerrainHeightFn;
  const getTerrainGradient: (x: number, z: number) => { x: number; z: number };
  const getDownhillDirection: (x: number, z: number) => { x: number; z: number };

  // snowman.js's checkTreeCollision test hook reads these two as bare globals
  // (they are not its parameters, unlike `pos`/`getTerrainHeight`). snowglider.js
  // re-publishes them onto window via accessors (PR 2.9), so keep them declared
  // here until that hook is refactored to take them as arguments.
  const isInAir: boolean;
  const verticalVelocity: number;

  // Howler.js globals (still listed in package.json / eslint; audio is native HTML5 now).
  const Howl: any;
  const Howler: any;

  // NOTE: as of PR 2.9 snowglider.js is an ES module, so its shared helpers
  // (`showGameOver`, `updateCamera`, `updateSnowman`, …) and ALL the shared mutable
  // game state (`scene`, `snowman`, `velocity`, `pos`, `camera`, `cameraManager`,
  // `avalanche`, `gameActive`, `isInAir`, `startTime`, `bestTime`, …) are now
  // module-scoped, not script globals — so they are absent from this ambient block.
  // snowglider.js re-publishes them onto `window` (via accessors) so the browser
  // test suites can still drive the live game by bare name; those window handles
  // are typed in the Window interface below. The Phase 3 step is to replace these
  // ad-hoc globals with a typed GameState object; `TerrainHeightFn` is kept for it.

  // Classic scripts publish their namespaces onto window; allow those writes.
  // NOTE: `Snow` and `Camera` used to be *bare globals* (NOT window properties),
  // but as of the terrain cluster / PR 2.3 their defining files (snow.js,
  // camera.js) are ES modules that publish `window.Snow` / `window.Camera`
  // migration bridges, so they are listed below until their bare consumers
  // (snowglider.js) are converted (PR 2.9). mountains.js (PR 2.7) likewise
  // republishes the terrain samplers onto window.
  interface Window {
    // three.js bridged onto window by main.js (PR 2.10) for the still-classic
    // browser-test scripts, replacing the removed CDN UMD global.
    THREE: typeof THREE_NS;
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
    // Deferred dynamic-import hook for the orchestrator (src/main.js -> snowglider.js),
    // invoked by the classic script-loader after audio.js + Auth are ready (PR 2.9).
    __loadSnowGliderOrchestrator?: () => Promise<unknown>;
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
