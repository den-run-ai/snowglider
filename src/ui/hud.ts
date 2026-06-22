// In-game HUD: the Game Stats panel (best time + collapse/swipe), the live run
// timer, and the per-frame speed / position / technique readouts. Extracted from
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

// Format a run time for the Game Stats panel. One decimal is plenty of
// precision for the live readout, and keeps the values consistent wherever the
// panel's time elements are written.
export function formatStatTime(seconds: number): string {
  return seconds !== Infinity ? `${seconds.toFixed(1)}s` : '--';
}

// Seed the best-time readout and wire up the Game Stats panel collapse/swipe.
export function initializeGameStats(bestTime: number): void {
  const bestTimeElement = document.getElementById('bestTimeValue');
  if (bestTimeElement) {
    bestTimeElement.textContent = formatStatTime(bestTime);
  }

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

// Per-frame stats readout: color-coded speed, altitude, and the ground /
// jump / ski-technique indicator.
export function updateStatsHud(result: UpdateResult, pos: PlayerPos, isInAir: boolean): void {
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

  const groundElement = document.getElementById('groundStatus');
  if (groundElement) {
    if (isInAir) {
      groundElement.innerHTML = '🚀 JUMP!';
      groundElement.style.color = '#00FFFF';
    } else {
      // Reflect the active ski technique so skill is legible in the HUD.
      const techMap: Record<string, { txt: string; color: string }> = {
        parallel: { txt: '🎿 Parallel', color: '#00d2ff' },
        carve:    { txt: '🎿 Carving',  color: '#55efc4' },
        hop:      { txt: '🦘 Hop turn', color: '#fab1a0' },
        skid:     { txt: '💨 Skidding', color: '#ffeaa7' },
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

// Update the live timer (and keep the best-time value fresh) during gameplay.
export function updateTimerDisplay(gameActive: boolean, startTime: number, bestTime: number): void {
  if (gameActive) {
    const currentTime = (performance.now() - startTime) / 1000;

    // Update the current time element in game stats
    const currentTimeElement = document.getElementById('currentTime');
    if (currentTimeElement) {
      currentTimeElement.textContent = formatStatTime(currentTime);
    }

    // Keep best time updated
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.textContent = formatStatTime(bestTime);
    }
  }
}
