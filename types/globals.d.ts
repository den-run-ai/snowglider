// Type-level twin of the `globals` block in eslint.config.js.
// Keep these two in lockstep: when a module gets typed, tighten the type here
// (and eventually remove the entry once it becomes a real ES-module import).
//
// Phase 1 strategy: start loose (`any` for not-yet-typed module namespaces),
// give the well-understood primitives real three.js types, and tighten per module.
import type * as THREE_NS from 'three';

declare global {
  // three.js r134, loaded as a CDN global (not an ES-module import yet).
  const THREE: typeof THREE_NS;

  /** Terrain height sampler injected via setTerrainFunction (see ARCHITECTURE.md §4). */
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
  //   - course.js:    @ts-checked -> `CourseModule` lives in src/course.js, not here.
  //   - camera.js:    @ts-checked -> `Camera` (class) lives in src/camera.js, not here.
  const AudioModule: any;
  const AuthModule: any;
  const Controls: any;
  const EffectsModule: any;
  const Mountains: any;
  const ScoresModule: any;
  const Snow: any;
  const Snowman: any;
  const Trees: any;
  const Utils: any;

  // Howler.js globals (still listed in package.json / eslint; audio is native HTML5 now).
  const Howl: any;
  const Howler: any;

  // Shared injected functions (see ARCHITECTURE.md §3 global namespace / §4 seams).
  const getTerrainHeight: TerrainHeightFn;
  const resetSnowman: (...args: any[]) => any;
  const showGameOver: (...args: any[]) => any;
  const updateCamera: (...args: any[]) => any;
  const updateSnowman: (...args: any[]) => any;

  // Shared mutable game state (writable globals in eslint.config.js).
  // NOTE: these are top-level `const`/`let` in src/snowglider.js, so they become
  // real script-globals once that file is @ts-checked (Phase 3, last) — at which
  // point these entries must be removed to avoid TS2451 (same rule as namespaces).
  // Types here mirror the ACTUAL shapes in snowglider.js, not the guide's example:
  // `velocity`/`pos` are plain `{x,z(,y)}` objects, NOT THREE.Vector3.
  let scene: THREE_NS.Scene;
  let snowman: THREE_NS.Object3D;
  let velocity: { x: number; z: number; y?: number };
  let pos: { x: number; z: number; y: number };
  let camera: THREE_NS.PerspectiveCamera;
  let cameraManager: any;
  let avalanche: any;
  let avalancheTriggered: boolean;
  let bestTime: number;
  let gameActive: boolean;
  let isInAir: boolean;
  let lastAvalancheZ: number;
  let startTime: number;
  let verticalVelocity: number;

  // Classic scripts publish their namespaces onto window; allow those writes.
  // NOTE: per ARCHITECTURE.md §3, `Snow` and `Camera` are *bare globals* and are
  // NOT window properties (only `window.Utils` aliases `Snow`), so they are
  // intentionally absent here.
  interface Window {
    AudioModule: any;
    AuthModule: any;
    Avalanche: any;
    Controls: any;
    CourseModule: any;
    EffectsModule: any;
    Mountains: any;
    ScoresModule: any;
    Snowman: any;
    Trees: any;
    Utils: any;
    FIREBASE_MANUAL_INIT?: boolean;
  }
}

export {};
