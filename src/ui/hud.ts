// In-game HUD: the Game Stats panel (best time + collapse/swipe), the live run
// timer, and the per-frame speed / position / technique readouts. Extracted from
// snowglider.ts; the orchestrator passes the run state in as parameters so this
// module stays decoupled from the coordinator's bindings.

import type { PlayerPos, UpdateResult } from '../snowman.js';
import { setupCollapsiblePanel } from './collapsible-panel.js';

// Seed the best-time readout and wire up the Game Stats panel collapse/swipe.
export function initializeGameStats(bestTime: number): void {
  const bestTimeElement = document.getElementById('bestTimeValue');
  if (bestTimeElement) {
    bestTimeElement.textContent = bestTime !== Infinity ? `${bestTime.toFixed(2)}s` : '--';
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

// Per-frame stats readout: color-coded speed, x/z position, and the ground /
// jump / ski-technique indicator.
export function updateStatsHud(result: UpdateResult, pos: PlayerPos, isInAir: boolean): void {
  // Format speed with color based on value
  const speed = result.currentSpeed.toFixed(1);
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
    speedElement.textContent = speed;
    speedElement.style.color = speedColor;
  }

  const positionElement = document.getElementById('positionValue');
  if (positionElement) {
    positionElement.textContent = `${pos.x.toFixed(0)},${pos.z.toFixed(0)}`;
  }

  const groundElement = document.getElementById('groundStatus');
  if (groundElement) {
    if (isInAir) {
      groundElement.innerHTML = '🚀 JUMP!';
      groundElement.style.color = '#00FFFF';
    } else {
      // Reflect the active ski technique so skill is legible in the HUD.
      const techMap: Record<string, { txt: string; color: string }> = {
        carve:    { txt: '🎿 Carving',  color: '#55efc4' },
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
      currentTimeElement.textContent = `${currentTime.toFixed(2)}s`;
    }

    // Keep best time updated
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.textContent = bestTime !== Infinity ? `${bestTime.toFixed(2)}s` : '--';
    }
  }
}
