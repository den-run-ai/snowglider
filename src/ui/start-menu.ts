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
import { DIFFICULTIES, getDifficultyConfig, readStoredDifficulty, storeDifficulty, type Difficulty } from '../difficulty.js';

(function () {
  let startGamePending = false;
  // The player's chosen difficulty tier, remembered across sessions in
  // localStorage. The picker writes it; the game reads the persisted value at run
  // start (src/snowglider.ts) so changing the pick then starting takes effect.
  let selectedDifficulty: Difficulty = readStoredDifficulty();
  // Monotonic token for refreshStartAccountUI: bumped on every call so a slow
  // in-flight leaderboard read can detect that a newer refresh superseded it
  // (e.g. the player logged out mid-read) and discard its now-stale result.
  let accountRefreshSeq = 0;

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

  function escapeHtml(value: string) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  // Populate the start-screen leaderboard preview and the optional sign-in hint.
  // Reuses the live AuthModule/ScoresModule (the in-game #authContainer keeps the
  // actual sign-in/profile state), so this only reads state — it never duplicates
  // the auth wiring. Safe to call repeatedly; degrades to hidden when Firestore is
  // unavailable (file:// / localhost / offline).
  function refreshStartAccountUI() {
    const auth = window.AuthModule;
    const scores = window.ScoresModule;
    const seq = ++accountRefreshSeq;

    const firebase = auth && typeof auth.isFirebaseAvailable === 'function'
      ? auth.isFirebaseAvailable()
      : { auth: false, firestore: false };
    const authState = auth && typeof auth.getAuthState === 'function'
      ? auth.getAuthState()
      : { user: null, isSignedIn: false };

    const hint = document.getElementById('startSignInHint');
    if (hint) {
      // Only show when signing in can actually deliver the advertised benefit:
      // real auth AND Firestore are up (the localhost/127.0.0.1 + file:// fallbacks
      // skip Firestore, so leaderboard writes are no-ops there) and the player is
      // signed out. Otherwise we'd advertise a global leaderboard that can't save.
      hint.style.display = (firebase.auth && firebase.firestore && !authState.isSignedIn) ? 'block' : 'none';
    }

    const lb = document.getElementById('startLeaderboard');
    if (!lb) {
      return;
    }
    // The Firestore rules only permit leaderboard get/list for signed-in users
    // (firestore.rules: `allow get, list: if isSignedIn()`). Reading while signed
    // out is denied — ScoresModule.getLeaderboard() swallows that into an empty
    // array (without disabling Firestore), which would otherwise render a
    // misleading "No times yet" preview and log a permission error on every
    // signed-out start screen. So only read once signed in; signed-out players get
    // the sign-in hint instead.
    if (!authState.isSignedIn || !scores || typeof scores.getLeaderboard !== 'function') {
      lb.style.display = 'none';
      return;
    }

    // Show the board for the currently-selected tier (the picker is the tier toggle).
    Promise.resolve(scores.getLeaderboard(selectedDifficulty))
      .then((list) => {
        // Discard a superseded read: if another refresh ran after this one (e.g.
        // the player logged out while this signed-in read was in flight), don't
        // clobber its result — otherwise a slow read could re-show the leaderboard
        // on a now signed-out start screen (Firestore rules forbid that read).
        if (seq !== accountRefreshSeq) {
          return;
        }
        if (!Array.isArray(list) || list.length === 0) {
          // getLeaderboard() resolves [] for BOTH a genuinely empty board and a
          // swallowed read error (offline / transient Firestore failure), and
          // isFirebaseAvailable() can still report Firestore "available" — so the
          // two are indistinguishable here. Hide the preview rather than risk a
          // false "No times yet" during an outage.
          lb.style.display = 'none';
          return;
        }

        const me = authState.user;
        const tierLabel = getDifficultyConfig(selectedDifficulty).label;
        let html = `<h3>🏆 ${tierLabel} Top Times</h3><table><tr><th>#</th><th>Player</th><th>Time</th></tr>`;
        list.slice(0, 5).forEach((entry, index) => {
          const isMe = me && entry.userId === me.uid;
          const name = isMe ? (me.displayName || 'You') : `Player ${index + 1}`;
          html += `<tr class="${isMe ? 'current-user-score' : ''}"><td>${index + 1}</td><td>${escapeHtml(name)}</td><td>${Number(entry.time).toFixed(2)}s</td></tr>`;
        });
        html += '</table>';
        lb.innerHTML = html;
        lb.style.display = 'block';
      })
      .catch(() => {
        // Same staleness guard: don't let a superseded read's failure hide a board
        // that a newer refresh has since populated.
        if (seq !== accountRefreshSeq) {
          return;
        }
        lb.style.display = 'none';
      });
  }

  async function unlockAudioForStart(source: string) {
    if (!AudioModule) {
      return;
    }

    try {
      await AudioModule.resumeAudioContext();
      console.log(`AudioContext resume attempted in ${source} handler`);
      AudioModule.playPreloadedAudio();
    } catch (e) {
      console.warn(`Audio operation in ${source} failed:`, e);
    }
  }

  function startGame() {
    const gameCanvas = document.getElementById('gameCanvas');
    const canInitializeGame = typeof window.initializeGameWithAudio === 'function';

    if (!gameCanvas || !canInitializeGame) {
      startGamePending = true;
      setStartButtonWaiting(true);
      console.log("Start requested before game scripts finished loading; deferring until ready.");
      return false;
    }

    startGamePending = false;
    setStartButtonWaiting(false);

    const startContainer = document.getElementById('startGameContainer');
    if (startContainer) {
      startContainer.style.display = 'none';
    }
    // Drop the start-screen account-control elevation now that the game is shown.
    document.body.classList.remove('start-screen-active');

    gameCanvas.style.display = 'block';

    window.initializeGameWithAudio?.();
    return true;
  }

  function startPendingGameIfReady() {
    const gameCanvas = document.getElementById('gameCanvas');
    if (!gameCanvas || typeof window.initializeGameWithAudio !== 'function') {
      return false;
    }

    if (startGamePending) {
      startGamePending = false;
      setStartButtonWaiting(false);
      console.log("Game scripts ready after deferred start request; waiting for a fresh start gesture.");
      return true;
    }

    setStartButtonWaiting(false);
    return true;
  }

  function setStartButtonWaiting(waiting: boolean) {
    const startButton = document.getElementById('startGameButton');
    if (!(startButton instanceof HTMLButtonElement)) {
      return;
    }

    startButton.disabled = waiting;
    if (waiting) {
      startButton.setAttribute('aria-busy', 'true');
    } else {
      startButton.removeAttribute('aria-busy');
    }
  }

  // Reflect `selectedDifficulty` onto the picker buttons (highlight + ARIA state).
  function applyDifficultySelection() {
    const picker = document.getElementById('difficultyPicker');
    if (!picker) return;
    picker.querySelectorAll('.difficulty-option').forEach((el) => {
      const isSel = el.getAttribute('data-difficulty') === selectedDifficulty;
      el.classList.toggle('selected', isSel);
      el.setAttribute('aria-checked', isSel ? 'true' : 'false');
      el.setAttribute('tabindex', isSel ? '0' : '-1');
    });
  }

  // Roving-tabindex arrow-key support for the radiogroup: arrows move AND select the
  // prev/next tier (standard radio behaviour), then focus it — so a keyboard-only
  // player can reach every tier even though only the selected option is tabbable.
  function moveDifficultySelection(delta: number) {
    const ids = DIFFICULTIES.map((c) => c.id);
    const cur = ids.indexOf(selectedDifficulty);
    const nextId = ids[(cur + delta + ids.length) % ids.length];
    if (!nextId) return;
    selectedDifficulty = nextId;
    storeDifficulty(selectedDifficulty);
    applyDifficultySelection();
    refreshStartAccountUI();
    const el = document.querySelector('#difficultyPicker [data-difficulty="' + selectedDifficulty + '"]');
    if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
  }

  // Build the difficulty picker from the difficulty config (single source of truth
  // for the labels/blurbs), pre-selecting the remembered tier. Idempotent so a
  // re-init (or the test harness) can rebuild cleanly.
  function buildDifficultyPicker() {
    const picker = document.getElementById('difficultyPicker');
    if (!picker) return;
    picker.innerHTML = '';
    selectedDifficulty = readStoredDifficulty();

    const heading = document.createElement('div');
    heading.className = 'difficulty-heading';
    heading.textContent = 'Difficulty';
    picker.appendChild(heading);

    DIFFICULTIES.forEach((cfg) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'difficulty-option';
      opt.setAttribute('role', 'radio');
      opt.setAttribute('data-difficulty', cfg.id);

      const name = document.createElement('span');
      name.className = 'difficulty-name';
      name.textContent = cfg.label;
      const blurb = document.createElement('span');
      blurb.className = 'difficulty-blurb';
      blurb.textContent = cfg.blurb;
      opt.appendChild(name);
      opt.appendChild(blurb);

      opt.addEventListener('click', function () {
        selectedDifficulty = cfg.id;
        storeDifficulty(cfg.id);
        applyDifficultySelection();
        // Swap the start-screen leaderboard preview to the newly-selected tier's board.
        refreshStartAccountUI();
      });
      opt.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          moveDifficultySelection(1);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          moveDifficultySelection(-1);
        }
      });
      picker.appendChild(opt);
    });

    applyDifficultySelection();
  }

  function getSelectedDifficulty(): Difficulty {
    return selectedDifficulty;
  }

  function showAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
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
  }

  function hideAbout() {
    const aboutPanel = document.getElementById('aboutGamePanel');
    const controlsGuide = document.getElementById('controlsGuide');
    const startMenu = document.getElementById('startMenu');
    const keyboardHint = document.getElementById('keyboardHint');
    const picker = document.getElementById('difficultyPicker');

    if (aboutPanel) aboutPanel.style.display = 'none';
    if (controlsGuide) controlsGuide.style.display = 'block';
    if (startMenu) startMenu.style.display = 'flex';
    if (keyboardHint) keyboardHint.style.display = 'block';
    if (picker) picker.style.display = 'flex'; // restore (CSS lays it out as flex)
  }

  function initializeStartMenu() {
    addBuildBadge();
    buildDifficultyPicker();
    // Surface the account/sign-in control above the start overlay while it's up.
    document.body.classList.add('start-screen-active');
    if ((window as any).SnowGliderGameScriptsReady) {
      startPendingGameIfReady();
      refreshStartAccountUI();
    }

    const startGameButton = document.getElementById('startGameButton');
    if (startGameButton) {
      startGameButton.addEventListener('click', function () {
        console.log("Start button clicked");
        // unlock the audio context first, then start; void marks the promise as
        // intentionally fire-and-forget so the handler stays void-returning.
        void unlockAudioForStart('click').then(() => startGame());
      });

      startGameButton.addEventListener('touchstart', function (e) {
        e.preventDefault();
        this.classList.add('touch-active');
      }, { passive: false });

      startGameButton.addEventListener('touchend', function (e) {
        e.preventDefault();
        this.classList.remove('touch-active');
        console.log("Touch end - starting game");
        void unlockAudioForStart('touch').then(() => startGame());
      }, { passive: false });

      startGameButton.addEventListener('touchcancel', function () {
        this.classList.remove('touch-active');
      }, { passive: true });
    }

    const aboutGameButton = document.getElementById('aboutGameButton');
    if (aboutGameButton) {
      aboutGameButton.addEventListener('click', showAbout);
    }

    const closeAboutButton = document.getElementById('closeAboutButton');
    if (closeAboutButton) {
      closeAboutButton.addEventListener('click', hideAbout);
    }

    document.addEventListener('keydown', function (event) {
      const startContainer = document.getElementById('startGameContainer');
      const aboutPanel = document.getElementById('aboutGamePanel');

      // Don't let Enter/Space start the run when a difficulty option is focused —
      // the button's native activation should just select the tier. Otherwise a
      // keyboard user picking Black/Bunny would also trigger the global start.
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('#difficultyPicker')) {
        return;
      }

      if (startContainer &&
          startContainer.style.display !== 'none' &&
          aboutPanel &&
          aboutPanel.style.display !== 'block') {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          startGame();
        }
      } else if (aboutPanel && aboutPanel.style.display === 'block') {
        if (event.key === 'Escape') {
          const closeAboutButton = document.getElementById('closeAboutButton');
          if (closeAboutButton) closeAboutButton.click();
        }
      }
    });
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
