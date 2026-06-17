// @ts-check
import * as THREE from 'three';

// Phase 2.0 (issue #84): a real ES-module entry that Vite bundles into a
// hashed asset, importing three.js from the npm package instead of the CDN
// global. Per-module conversions (PR 2.1 onward) move each game module onto
// this bundle, which index.html now loads as `<script type="module">`.
//
// Phase 2.1: avalanche.js is the first converted module. Importing it here for
// its side effect runs its `window.Avalanche = …` bridge before the classic
// script-loader pulls in the game/test scripts, so the still-classic consumers
// (the browser-test suite) keep finding the avalanche system.
import './avalanche.js';
// Phase 2.2: course.js, imported for its `window.CourseModule = …` bridge so the
// still-classic snowglider.js keeps finding the course system.
import './course.js';
// Phase 2.3: camera.js, imported for its `window.Camera = …` bridge so the
// still-classic snowglider.js keeps finding the Camera class (`new Camera(...)`).
import './camera.js';
// Phase 2.5: controls.js, imported for its `window.Controls = …` bridge so the
// still-classic snowglider.js keeps finding the input controls.
import './controls.js';
// Phase 2.6: effects.js, imported for its `window.EffectsModule = …` bridge so the
// still-classic snowglider.js keeps finding the avalanche/camera-juice effects.
import './effects.js';
// Phase 2.4: trees.js, imported for its `window.Trees = …` bridge. Imported before
// snow.js (below) because snow.js reads `Trees` at module-eval time when it builds
// the `Snow` namespace.
import './trees.js';
// Phase 2.7: mountains.js, imported for its `window.Mountains = …` +
// `window.getTerrainHeight/getTerrainGradient/getDownhillDirection` bridges. Also
// imported before snow.js, which reads `Mountains` at module-eval time.
import './mountains.js';
// Phase 2.6/cluster: snow.js, imported LAST of the terrain trio for its
// `window.Snow`/`window.Utils` bridges — it reads `Mountains`/`Trees` at eval, so
// both must already be bridged above.
import './snow.js';
// Phase 2.8: snowman.js, imported for its `window.Snowman = …` bridge so the
// still-classic snowglider.js keeps finding the snowman model + physics.
import './snowman.js';
// Phase 2 (audio): audio.js, imported for its `window.AudioModule = …` bridge so
// snowglider.js (bare `AudioModule` reads), start-menu.js, and the audio-tests
// browser suite keep finding it. It was the last game module loaded by the
// classic script-loader; with this import GAME_SCRIPT_ORDER is empty.
import './audio.js';

/** Revision of the three.js build pulled from npm and bundled by Vite. */
export const BUNDLED_THREE_REVISION = THREE.REVISION;

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__SNOWGLIDER_BUNDLE__ = {
    threeRevision: THREE.REVISION
  };

  // PR 2.10 (issue #84): the CDN UMD <script> that used to define the global
  // `THREE` is gone — three is now single-sourced from npm (bundled by Vite, or
  // import-mapped from node_modules when index.html is served as raw source).
  // The still-classic browser-test scripts (camera-tests.js) read three as a
  // bare global, so bridge it here, exactly like the per-module bridges above.
  // Drop this once those test scripts are converted to ES modules.
  /** @type {any} */ (window).THREE = THREE;

  // Phase 2.9: snowglider.js (the orchestrator) is now an ES module too, but it
  // must still run LAST — after the classic loader has loaded audio.js + Auth —
  // and stay deferred so the start menu's "clicked before scripts loaded" path
  // keeps working. So instead of a static import here (which would run it eagerly
  // at bundle load), expose a dynamic-import hook the classic script-loader calls
  // at the right moment. Keeping it a dynamic import of './snowglider.js' means
  // Vite still bundles it into the shared module graph (one Snow/Snowman/etc.
  // instance), while raw-source serving resolves it to /src/snowglider.js (the
  // request the puppeteer start-menu regression intercepts).
  /** @type {any} */ (window).__loadSnowGliderOrchestrator = () => import('./snowglider.js');
}

console.log(`[snowglider] bundled three.js r${THREE.REVISION}`);
