// effects.ts - Drama and "juice" effects for SnowGlider
//
// Two responsibilities:
//   1. Avalanche telegraphing: a warning banner, a "distance behind you" danger meter,
//      and a red vignette that intensifies as the slide closes in — plus camera shake
//      tied to proximity, so a threat from behind is felt and not just discovered.
//   2. General game feel: speed-based field-of-view (widens at speed) and a shared
//      camera-shake channel that other systems (e.g. hard landings) can poke.
//
// The camera is never modified directly inside camera.js. Instead the animation loop
// asks this module for a per-frame shake offset, applies it for the render, and reverts
// it, so the camera manager's own smoothing is never fed its own shake.
//
// Phase 2.6 (issue #84): converted off the classic global model. `EffectsModule`
// is now `export`ed instead of being a bare script global. This module uses no
// three.js (it only pokes a camera object handed to it), so there is no
// `import * as THREE`. It is loaded into the page through the bundle entry
// (src/main.js) and imported directly by snowglider.js.
//
// Phase 3.1 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file) and the previously inferred shapes are now real
// `interface` declarations (the lazily-built UI handles, the per-frame shake
// offset, and the minimal camera surface `tickCamera` pokes). Behaviour is
// unchanged — every edit is type-only/erasable, so esbuild (Vite) and Node's
// native type-stripping both run it exactly as before.

/** Per-frame camera shake offset returned by {@link EffectsModule.tickCamera}. */
export interface ShakeOffset {
  x: number;
  y: number;
  z: number;
}

/**
 * Minimal camera surface `tickCamera` reads/writes. Satisfied by a real
 * `THREE.PerspectiveCamera` (the live game) and by the plain object the headless
 * DOM smoke test hands in.
 */
export interface ShakeCamera {
  fov: number;
  updateProjectionMatrix(): void;
  position: { x: number; y: number; z: number };
}

/** Lazily-built avalanche-warning DOM overlays. */
interface EffectsUI {
  vignette: HTMLDivElement;
  banner: HTMLDivElement;
  meterWrap: HTMLDivElement;
  meterFill: HTMLDivElement;
  meterLabelR: HTMLSpanElement;
}

export const EffectsModule = (function () {
  'use strict';

  const BASE_FOV = 75;
  const MAX_FOV = 88;            // at high speed
  const FOV_SPEED_REF = 28;      // speed (units/s) that maps to MAX_FOV
  const WARN_NEAR = 9;           // distance (units) considered "very close"
  const WARN_FAR = 70;           // distance at/above which the meter reads empty

  const reduceMotion = typeof window !== 'undefined' &&
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let ui: EffectsUI | null = null;
  let shake = 0;        // current shake intensity (decays over time)
  let proximityShake = 0; // sustained shake from avalanche proximity
  let currentFov = BASE_FOV;

  function buildUI() {
    if (ui) return;

    // Red vignette (full-screen radial gradient overlay)
    const vignette = document.createElement('div');
    Object.assign(vignette.style, {
      position: 'fixed', inset: '0', zIndex: '850', pointerEvents: 'none',
      opacity: '0', transition: reduceMotion ? 'none' : 'opacity 0.15s linear',
      background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(200,30,30,0.55) 100%)'
    });
    document.body.appendChild(vignette);

    // Warning banner
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed', top: '110px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '902', padding: '10px 22px', borderRadius: '10px',
      background: 'rgba(200,30,30,0.85)', color: '#fff', fontFamily: 'Arial, sans-serif',
      fontSize: '20px', fontWeight: '800', letterSpacing: '0.5px', textAlign: 'center',
      display: 'none', pointerEvents: 'none', boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
      textShadow: '0 1px 3px rgba(0,0,0,0.7)'
    });
    banner.textContent = '⚠ AVALANCHE — GO!';
    document.body.appendChild(banner);

    // Danger meter (label + bar) showing how close the slide is behind you
    const meterWrap = document.createElement('div');
    Object.assign(meterWrap.style, {
      position: 'fixed', top: '152px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '902', width: 'min(300px, 80vw)', display: 'none',
      fontFamily: 'Arial, sans-serif', textShadow: '0 1px 3px rgba(0,0,0,0.8)'
    });
    const meterLabel = document.createElement('div');
    Object.assign(meterLabel.style, {
      fontSize: '12px', color: '#fff', fontWeight: '700', marginBottom: '3px',
      display: 'flex', justifyContent: 'space-between'
    });
    const meterLabelL = document.createElement('span');
    meterLabelL.textContent = 'Avalanche';
    const meterLabelR = document.createElement('span');
    meterLabelR.textContent = '';
    meterLabel.appendChild(meterLabelL);
    meterLabel.appendChild(meterLabelR);

    const meterTrack = document.createElement('div');
    Object.assign(meterTrack.style, {
      width: '100%', height: '10px', borderRadius: '6px',
      background: 'rgba(0,0,0,0.4)', overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.25)'
    });
    const meterFill = document.createElement('div');
    Object.assign(meterFill.style, {
      width: '0%', height: '100%', borderRadius: '6px',
      background: 'linear-gradient(90deg,#fdcb6e,#e17055,#d63031)',
      transition: reduceMotion ? 'none' : 'width 0.12s linear'
    });
    meterTrack.appendChild(meterFill);
    meterWrap.appendChild(meterLabel);
    meterWrap.appendChild(meterTrack);
    document.body.appendChild(meterWrap);

    ui = { vignette, banner, meterWrap, meterFill, meterLabelR };
  }

  function init() {
    buildUI();
    reset();
  }

  // Called each frame with the live avalanche state.
  //   active:   whether the avalanche is currently bearing down
  //   distance: closest boulder distance to the player (units); Infinity if none
  function updateAvalanche(active: boolean, distance: number) {
    if (!ui) return;

    if (!active || !isFinite(distance)) {
      ui.banner.style.display = 'none';
      ui.meterWrap.style.display = 'none';
      ui.vignette.style.opacity = '0';
      proximityShake = 0;
      return;
    }

    ui.banner.style.display = 'block';
    ui.meterWrap.style.display = 'block';

    // Map distance -> danger in [0,1] (closer == higher).
    const danger = Math.max(0, Math.min(1, (WARN_FAR - distance) / (WARN_FAR - WARN_NEAR)));
    ui.meterFill.style.width = `${(danger * 100).toFixed(0)}%`;
    ui.meterLabelR.textContent = `${Math.max(0, distance).toFixed(0)} m behind`;

    // Vignette and shake scale with danger; only really bite when close.
    ui.vignette.style.opacity = (danger * 0.9).toFixed(2);
    proximityShake = reduceMotion ? 0 : danger * danger * 0.6;

    // Pulse the banner copy when it's almost on top of you.
    ui.banner.textContent = distance < WARN_NEAR + 6
      ? '⚠ AVALANCHE RIGHT BEHIND YOU!'
      : '⚠ AVALANCHE — GO!';
  }

  // Other systems can request a one-off shake impulse (e.g. a hard landing).
  function addShake(amount: number) {
    if (reduceMotion) return;
    shake = Math.min(2.5, shake + amount);
  }

  // Per-frame camera treatment. Returns the shake offset that was applied so the
  // caller can revert it after rendering.
  function tickCamera(camera: ShakeCamera, dt: number, speed: number): ShakeOffset {
    // Speed-based FOV (smoothed). A zooming FOV is itself camera motion, so honor
    // prefers-reduced-motion by pinning to the base FOV and skipping the zoom.
    if (reduceMotion) {
      currentFov = BASE_FOV;
    } else {
      const targetFov = BASE_FOV + (MAX_FOV - BASE_FOV) * Math.min(1, Math.max(0, speed / FOV_SPEED_REF));
      currentFov += (targetFov - currentFov) * Math.min(1, dt * 3);
    }
    if (Math.abs(camera.fov - currentFov) > 0.05) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }

    // Decay transient shake
    shake = Math.max(0, shake - dt * 4);
    const intensity = Math.max(shake, proximityShake);
    if (intensity <= 0.0001) return { x: 0, y: 0, z: 0 };

    const offset = {
      x: (Math.random() - 0.5) * intensity,
      y: (Math.random() - 0.5) * intensity,
      z: (Math.random() - 0.5) * intensity * 0.5
    };
    camera.position.x += offset.x;
    camera.position.y += offset.y;
    camera.position.z += offset.z;
    return offset;
  }

  function reset() {
    shake = 0;
    proximityShake = 0;
    currentFov = BASE_FOV;
    if (ui) {
      ui.banner.style.display = 'none';
      ui.meterWrap.style.display = 'none';
      ui.vignette.style.opacity = '0';
    }
  }

  return { init, updateAvalanche, addShake, tickCamera, reset };
})();

// EffectsModule is imported directly by snowglider.js (issue #84).
