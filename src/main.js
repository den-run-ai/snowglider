// @ts-check
import * as THREE from 'three';

// Phase 2.0 (issue #84): a real ES-module entry that Vite bundles into a
// hashed asset, importing three.js from the npm package instead of the CDN
// global. index.html loads this as `<script type="module">`.
//
// Game modules are imported here only so they're part of the eagerly-loaded
// bundle graph; snowglider.js (the deferred orchestrator) imports them too, the
// browser tests import the ones they need directly, and the boot/start-menu
// scripts import audio.js. Every per-module `window.*` namespace bridge has been
// removed (issue #84) — the modules resolve each other through real ES-module
// imports (e.g. snow.js imports Mountains/Trees, camera.js imports Mountains), so
// the import order below is no longer load-bearing.
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
