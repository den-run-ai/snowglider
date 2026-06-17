// @ts-check
import * as THREE from 'three';

// Phase 2.0 (issue #84): a real ES-module entry that Vite bundles into a
// hashed asset, importing three.js from the npm package instead of the CDN
// global. index.html loads this as `<script type="module">`.
//
// Most game modules are imported here only so they're part of the eagerly-loaded
// bundle graph; snowglider.js (the deferred orchestrator) imports them too, and
// the browser tests import the ones they need directly. Their per-module
// `window.*` namespace bridges have been removed (issue #84). Two side effects
// here are still load-bearing:
//   1. The terrain trio (trees.js, mountains.js, snow.js) must run in THIS order:
//      snow.js reads `Mountains`/`Trees` by bare name at module-eval (via the
//      window.Mountains / window.Trees bridges those two still publish), so both
//      must execute before snow.js. mountains.js also publishes the
//      window.getTerrainHeight/getTerrainGradient/getDownhillDirection samplers.
//   2. audio.js publishes the still-needed window.AudioModule bridge (read by the
//      classic start-menu.js + the audio browser tests).
import './avalanche.js';
import './course.js';
import './camera.js';
import './controls.js';
import './effects.js';
import './trees.js';
import './mountains.js';
import './snow.js';
import './snowman.js';
import './audio.js';

/** Revision of the three.js build pulled from npm and bundled by Vite. */
export const BUNDLED_THREE_REVISION = THREE.REVISION;

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__SNOWGLIDER_BUNDLE__ = {
    threeRevision: THREE.REVISION
  };

  // The window.THREE bridge was removed (issue #84): three is single-sourced
  // from npm (bundled by Vite, or import-mapped from node_modules in raw source),
  // and the browser-test scripts that used to read it bare (camera-tests.js) now
  // `import * as THREE from 'three'` directly.

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
