// @ts-check
import * as THREE from 'three';

// Phase 2.0 (issue #84): a real ES-module entry that Vite bundles into a
// hashed asset, importing three.js from the npm package instead of the CDN
// global. Per-module conversions (PR 2.1 onward) move each game module onto
// this bundle, which index.html now loads as `<script type="module">`.
//
// Phase 2.1: avalanche.js is the first converted module. Importing it here for
// its side effect runs its `window.Avalanche = …` bridge before the classic
// script-loader pulls in snowglider.js, so the still-classic consumer keeps
// finding the avalanche system. As more modules convert, add them here too
// until the classic loader is retired (PR 2.10).
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

/** Revision of the three.js build pulled from npm and bundled by Vite. */
export const BUNDLED_THREE_REVISION = THREE.REVISION;

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__SNOWGLIDER_BUNDLE__ = {
    threeRevision: THREE.REVISION
  };
}

console.log(`[snowglider] bundled three.js r${THREE.REVISION}`);
