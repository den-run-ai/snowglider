// @ts-check
import * as THREE from 'three';

// Phase 2.0 (issue #84): a real ES-module entry that Vite bundles into a
// hashed asset, importing three.js from the npm package instead of the CDN
// global. The live game still boots through the classic CDN + script-loader
// path in index.html until the per-module conversions (PR 2.1 onward) move
// each game module onto this bundle. This entry exists only to stand up and
// verify the bundling pipeline without changing how the game currently loads.

/** Revision of the three.js build pulled from npm and bundled by Vite. */
export const BUNDLED_THREE_REVISION = THREE.REVISION;

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).__SNOWGLIDER_BUNDLE__ = {
    threeRevision: THREE.REVISION
  };
}

console.log(`[snowglider] bundled three.js r${THREE.REVISION}`);
