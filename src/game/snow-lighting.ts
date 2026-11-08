import * as THREE from 'three';

/** Static snow light rig. Keep diffuse highlights below the linear framebuffer's
 * ceiling so slope normals and powder relief survive instead of clipping white.
 * Sky captures the returned sun as its midday endpoint; the cool fill stays fixed.
 */
export function createSnowLighting(scene: THREE.Scene): THREE.DirectionalLight {
  // Three's diffuse BRDF divides by PI. These coefficients are the effective
  // diffuse budgets in our legacy linear-output pipeline (not display exposure).
  // Directional light must carry enough of the budget to reveal the wind ridges.
  // Broad fill alone makes even a detailed normal map look like a white backdrop.
  scene.add(new THREE.AmbientLight(0xffffff, 0.10 * Math.PI));
  scene.add(new THREE.HemisphereLight(0xdcebfb, 0xbcc7d4, 0.56 * Math.PI));
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.34 * Math.PI);
  sun.position.set(50, 100, 50);
  sun.castShadow = true;
  scene.add(sun);
  return sun;
}
