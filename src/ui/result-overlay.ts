// Game-over / finish result overlay: score-time validation, the best-time readout,
// the leaderboard insertion, the optional login prompt, and the course result panel
// (CourseModule.onFinish). Extracted from snowglider.ts; the coordinator injects the
// run state and the overlay DOM nodes so this module owns the behavior, not the
// element ownership (those nodes move to game/scene-setup.ts in a later step).

import { AudioModule } from '../audio.js';
import { Sfx } from '../sfx.js';
import { Diag } from '../diagnostics.js';
import { CourseModule } from '../course.js';
import { EffectsModule } from '../effects.js';
// Plausibility floor + cap from the single source (see score-limits.ts) — used as the
// local fallback when ScoresModule isn't present, so the client finish gate matches the
// scores module and the Firestore rules (issue #229, PR C).
import { MIN_VALID_SCORE_TIME, MAX_VALID_SCORE_TIME } from '../score-limits.js';
// Per-tier best-time key + the active tier (Blue == the original key, unchanged).
import { DEFAULT_DIFFICULTY, getDifficultyConfig, localBestTimeKey, readStoredDifficulty, type Difficulty } from '../difficulty.js';

export function isValidScoreTime(time: number): boolean {
  if (window.ScoresModule && typeof window.ScoresModule.isValidScoreTime === 'function') {
    return window.ScoresModule.isValidScoreTime(time);
  }
  return typeof time === 'number' &&
    Number.isFinite(time) &&
    time >= MIN_VALID_SCORE_TIME &&
    time <= MAX_VALID_SCORE_TIME;
}

// Tier-aware plausibility: a finish/best is valid for a tier if it clears that tier's
// own floor (Blue == 18 s == the global floor, so Blue is unchanged). This matters now
// that Black plays faster and can legitimately finish below Blue's 18 s floor — using
// the global floor there would drop a valid fast Black run's local best/ghost/panel.
export function isPlausibleForTier(time: number, tier: Difficulty = DEFAULT_DIFFICULTY): boolean {
  return typeof time === 'number' && Number.isFinite(time)
    && time >= getDifficultyConfig(tier).minScoreTime
    && time <= MAX_VALID_SCORE_TIME;
}

export function readStoredBestTime(tier: Difficulty = DEFAULT_DIFFICULTY): number {
  const key = localBestTimeKey(tier);
  const storedBestTime = localStorage.getItem(key);
  if (!storedBestTime) {
    return Infinity;
  }

  const parsedBestTime = parseFloat(storedBestTime);
  if (isPlausibleForTier(parsedBestTime, tier)) {
    return parsedBestTime;
  }

  console.warn("Ignoring invalid stored best time:", storedBestTime);
  localStorage.removeItem(key);
  return Infinity;
}

function getSignedInUser() {
  const authModule = window.AuthModule;
  if (!authModule) {
    return null;
  }

  try {
    return authModule.getCurrentUser?.() || authModule.getAuthState?.()?.user || null;
  } catch (error) {
    console.warn("Unable to read auth state:", error);
    return null;
  }
}

function removeLoginPrompt() {
  const loginPrompt = document.getElementById('loginPrompt');
  if (loginPrompt) {
    loginPrompt.remove();
  }
}

// The run-state slice showGameOver reads and mutates (the coordinator's GameState
// satisfies this structurally; mutations flow back to the live object).
export interface ResultOverlayState {
  gameActive: boolean;
  bestTime: number;
  startTime: number;
}

// Overlay DOM the result screen writes into. Owned by the coordinator for now.
export interface ResultOverlayDeps {
  state: ResultOverlayState;
  gameOverOverlay: HTMLElement;
  gameOverDetail: HTMLElement;
  restartButton: HTMLElement;
  bestTimeDisplay: HTMLElement;
  // Optional crash-only side effect (#53): fires the snowman-shatter wipeout on a
  // crash (any non-finish reason), built by the coordinator where the scene/snowman/
  // renderer are in scope. Kept as an injected hook so this UI module stays free of
  // three.js. The overlay itself is unchanged (shown immediately, as before).
  onCrash?: (reason: string) => void;
  // The run's difficulty tier, so the score/best-time/leaderboard go to that tier.
  // Omitted => falls back to the persisted pick (readStoredDifficulty).
  getDifficulty?: () => Difficulty;
}

// Build the showGameOver(reason) handler bound to the injected overlay/state. The
// body is the original snowglider.ts implementation verbatim (deps are destructured
// under the same names it used as module-locals).
export function createShowGameOver(deps: ResultOverlayDeps): (reason: string) => void {
  const { state, gameOverOverlay, gameOverDetail, restartButton, bestTimeDisplay, onCrash, getDifficulty } = deps;
  const FINISH_REASON = "You reached the end of the slope!";

  return function showGameOver(reason: string) {
    // The tier this run was played on; routes the score/best/leaderboard per tier.
    const tier: Difficulty = getDifficulty ? getDifficulty() : readStoredDifficulty();
    // Unranked tiers (Bunny/Black for now) are practice-only: local best/ghost still
    // work, but nothing is submitted to the global board until their floors are measured.
    const tierRanked = getDifficultyConfig(tier).ranked;
    // Allow tests to intercept showGameOver calls
    if (window._testShowGameOverOverride) {
      window._testShowGameOverOverride(reason);
      return;
    }
    state.gameActive = false;

    // Flush the run's diagnostics baseline now that the run has ended. The main loop stops
    // recording once gameActive is false, and a player who finishes/crashes and then leaves
    // never presses Reset/Restart (which is the other path that flushes), so without this a
    // one-and-done session would contribute no session_health sample. De-duped against the
    // eventual reset()/pagehide flush; a no-op under automation.
    try { Diag.endRun(); } catch { /* telemetry must never block the overlay */ }

    // Fire the crash-shatter wipeout on a crash (any non-finish reason): tree/rock
    // hit, off-mountain, fell-off, or avalanche burial. The finish is never a crash.
    // The hook handles its own test-mode gate + reduced-motion; failures here must not
    // block the overlay below.
    if (onCrash && reason !== FINISH_REASON) {
      try { onCrash(reason); } catch (e) { console.warn("Crash effect failed:", (e as Error).message); }
    }

    // Sound effects (#158): silence the continuous skiing/avalanche bed and play the
    // outcome cue — a success chime on a finish, a wipeout whoomph on any crash
    // (tree/rock/fall/avalanche burial). No-op until the SFX engine is unlocked.
    try { Sfx.endRun(reason === FINISH_REASON ? 'finish' : 'crash'); } catch { /* never block the overlay */ }

    // Capture the best time BEFORE the finish branch updates it, so the result
    // screen can report the delta and whether this run set a new record.
    const previousBest = state.bestTime;

    // Measure the finish elapsed ONCE and reuse it for both the best-time/score path
    // and CourseModule.onFinish(). Otherwise a second performance.now() taken after the
    // DOM/localStorage/score work could read later: a sub-millisecond personal best
    // would be saved as a new record while the course screen sees elapsed >= previousBest,
    // skips persisting the new ghost/splits, and shows a time that disagrees with the score.
    const finishTime = (performance.now() - state.startTime) / 1000;
    // Validate against the RUN's tier floor, not the global Blue floor — otherwise a
    // legitimately fast Black finish (below Blue's 18 s) would be treated as invalid and
    // lose its local best/ghost/result panel. Blue's floor == the global floor, unchanged.
    const hasValidFinishTime = isPlausibleForTier(finishTime, tier);

    // Remove game-active class from body for styling
    document.body.classList.remove('game-active');

    gameOverDetail.textContent = reason;
    removeLoginPrompt();

    // TODO: AUDIO DISABLED - Pause audio on game over (will be no-op if disabled)
    if (AudioModule) {
      AudioModule.enableSound(false);
    }

    // Hide or collapse game stats container on game over
    const gameStatsContainer = document.getElementById('gameStatsContainer');
    if (gameStatsContainer) {
      // Option 1: Collapse the stats
      gameStatsContainer.classList.add('collapsed');
      const toggleBtn = document.getElementById('toggleStats');
      if (toggleBtn) {
        toggleBtn.textContent = '▼';
      }

      // Option 2 (alternative): Hide the stats completely
      // gameStatsContainer.style.display = 'none';
    }

    // Only update times if player reached the end successfully
    if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
      const currentTime = finishTime;
      const isNewBestTime = currentTime < state.bestTime;
      const canRecordScore = window.AuthModule && typeof window.AuthModule.recordScore === 'function';

      // Record the score whenever the leaderboard API is available (it handles its own
      // auth + persistence); otherwise fall back to persisting a new local best.
      if (canRecordScore && tierRanked) {
        window.AuthModule.recordScore(currentTime, tier);
      } else if (isNewBestTime) {
        // Unranked tier (or no leaderboard API): keep the local per-tier best only.
        localStorage.setItem(localBestTimeKey(tier), String(currentTime));
      }

      // Show appropriate message based on time
      if (isNewBestTime) {
        state.bestTime = currentTime;
        bestTimeDisplay.textContent = `New Best Time: ${state.bestTime.toFixed(2)}s`;
        bestTimeDisplay.style.color = '#ffff00'; // Highlight new record
      } else {
        bestTimeDisplay.textContent = `Your Time: ${currentTime.toFixed(2)}s (Best: ${state.bestTime.toFixed(2)}s)`;
        bestTimeDisplay.style.color = 'white';
      }

      // Show login prompt if not logged in — only on ranked tiers, where signing in
      // actually saves to the global board (unranked tiers are local practice only).
      if (!getSignedInUser() && tierRanked) {
        const loginPrompt = document.createElement('p');
        loginPrompt.textContent = 'Log in to save your score and see the leaderboard!';
        loginPrompt.style.color = '#4285F4';
        loginPrompt.style.fontStyle = 'italic';
        loginPrompt.style.margin = '10px 0';

        // Insert before restart button
        if (!document.getElementById('loginPrompt')) {
          loginPrompt.id = 'loginPrompt';
          gameOverOverlay.insertBefore(loginPrompt, restartButton);
        }
      }

      // Track successful run in Analytics
      try {
        // Only try to use analytics when properly initialized with modular SDK
        if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
          // Using the direct logEvent function
          window.firebaseModules.logEvent('complete_game', {
            time: currentTime
          });
        }
      } catch (e) {
        console.log("Analytics tracking skipped:", (e as Error).message);
      }
    } else if (reason === "You reached the end of the slope!") {
      console.warn("Finish reached with invalid elapsed time; score not recorded:", finishTime);
      bestTimeDisplay.textContent = state.bestTime !== Infinity ?
        `Best Time: ${state.bestTime.toFixed(2)}s` :
        'No best time yet';
      bestTimeDisplay.style.color = 'white';
    } else {
      // For failures (tree collision, falling, etc.), don't record or update best time
      bestTimeDisplay.textContent = state.bestTime !== Infinity ? `Best Time: ${state.bestTime.toFixed(2)}s` : 'No best time yet';
      bestTimeDisplay.style.color = 'white';

      // Track game over reason in Analytics
      try {
        // Only try to use analytics when properly initialized with modular SDK
        if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
          // Using the direct logEvent function
          window.firebaseModules.logEvent('game_over', {
            reason: reason
          });
        }
      } catch (e) {
        console.log("Analytics tracking skipped:", (e as Error).message);
      }
    }

    // Get leaderboard if user is logged in — ranked tiers only (unranked tiers have
    // no global board to show).
    if (getSignedInUser() && tierRanked) {
      // Get the leaderboard element
      const leaderboardElement = document.getElementById('leaderboard');

      // Add to game over overlay if not already there
      if (leaderboardElement && leaderboardElement.parentNode !== gameOverOverlay) {
        gameOverOverlay.insertBefore(leaderboardElement, restartButton);
        leaderboardElement.style.display = 'block';
      }

      // Display leaderboard for the run's tier
      window.AuthModule.displayLeaderboard(tier);
    }

    // Build the result screen (splits + medal) on a finish; otherwise just clear
    // the live HUD/effects. The panel is inserted above the restart button.
    if (CourseModule) {
      const staleResult = document.getElementById('courseResult');
      if (staleResult && staleResult.parentNode) staleResult.parentNode.removeChild(staleResult);

      if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
        try {
          const panel = CourseModule.onFinish(finishTime, previousBest);
          if (panel) gameOverOverlay.insertBefore(panel, restartButton);
        } catch (e) {
          console.warn("Result screen failed:", (e as Error).message);
        }
      } else {
        CourseModule.hideHud();
      }
    }
    if (EffectsModule) EffectsModule.reset();

    gameOverOverlay.style.display = 'flex';
  };
}
