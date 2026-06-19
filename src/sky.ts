// Sky rendering for SnowGlider.
//
// The original scene used a single flat clear colour
// (`scene.background = new THREE.Color(0x87CEEB)`) and no fog, so the procedural
// terrain hard-cut against a featureless blue at the camera far plane. This
// module replaces that with a graduated sky and matching distance fog so the
// mountain reads with depth and a horizon instead of a flat wall of blue
// (issue #2 — "visible sky").
//
// Tier 1: a vertical-gradient sky dome plus linear distance fog tinted to the
// horizon colour (`applyGradientSky`), so distant terrain fades into the sky
// rather than popping at the far plane. Kept as a lightweight fallback.
//
// Tier 2: the Preetham atmospheric-scattering model plus a sun disc
// (`applyAtmosphericSky`) — a physically-motivated graduated sky whose sun is
// aligned with the scene's directional light so the sky and the cast shadows
// agree. This is what the game uses; see the `SKY_SHADER` note for the legacy
// colour-pipeline caveat.
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

// --- Tier 2: Preetham atmospheric sky -------------------------------------
//
// Ported from three.js's `examples/jsm/objects/Sky.js` (the de-facto Preetham
// daylight model). It is inlined here rather than imported from
// `three/addons/*` deliberately: the verbatim-copied `dist/src/*.js` browser
// `?test=` pages only rewrite/copy the bare-`three` build graph, so a
// `three/addons/objects/Sky.js` specifier would 404 on the deployed test pages.
// This module imports only named symbols from bare `three`, so it resolves
// identically across the Vite bundle, the raw-source import map, and the dist
// test pages.
//
// Colour-pipeline caveat: the project runs the legacy pipeline
// (`ColorManagement.enabled = false`, linear output, no tone mapping), which is
// the era this shader was originally tuned for, so it renders a recognisable
// sky without ACES. The `#include <tonemapping_fragment>` / `<colorspace_fragment>`
// chunks are kept for forward-compat but are no-ops under the current renderer
// settings; an explicit `exposure` uniform stands in for the
// `renderer.toneMappingExposure` knob the addon would otherwise use.

// Scattering parameters (tunable). With no tone mapping (legacy pipeline) the
// shader's HDR output would clip the green/blue channels to white across most of
// the sky at the addon's usual exposure, so `SKY_EXPOSURE` is set low to keep
// the whole dome in-gamut: this yields zenith ≈ (88,136,196), mid-sky ≈
// (122,182,237) and a pale, hazy horizon ≈ (209,229,235) — a cheerful clear-sky
// blue that brackets the old flat 0x87CEEB without any channel clipping. The
// numbers were chosen by evaluating the fragment math directly; eyeball and
// adjust if the on-device look differs.
const SKY_TURBIDITY = 8.0;
const SKY_RAYLEIGH = 3.0;
const SKY_MIE_COEFFICIENT = 0.005;
const SKY_MIE_DIRECTIONAL_G = 0.8;
const SKY_EXPOSURE = 0.35;

// Distance fog tuned to the atmospheric horizon colour (a pale, hazy blue) so
// terrain fades into the sky seamlessly. Same near/far envelope as the gradient
// sky so the gameplay area stays crisp.
const ATMOSPHERE_FOG_COLOR = 0xd1e5eb;

const SKY_SHADER = {
  uniforms: {
    turbidity: { value: SKY_TURBIDITY },
    rayleigh: { value: SKY_RAYLEIGH },
    mieCoefficient: { value: SKY_MIE_COEFFICIENT },
    mieDirectionalG: { value: SKY_MIE_DIRECTIONAL_G },
    exposure: { value: SKY_EXPOSURE },
    sunPosition: { value: new THREE.Vector3() },
    up: { value: new THREE.Vector3(0, 1, 0) }
  },
  vertexShader: /* glsl */`
    uniform vec3 sunPosition;
    uniform float rayleigh;
    uniform float turbidity;
    uniform float mieCoefficient;
    uniform vec3 up;

    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying float vSunfade;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;

    const float e = 2.71828182845904523536028747135266249775724709369995957;
    const float pi = 3.141592653589793238462643383279502884197169;

    const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
    const float v = 4.0;
    const vec3 K = vec3( 0.686, 0.678, 0.666 );
    const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

    const float cutoffAngle = 1.6110731556870734;
    const float steepness = 1.5;
    const float EE = 1000.0;

    float sunIntensity( float zenithAngleCos ) {
      zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
      return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
    }

    vec3 totalMie( float T ) {
      float c = ( 0.2 * T ) * 10E-18;
      return 0.434 * c * MieConst;
    }

    void main() {
      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;

      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      gl_Position.z = gl_Position.w; // pin to the far plane (skybox behaviour)

      vSunDirection = normalize( sunPosition );
      vSunE = sunIntensity( dot( vSunDirection, up ) );
      vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );

      float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );
      vBetaR = totalRayleigh * rayleighCoefficient;
      vBetaM = totalMie( turbidity ) * mieCoefficient;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying float vSunfade;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;

    uniform float mieDirectionalG;
    uniform float exposure;
    uniform vec3 up;

    const float pi = 3.141592653589793238462643383279502884197169;

    const float rayleighZenithLength = 8.4E3;
    const float mieZenithLength = 1.25E3;
    const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

    const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
    const float ONE_OVER_FOURPI = 0.07957747154594767;

    float rayleighPhase( float cosTheta ) {
      return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
    }

    float hgPhase( float cosTheta, float g ) {
      float g2 = pow( g, 2.0 );
      float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
      return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
    }

    void main() {
      vec3 direction = normalize( vWorldPosition - cameraPosition );

      float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );
      float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
      float sR = rayleighZenithLength * inverse;
      float sM = mieZenithLength * inverse;

      vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

      float cosTheta = dot( direction, vSunDirection );

      float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
      vec3 betaRTheta = vBetaR * rPhase;

      float mPhase = hgPhase( cosTheta, mieDirectionalG );
      vec3 betaMTheta = vBetaM * mPhase;

      vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
      Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 ) );

      vec3 L0 = vec3( 0.1 ) * Fex;
      float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );
      L0 += ( vSunE * 19000.0 * Fex ) * sundisk;

      vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
      vec3 retColor = pow( texColor, vec3( 1.0 / ( 1.2 + ( 1.2 * vSunfade ) ) ) );

      gl_FragColor = vec4( retColor * exposure, 1.0 );

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
};

function createAtmosphericSky(sunDirection: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    name: 'AtmosphericSky',
    uniforms: THREE.UniformsUtils.clone(SKY_SHADER.uniforms),
    vertexShader: SKY_SHADER.vertexShader,
    fragmentShader: SKY_SHADER.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false
  });
  // Direction only — the shader normalises it; magnitude does not matter.
  material.uniforms.sunPosition.value.copy(sunDirection).normalize();

  const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  sky.scale.setScalar(DOME_SCALE);
  sky.frustumCulled = false;
  sky.name = 'AtmosphericSky';
  return sky;
}

/**
 * Apply the Tier 2 Preetham atmospheric sky (with a sun) and matching distance
 * fog. `sunDirection` should be the scene's directional-light direction so the
 * visible sun and the cast shadows agree (magnitude is ignored).
 */
function applyAtmosphericSky(scene: THREE.Scene, sunDirection: THREE.Vector3): void {
  scene.background = new THREE.Color(ATMOSPHERE_FOG_COLOR);
  scene.fog = new THREE.Fog(ATMOSPHERE_FOG_COLOR, FOG_NEAR, FOG_FAR);
  scene.add(createAtmosphericSky(sunDirection));
}

export const Sky = {
  applyGradientSky,
  applyAtmosphericSky,
  ZENITH_COLOR,
  HORIZON_COLOR,
  ATMOSPHERE_FOG_COLOR,
  FOG_NEAR,
  FOG_FAR
};
