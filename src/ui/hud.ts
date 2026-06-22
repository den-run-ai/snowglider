// In-game HUD: the Game Stats panel (collapse/swipe), the live run timer, and
// the per-frame speed / altitude / slope / technique readouts. Extracted from
// snowglider.ts; the orchestrator passes the run state in as parameters so this
// module stays decoupled from the coordinator's bindings.

import type { PlayerPos, UpdateResult } from '../snowman.js';
import { setupCollapsiblePanel } from './collapsible-panel.js';

// --- Real-world units for the Game Stats readout ---
// The simulation runs in metric world units where 1 unit ≈ 1 metre (the same
// scale the course HUD already uses for its "… m to finish" distance) and
// velocities are in metres per second (gravity is modelled at 9.8 m/s²). We
// surface both metric and imperial so the numbers read like real skiing stats.
const MPS_TO_KMH = 3.6;          // metres/second → km/h
const MPS_TO_MPH = 2.236936;     // metres/second → mph
const M_TO_FT = 3.280839895;     // metres → feet
// Display anchor so altitude reads like a real alpine elevation and never goes
// negative on the lower half of the run (terrain drops below the y=0 plane far
// downhill). Cosmetic only — it shifts the readout, not the physics.
const BASE_ELEVATION_M = 1500;
const RAD_TO_DEG = 180 / Math.PI;
// Slope steepness tiers, in gradient magnitude (rise/run = tan θ), shown with the
// familiar ski-trail difficulty marks (● green / ■ blue / ◆ black diamond).
// Difficulty is relative to this run (the skiable line sits around 15–40°, median
// ~24°, which is steep in absolute terms), and the boundaries double as the
// snowplow's "can I stop here?" cue — the wedge can fully stop you up to the black
// line and only checks speed beyond it (PHYSICS.md §3.4, issue #54).
const SLOPE_MODERATE = 0.32;     // ≈18° / 32% — green (●) → blue (■)
const SLOPE_STEEP = 0.58;        // ≈30° / 58% — blue (■) → black diamond (◆)
// The raw per-frame gradient is noisy (high-frequency terrain detail makes it jump
// several degrees frame-to-frame as the snowman moves), which made the readout — and
// its difficulty tier — flicker. Smooth the *display* value with an exponential
// moving average so it reads steadily; the physics is untouched (it uses its own raw
// per-frame gradient). `null` until the first sample seeds it; reset on a new run.
const SLOPE_SMOOTH = 0.12;       // EMA weight on each new sample (~0.4s settle @60fps)
const SLOPE_TIER_HYST = 0.03;    // deadband around each tier edge so the label/colour
                                 // doesn't dither when the pitch hovers on a boundary
const SLOPE_TIERS = [
  { mark: '●', name: 'Green', color: '#4CAF50' },
  { mark: '■', name: 'Blue', color: '#4FC3F7' },
  { mark: '◆', name: 'Black', color: '#FFFFFF' }, // white: a true-black glyph is invisible on the dark panel
];
const SLOPE_EDGES = [SLOPE_MODERATE, SLOPE_STEEP]; // green|blue edge, blue|black edge
let smoothedSlope: number | null = null;
let slopeTierIdx = 0;

// Format a run time for the Game Stats panel. One decimal is plenty of
// precision for the live readout, and keeps the values consistent wherever the
// panel's time elements are written.
export function formatStatTime(seconds: number): string {
  return seconds !== Infinity ? `${seconds.toFixed(1)}s` : '--';
}

// Wire up the Game Stats panel collapse/swipe behavior.
export function initializeGameStats(): void {
  // Re-seed the slope EMA + tier so a new run doesn't drift in from the last run.
  smoothedSlope = null;
  slopeTierIdx = 0;
  // Game stats panel collapse/swipe behavior (shared with the Controls panel).
  setupCollapsiblePanel({
    name: 'game stats',
    containerId: 'gameStatsContainer',
    toggleButtonId: 'toggleStats',
    headerId: 'gameStatsHeader',
  });
}

// Wire up the Game Controls panel collapse/swipe behavior. Resets stale listeners
// and auto-collapses on small screens — this is invoked more than once
// (DOMContentLoaded + initializeGameWithAudio).
export function initializeControlsToggle(): void {
  setupCollapsiblePanel({
    name: 'controls',
    containerId: 'controlsInfo',
    toggleButtonId: 'toggleControls',
    headerId: 'controlsHeader',
    resetListeners: true,
    autoCollapseOnSmallScreens: true,
  });
}

// Per-frame stats readout: color-coded speed, altitude, terrain slope, and the
// ground / jump / ski-technique indicator. `slopeRatio` is the terrain gradient
// magnitude under the player (rise/run = tan θ), supplied by the run loop.
export function updateStatsHud(result: UpdateResult, pos: PlayerPos, isInAir: boolean, slopeRatio: number): void {
  // Convert the metric world speed into real skiing units (km/h and mph).
  const speedMps = result.currentSpeed;
  const speedText = `${Math.round(speedMps * MPS_TO_KMH)} km/h (${Math.round(speedMps * MPS_TO_MPH)} mph)`;
  let speedColor = '#FFFFFF'; // Default white

  // Color code speed (green for slow, yellow for medium, red for fast)
  if (result.currentSpeed > 20) {
    speedColor = '#FF5252'; // Red for fast
  } else if (result.currentSpeed > 12) {
    speedColor = '#FFD700'; // Yellow for medium
  } else if (result.currentSpeed > 5) {
    speedColor = '#4CAF50'; // Green for good speed
  }

  // Update individual stat elements
  const speedElement = document.getElementById('speedValue');
  if (speedElement) {
    speedElement.textContent = speedText;
    speedElement.style.color = speedColor;
  }

  // Altitude (height above the run's base elevation) in metres and feet.
  const altitudeElement = document.getElementById('altitudeValue');
  if (altitudeElement) {
    const altitudeM = BASE_ELEVATION_M + pos.y;
    altitudeElement.textContent = `${Math.round(altitudeM)} m (${Math.round(altitudeM * M_TO_FT)} ft)`;
  }

  // Slope / incline of the terrain under the player, in degrees and percent grade
  // (rise/run × 100), tagged with the ski-trail difficulty mark for that pitch:
  // ● green (gentle), ■ blue (moderate), ◆ black diamond (steep). The value is an
  // EMA of the noisy per-frame gradient, and the difficulty tier only changes once
  // the smoothed pitch is past an edge by SLOPE_TIER_HYST, so neither flickers.
  const slopeElement = document.getElementById('slopeValue');
  if (slopeElement) {
    smoothedSlope = smoothedSlope === null
      ? slopeRatio
      : smoothedSlope + (slopeRatio - smoothedSlope) * SLOPE_SMOOTH;
    const slope = smoothedSlope;
    // Hysteresis: step up only when clearly above the current band's top edge, and
    // down only when clearly below its bottom edge (one step per frame; the EMA
    // never jumps a whole band in a frame).
    if (slopeTierIdx < SLOPE_EDGES.length && slope > SLOPE_EDGES[slopeTierIdx] + SLOPE_TIER_HYST) {
      slopeTierIdx++;
    } else if (slopeTierIdx > 0 && slope < SLOPE_EDGES[slopeTierIdx - 1] - SLOPE_TIER_HYST) {
      slopeTierIdx--;
    }
    const tier = SLOPE_TIERS[slopeTierIdx];
    const slopeDeg = Math.round(Math.atan(slope) * RAD_TO_DEG);
    const slopePct = Math.round(slope * 100);
    slopeElement.textContent = `${slopeDeg}° (${slopePct}%) ${tier.mark} ${tier.name}`;
    slopeElement.style.color = tier.color;
  }

  const groundElement = document.getElementById('groundStatus');
  if (groundElement) {
    if (isInAir) {
      groundElement.innerHTML = '🚀 JUMP!';
      groundElement.style.color = '#00FFFF';
    } else {
      // Reflect the active ski technique so skill is legible in the HUD.
      const techMap: Record<string, { txt: string; color: string }> = {
        parallel: { txt: '🎿 Parallel (skid)', color: '#ffeaa7' },
        carve:    { txt: '🎿 Carving',        color: '#55efc4' },
        hop:      { txt: '🦘 Hop turn',       color: '#fab1a0' },
        skid:     { txt: '💨 Skidding',       color: '#ffeaa7' },
        snowplow: { txt: '🍕 Snowplow', color: '#74b9ff' },
        tuck:     { txt: '🏎️ Tuck',     color: '#ff7675' },
        glide:    { txt: '⛷️ Ground',   color: '#AAFFAA' }
      };
      const t = techMap[result.technique] || techMap.glide;
      groundElement.innerHTML = t.txt;
      groundElement.style.color = t.color;
    }
  }
}

// Update the live run timer during gameplay.
export function updateTimerDisplay(gameActive: boolean, startTime: number): void {
  if (gameActive) {
    const currentTime = (performance.now() - startTime) / 1000;

    // Update the current time element in game stats
    const currentTimeElement = document.getElementById('currentTime');
    if (currentTimeElement) {
      currentTimeElement.textContent = formatStatTime(currentTime);
    }
  }
}
