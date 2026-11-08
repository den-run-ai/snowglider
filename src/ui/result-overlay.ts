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
import { DEFAULT_DIFFICULTY, getDifficultyConfig, localBestTimeKey, readStoredDifficulty, stampLocalBestMeta, type Difficulty } from '../difficulty.js';
import { getRunStamp } from '../run-context.js';
import { endRunTelemetry } from '../run-telemetry.js';
import { resultSyncStatusCopy } from '../offline/sync-manager.js';
import { isOnline } from '../offline/offline-state.js';
import { readLocalBest, safeSetItem } from '../offline/offline-store.js';
import { announceGameStatus, closeOverlayFocus, openOverlayFocus } from './accessibility.js';
import { setPanelCollapsed } from './collapsible-panel.js';
import { mountLeaderboardPanel, type LeaderboardPanel } from './leaderboard-panel.js';
import { createResultSaveControls, type ResultSaveControls } from './result-save.js';
import type { ScoreSaveResult } from '../scores.js';
import { getDailyChallenge } from '../daily-session.js';
import { readDailyBest, recordDailyBest, type DailyBestResult } from '../daily-records.js';
import { buildDailyResultSummary, regularMountainUrl } from './daily-mountain.js';

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
// own floor. This matters now
// that Black plays faster and can legitimately finish below Blue's 18 s floor — using
// the global floor there would drop a valid fast Black run's local best/ghost/panel.
export function isPlausibleForTier(time: number, tier: Difficulty = DEFAULT_DIFFICULTY): boolean {
  return typeof time === 'number' && Number.isFinite(time)
    && time >= getDifficultyConfig(tier).minScoreTime
    && time <= MAX_VALID_SCORE_TIME;
}

export function readStoredBestTime(tier: Difficulty = DEFAULT_DIFFICULTY): number {
  return readLocalBest(tier) ?? Infinity;
}

function persistLocalBest(tier: Difficulty, time: number): void {
  try {
    // Another tab may have improved the device best after this run started.
    // If the read fails, preserve the unread record instead of overwriting it.
    const raw = localStorage.getItem(localBestTimeKey(tier));
    const existing = raw === null ? null : Number(raw);
    if (existing !== null && isPlausibleForTier(existing, tier) && existing <= time) return;
    if (safeSetItem(localBestTimeKey(tier), String(time))) stampLocalBestMeta(tier);
  } catch { /* the completed result remains usable without browser storage */ }
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
  // Clear the PR-4 sync-status line too, so a prior run's message can't linger.
  const syncStatus = document.getElementById('syncStatus');
  if (syncStatus) {
    syncStatus.remove();
  }
}

// The run-state slice showGameOver reads and mutates (the coordinator's GameState
// satisfies this structurally; mutations flow back to the live object).
export interface ResultOverlayState {
  gameActive: boolean;
  bestTime: number;
  startTime: number;
  /** The loop's simulation clock (#402): accumulated fixed-step seconds this
   *  run. Optional so legacy fixtures without it fall back to wall clock. */
  simElapsed?: number;
  /** Set by the loop when this run dropped enough stalled wall time that its sim
   *  clock ran materially slower than real time (#403 review). A compromised run
   *  still finishes and shows its time, but is never ranked (no PB, no
   *  leaderboard, no ghost commit). Optional for legacy fixtures. */
  timingCompromised?: boolean;
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
  /** Cancel pending run-only UI work before opening the result dialog. */
  onEndRun?: () => void;
  // The run's difficulty tier, so the score/best-time/leaderboard go to that tier.
  // Omitted => falls back to the persisted pick (readStoredDifficulty).
  getDifficulty?: () => Difficulty;
  // Optional finish-screen difficulty picker (lets the player switch tier and replay
  // without reloading). When present, showGameOver keeps it positioned directly above
  // the restart button — the result panel/leaderboard get inserted above it during the
  // call — and reflects the tier just played via setPickerTier.
  finishDifficultyPicker?: HTMLElement;
  setPickerTier?: (tier: Difficulty) => void;
}

// Build the showGameOver(reason) handler bound to the injected overlay/state. The
// body is the original snowglider.ts implementation verbatim (deps are destructured
// under the same names it used as module-locals).
export function createShowGameOver(deps: ResultOverlayDeps): (reason: string) => void {
  const { state, gameOverOverlay, gameOverDetail, restartButton, bestTimeDisplay, onCrash, getDifficulty, finishDifficultyPicker, setPickerTier } = deps;
  const FINISH_REASON = "You reached the end of the slope!";
  // Results may grow with splits, sharing, authentication and the leaderboard.
  // Keep replay outside that scrolling content so it is always reachable.
  let resultContent = gameOverOverlay.querySelector<HTMLElement>('#gameOverContent');
  let replayActions = gameOverOverlay.querySelector<HTMLElement>('#gameOverActions');
  if (!resultContent || !replayActions) {
    resultContent = document.createElement('div');
    resultContent.id = 'gameOverContent';
    replayActions = document.createElement('div');
    replayActions.id = 'gameOverActions';
    for (const child of Array.from(gameOverOverlay.children)) {
      if (child !== restartButton && child !== finishDifficultyPicker) resultContent.appendChild(child);
    }
    if (finishDifficultyPicker) replayActions.appendChild(finishDifficultyPicker);
    replayActions.appendChild(restartButton);
    gameOverOverlay.append(resultContent, replayActions);
  }
  const content = resultContent;
  const actions = replayActions;
  let saveControls: ResultSaveControls | null = null;
  let leaderboardPanel: LeaderboardPanel | null = null;

  return function showGameOver(reason: string) {
    // The tier this run was played on; routes the score/best/leaderboard per tier.
    const tier: Difficulty = getDifficulty ? getDifficulty() : readStoredDifficulty();
    const daily = getDailyChallenge();
    let dailyResult: DailyBestResult | null = null;
    // Ranked-eligibility for THIS run: the tier must be ranked AND the world must
    // be canonical — a ?seed= practice world reads as unranked through the WHOLE
    // overlay (Codex review PR #407): no login prompt, no "saved" status copy,
    // no leaderboard render, and the practice result panel makes no PB promises.
    // ... AND the run's timing must be intact: a stall-heavy run played in slow
    // motion against its own ranked clock (free reaction time), so it records
    // nothing competitive either (#403 review).
    const tierRanked = getDifficultyConfig(tier).ranked && !getRunStamp().practice
      && state.timingCompromised !== true;
    // Allow tests to intercept showGameOver calls
    if (window._testShowGameOverOverride) {
      window._testShowGameOverOverride(reason);
      return;
    }
    closeOverlayFocus(gameOverOverlay, false);
    saveControls?.dispose();
    saveControls?.element.remove();
    saveControls = null;
    leaderboardPanel?.dispose();
    leaderboardPanel = null;
    let initialSave: Promise<ScoreSaveResult> | void = undefined;
    state.gameActive = false;
    deps.onEndRun?.();
    AudioModule.clearMessages();

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

    // Refresh a device best improved by another tab while this run was active.
    const deviceBest = daily ? null : readLocalBest(tier);
    if (deviceBest !== null && deviceBest < state.bestTime) state.bestTime = deviceBest;
    // Capture the best time BEFORE the finish branch updates it, so the result
    // screen can report the delta and whether this run set a new record.
    const previousDailyBest = daily ? readDailyBest(daily) : null;
    const previousBest = daily ? previousDailyBest === null ? Infinity : previousDailyBest / 1000 : state.bestTime;

    // The finish time IS the simulation clock (#402): the loop accumulates it in
    // fixed steps and publishes it as state.simElapsed, so a stalled run records
    // the time the simulation actually ran — wall clock can no longer inflate a
    // ranked score (and it matches the splits/ghost, which read the same clock).
    // Snapshotted ONCE and reused for the best-time/score path and
    // CourseModule.onFinish() so every consumer sees the same value. Wall-clock
    // fallback only for legacy callers whose state predates simElapsed.
    const finishTime = typeof state.simElapsed === 'number'
      ? state.simElapsed
      : (performance.now() - state.startTime) / 1000;
    // Validate against the RUN's tier floor, not the global Blue floor — otherwise a
    // legitimately fast Black finish (below Blue's floor) would be treated as invalid and
    // lose its local best/ghost/result panel. Blue's floor == the global floor, unchanged.
    const hasValidFinishTime = isPlausibleForTier(finishTime, tier);
    endRunTelemetry(state, {
      outcome: reason === FINISH_REASON ? 'finish' : 'crash',
      time: finishTime,
      timingCompromised: state.timingCompromised === true,
      scoreEligible: tierRanked && hasValidFinishTime,
      reason,
    });
    if (daily && reason === FINISH_REASON && hasValidFinishTime) {
      dailyResult = recordDailyBest(daily, getRunStamp(), tier, finishTime, state.timingCompromised);
    }

    // Remove game-active class from body for styling
    document.body.classList.remove('game-active');

    gameOverDetail.textContent = reason;
    removeLoginPrompt();

    // Pause the background music on game over (audio is ENABLED — see audio.ts;
    // this is a no-op only if AUDIO_ENABLED is ever set false there).
    if (AudioModule) {
      AudioModule.enableSound(false);
    }

    // Hide or collapse game stats container on game over
    const gameStatsContainer = document.getElementById('gameStatsContainer');
    if (gameStatsContainer) {
      // Option 1: Collapse the stats
      const toggleBtn = document.getElementById('toggleStats');
      if (toggleBtn) {
        setPanelCollapsed(gameStatsContainer, toggleBtn, true);
      }

      // Option 2 (alternative): Hide the stats completely
      // gameStatsContainer.style.display = 'none';
    }

    // Only update times if player reached the end successfully
    if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
      const currentTime = finishTime;
      // Practice worlds (?seed=..., #403 review) show their time but record
      // NOTHING competitive: no leaderboard submit, no local best, no
      // state.bestTime update — a freely chosen seed could cherry-pick an easy
      // obstacle/avalanche field (seed-shopping), so only canonical-world runs
      // are ranked. The result panel still renders (CourseModule.onFinish).
      const practice = getRunStamp().practice;
      const isNewBestTime = !practice && state.timingCompromised !== true
        && currentTime < state.bestTime;
      const canRecordScore = window.AuthModule && typeof window.AuthModule.recordScore === 'function';

      // Record the score whenever the leaderboard API is available (it handles its own
      // auth + persistence); otherwise fall back to persisting a new local best.
      if (canRecordScore && tierRanked) {
        try {
          initialSave = window.AuthModule.recordScore?.(currentTime, tier);
        } catch (error) {
          // Classic local-auth fallback can throw when browser storage is denied.
          // The completed run and Play again must remain available even then.
          console.warn('Score persistence unavailable; keeping the session result.', error);
          if (isNewBestTime) persistLocalBest(tier, currentTime);
        }
      } else if (isNewBestTime) {
        // Unranked tier (or no leaderboard API): keep the local per-tier best only —
        // stamped with the same run provenance every other local-best write carries
        // (#400; Codex review PR #407). Practice runs never reach here
        // (isNewBestTime is force-false above).
        persistLocalBest(tier, currentTime);
      }

      // Show appropriate message based on time
      if (isNewBestTime) {
        state.bestTime = currentTime;
        bestTimeDisplay.textContent = `New Best Time: ${state.bestTime.toFixed(2)}s`;
        bestTimeDisplay.style.color = '#ffff00'; // Highlight new record
      } else if (practice || state.timingCompromised === true) {
        // A seeded practice world records nothing and its times are not comparable
        // with the canonical-world best — showing that best here would juxtapose two
        // different worlds (or print 'Best: Infinitys' for a new player). Render the
        // practice time alone (Codex review PR #407). A timing-compromised finish
        // recorded nothing either, so it gets the same no-best-safe display
        // (Codex review PR #409): its slow-motion time must not sit next to a
        // real best — or next to 'Infinitys' for a new player.
        bestTimeDisplay.textContent = `Your Time: ${currentTime.toFixed(2)}s`;
        bestTimeDisplay.style.color = 'white';
      } else {
        bestTimeDisplay.textContent = `Your Time: ${currentTime.toFixed(2)}s (Best: ${state.bestTime.toFixed(2)}s)`;
        bestTimeDisplay.style.color = 'white';
      }

      // Explain the result's leaderboard status: practice tier (local only),
      // offline, guest, or a board outage. These availability signals cannot
      // confirm a successful save; storage and remote writes are best-effort.
      const signedInUser = getSignedInUser();
      const online = isOnline();
      let firestoreAvailable = false;
      try {
        firestoreAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore === true;
      } catch (error) {
        // Service availability is optional; a broken SDK must not trap a finished run.
        Diag.reportError(error, 'result_firebase_status');
      }
      const syncCopy = resultSyncStatusCopy({
        online,
        firestoreAvailable,
        ranked: tierRanked,
        signedIn: !!signedInUser,
        anonymous: !!(signedInUser && signedInUser.isAnonymous),
        // A ?seed= practice WORLD saves nothing at all (no local best, no ghost),
        // which needs different copy than an unranked TIER (Codex review PR #407).
        practiceWorld: getRunStamp().practice,
        // A timing-compromised run recorded nothing either — its copy must not
        // claim a local best/ghost exist (Codex review PR #409).
        timingCompromised: state.timingCompromised === true,
      });
      if (syncCopy && !tierRanked && !document.getElementById('syncStatus')) {
        const syncStatus = document.createElement('p');
        syncStatus.id = 'syncStatus';
        syncStatus.textContent = daily
          ? dailyResult?.status === 'saved' || dailyResult?.status === 'unchanged'
            ? 'Daily best saved on this device. Daily runs stay separate from the regular leaderboards.'
            : dailyResult?.status === 'unavailable'
              ? 'Browser storage is unavailable. You can still share this finish or play again.'
              : 'This attempt was not saved. Restart to try the daily mountain again.'
          : syncCopy;
        syncStatus.style.color = '#9fd0f5';
        syncStatus.style.fontStyle = 'italic';
        syncStatus.style.margin = '10px 0';
        content.appendChild(syncStatus);
      }

      if (tierRanked) {
        saveControls = createResultSaveControls({
          time: currentTime,
          tier,
          initialSave,
          onSaved: () => leaderboardPanel?.refresh(),
        });
        content.appendChild(saveControls.element);
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
    }

    document.getElementById('dailyRunResult')?.remove();
    document.getElementById('leaveDailyRun')?.remove();
    if (daily) {
      const best = readDailyBest(daily);
      bestTimeDisplay.textContent = reason === FINISH_REASON && hasValidFinishTime
        ? dailyResult?.status === 'ineligible'
          ? `Your Time: ${finishTime.toFixed(2)}s (not comparable)`
          : `Your Time: ${finishTime.toFixed(2)}s${best === null ? '' : ` · Daily best: ${(best / 1000).toFixed(2)}s`}`
        : best === null ? 'Finish this daily mountain to set your first time.' : `Daily best on this device: ${(best / 1000).toFixed(2)}s`;
      const summary = buildDailyResultSummary(finishTime, dailyResult, reason === FINISH_REASON && hasValidFinishTime);
      if (summary) content.appendChild(summary);
      const regular = document.createElement('a');
      regular.id = 'leaveDailyRun';
      regular.textContent = 'Regular mountain';
      regular.href = regularMountainUrl(window.location.href, tier);
      actions.appendChild(regular);
    }

    // Mount the same four-level board used on the start screen. Signed-out and
    // offline players see an explicit status without a denied Firestore request.
    const leaderboardElement = document.getElementById('leaderboard');
    if (leaderboardElement) {
      if (tierRanked) {
        content.appendChild(leaderboardElement);
        leaderboardPanel = mountLeaderboardPanel(leaderboardElement, tier);
      } else {
        leaderboardElement.style.display = 'none';
      }
    }

    // Build the result screen (splits + medal) on a finish; otherwise just clear
    // the live HUD/effects. The panel is inserted above the restart button.
    if (CourseModule) {
      const staleResult = document.getElementById('courseResult');
      if (staleResult && staleResult.parentNode) staleResult.parentNode.removeChild(staleResult);

      if (reason === "You reached the end of the slope!" && hasValidFinishTime) {
        try {
          // A timing-compromised run may not commit ghost/splits either — its
          // slow-motion trajectory is as non-comparable as its time (#403 review).
          const panel = CourseModule.onFinish(finishTime, previousBest,
            state.timingCompromised !== true, dailyResult ?? undefined);
          if (panel) {
            // Keep save/sign-in immediately below the finish time on short
            // screens; the detailed splits and sharing follow, then the board.
            content.insertBefore(panel, leaderboardElement?.parentNode === content ? leaderboardElement : null);
          }
        } catch (e) {
          console.warn("Result screen failed:", (e as Error).message);
          Diag.reportError(e, 'course_result');
        }
      } else {
        CourseModule.hideHud();
      }
    }
    if (EffectsModule) EffectsModule.reset();

    // Keep the difficulty picker directly above RESTART (the result panel/leaderboard
    // were just inserted before the button above) and reflecting the tier just played,
    // so "Play again on" defaults to the current tier and the player can switch + replay.
    if (finishDifficultyPicker) {
      if (setPickerTier) setPickerTier(tier);
      actions.insertBefore(finishDifficultyPicker, restartButton);
    }

    gameOverOverlay.style.display = 'flex';
    content.scrollTop = 0;
    gameOverOverlay.scrollTop = 0;
    const heading = gameOverOverlay.querySelector('#gameOverMessage');
    if (heading) heading.textContent = reason === FINISH_REASON ? 'RUN COMPLETE' : 'GAME OVER';
    gameOverOverlay.setAttribute('role', 'dialog');
    gameOverOverlay.setAttribute('aria-label', reason === FINISH_REASON ? 'Run complete' : 'Run ended');
    if (gameOverDetail.id) gameOverOverlay.setAttribute('aria-describedby', gameOverDetail.id);
    announceGameStatus(`${reason} ${bestTimeDisplay.textContent ?? ''}`);
    // Keep the advertised sign-in action inside the dialog's focus boundary.
    // Move the real controls, preserving native popup gestures and auth listeners;
    // restore their original placement on Restart, re-show, or game teardown.
    const account = document.getElementById('authContainer');
    const accountParent = account?.parentNode;
    const accountNext = account?.nextSibling ?? null;
    if (account) {
      content.insertBefore(account, saveControls?.element.nextSibling ?? (leaderboardElement?.parentNode === content ? leaderboardElement : null));
    }
    const refreshResultBoard = () => leaderboardPanel?.refresh();
    window.addEventListener('snowglider:auth-changed', refreshResultBoard);
    window.addEventListener('snowglider:account-bests-changed', refreshResultBoard);
    window.addEventListener('online', refreshResultBoard);
    window.addEventListener('offline', refreshResultBoard);
    openOverlayFocus(gameOverOverlay, {
      initialFocus: restartButton,
      onClose: () => {
        saveControls?.dispose();
        leaderboardPanel?.dispose();
        window.removeEventListener('snowglider:auth-changed', refreshResultBoard);
        window.removeEventListener('snowglider:account-bests-changed', refreshResultBoard);
        window.removeEventListener('online', refreshResultBoard);
        window.removeEventListener('offline', refreshResultBoard);
        if (account && accountParent) {
          accountParent.insertBefore(account, accountNext?.parentNode === accountParent ? accountNext : null);
        }
      },
    });
  };
}
