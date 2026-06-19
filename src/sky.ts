// Sky rendering for SnowGlider.
//
// The original scene used a single flat clear colour
// (`scene.background = new THREE.Color(0x87CEEB)`) and no fog, so the procedural
// terrain hard-cut against a featureless blue at the camera far plane. This
// module replaces that with a graduated sky and matching distance fog so the
// mountain reads with depth and a horizon instead of a flat wall of blue
// (issue #2 — "visible sky").
//
// Tier 1 (this commit): a vertical-gradient sky dome plus linear distance fog
// tinted to the horizon colour, so distant terrain fades into the sky rather
// than popping at the far plane. Tier 2 layers the Preetham atmospheric model
// and a sun on top — see `applyAtmosphericSky` once it lands.
//
// Implementation notes:
// - The dome is a large box with `BackSide` + `depthWrite: false`, and the
//   vertex shader pins it to the far plane (`gl_Position.z = gl_Position.w`).
//   Combined with three.js's default `LessEqualDepth` test that makes it behave
//   as a skybox: it fills every pixel not covered by scene geometry regardless
//   of draw order, and never clips against the camera far plane (so the box
//   scale only has to enclose the camera, not fit inside `far`).
// - The gradient is evaluated from the per-pixel view direction
//   (`worldPosition - cameraPosition`), so it tracks camera orientation
//   correctly as the chase camera pitches.
// - The dome material intentionally has no fog: it *is* the horizon. Scene
//   geometry (terrain/trees/rocks, all `fog: true` by default) fogs toward the
//   horizon colour so terrain and sky meet seamlessly.

import * as THREE from 'three';

// Gradient endpoints. Colours are consumed under the project's legacy colour
// pipeline (`ColorManagement.enabled = false`, linear output), matching how the
// rest of the scene's colours are authored.
const ZENITH_COLOR = 0x4696e1;   // deeper blue overhead
const HORIZON_COLOR = 0xc8e1f5;  // pale, hazy blue near the horizon

// Linear distance fog. The terrain plane spans z ∈ [-200, 200] and the run is
// ~180 units long, so keep the gameplay area (well within FOG_NEAR) crisp and
// only fade genuinely distant terrain / the far peak.
const FOG_NEAR = 140;
const FOG_FAR = 750;

// Box half-extent only has to enclose the camera's travel; the far-plane pin
// (see above) does the rest.
const DOME_SCALE = 10000;

function createGradientDome(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    name: 'GradientSky',
    uniforms: {
      topColor: { value: new THREE.Color(ZENITH_COLOR) },
      bottomColor: { value: new THREE.Color(HORIZON_COLOR) },
      offset: { value: 0.0 },
      exponent: { value: 0.6 }
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // pin to the far plane (skybox behaviour)
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        vec3 direction = normalize(vWorldPosition - cameraPosition);
        float h = max(direction.y + offset, 0.0);
        float t = clamp(pow(h, exponent), 0.0, 1.0);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false
  });

  const dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  dome.scale.setScalar(DOME_SCALE);
  dome.frustumCulled = false; // huge bounds; keep it from ever being culled
  dome.name = 'GradientSky';
  return dome;
}

/**
 * Apply the Tier 1 gradient sky dome and matching distance fog to a scene.
 * Also sets `scene.background` to the horizon colour as a cheap fallback for any
 * frame before the dome draws.
 */
function applyGradientSky(scene: THREE.Scene): void {
  scene.background = new THREE.Color(HORIZON_COLOR);
  scene.fog = new THREE.Fog(HORIZON_COLOR, FOG_NEAR, FOG_FAR);
  scene.add(createGradientDome());
}

export const Sky = {
  applyGradientSky,
  ZENITH_COLOR,
  HORIZON_COLOR,
  FOG_NEAR,
  FOG_FAR
};
