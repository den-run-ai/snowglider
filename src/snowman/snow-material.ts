// snow-material.ts — the ONE shared snow material for the snowman body and the crash
// debris (completion-plan PR-V4; closes the last #17 item).
//
// WHY: the terrain snow gained a mottled near-white albedo, micro-relief normal map
// and cavity shading (#17), so the snowman's flat `0xffffff, roughness 0.9` spheres —
// and the crash debris chunks that mimic them — read as plastic against it. This
// module reuses the SAME texture generators the terrain uses (mountains/snow-surface)
// re-tiled to snowman scale, and matches the terrain's roughness, so "snowman snow ≈
// ground snow" under both sun-cycle endpoints.
//
// OWNERSHIP (load-bearing, mirrors the tree pools): a single module-level material is
// shared by every snowman body sphere AND every debris fragment. Debris must NOT
// dispose it in reset() — its per-cycle disposal stays geometry-only. disposeGame's
// dedup scene sweep (game/teardown.ts) disposes it exactly once at unmount, and
// resetSnowmanSnowMaterial() (called there next to resetTreePools) clears this cache
// so a later remount rebuilds the material instead of referencing freed handles.
//
// HEADLESS: the texture bake needs a 2d canvas. The Node suites (debris / flex / leak
// / lifecycle) build snowmen headless, so textures are applied only when a working 2d
// context exists; the material itself (colour / roughness / vertexColors) is identical
// either way, so the sharing and shading contracts hold in both environments.

import * as THREE from 'three';
import { createSnowAlbedoTexture, createSnowNormalTexture } from '../mountains/snow-surface.js';

/** Matches the terrain snow material (mountains/terrain-mesh.ts). */
export const SNOWMAN_SNOW_ROUGHNESS = 0.92;
/** Faint granulation only — the balls are hand-packed snow, softer than the slope. */
export const SNOWMAN_SNOW_NORMAL_SCALE = 0.1;

let shared: THREE.MeshStandardMaterial | null = null;

/** True when a 2d canvas with the pixel APIs the snow-surface generators use
 *  (createImageData/putImageData) exists — a browser, or a shim that provides them.
 *  Partial jsdom shims (e.g. the DOM smoke harness stubs only fillRect/fillText)
 *  must fall to the textureless path, not crash the bake. */
function canvas2dAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const ctx = document.createElement('canvas').getContext('2d') as
      CanvasRenderingContext2D | null;
    return !!ctx &&
      typeof ctx.createImageData === 'function' &&
      typeof ctx.putImageData === 'function';
  } catch {
    return false;
  }
}

/**
 * The shared snowman/debris snow material (lazily built once per mount).
 *
 * `vertexColors` is on: the body spheres bake a faint cool junction-crease tint
 * (snowman/model.ts) and the debris bakes plain white, so every geometry rendered
 * with this material MUST carry a `color` attribute.
 */
export function getSnowmanSnowMaterial(): THREE.MeshStandardMaterial {
  if (!shared) {
    shared = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: SNOWMAN_SNOW_ROUGHNESS,
      vertexColors: true
    });
    if (canvas2dAvailable()) {
      // The generators bake terrain-scale repeats (the slope is ~400 units across);
      // re-tile for a ball a few units across: one broad mottle tile per ball face,
      // finer grain for the micro-relief.
      const albedo = createSnowAlbedoTexture();
      albedo.repeat.set(2, 2);
      const normalMap = createSnowNormalTexture();
      normalMap.repeat.set(4, 4);
      shared.map = albedo;
      shared.normalMap = normalMap;
      shared.normalScale = new THREE.Vector2(SNOWMAN_SNOW_NORMAL_SCALE, SNOWMAN_SNOW_NORMAL_SCALE);
    }
  }
  return shared;
}

/** Drop the cached material (dispose-audit teardown / dev-HMR). The scene sweep has
 *  already disposed the material + textures; clearing the cache makes the next
 *  getSnowmanSnowMaterial() rebuild instead of handing out freed handles. Idempotent. */
export function resetSnowmanSnowMaterial(): void {
  shared = null;
}
