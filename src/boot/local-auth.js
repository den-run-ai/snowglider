// @ts-check
(function () {
  // Plausibility floor + cap. This classic bootstrap script can't import ES modules, so
  // the two literals are duplicated from src/score-limits.ts (the single source of truth);
  // tests/score-limits-sync-tests.js asserts they stay equal. Floor measured in issue #229
  // (PR A); see score-limits.ts for the derivation.
  const MIN_VALID_SCORE_TIME = 15;
  const MAX_VALID_SCORE_TIME = 600;
  /** @type {Record<string, number>} */
  const MIN_SCORE_TIME_BY_DIFFICULTY = { bunny: 15, blue: MIN_VALID_SCORE_TIME, black: 10, expert: 10 };
  // The classic fallback cannot import run-context.ts. Its tests save a genuine
  // live game stamp, so either constant drifting from that module fails the gate.
  const PHYSICS_VERSION = 4;
  const CANONICAL_WORLD_SEED = 0x5310_60D5;
  /** @typedef {ReturnType<typeof import('../run-context.js').getRunStamp>} RunStamp */

  /** @param {number} time @param {string=} tier */
  function isValidScoreTime(time, tier) {
    const floor = MIN_SCORE_TIME_BY_DIFFICULTY[tier || 'blue'];
    return typeof floor === 'number' &&
      typeof time === 'number' &&
      Number.isFinite(time) &&
      time >= floor &&
      time <= MAX_VALID_SCORE_TIME;
  }

  /**
   * Mirror scores.ts's live-provenance guard before any storage access. An absent
   * seam preserves legacy, unversioned local records; a broken or ineligible live
   * context must never fall back to that path. Capture once for both key and stamp.
   * @returns {RunStamp | null | undefined}
   */
  function readCompetitiveRunStamp() {
    try {
      const liveGetter = window.__snowgliderGetRunStamp;
      if (liveGetter === undefined) return undefined;
      if (typeof liveGetter !== 'function') return null;
      const raw = /** @type {unknown} */ (liveGetter());
      if (!raw || typeof raw !== 'object') return null;
      const value = /** @type {Record<string, unknown>} */ (raw);
      if (value.physicsVersion !== PHYSICS_VERSION || value.practice === true) return null;
      if (value.practice !== undefined && typeof value.practice !== 'boolean') return null;
      if (value.seed !== CANONICAL_WORLD_SEED) return null;
      const nonce = value.nonce ?? 0;
      if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) return null;
      return { seed: CANONICAL_WORLD_SEED, practice: false, nonce, physicsVersion: PHYSICS_VERSION };
    } catch { return null; }
  }

  // Mirror difficulty.ts for valid live runs. Without a game context retain the
  // legacy unversioned key, a historical record never synced from local mode.
  /** @param {string | undefined} tier @param {RunStamp | undefined} stamp */
  function localBestTimeKey(tier, stamp) {
    const base = 'snowgliderBestTime' + (stamp ? '_v' + stamp.physicsVersion : '');
    return (!tier || tier === 'blue') ? base : base + '_' + tier;
  }

  /**
   * Preserve the fastest result even when only the classic fallback is available.
   * Storage restrictions must not throw out of the finish handler or report a
   * persistent save that did not happen.
   * @param {number} time
   * @param {string=} tier
   * @returns {{status: 'local' | 'unavailable' | 'invalid', localSaved: boolean}}
   */
  function recordLocalBest(time, tier) {
    if (!isValidScoreTime(time, tier)) return { status: 'invalid', localSaved: false };
    const stamp = readCompetitiveRunStamp();
    if (stamp === null) return { status: 'invalid', localSaved: false };
    try {
      const key = localBestTimeKey(tier, stamp);
      const raw = localStorage.getItem(key);
      const bestTime = raw === null ? NaN : Number(raw);
      if (!isValidScoreTime(bestTime, tier) || time < bestTime) {
        // Clear the old stamp BEFORE replacing its time; a failed remove cannot
        // leave a new result described by the previous run's provenance.
        localStorage.removeItem(key + '_meta');
        localStorage.setItem(key, String(time));
        try {
          if (stamp) {
            localStorage.setItem(key + '_meta', JSON.stringify(stamp));
          }
        } catch (e) { /* the local time is valid; no stamp means it stays historical */ }
      }
      return { status: 'local', localSaved: true };
    } catch (e) {
      console.warn('Local score storage is unavailable; the finished run remains visible.', e);
      return { status: 'unavailable', localSaved: false };
    }
  }

  /** @param {number} time @param {string=} tier */
  function saveLocalScore(time, tier) {
    return Promise.resolve(recordLocalBest(time, tier));
  }

  function installScoresModule() {
    window.ScoresModule = {
      initializeScores: function () {
        console.log("ScoresModule initialized in local mode (simplified)");
      },
      setCurrentUser: function () {
        console.log("ScoresModule: setCurrentUser called in local mode");
      },
      recordScore: saveLocalScore,
      saveScore: saveLocalScore,
      displayLeaderboard: function () {
        console.log("Leaderboard not available in local file mode");
        const leaderboardElement = document.getElementById('leaderboard');
        if (leaderboardElement) {
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable in local file mode</h3>';
        }
      },
      getLeaderboard: function () { return Promise.resolve([]); },
      getLeaderboardResult: function () { return Promise.resolve({ status: 'unavailable', scores: [] }); },
      updateUserBestTime: function () {
        console.log("updateUserBestTime not available in local file mode");
      },
      updateLeaderboard: function () {
        console.log("updateLeaderboard not available in local file mode");
      },
      isFirestoreAvailable: function () { return false; },
      isValidScoreTime: isValidScoreTime
    };
  }

  function installAuthModule() {
    window.AuthModule = {
      initializeAuth: function () {
        console.log("Auth initialized in local mode (simplified)");
        const authUI = document.getElementById('authUI');
        const profileUI = document.getElementById('profileUI');
        if (authUI) authUI.style.display = 'none';
        if (profileUI) profileUI.style.display = 'none';

        const authContainer = document.getElementById('authContainer');
        if (authContainer && !authContainer.querySelector('.local-mode-notice')) {
          const localModeNotice = document.createElement('div');
          localModeNotice.className = 'local-mode-notice';
          localModeNotice.style.color = 'white';
          localModeNotice.style.padding = '8px';
          localModeNotice.style.textAlign = 'center';
          localModeNotice.textContent = 'Playing locally. Sign-in is unavailable; your best times stay on this device.';
          authContainer.appendChild(localModeNotice);
        }
      },
      openSignIn: function () {
        const notice = /** @type {HTMLElement | null} */ (document.querySelector('#authContainer .local-mode-notice'));
        if (notice) {
          notice.setAttribute('tabindex', '-1');
          notice.focus();
        }
      },
      /** @param {number} time @param {import('../difficulty.js').Difficulty=} tier */
      recordScore: function (time, tier) {
        if (window.ScoresModule && typeof window.ScoresModule.recordScore === 'function') {
          return window.ScoresModule.recordScore(time, tier);
        }
        return saveLocalScore(time, tier);
      },
      /** @param {number} time @param {import('../difficulty.js').Difficulty=} tier */
      saveScore: function (time, tier) {
        if (window.ScoresModule && typeof window.ScoresModule.saveScore === 'function') {
          return window.ScoresModule.saveScore(time, tier);
        }
        return saveLocalScore(time, tier);
      },
      /** @param {import('../difficulty.js').Difficulty=} tier */
      displayLeaderboard: function (tier) {
        if (window.ScoresModule && typeof window.ScoresModule.displayLeaderboard === 'function') {
          window.ScoresModule.displayLeaderboard(tier);
        } else {
          console.log("Leaderboard not available in local mode");
          const leaderboardElement = document.getElementById('leaderboard');
          if (leaderboardElement) {
            leaderboardElement.innerHTML = '<h3>Leaderboard unavailable in local mode</h3>';
          }
        }
      },
      getCurrentUser: function () { return null; },
      isUserSignedIn: function () { return false; },
      getUserIdToken: function () { return Promise.reject("Not available in local mode"); },
      signOut: function () { return Promise.resolve(); },
      getAuthState: function () { return { user: null, isSignedIn: false }; },
      isFirebaseAvailable: function () {
        return { auth: false, firestore: false, analytics: false };
      }
    };
  }

  window.SnowGliderLocalAuth = {
    installScoresModule,
    installAuthModule
  };

  if (window.location.protocol === 'file:') {
    console.log("File protocol detected - using mock Firebase implementation");
    console.log("Mock Firebase services will be handled by AuthModule in local file mode");
    installScoresModule();
  }
})();
