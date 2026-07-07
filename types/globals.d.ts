// Type-level twin of the `globals` block in eslint.config.js.
// Keep these two in lockstep: when a module gets typed, tighten the type here
// (and eventually remove the entry once it becomes a real ES-module import).
//
// Phase 1 strategy: start loose (`any` for not-yet-typed module namespaces),
// give the well-understood primitives real three.js types, and tighten per module.
import type * as THREE from 'three';
import type { TreePosition } from '../src/trees.js';
import type { User } from 'firebase/auth';
import type { Difficulty } from '../src/difficulty.js';
import type { LeaderboardScore } from '../src/scores.js';

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
  const AuthModule: AuthModuleApi;
  const ScoresModule: ScoresModuleApi;
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

  // --- Typed boot/auth/scoring seams (issue: type-hardening) ---------------------
  // These interfaces replace the former `any` on the window bridges published by
  // auth.ts / scores.ts (or the reduced local-mode shims in boot/local-auth.js).
  // Members are OPTIONAL because the bridge may be: the reduced local-mode fallback
  // (which omits reinitializeFirestore / syncBestTimeWithRetry / leaderboardRow), or
  // not yet loaded — and every reader already guards each call (`?.` / typeof).
  // Keeping the READERS honest (typed member access instead of silent `any`) is the
  // whole point; the loose optionality models the real, partially-populated bridge.

  /** Which Firebase services the Auth bootstrap currently reports live. */
  interface FirebaseAvailability {
    auth: boolean;
    firestore: boolean;
    analytics: boolean;
  }

  /** Synchronous snapshot of the signed-in user (AuthModule.getAuthState). */
  interface AuthState {
    user: User | null;
    isSignedIn: boolean;
  }

  // NOTE: the members below use METHOD syntax (`foo?(): T`) rather than property
  // syntax (`foo?: () => T`) deliberately — method signatures are compared with
  // BIVARIANT parameters, so the concrete modules (whose params are the precise
  // Firebase types, e.g. `initializeAuth(config: FirebaseOptions)`) stay assignable
  // to these loosened seam declarations. Property syntax would reject them under
  // strictFunctionTypes.

  /** The auth/scoring boot bridge published on `window` by auth.ts (real Firebase)
   *  or boot/local-auth.js (the reduced file://-mode shim). */
  interface AuthModuleApi {
    initializeAuth?(config?: unknown): unknown;
    getCurrentUser?(): User | null;
    isUserSignedIn?(): boolean;
    getUserIdToken?(forceRefresh?: boolean): Promise<string | null>;
    reinitializeFirestore?(): boolean;
    recordScore?(time: number, tier?: Difficulty): void;
    displayLeaderboard?(tier?: Difficulty): void;
    signOut?(): Promise<void>;
    getAuthState?(): AuthState;
    isFirebaseAvailable?(): FirebaseAvailability;
  }

  /** The scoring/leaderboard boot bridge published on `window` by scores.ts (or the
   *  reduced boot/local-auth.js shim, whose updateUserBestTime/updateLeaderboard are
   *  no-op `() => void` — hence the `| void` returns). */
  interface ScoresModuleApi {
    initializeScores?(firestore: unknown, analytics: unknown): void;
    setCurrentUser?(user: User | null): void;
    recordScore?(time: number, tier?: Difficulty): void;
    displayLeaderboard?(tier?: Difficulty): void;
    getLeaderboard?(tier?: Difficulty): Promise<LeaderboardScore[]>;
    updateUserBestTime?(uid: string, time: number, tier?: Difficulty): Promise<boolean> | void;
    updateLeaderboard?(uid: string, time: number, tier?: Difficulty): Promise<boolean> | void;
    syncBestTimeWithRetry?(uid: string, time: number, tier: Difficulty): void;
    isFirestoreAvailable?(): boolean;
    isValidScoreTime?(time: number): boolean;
    leaderboardRow?(rank: number, name: string, photoURL: string | null,
                    time: number, isCurrentUser: boolean): HTMLTableRowElement;
  }

  /** Thin Firebase Analytics seam published by auth.ts / auth.html — the keyless
   *  `logEvent` bridge the game's analytics calls go through. */
  interface FirebaseModulesApi {
    logEvent?(name: string, params?: Record<string, unknown>): void;
  }

  /** Classic Firebase bootstrap handle (boot/firebase-bootstrap.js). */
  interface SnowGliderFirebaseApi {
    isFileProtocol?: boolean;
    isLocalDevelopment?: boolean;
    waitForAuthModule?(): Promise<void>;
    initializeAuthModule?(): void;
  }

  /** Classic local-auth fallback installer (boot/local-auth.js). */
  interface SnowGliderLocalAuthApi {
    installScoresModule?(): void;
    installAuthModule?(): void;
  }

  /** The start-menu handle published on `window` by ui/start-menu.ts. Every member is
   *  a nullary function; getSelectedDifficulty returns the active tier. */
  interface SnowGliderStartMenuApi {
    startGame?: () => unknown;
    showAbout?: () => unknown;
    hideAbout?: () => unknown;
    initializeStartMenu?: () => unknown;
    startPendingGameIfReady?: () => unknown;
    refreshStartAccountUI?: () => unknown;
    buildDifficultyPicker?: () => unknown;
    getSelectedDifficulty?: () => Difficulty;
  }

  /** The module script-loader handle (boot/script-loader.ts). */
  interface SnowGliderScriptLoaderApi {
    loadScript: (src: string) => Promise<void>;
    loadScriptsInOrder: (scripts: string[]) => Promise<void>;
    loadTests: () => void;
    initializeGameScripts: () => void;
    announceGameScriptsReady: () => void;
  }

  /** Firebase's own auto-init defaults hook (auth.ts sets these to suppress 404s). */
  interface FirebaseDefaults {
    config?: unknown;
    _authTokenSyncURL?: string | null;
  }

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
    AuthModule: AuthModuleApi;
    ScoresModule: ScoresModuleApi;
    SnowGliderFirebase?: SnowGliderFirebaseApi;
    SnowGliderLocalAuth?: SnowGliderLocalAuthApi;
    SnowGliderScriptLoader?: SnowGliderScriptLoaderApi;
    SnowGliderStartMenu?: SnowGliderStartMenuApi;
    // Deferred dynamic-import hook for the orchestrator (src/main.js -> snowglider.js),
    // invoked by the module script-loader after audio.js + Auth are ready (PR 2.9).
    __loadSnowGliderOrchestrator?: () => Promise<unknown>;
    // Diagnostic handle set by src/main.ts at bundle load (three.js revision probe).
    __SNOWGLIDER_BUNDLE__?: { threeRevision: string };
    FIREBASE_MANUAL_INIT?: boolean;
    __FIREBASE_DEFAULTS__?: FirebaseDefaults; // set by auth.js to stop Firebase auto-init 404s
    // Cross-module/test handles published by snowglider.js (docs/ARCHITECTURE.md §3).
    terrainMesh?: THREE.Mesh;
    treePositions?: TreePosition[];
    rockPositions?: Array<{ x: number; y: number; z: number; size: number }>;
    isTestMode?: boolean;
    // Lifecycle/input callbacks snowglider.js publishes for controls.js + buttons.
    toggleCameraView?: () => unknown;
    resetSnowman?: () => void;
    restartGame?: () => unknown;
    // Idempotent teardown for the whole game instance (dispose-audit plan): frees the
    // WebGL context + GPU resources and removes game-lifetime listeners. Used by
    // embedders/unmount and the dev-HMR hook; see src/game/teardown.ts.
    disposeGame?: () => void;
    showGameOver?: (reason: string) => void;
    initializeGameWithAudio?: () => void;
    // Test-only handles read/written by snowman.js test hooks + browser suites.
    // (Still `any` — the test-hook surface is typed in a later hardening PR.)
    testHooks?: any;
    treeCollisionRadius?: number;
    testTreeJumpingCheck?: boolean;
    testCollisionDetected?: boolean;
    _treeCheckLogged?: boolean;
    _testShowGameOverOverride?: (reason: string) => void;
    // Analytics seam wired up by auth.ts / auth.html (keyless logEvent bridge).
    firebaseModules?: FirebaseModulesApi;
    // Boot progress flags set by the module script-loader (boot/script-loader.ts).
    _unifiedTestRunnerActive?: boolean;
    SnowGliderGameScriptsReady?: boolean;
    // Physics/frame-rate diagnostics bug-report API (src/diagnostics.ts): snapshot /
    // dump (downloads a JSON trace) / reset / overlay toggle. Present only in live play.
    __snowgliderDiag?: {
      snapshot: () => unknown;
      dump: () => unknown;
      reset: () => void;
      overlay: (on?: boolean) => void;
    };
  }

  // Minimal Vite HMR typing for the coordinator's dev-only `import.meta.hot.dispose`
  // teardown hook (src/snowglider.ts). The project doesn't pull in `vite/client`
  // (its broad ambient module declarations would leak into every file), so declare
  // just the slice we use. `hot` is undefined in production builds.
  interface ImportMeta {
    readonly hot?: {
      dispose(cb: (data: unknown) => void): void;
      accept(cb?: (mod: unknown) => void): void;
    };
  }
}

export {};
