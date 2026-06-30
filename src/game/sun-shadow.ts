// Player-following sun shadow (issue #18).
//
// THE BUG THIS CLOSES. Everything in the scene sets `castShadow` (the snowman's
// body/hat/arms/skis/scarf, trees, rocks, avalanche boulders, course gates) and the
// terrain has `receiveShadow = true`, but nothing ever configured the directional
// (sun) light's shadow-camera frustum. Three.js's default DirectionalLight shadow box
// is a ±5-unit orthographic volume centred on the world origin. The snowman SPAWNS at
// z = -15 — already outside that box — and then skis far downhill, so for essentially
// the entire run the snowman sat outside the shadow camera and cast NO contact shadow,
// while the 2048² shadow map was spent on a patch of slope nobody skis through. On an
// all-white slope a grounding shadow is the single strongest "this object is on the
// snow" cue, so its absence read as the snowman floating.
//
// THE FIX, in two pure pieces (no scene-graph ownership here — the caller wires them):
//  - configureSunShadow(): widen the frustum to cover the slope around the player, set
//    soft shadows + depth bias once at setup.
//  - aimSunLight(): each render frame, move the light AND its target so the frustum
//    follows the player while the sun *direction* (and thus the shadow direction) is
//    preserved. The sun-cycle (sky.ts) keeps driving the direction; this only offsets
//    the whole light→target pair to sit over the player.
//
// Pure-rendering change: it never touches pos/velocity or the physics height field, so
// the no-input physics invariant is unaffected. The shadow map already re-rendered every
// frame (the sun cycle moves the light continuously), so following the player adds no new
// per-frame shadow cost beyond the same single shadow-map pass.

import * as THREE from 'three';

// Half-extent (world units) of the sun's orthographic shadow frustum, centred on the
// player each frame by aimSunLight(). ±60 covers the visible slope around the snowman;
// tighter would sharpen the shadow but risk clipping nearby obstacle shadows.
export const SHADOW_HALF_EXTENT = 60;
// Near/far bracket the light→player distance (the captured midday sun sits ~122 units
// out, see sky.ts) plus the terrain relief inside the frustum, with margin.
export const SHADOW_NEAR = 10;
export const SHADOW_FAR = 400;
export const SHADOW_MAP_SIZE = 2048;
// Depth biases that kill shadow acne / peter-panning on the low-relief snow surface.
export const SHADOW_BIAS = -0.0004;
export const SHADOW_NORMAL_BIAS = 0.02;

/**
 * Configure the directional (sun) light's shadow camera once at setup: widen the
 * default ±5 frustum to {@link SHADOW_HALF_EXTENT} around the player, set the map size,
 * enable soft (PCF) shadows on the renderer, and bias away acne. Pure config — it does
 * NOT add anything to the scene; the caller adds `light.target` to the scene and
 * {@link aimSunLight} repositions the frustum each frame.
 */
export function configureSunShadow(
  light: THREE.DirectionalLight,
  renderer: Pick<THREE.WebGLRenderer, 'shadowMap'>
): void {
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const cam = light.shadow.camera;
  cam.left = -SHADOW_HALF_EXTENT;
  cam.right = SHADOW_HALF_EXTENT;
  cam.top = SHADOW_HALF_EXTENT;
  cam.bottom = -SHADOW_HALF_EXTENT;
  cam.near = SHADOW_NEAR;
  cam.far = SHADOW_FAR;
  cam.updateProjectionMatrix();
  light.shadow.bias = SHADOW_BIAS;
  light.shadow.normalBias = SHADOW_NORMAL_BIAS;
}

/**
 * Re-aim the sun light + its target so the shadow frustum follows the player while the
 * sun *direction* is preserved. Sets `light.position = player + sunDir * distance` and
 * `light.target.position = player`, so the light→target vector (which Three.js uses as
 * the shadow direction) stays exactly `sunDir * distance`.
 *
 * @param sunDir   unit sun direction (from `Sky.getSunDirection`)
 * @param distance how far along `sunDir` to place the light (from `Sky.getSunDistance`)
 * @param x,y,z    the interpolated render position to centre the frustum on
 *
 * Call each render frame AFTER the render pose is set and BEFORE `renderer.render`, using
 * the interpolated position so the shadow tracks the visible snowman, not the raw physics
 * position.
 */
export function aimSunLight(
  light: THREE.DirectionalLight,
  sunDir: THREE.Vector3,
  distance: number,
  x: number,
  y: number,
  z: number
): void {
  light.position.set(x + sunDir.x * distance, y + sunDir.y * distance, z + sunDir.z * distance);
  light.target.position.set(x, y, z);
  light.target.updateMatrixWorld();
}
