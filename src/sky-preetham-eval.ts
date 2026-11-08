// sky-preetham-eval.ts — a pure TypeScript port of the Preetham daylight fragment
// math for a SINGLE view direction (completion-plan PR-V3).
//
// WHY: the atmospheric sky dome (src/sky.ts `SKY_SHADER`) renders the real Preetham
// sky per-pixel on the GPU, but the distance FOG that fades terrain into that sky was
// a hand-tuned constant (`ATMOSPHERE_FOG_COLOR`) that lerped to a warm golden constant
// (`GOLDEN_FOG_COLOR_HEX`). Because the sun azimuth is fixed at ~45° while the run
// heads downhill toward -z, the player mostly faces the ANTI-SOLAR horizon — which the
// Preetham model keeps cool — so a warm-fogged terrain met a cool sky band at golden
// hour, recreating the very terrain/sky seam the fog tuning removed at midday.
//
// Evaluating the dome's own fragment math at the view-forward horizon and driving
// `fog.color`/`scene.background` from it makes the fog EXACTLY the colour the dome
// paints where terrain meets it, at every cycle phase — no seam, no second constant to
// keep in sync. This is the same methodology already used to derive `SKY_EXPOSURE`
// ("evaluating the fragment math directly").
//
// FIDELITY: this is a line-for-line port of the `SKY_SHADER` vertex+fragment code in
// sky.ts under the project's LEGACY colour pipeline (`ColorManagement.enabled = false`,
// no tone mapping) — the `#include <tonemapping_fragment>`/`<colorspace_fragment>`
// chunks are no-ops there, so the final colour is `retColor * exposure`, clamped to
// [0,1] the way the 8-bit framebuffer clamps the rendered dome. Keep the two in lockstep:
// any change to the constants here or in `SKY_SHADER` must change the other.
//
// Pure + THREE-free math (plain {x,y,z} vectors in, {r,g,b} out), so it unit-tests in
// plain Node and can be called per-frame (a few hundred flops) or baked into a LUT.

/** Minimal vector shape (THREE.Vector3 satisfies it). */
export interface Vec3Like { x: number; y: number; z: number; }

/** Scattering parameters — mirror the `SKY_SHADER` uniforms in sky.ts. */
export interface PreethamParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  exposure: number;
}

/** Linear RGB (0..1), matching the dome's framebuffer output under the legacy pipeline. */
export interface RGB { r: number; g: number; b: number; }

// --- Constants (verbatim from SKY_SHADER) -----------------------------------
const E = Math.E;
const PI = Math.PI;

const TOTAL_RAYLEIGH: RGB = { r: 5.804542996261093e-6, g: 1.3562911419845635e-5, b: 3.0265902468824876e-5 };
const MIE_CONST: RGB = { r: 1.8399918514433978e14, g: 2.7798023919660528e14, b: 4.0790479543861094e14 };

const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;

const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const SUN_ANGULAR_DIAMETER_COS = 0.999956676946448443553574619906976478926848692873900859324;

const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

const UP: Vec3Like = { x: 0, y: 1, z: 0 };

// --- Small vector helpers ---------------------------------------------------
function dot(a: Vec3Like, b: Vec3Like): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function normalize(v: Vec3Like): Vec3Like {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// --- Ported shader functions ------------------------------------------------
function sunIntensity(zenithAngleCos: number): number {
  const c = clamp(zenithAngleCos, -1, 1);
  return EE * Math.max(0, 1 - Math.pow(E, -((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}
function totalMie(turbidity: number): RGB {
  const c = (0.2 * turbidity) * 10e-18; // 10E-18 == 1e-17 (GLSL literal)
  return { r: 0.434 * c * MIE_CONST.r, g: 0.434 * c * MIE_CONST.g, b: 0.434 * c * MIE_CONST.b };
}
function rayleighPhase(cosTheta: number): number {
  return THREE_OVER_SIXTEENPI * (1 + Math.pow(cosTheta, 2));
}
function hgPhase(cosTheta: number, g: number): number {
  const g2 = Math.pow(g, 2);
  const inverse = 1 / Math.pow(1 - 2 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1 - g2) * inverse);
}

/**
 * The Preetham dome colour along `viewDir` for a sun at `sunDir`, under the given
 * scattering params — the exact value the `SKY_SHADER` fragment shader writes (minus
 * the no-op tonemap/colorspace chunks), clamped to [0,1] like the 8-bit framebuffer.
 *
 * @param sunDir  sun direction (need not be unit — normalised here, as the shader does)
 * @param viewDir view direction (need not be unit)
 */
export function evalPreethamColor(sunDir: Vec3Like, viewDir: Vec3Like, params: PreethamParams): RGB {
  const { turbidity, rayleigh, mieCoefficient, mieDirectionalG, exposure } = params;

  // --- vertex-stage varyings ---
  const vSunDirection = normalize(sunDir);
  const vSunE = sunIntensity(dot(vSunDirection, UP));
  // With a UNIT sun direction sunPosition.y is small (sin elevation), so
  // exp(y/450000) ≈ 1 and vSunfade clamps to 1 — matching the live shader, which is
  // fed the same normalised direction.
  const vSunfade = 1 - clamp(1 - Math.exp(vSunDirection.y / 450000), 0, 1);
  const rayleighCoefficient = rayleigh - (1 * (1 - vSunfade));
  const vBetaR: RGB = {
    r: TOTAL_RAYLEIGH.r * rayleighCoefficient,
    g: TOTAL_RAYLEIGH.g * rayleighCoefficient,
    b: TOTAL_RAYLEIGH.b * rayleighCoefficient,
  };
  const mie = totalMie(turbidity);
  const vBetaM: RGB = { r: mie.r * mieCoefficient, g: mie.g * mieCoefficient, b: mie.b * mieCoefficient };

  // --- fragment stage ---
  const direction = normalize(viewDir);
  const zenithAngle = Math.acos(Math.max(0, dot(UP, direction)));
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;

  const Fex: RGB = {
    r: Math.exp(-(vBetaR.r * sR + vBetaM.r * sM)),
    g: Math.exp(-(vBetaR.g * sR + vBetaM.g * sM)),
    b: Math.exp(-(vBetaR.b * sR + vBetaM.b * sM)),
  };

  const cosTheta = dot(direction, vSunDirection);
  const rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  const betaRTheta: RGB = { r: vBetaR.r * rPhase, g: vBetaR.g * rPhase, b: vBetaR.b * rPhase };
  const mPhase = hgPhase(cosTheta, mieDirectionalG);
  const betaMTheta: RGB = { r: vBetaM.r * mPhase, g: vBetaM.g * mPhase, b: vBetaM.b * mPhase };

  // Lin = pow( vSunE * ((betaRTheta+betaMTheta)/(betaR+betaM)) * (1-Fex), 1.5 )
  const denom: RGB = { r: vBetaR.r + vBetaM.r, g: vBetaR.g + vBetaM.g, b: vBetaR.b + vBetaM.b };
  const scatter: RGB = {
    r: (betaRTheta.r + betaMTheta.r) / denom.r,
    g: (betaRTheta.g + betaMTheta.g) / denom.g,
    b: (betaRTheta.b + betaMTheta.b) / denom.b,
  };
  const Lin: RGB = {
    r: Math.pow(vSunE * scatter.r * (1 - Fex.r), 1.5),
    g: Math.pow(vSunE * scatter.g * (1 - Fex.g), 1.5),
    b: Math.pow(vSunE * scatter.b * (1 - Fex.b), 1.5),
  };
  // Lin *= mix(1, pow(vSunE*scatter*Fex, 0.5), clamp(pow(1-dot(up,sun),5),0,1))
  const mixT = clamp(Math.pow(1 - dot(UP, vSunDirection), 5), 0, 1);
  const linScale: RGB = {
    r: Math.pow(vSunE * scatter.r * Fex.r, 0.5),
    g: Math.pow(vSunE * scatter.g * Fex.g, 0.5),
    b: Math.pow(vSunE * scatter.b * Fex.b, 0.5),
  };
  Lin.r *= 1 * (1 - mixT) + linScale.r * mixT;
  Lin.g *= 1 * (1 - mixT) + linScale.g * mixT;
  Lin.b *= 1 * (1 - mixT) + linScale.b * mixT;

  // L0 = 0.1*Fex + sun disc
  const sundisk = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, cosTheta);
  const L0: RGB = {
    r: 0.1 * Fex.r + vSunE * 19000 * Fex.r * sundisk,
    g: 0.1 * Fex.g + vSunE * 19000 * Fex.g * sundisk,
    b: 0.1 * Fex.b + vSunE * 19000 * Fex.b * sundisk,
  };

  const texColor: RGB = {
    r: (Lin.r + L0.r) * 0.04 + 0.0,
    g: (Lin.g + L0.g) * 0.04 + 0.0003,
    b: (Lin.b + L0.b) * 0.04 + 0.00075,
  };
  const gamma = 1 / (1.2 + 1.2 * vSunfade);
  const retColor: RGB = {
    r: Math.pow(texColor.r, gamma),
    g: Math.pow(texColor.g, gamma),
    b: Math.pow(texColor.b, gamma),
  };

  // gl_FragColor = retColor * exposure, clamped to [0,1] like the framebuffer.
  return {
    r: clamp(retColor.r * exposure, 0, 1),
    g: clamp(retColor.g * exposure, 0, 1),
    b: clamp(retColor.b * exposure, 0, 1),
  };
}

/**
 * View-forward horizon direction the fog is sampled along: the run heads downhill
 * toward -z, so the player mostly faces the -z (anti-solar) horizon. y is exactly 0 —
 * the horizon line — where terrain meets the dome.
 */
export const VIEW_FORWARD_HORIZON: Vec3Like = { x: 0, y: 0, z: -1 };
