// Type-level twin of the `globals` block in eslint.config.js.
// Keep these two in lockstep: when a module gets typed, tighten the type here
// (and eventually remove the entry once it becomes a real ES-module import).
//
// Phase 1 strategy: start loose (`any` for not-yet-typed module namespaces),
// give the well-understood primitives real three.js types, and tighten per module.
import type * as THREE from 'three';
import type { TreePosition } from '../src/trees.js';

declare global {
  // three.js r160 is single-sourced from npm. Every src module and every browser
  // test now `import * as THREE from 'three'`, so the ambient `THREE` global and
  // its window.THREE bridge were removed (issue #84).

  /** Terrain height sampler injected via setTerrainFunction (see docs/ARCHITECTURE.md §4). */
  type TerrainHeightFn = (x: number, z: number) => number;

  // Auth/scoring globals are still published by the Firebase modules and read
  // loosely by the boot/orchestrator seams. Game-module namespaces are not
  // declared here anymore; Phase 2 converted them to real imports.
  // As of PR 2.9, snowglider.js is itself an ES module that *imports* camera.js/
  // controls.js/course.js/effects.js/snow.js/snowman.js, so the bare-name globals
  // `Camera`/`Controls`/`CourseModule`/`EffectsModule`/`Snow`/`Snowman` have no
  // remaining consumer and were dropped here. The later Phase 2 cleanup removed
  // their window namespace bridges too.
  // AuthModule/ScoresModule stay: auth.js/scores.js publish them onto window and
  // they're still referenced loosely.
  const AuthModule: any;
  const ScoresModule: any;
  // trees.js / mountains.js / snow.js import each other directly, camera.js imports
  // Mountains, and snowman.js / course.js receive the terrain samplers as injected
  // parameters — so the bare `Trees` / `Mountains` / `getTerrainHeight` /
  // `getTerrainGradient` / `getDownhillDirection` globals + their window bridges
  // were all removed (issue #84). `TerrainHeightFn` is still used below.

  // snowman.js's checkTreeCollision test hook reads these two as bare globals
  // (they are not its parameters, unlike `pos`/`getTerrainHeight`). snowglider.js
  // re-publishes them onto window via accessors (PR 2.9), so keep them declared
  // here until that hook is refactored to take them as arguments.
  const isInAir: boolean;
  const verticalVelocity: number;

  // NOTE: as of PR 2.9 snowglider.js is an ES module, so its shared helpers
  // (`showGameOver`, `updateCamera`, `updateSnowman`, …) and ALL the shared mutable
  // game state (`scene`, `snowman`, `velocity`, `pos`, `camera`, `cameraManager`,
  // `avalanche`, `gameActive`, `isInAir`, `startTime`, `bestTime`, …) are now
  // module-scoped, not script globals — so they are absent from this ambient block.
  // snowglider.js re-publishes them onto `window` (via accessors) so the browser
  // test suites can still drive the live game by bare name; those window handles
  // are typed in the Window interface below. The Phase 3 step is to replace these
  // ad-hoc globals with a typed GameState object; `TerrainHeightFn` is kept for it.

  // Window members below are the remaining boot/auth/test seams. They are not
  // per-module namespace bridges.
  interface Window {
    // Every per-module window.* namespace bridge has been removed (issue #84):
    // AudioModule was the last one (the boot script-loader, the start menu, and
    // the audio browser tests now import it), and the THREE/Avalanche/Camera/
    // Controls/CourseModule/EffectsModule/Snow/Snowman/Utils/Mountains/Trees
    // bridges + the getTerrainHeight* samplers were dropped earlier — every
    // consumer imports those directly or receives them as injected parameters.
    // The members below are boot/auth/test seams, not module-namespace bridges.
    AuthModule: any;
    ScoresModule: any;
    SnowGliderFirebase?: any;
    SnowGliderLocalAuth?: any;
    SnowGliderScriptLoader?: any;
    SnowGliderStartMenu?: any;
    // Deferred dynamic-import hook for the orchestrator (src/main.js -> snowglider.js),
    // invoked by the module script-loader after audio.js + Auth are ready (PR 2.9).
    __loadSnowGliderOrchestrator?: () => Promise<unknown>;
    FIREBASE_MANUAL_INIT?: boolean;
    __FIREBASE_DEFAULTS__?: any; // set by auth.js to stop Firebase auto-init 404s
    // Cross-module/test handles published by snowglider.js (docs/ARCHITECTURE.md §3).
    terrainMesh?: THREE.Mesh;
    treePositions?: TreePosition[];
    rockPositions?: Array<{ x: number; y: number; z: number; size: number }>;
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
    // Physics/frame-rate diagnostics bug-report API (src/diagnostics.ts): snapshot /
    // dump (downloads a JSON trace) / reset / overlay toggle. Present only in live play.
    __snowgliderDiag?: {
      snapshot: () => unknown;
      dump: () => unknown;
      reset: () => void;
      overlay: (on?: boolean) => void;
    };
  }
}

export {};
