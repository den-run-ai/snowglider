// Phase 2 (issue #84): converted to an ES module so it imports AudioModule from
// the real src module instead of reading the window.AudioModule bridge. index.html
// loads it as `<script type="module">`; like every module script it is deferred,
// so it still runs before DOMContentLoaded and its listeners are registered in time.
//
// Phase 3.11 (issue #84): renamed `.js` -> `.ts`. The only edit is the JSDoc
// `(window)` cast → `as`; the DOM/menu wiring carries no type surface to promote
// under the current non-strict config. The `../audio.js` import specifier is
// unchanged — Vite/tsc Bundler resolve it to audio.ts.
import { AudioModule } from '../audio.js';
import { mountLeaderboardPanel, type LeaderboardPanel } from './leaderboard-panel.js';
import { getDifficultyConfig, storeDifficulty, type Difficulty } from '../difficulty.js';
import { consumeRunLaunch, initialRunDifficulty, isRunTransition } from '../game/run-transition.js';
import { Sfx } from '../sfx.js';
import { buildDifficultyPicker as buildDifficultyPickerUI, type DifficultyPickerHandle } from './difficulty-picker.js';
import { isOnline, watchConnectivity } from '../offline/offline-state.js';
import { ensureOfflineBadge, setOfflineBadgeVisible } from '../offline/offline-ui.js';
import { initInstallPrompt, type InstallPromptController } from '../pwa/install-prompt.js';
import { closeOverlayFocus, focusGameCanvas, openOverlayFocus } from './accessibility.js';
import { getStartupStatus, showStartupError, subscribeStartupStatus, type StartupStatus } from '../boot/startup-status.js';
import { parseDailyChallenge } from '../daily-challenge.js';
import { renderDailyMountainMenu } from './daily-mountain.js';

(function () {
  let startGamePending = false;
  // A navigation cannot carry the Restart button's user activation. Prepare the
  // selected course, then wait for Start in this document before audio/gameplay.
  const preparingNewTier = isRunTransition();
  const dailyInvitation = parseDailyChallenge(window.location.search);
  const invalidInvitation = dailyInvitation.kind === 'invalid' || dailyInvitation.kind === 'unsupported';
  // The player's chosen difficulty tier, remembered across sessions in
  // localStorage. The picker writes it; the game reads the persisted value at run
  // start (src/snowglider.ts) so changing the pick then starting takes effect.
  let selectedDifficulty: Difficulty = initialRunDifficulty();
  let menuListeners: AbortController | null = null;
  // Handle to the shared picker widget; getSelectedDifficulty reads through it so the
  // live selection stays the single source of truth across rebuilds.
  let pickerHandle: DifficultyPickerHandle | null = null;
  let leaderboardHandle: LeaderboardPanel | null = null;
  let leaderboardContainer: HTMLElement | null = null;
  let scrollBeforeAbout = 0;

  // Handle to the offline-mode badge + its connectivity subscription. The badge is
  // mounted hidden and only revealed when offline, so the online start screen is
  // unchanged; the unsubscribe keeps us teardown-clean if the menu is re-initialized.
  let offlineBadge: HTMLElement | null = null;
  let unwatchConnectivity: (() => void) | null = null;
  // The install-prompt controller; re-init disposes the prior one so we never stack
  // duplicate beforeinstallprompt listeners or leave a second chip behind.
  let installPrompt: InstallPromptController | null = null;
  let unwatchStartup: (() => void) | null = null;

  function updateStartupStatus(status: StartupStatus) {
    const loading = document.getElementById('startLoadingStatus');
    const text = document.getElementById('startLoadingText');
    if (loading) loading.dataset.stage = status.stage;
    if (text) text.textContent = {
      loading: 'Loading the mountain…',
      building: 'Preparing your run…',
      warming: 'Warming up the mountain…',
      ready: 'Ready to ride',
      error: 'Couldn’t prepare the mountain',
    }[status.stage];
    if (preparingNewTier && status.stage !== 'error') {
      const waiting = status.stage !== 'ready';
      document.getElementById('startGameContainer')?.classList.toggle('run-preparing', waiting);
      setStartButtonWaiting(waiting);
    }
    if (status.stage === 'error') {
      const wasPending = startGamePending;
      startGamePending = false;
      setStartButtonWaiting(false);
      // An early Play gesture may already have unlocked audio. A failed boot
      // must not leave its soundtrack running over the recovery screen.
      AudioModule.enableSound(false);
      Sfx.teardown();
      const button = document.getElementById('startGameButton');
      if (button) button.textContent = 'Loading help';
      document.getElementById('startGameContainer')?.classList.remove('run-preparing');
      if (wasPending) showStartupError();
    }
  }

  // Mount the offline badge into the start container and keep its visibility in sync
  // with connectivity. Idempotent: re-init tears down the prior watcher first so we
  // never stack duplicate `online`/`offline` listeners.
  function setupOfflineBadge() {
    const container = document.getElementById('startStatus') ?? document.getElementById('startGameContainer');
    if (!container) return;
    offlineBadge = ensureOfflineBadge(container);
    setOfflineBadgeVisible(offlineBadge, !isOnline());
    if (unwatchConnectivity) unwatchConnectivity();
    unwatchConnectivity = watchConnectivity((online) => {
      setOfflineBadgeVisible(offlineBadge, !online);
      // Global-only affordances (sign-in hint + leaderboard preview) are decided from
      // Firebase-INITIALIZED state, which stays true after going offline; re-run the
      // refresh so they hide/show with connectivity, not just the badge (Codex #359).
      refreshStartAccountUI();
    });
  }

  // Wire the PWA install prompt (issue #358, PR 2). Additive and self-gating: the
  // chip only appears when the browser fires `beforeinstallprompt` and we're not
  // under automation/standalone. Dispose any prior controller first so a re-init
  // doesn't stack listeners.
  function setupInstallPrompt() {
    if (installPrompt) installPrompt.dispose();
    installPrompt = initInstallPrompt();
  }

  function addBuildBadge() {
    const buildMeta = document.querySelector('meta[name="build-id"]');
    const build = buildMeta instanceof HTMLMetaElement && buildMeta.content
      ? buildMeta.content
      : new Date().toISOString().slice(0, 16).replace('T', ' ');
    // Show the build version as an unobtrusive footer on the start screen rather
    // than as a pill on the primary "Start Game" CTA.
    const badge = document.getElementById('buildBadge');
    if (badge) {
      badge.textContent = `build ${build}`;
    }
  }

  // The same level-switching view is used here and on the finish screen.
  function refreshStartAccountUI() {
    const hint = document.getElementById('startSignInHint');
    const details = document.getElementById('leaderboardsDetails');
    const lb = document.getElementById('startLeaderboard');
    const daily = dailyInvitation.kind !== 'none';
    if (details) details.style.display = daily ? 'none' : '';
    if (daily) {
      // Daily records belong to this device. Neither valid nor broken invitations
      // should display ordinary bests, fetch their boards, or suggest account saves.
      if (hint) hint.style.display = 'none';
      leaderboardHandle?.dispose();
      leaderboardHandle = null;
      leaderboardContainer = null;
      if (lb) {
        lb.style.display = 'none';
        lb.replaceChildren();
      }
      return;
    }
    const auth = window.AuthModule;
    let canSignIn = false;
    let signedIn = false;
    try {
      canSignIn = auth?.isFirebaseAvailable?.().auth === true && isOnline();
      const user = auth?.getCurrentUser?.() ?? auth?.getAuthState?.().user;
      signedIn = !!user && !user.isAnonymous;
    } catch { /* The local board remains usable when auth is unavailable. */ }
    if (hint) hint.style.display = canSignIn && !signedIn ? 'block' : 'none';
    if (!lb) return;
    if (lb !== leaderboardContainer || !lb.querySelector('.leaderboard-levels')) {
      leaderboardHandle?.dispose();
      leaderboardContainer = lb;
      leaderboardHandle = mountLeaderboardPanel(lb, selectedDifficulty);
    } else {
      // Account restoration and connectivity updates must preserve the level
      // someone is browsing, independently of their next run's difficulty.
      leaderboardHandle?.refresh();
    }
  }

  function startGame() {
    if (invalidInvitation) return false;
    const startContainer = document.getElementById('startGameContainer');
    // Click/touch compatibility events and retained callbacks must not reset an
    // already-starting run or create a second loop/intro.
    if (!startContainer || startContainer.style.display === 'none') return false;
    if (showStartupError()) return false;
    // Unlock inside the original user gesture, even when scripts are still loading.
    // Audio readiness never blocks play; the browser still enforces autoplay policy.
    try {
      void AudioModule.resumeAudioContext().catch(() => {});
      AudioModule.playPreloadedAudio();
    } catch (error) {
      console.warn('Audio unavailable; continuing to play.', error);
    }
    Sfx.unlock();
    const gameCanvas = document.getElementById('gameCanvas');
    const canInitializeGame = typeof window.initializeGameWithAudio === 'function';

    if (!gameCanvas || !canInitializeGame || getStartupStatus().stage !== 'ready') {
      startGamePending = true;
      setStartButtonWaiting(true);
      console.log("Start requested before game scripts finished loading; deferring until ready.");
      return false;
    }

    startGamePending = false;
    setStartButtonWaiting(false);

    if (startContainer) {
      startContainer.style.display = 'none';
      closeOverlayFocus(startContainer, false);
    }
    // Drop the start-screen account-control elevation now that the game is shown.
    document.body.classList.remove('start-screen-active');

    gameCanvas.style.display = 'block';
    focusGameCanvas();

    window.initializeGameWithAudio?.();
    return true;
  }

  function startPendingGameIfReady() {
    const gameCanvas = document.getElementById('gameCanvas');
    if (!gameCanvas || typeof window.initializeGameWithAudio !== 'function' || getStartupStatus().stage !== 'ready') {
      return false;
    }

    if (startGamePending) {
      startGamePending = false;
      return startGame();
    }

    setStartButtonWaiting(false);
    return true;
  }

  function setStartButtonWaiting(waiting: boolean) {
    const startButton = document.getElementById('startGameButton');
    if (!(startButton instanceof HTMLButtonElement)) {
      return;
    }

    startButton.disabled = waiting || invalidInvitation;
    startButton.textContent = invalidInvitation ? 'Choose a mountain below'
      : waiting ? 'Preparing run…' : dailyInvitation.kind === 'daily' ? 'Start daily run'
        : preparingNewTier ? 'Start run' : 'Start Game';
    if (waiting) {
      startButton.setAttribute('aria-busy', 'true');
    } else {
      startButton.removeAttribute('aria-busy');
    }
  }

  // Tier-aware jump copy (workstream A): a tier without the jump verb (Bunny,
  // ski.manualJump false) must not advertise it. Hides/shows the two jump rows in
  // the controls guide and the touch-note's ", and the center to jump" clause to
  // match the selected tier. The in-run touch REGION itself is gated separately at
  // run start (Controls.setJumpEnabled, called from the lifecycle reset).
  function updateJumpCopy() {
    const hasJump = getDifficultyConfig(selectedDifficulty).ski.manualJump;
    for (const id of ['jumpControlRow', 'hopControlRow', 'touchJumpNote']) {
      const el = document.getElementById(id);
      if (el) el.style.display = hasJump ? '' : 'none';
    }
  }

  // Build (or rebuild) the start-screen difficulty picker via the shared picker
  // widget (src/ui/difficulty-picker.ts) — the same factory builds the finish-screen
  // picker, so the DOM/ARIA/keyboard contract stays single-source. Pre-selects the
  // remembered tier; idempotent so a re-init (or the test harness) can rebuild cleanly.
  function buildDifficultyPicker() {
    const picker = document.getElementById('difficultyPicker');
    if (!picker) return;
    selectedDifficulty = initialRunDifficulty();
    pickerHandle = buildDifficultyPickerUI(picker, {
      initial: selectedDifficulty,
      heading: 'Difficulty',
      onChange: function (id) {
        selectedDifficulty = id;
        storeDifficulty(id);
        // Swap the start-screen leaderboard preview to the newly-selected tier's board.
        if (leaderboardHandle) leaderboardHandle.setTier(id);
        else refreshStartAccountUI();
        // Keep the controls guide + touch-note honest for the newly-selected tier.
        updateJumpCopy();
        renderDailyMountainMenu(id);
      },
    });
    updateJumpCopy();
    renderDailyMountainMenu(selectedDifficulty);
  }

  function getSelectedDifficulty(): Difficulty {
    return pickerHandle ? pickerHandle.getSelected() : selectedDifficulty;
  }

  function updateSoundButton() {
    const button = document.getElementById('startSoundButton');
    if (!button) return;
    const muted = AudioModule.getStatus().muted;
    button.textContent = muted ? '♪ Sound off' : '♫ Sound on';
    button.setAttribute('aria-pressed', String(!muted));
  }

  function showAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
    const card = aboutPanel?.closest<HTMLElement>('.start-dialog');
    if (card && !card.classList.contains('about-open')) scrollBeforeAbout = card.scrollTop;
    const controlsGuide = document.getElementById('controlsGuide');
    const startMenu = document.getElementById('startMenu');
    const keyboardHint = document.getElementById('keyboardHint');
    const picker = document.getElementById('difficultyPicker');

    if (aboutPanel) aboutPanel.style.display = 'block';
    if (controlsGuide) controlsGuide.style.display = 'none';
    if (startMenu) startMenu.style.display = 'none';
    if (keyboardHint) keyboardHint.style.display = 'none';
    // Hide the difficulty picker alongside the rest of the start controls so it
    // doesn't stay visible/clickable over the About panel.
    if (picker) picker.style.display = 'none';
    if (card) {
      card.classList.add('about-open');
      card.scrollTop = 0;
    }
    document.getElementById('aboutGameButton')?.setAttribute('aria-expanded', 'true');
    if (aboutPanel) openOverlayFocus(aboutPanel, {
      // Read from the top of the panel. The bottom Close action may need scrolling
      // on a short phone, so focusing it with preventScroll would hide that focus.
      initialFocus: aboutPanel, onEscape: hideAbout,
    });
  }

  function hideAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
    const card = aboutPanel?.closest<HTMLElement>('.start-dialog');
    const controlsGuide = document.getElementById('controlsGuide');
    const startMenu = document.getElementById('startMenu');
    const keyboardHint = document.getElementById('keyboardHint');
    const picker = document.getElementById('difficultyPicker');

    if (aboutPanel) aboutPanel.style.display = 'none';
    if (controlsGuide) controlsGuide.style.display = '';
    if (startMenu) startMenu.style.display = '';
    if (keyboardHint) keyboardHint.style.display = '';
    if (picker) picker.style.display = ''; // restore the responsive CSS layout
    if (card) {
      card.classList.remove('about-open');
      card.scrollTop = scrollBeforeAbout;
    }
    document.getElementById('aboutGameButton')?.setAttribute('aria-expanded', 'false');
    if (aboutPanel) closeOverlayFocus(aboutPanel);
    document.getElementById('aboutGameButton')?.focus({ preventScroll: true });
  }

  function initializeStartMenu() {
    menuListeners?.abort();
    menuListeners = new window.AbortController();
    const listenerOptions = { signal: menuListeners.signal };
    // Read preferences before an early Play gesture. This never downloads or
    // starts audio; the welcome screen stays silent until the player starts.
    AudioModule.init();
    updateSoundButton();
    document.getElementById('startSoundButton')?.addEventListener('click', () => {
      AudioModule.setMuted(!AudioModule.getStatus().muted);
      updateSoundButton();
    }, listenerOptions);
    const updateMotionVisibility = () => {
      document.body.classList.toggle('onboarding-paused', document.hidden);
      if (!document.hidden) renderDailyMountainMenu(getSelectedDifficulty());
    };
    updateMotionVisibility();
    document.addEventListener('visibilitychange', updateMotionVisibility, listenerOptions);
    addBuildBadge();
    setupOfflineBadge();
    setupInstallPrompt();
    buildDifficultyPicker();
    // Consume the URL intent without queuing a synthetic start. The fresh Start
    // gesture unlocks music and SFX synchronously, before starting the run.
    consumeRunLaunch();
    const startContainer = document.getElementById('startGameContainer');
    const card = startContainer?.querySelector<HTMLElement>('.start-dialog');
    const disclosures = card?.querySelectorAll<HTMLDetailsElement>('.start-extras > details');
    disclosures?.forEach((details) => {
      details.addEventListener('toggle', () => {
        if (details.open || card?.classList.contains('about-open')) return;
        // Full daily/error invitations may still need vertical reading space.
        // Keep their focused summary in place instead of jumping above it.
        if (!card?.querySelector('#startMenu.has-daily-entry')) return;
        // Closing the last long disclosure returns to the same compact menu.
        // Native focus stays on its summary; do not retain a landscape scroll
        // offset that leaves the difficulty choices above the visible card.
        if (card && !card.querySelector('.start-extras > details[open]')) card.scrollTop = 0;
      }, listenerOptions);
    });
    const account = document.getElementById('authContainer');
    if (startContainer) openOverlayFocus(startContainer, {
      initialFocus: document.getElementById('startGameButton'),
      allowed: account ? [account] : [], modal: false,
    });
    // Surface the account/sign-in control above the start overlay while it's up.
    document.body.classList.add('start-screen-active');
    if (window.SnowGliderGameScriptsReady) {
      startPendingGameIfReady();
      refreshStartAccountUI();
    }
    unwatchStartup?.();
    unwatchStartup = subscribeStartupStatus(updateStartupStatus);

    const startGameButton = document.getElementById('startGameButton');
    if (startGameButton) {
      startGameButton.addEventListener('click', function () {
        startGame();
      }, listenerOptions);

      startGameButton.addEventListener('touchstart', function (e) {
        e.preventDefault();
        this.classList.add('touch-active');
      }, { ...listenerOptions, passive: false });

      startGameButton.addEventListener('touchend', function (e) {
        e.preventDefault();
        this.classList.remove('touch-active');
        startGame();
      }, { ...listenerOptions, passive: false });

      startGameButton.addEventListener('touchcancel', function () {
        this.classList.remove('touch-active');
      }, { ...listenerOptions, passive: true });
    }

    const aboutGameButton = document.getElementById('aboutGameButton');
    if (aboutGameButton) {
      aboutGameButton.addEventListener('click', showAbout, listenerOptions);
    }

    const closeAboutButton = document.getElementById('closeAboutButton');
    if (closeAboutButton) {
      closeAboutButton.addEventListener('click', hideAbout, listenerOptions);
    }

    document.addEventListener('keydown', function (event) {
      const startContainer = document.getElementById('startGameContainer');
      const aboutPanel = document.getElementById('aboutGamePanel');

      // Don't let Enter/Space start the run when focus is on an interactive start-screen
      // control whose own activation should NOT also launch the game: a difficulty option
      // (just selects the tier) or the PWA install chip (Install/dismiss — Codex #360, a
      // keyboard Enter on Install would otherwise both install AND start the run).
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('button, a, summary, input, textarea, select, [role="radio"], [role="dialog"]')) {
        return;
      }

      if (startContainer &&
          startContainer.style.display !== 'none' &&
          aboutPanel &&
          aboutPanel.style.display !== 'block') {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          startGame();
        }
      } else if (aboutPanel && aboutPanel.style.display === 'block') {
        if (event.key === 'Escape') {
          const closeAboutButton = document.getElementById('closeAboutButton');
          if (closeAboutButton) closeAboutButton.click();
        }
      }
    }, listenerOptions);
  }

  document.addEventListener('DOMContentLoaded', initializeStartMenu);
  window.addEventListener('snowglider:game-scripts-ready', function () {
    startPendingGameIfReady();
    // Render the leaderboard/sign-in state now, and again shortly after to catch
    // Firebase auth + Firestore finishing their async init after scripts load.
    refreshStartAccountUI();
    setTimeout(refreshStartAccountUI, 1500);
  });
  // Re-render whenever auth state changes (auth.ts dispatches this on login/logout),
  // so signing in from the elevated start-screen control immediately swaps the
  // sign-in hint for the leaderboard instead of leaving stale state until reload.
  window.addEventListener('snowglider:auth-changed', refreshStartAccountUI);
  window.addEventListener('snowglider:account-bests-changed', refreshStartAccountUI);

  window.SnowGliderStartMenu = {
    startGame,
    showAbout,
    hideAbout,
    initializeStartMenu,
    startPendingGameIfReady,
    refreshStartAccountUI,
    buildDifficultyPicker,
    getSelectedDifficulty
  };
})();
