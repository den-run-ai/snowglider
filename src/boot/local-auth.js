// @ts-check
(function () {
  // Plausibility floor + cap. This classic bootstrap script can't import ES modules, so
  // the two literals are duplicated from src/score-limits.ts (the single source of truth);
  // tests/score-limits-sync-tests.js asserts they stay equal. Floor measured in issue #229
  // (PR A); see score-limits.ts for the derivation.
  const MIN_VALID_SCORE_TIME = 18;
  const MAX_VALID_SCORE_TIME = 600;

  /** @param {number} time */
  function isValidScoreTime(time) {
    return typeof time === 'number' &&
      Number.isFinite(time) &&
      time >= MIN_VALID_SCORE_TIME &&
      time <= MAX_VALID_SCORE_TIME;
  }

  // Per-tier best-time localStorage key. Mirrors localBestTimeKey() in src/difficulty.ts
  // (Blue / no tier == the original un-suffixed key); inlined because this classic
  // bootstrap script can't import the ES module.
  /** @param {string=} tier */
  function localBestTimeKey(tier) {
    // Version-namespaced competitive key (#403 review), mirroring difficulty.ts.
    // The physics version comes from the boot seam the module graph publishes;
    // in a fully degraded boot (seam absent) fall back to the legacy unversioned
    // key — a historical record, never leaderboard-synced from local mode.
    var base = 'snowgliderBestTime';
    try {
      if (typeof window.__snowgliderGetRunStamp === 'function') {
        base += '_v' + window.__snowgliderGetRunStamp().physicsVersion;
      }
    } catch (e) { /* seam is best-effort */ }
    return (!tier || tier === 'blue') ? base : base + '_' + tier;
  }

  function installScoresModule() {
    window.ScoresModule = {
      initializeScores: function () {
        console.log("ScoresModule initialized in local mode (simplified)");
      },
      setCurrentUser: function () {
        console.log("ScoresModule: setCurrentUser called in local mode");
      },
      /** @param {number} time @param {string=} tier */
      recordScore: function (time, tier) {
        if (!isValidScoreTime(time)) {
          console.warn("Skipping local score record (Invalid time value):", time);
          return;
        }

        const key = localBestTimeKey(tier);
        const localBestTimeStr = localStorage.getItem(key);
        const localBestTime = localBestTimeStr ? parseFloat(localBestTimeStr) : null;
        // Inline (not isValidScoreTime) so the `typeof` check narrows localBestTime
        // from `number | null` to `number` for the `time < localBestTime` use below
        // under strictNullChecks.
        const hasValidLocalBest = typeof localBestTime === 'number' &&
          Number.isFinite(localBestTime) &&
          localBestTime >= MIN_VALID_SCORE_TIME &&
          localBestTime <= MAX_VALID_SCORE_TIME;
        if (localBestTimeStr && !hasValidLocalBest) {
          console.warn("Ignoring invalid local best time:", localBestTimeStr);
          localStorage.removeItem(key);
        }

        const isNewPersonalBest = !hasValidLocalBest || time < localBestTime;

        if (isNewPersonalBest) {
          localStorage.setItem(key, time.toString());
          // Run-provenance stamp (#400): mirror the module-graph write paths. This is
          // a CLASSIC script (no ES imports), so it reads the deliberate window seam
          // scene-setup publishes at module load; the seam is defined by finish time
          // (recordScore only runs after a full game session). Best-effort: absent
          // seam or blocked storage must never break local-mode score recording —
          // but a PREVIOUS run's sidecar must never survive to describe the NEW
          // time (Codex review PR #407): clear it first, so an absent seam or a
          // failed stamp write leaves the record unstamped, not mis-stamped.
          try {
            localStorage.removeItem(key + '_meta');
            if (typeof window.__snowgliderGetRunStamp === 'function') {
              localStorage.setItem(key + '_meta', JSON.stringify(window.__snowgliderGetRunStamp()));
            }
          } catch (e) { /* stamp is best-effort; the cleared sidecar stays cleared */ }
          console.log("New local best time recorded:", time);
        } else {
          console.log("Score recorded, but not a new local best time:", time);
        }
      },
      displayLeaderboard: function () {
        console.log("Leaderboard not available in local file mode");
        const leaderboardElement = document.getElementById('leaderboard');
        if (leaderboardElement) {
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable in local file mode</h3>';
        }
      },
      getLeaderboard: function () { return Promise.resolve([]); },
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
          localModeNotice.innerHTML = '&#127968; Local Mode<br>Auth disabled';
          authContainer.appendChild(localModeNotice);
        }
      },
      /** @param {number} time @param {import('../difficulty.js').Difficulty=} tier */
      recordScore: function (time, tier) {
        if (!isValidScoreTime(time)) {
          console.warn("Skipping local score record (Invalid time value):", time);
          return;
        }

        if (window.ScoresModule && typeof window.ScoresModule.recordScore === 'function') {
          window.ScoresModule.recordScore(time, tier);
        } else {
          localStorage.setItem(localBestTimeKey(tier), time.toString());
          console.log("Score recorded locally:", time);
        }
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
