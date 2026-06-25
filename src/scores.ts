/**
 * scores.ts - User scoring and leaderboard module for SnowGlider
 *
 * Phase 3.8 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
 * (implied for a real `.ts` file); the module keeps its existing Firebase-typed
 * JSDoc (TypeScript reads JSDoc in `.ts` too), so score validation, the
 * localStorage best-time store and the leaderboard sync/fallback stay byte-for-byte
 * unchanged (no TS syntax added). It loads via firebase-bootstrap's
 * `<script src="src/scores.js">` (Vite-dev resolves `.js`->`.ts`; the build emits
 * `dist/src/scores.js`); the headless scores test reads `src/scores.ts` now.
 *
 * This module handles player scoring, personal best tracking, and the global
 * leaderboard functionality. It was split from auth.js to provide better
 * separation of concerns.
 * 
 * Features:
 * - Best time tracking with localStorage
 * - Syncing best times to Firebase Firestore when authenticated
 * - Global leaderboard with top 10 player times
 * - Graceful handling of Firebase availability
 * - Complete service isolation from authentication
 * 
 * The module is designed to work both independently and in conjunction
 * with the auth.js module. It maintains backward compatibility with
 * existing code through the AuthModule interface.
 */

import {
  doc,
  setDoc,
  getDoc,
  collection,
  where,
  orderBy,
  query,
  limit,
  getDocs,
  serverTimestamp,
  type Firestore
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { logEvent, type Analytics } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js";
import type { User } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";

// Module state
let firestore: Firestore | null = null; // Local cache of firestore instance, updated by initializeScores
let analytics: Analytics | null = null;
let currentUser: User | null = null;

// The timed course runs from z=-15 to z=-195 (180 world metres). Four seconds is
// deliberately loose: it rejects timer/startup artifacts like 0.01s while allowing
// any physically plausible descent the current game can produce. Ten minutes is
// a generous upper bound for completed runs and matches the Firestore rules cap.
const MIN_VALID_SCORE_TIME = 4;
const MAX_VALID_SCORE_TIME = 600;

function isValidScoreTime(time: number) {
  return typeof time === 'number' &&
    Number.isFinite(time) &&
    time >= MIN_VALID_SCORE_TIME &&
    time <= MAX_VALID_SCORE_TIME;
}

function readLocalBestTime() {
  const localBestTimeStr = localStorage.getItem('snowgliderBestTime');
  if (!localBestTimeStr) {
    return null;
  }

  const localBestTime = parseFloat(localBestTimeStr);
  if (isValidScoreTime(localBestTime)) {
    return localBestTime;
  }

  console.warn("Ignoring invalid local best time:", localBestTimeStr);
  localStorage.removeItem('snowgliderBestTime');
  return null;
}

/**
 * Initialize the scores module with Firebase services
 * @param {Object|null} firestoreInstance - Initialized Firestore instance (or null)
 * @param {Object|null} analyticsInstance - Initialized Analytics instance (or null)
 */
function initializeScores(firestoreInstance: Firestore | null, analyticsInstance: Analytics | null) {
  firestore = firestoreInstance; // Update local cache
  analytics = analyticsInstance;
  console.log("Scores module initialized/updated:",
    { firestore: !!firestore, analytics: !!analytics });

  if (!firestore) {
    console.warn("ScoresModule received null Firestore instance.");
  } else {
    console.log("ScoresModule received valid Firestore instance.");
  }
}

/**
 * Set the current user for score tracking
 * @param {Object} user - Firebase auth user object
 */
function setCurrentUser(user: User | null) {
  currentUser = user;
}

function getActiveUser() {
  if (currentUser) {
    return currentUser;
  }

  const authModule = window.AuthModule;
  if (!authModule) {
    return null;
  }

  try {
    const authStateUser = authModule.getAuthState?.()?.user || authModule.getCurrentUser?.();
    // Anonymous "guest" users have no leaderboard identity: AuthModule still
    // reports them as signed in (so the UI shows logged-in chrome), but their best
    // time must stay local until they upgrade to a real provider (which reuses the
    // same uid and re-fires this path with isAnonymous === false). Skipping them
    // here ensures a guest finishing a run never writes to users/leaderboard.
    if (authStateUser && !authStateUser.isAnonymous) {
      currentUser = authStateUser;
      return authStateUser;
    }
  } catch (error) {
    console.warn("Unable to refresh current user from AuthModule:", error);
  }

  return null;
}

/**
 * Update user's best time in Firestore
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateUserBestTime(userId: string, time: number) {
  // Guard clauses
  if (!firestore) {
    console.log("Skipping best time update (Firestore unavailable).");
    return;
  }
  if (!userId) {
    console.warn("Skipping best time update (User ID missing).");
    return;
  }
  if (!isValidScoreTime(time)) {
    console.warn("Skipping best time update (Invalid time value):", time);
    return;
  }

  try {
    const userDocRef = doc(firestore, 'users', userId);

    // Read the stored best, then write only when this run ties or beats it. This is a
    // plain getDoc + setDoc, not a transaction: setDoc queues offline and flushes on
    // reconnect on its own, so a finish during a network blip still syncs without any
    // custom retry timer/backoff. The narrow read-then-write race (two tabs finishing
    // within the same few hundred ms) is self-healing — the next finish, or the on-login
    // syncUserData reconciliation in auth.js, re-applies the authoritative best.
    getDoc(userDocRef)
      .then(docSnap => {
        const storedBest = docSnap.exists() ? docSnap.data().bestTime : null;
        const hasStoredBest = isValidScoreTime(storedBest);
        if (storedBest !== null && !hasStoredBest) {
          console.warn(`Ignoring invalid stored best for user ${userId}:`, storedBest);
        }
        // The authoritative best is the better of the stored value and this run. This is
        // the value the leaderboard must reflect — never the raw run time, which may be
        // slower than a best already stored from another device/tab.
        const authoritativeBest = hasStoredBest ? Math.min(storedBest, time) : time;

        let userWrite;
        if (!hasStoredBest || time <= storedBest) {
          console.log(`Updating best time for user ${userId} to ${time}`);
          userWrite = setDoc(userDocRef, {
            bestTime: time,
            updatedAt: serverTimestamp() // Track when the best time was updated
          }, { merge: true });
        } else {
          console.log(`New time (${time}) is not better than stored best (${storedBest}). User doc unchanged.`);
          userWrite = Promise.resolve();
        }

        // Reconcile the leaderboard toward the authoritative best AFTER the user write
        // settles, in a SEPARATE write so a leaderboard-only permission/rule failure
        // can't abort the personal-best sync above. Chaining onto the setDoc promise
        // (rather than firing in parallel) is what makes an offline finish durable: when
        // setDoc stays queued until reconnect, the leaderboard read+write run only once
        // we are back online, so the backfill rides the SDK's own offline queue instead
        // of being dropped by an immediate read against an uncached leaderboard doc. We
        // still reconcile when the user write failed or was skipped, so a missing entry —
        // the original bug — is backfilled, and passing authoritativeBest (not the raw
        // run time) means a slower local run never downgrades the board.
        // Fire-and-forget: this backfill intentionally rides the SDK's offline
        // queue and is not awaited by the surrounding chain (see comment above).
        void userWrite
          .catch(error => console.warn("Best time write did not complete:", error))
          .then(() => updateLeaderboard(userId, authoritativeBest));
      })
      .catch(error => {
        // getDoc can reject when offline with nothing cached (or on a permission/rules
        // issue). Nothing is written now; the local best stays in localStorage and the
        // on-login syncUserData reconciliation re-applies it on the next sign-in.
        console.warn("Could not sync best time now; will reconcile on next sign-in.", error);
      });
  } catch (error) {
    console.error("Unexpected error in updateUserBestTime:", error);
  }
}

/**
 * Update the global leaderboard entry for a user (compare-and-write).
 *
 * Runs as a separate getDoc + setDoc from the user best-time write in updateUserBestTime,
 * so a leaderboard-only permission/rule failure does not abort the personal-best sync.
 * It writes only when this time improves (or creates) the entry, so a slower run never
 * downgrades a faster existing entry. The setDoc queues offline and flushes on reconnect.
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateLeaderboard(userId: string, time: number) {
  if (!isValidScoreTime(time)) {
    console.warn("Skipping leaderboard update (Invalid time value):", time);
    return;
  }

  // Check AuthModule first for availability
  if (!window.AuthModule?.isFirebaseAvailable?.().firestore) {
    console.log("Skipping leaderboard update (Firestore unavailable according to AuthModule).");
    if (firestore) {
        console.warn("updateLeaderboard: AuthModule reports unavailable, clearing local Firestore instance.");
        firestore = null; // Ensure local state matches AuthModule if it became unavailable
    }
    return;
  }
  // If AuthModule thinks it's available, but we don't have it locally, bail out;
  // doc() needs a valid Firestore instance.
  if (!firestore) {
      console.warn("updateLeaderboard: AuthModule reports Firestore available, but local instance is null. Skipping.");
      return;
  }

  try {
    // Reference to the user document (used as a foreign key in leaderboard)
    const userDocRef = doc(firestore, 'users', userId);
    // Use the user's UID as the document ID in the leaderboard collection
    const leaderboardDocRef = doc(firestore, 'leaderboard', userId);

    // Read the current entry, then write only when this time improves (or creates) it,
    // so a slower run can never downgrade a faster board entry.
    getDoc(leaderboardDocRef)
      .then(leaderboardSnap => {
        const leaderboardBest = leaderboardSnap.exists() ? leaderboardSnap.data().time : null;
        if (leaderboardBest !== null && !isValidScoreTime(leaderboardBest)) {
          console.warn(`Replacing invalid leaderboard entry for user ${userId}:`, leaderboardBest);
        }
        if (isValidScoreTime(leaderboardBest) && time > leaderboardBest) {
          console.log(`Leaderboard already has a faster entry for user ${userId}. No update needed.`);
          return;
        }
        console.log(`Updating leaderboard entry for user ${userId} with time ${time}`);
        setDoc(leaderboardDocRef, {
          user: userDocRef, // Store a reference to the user document
          time: time,
          achievedAt: serverTimestamp() // Record when this score was achieved/updated
        })
          .then(() => console.log("Leaderboard updated successfully for user:", userId))
          .catch(error => console.warn("Leaderboard write did not complete:", error));
      })
      .catch(error => {
        // Read failed (offline with nothing cached, permissions, etc.); skip this
        // update. The personal-best write above is unaffected, and the next finish or
        // the on-login syncUserData reconciliation re-applies the authoritative best.
        console.warn("Could not read leaderboard entry for comparison; skipping update.", error);
      });
  } catch (error) {
    console.error("Unexpected error in updateLeaderboard:", error);
  }
}

/**
 * Get leaderboard data (top 10 scores)
 * @returns {Promise<Array>} Promise resolving to array of score objects
 */
/** A leaderboard row assembled from a Firestore `leaderboard` document. */
interface LeaderboardScore {
  userId: string;     // the leaderboard document id (== the user's uid)
  time: number;       // best run time in seconds
  userRef: any;       // Firestore DocumentReference to the user doc (untyped DocumentData)
}

function getLeaderboard(): Promise<LeaderboardScore[]> {
  // Check AuthModule first for availability
   if (!window.AuthModule?.isFirebaseAvailable?.().firestore) {
    console.log("Cannot get leaderboard (Firestore unavailable according to AuthModule).");
     if (firestore) {
        console.warn("getLeaderboard: AuthModule reports unavailable, clearing local Firestore instance.");
        firestore = null; // Ensure local state matches AuthModule
    }
    return Promise.resolve([]);
  }
   // If AuthModule thinks it's available, but we don't have it locally, log warning.
   if (!firestore) {
       console.warn("getLeaderboard: AuthModule reports Firestore available, but local instance is null. Attempting fetch anyway.");
   }

  try {
    // firestore is non-null on the normal path; if AuthModule lied (warned above)
    // this best-effort call throws and is handled by the surrounding catch.
    const leaderboardRef = collection(firestore!, 'leaderboard');
    // Query for top 10 scores, ordered by time ascending
    const q = query(
      leaderboardRef,
      where('time', '>=', MIN_VALID_SCORE_TIME),
      orderBy('time', 'asc'),
      limit(10)
    );

    console.log("Fetching leaderboard data...");
    return getDocs(q)
      .then(snapshot => {
        const scores: LeaderboardScore[] = [];
        snapshot.forEach(docSnap => {
          const data = docSnap.data();
          // Ensure data has expected fields before pushing
          if (data && isValidScoreTime(data.time) && data.user) {
            scores.push({
              userId: docSnap.id, // The user ID is the document ID
              time: data.time,
              userRef: data.user // Store the DocumentReference to the user
            });
          } else {
            console.warn("Skipping invalid leaderboard entry:", docSnap.id, data);
          }
        });
        console.log("Leaderboard data fetched:", scores.length, "entries");
        return scores;
      })
      .catch(error => {
        console.error("Error fetching leaderboard:", error);
        // Only set Firestore to null for serious connectivity issues, not permissions
        if (error.code === 'unavailable' || error.code === 'failed-precondition') {
          console.warn("Firestore became unavailable fetching leaderboard. Clearing local instance.");
          firestore = null; // Set local instance to null
        } else if (error.code === 'permission-denied') {
          console.warn("Permission issues with Firestore leaderboard access. Continuing with limited functionality.");
          // Don't disable Firestore entirely for permission issues
        }
        return []; // Return empty array on error
      });
  } catch (error) {
    console.error("Unexpected error in getLeaderboard:", error);
    firestore = null; // Assume Firestore is problematic
    return Promise.resolve([]); // Return empty array
  }
}

/**
 * Display leaderboard in game over overlay
 */
function displayLeaderboard() {
  const leaderboardElement = document.getElementById('leaderboard');
  if (!leaderboardElement) return;

  leaderboardElement.innerHTML = '<h3>Loading Leaderboard...</h3>';

  if (!window.navigator.onLine) {
    leaderboardElement.innerHTML = '<h3>Leaderboard unavailable (offline)</h3>';
    return;
  }

  // --- Revised Logic ---
  const firestoreIsAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore ?? false;

  // Function to attempt fetching and rendering the leaderboard
  const attemptFetchAndRender = () => {
    // Double-check AuthModule status AND local instance before fetching
    if (!window.AuthModule?.isFirebaseAvailable?.().firestore || !firestore) {
        console.warn("attemptFetchAndRender: Pre-fetch check failed. Firestore unavailable.");
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        return; // Stop if unavailable before starting fetch
    }

    console.log("attemptFetchAndRender: Firestore available, fetching leaderboard...");
    getLeaderboard()
      .then(scores => {
        // Check availability *after* the async call, primarily the local instance
        // as getLeaderboard's catch block should have nulled it on error.
        if (!firestore) {
          console.warn("displayLeaderboard: Firestore became unavailable during getLeaderboard fetch.");
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
          return;
        }

        if (scores.length === 0) {
          leaderboardElement.innerHTML = '<h3>No scores recorded yet!</h3>';
          return;
        }

        // Fetch user data only if firestore is still available
        const userPromises = scores.map(score => {
          if (!firestore) { // Check before each user fetch
              console.warn("displayLeaderboard: Firestore became unavailable before fetching user data for", score.userId);
              return Promise.resolve({ displayName: 'Anonymous Player', photoURL: null });
          }
          if (!score.userRef || typeof score.userRef.path !== 'string') {
            console.warn("Invalid user reference in leaderboard score for:", score.userId);
            return Promise.resolve({ displayName: 'Anonymous Player', photoURL: null });
          }

          // Don't try to fetch user data for leaderboard entries - this appears to be causing permission issues
          // Instead, just use a generic player name with their position
          return Promise.resolve({ 
            displayName: 'Player',
            photoURL: null,
            userId: score.userId
          });
          
          /* Previous implementation with permissions issues:
          return getDoc(score.userRef)
            .then(docSnap => {
              if (docSnap.exists()) {
                const userData = docSnap.data();
                return {
                  displayName: userData.displayName || 'Anonymous',
                  photoURL: userData.photoURL || null
                };
              } else {
                console.warn("User document not found for leaderboard entry:", score.userId);
                return { displayName: 'Unknown User', photoURL: null };
              }
            })
            .catch(error => {
              console.error("Error fetching user data for leaderboard entry:", score.userId, error);
              if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
                console.warn("Firestore became unavailable fetching user data. Clearing local instance.");
                firestore = null; // Set local instance to null
              }
              return { displayName: 'Error Loading', photoURL: null };
            });
          */
        });

        return Promise.all(userPromises).then(users => ({ scores, users })); // Pass both scores and users
      })
      .then(result => {
        // Handle the case where getLeaderboard resolved but Firestore became unavailable during user fetches
        if (!result) return; // Exit if previous step returned nothing (e.g., Firestore became unavailable)
        
        // Continue showing leaderboard even if there were some user data issues
        // This ensures the leaderboard is displayed even with permissions problems

        const { scores, users } = result;
        const activeUser = getActiveUser();
        let html = '<h3>Top 10 Times</h3><table>';
        html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';

        scores.forEach((score, index) => {
          const user = users[index]!;
          // Show current user differently (match by userId)
          const isCurrentUser = activeUser && score.userId === activeUser.uid;
          const displayName = isCurrentUser ? 
            (activeUser.displayName || 'You') : 
            `${user.displayName} ${index + 1}`;
            
          html += `<tr class="${isCurrentUser ? 'current-user-score' : ''}">
            <td>${index + 1}</td>
            <td>
              ${user.photoURL ? `<img src="${user.photoURL}" alt="" class="mini-avatar">` : ''}
              ${displayName}
            </td>
            <td>${score.time.toFixed(2)}s</td>
          </tr>`;
        });

        html += '</table>';
        leaderboardElement.innerHTML = html;
        console.log("Leaderboard display updated successfully.");
      })
      .catch(error => {
        // Catch errors from getLeaderboard() OR Promise.all()
        console.error("Failed during leaderboard display process:", error);
        // Check local firestore status after the error
        if (!firestore) {
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        } else {
          // Firestore might still be technically available, but some other error occurred
          leaderboardElement.innerHTML = '<h3>Failed to load leaderboard data</h3>';
        }
      });
  }; // End of attemptFetchAndRender

  // --- Control Flow ---
  if (firestoreIsAvailable) {
    // If AuthModule says Firestore is available, ensure our local instance is synced.
    // initializeScores should have been called by AuthModule if it just became available.
    if (!firestore) {
        console.warn("displayLeaderboard: AuthModule reports Firestore available, but local instance is null. Attempting reinitialization first.");
        // Try re-initializing via AuthModule, which should call initializeScores on success
        if (window.AuthModule?.reinitializeFirestore?.()) {
            console.log("displayLeaderboard: Reinitialization successful via AuthModule. Fetching leaderboard.");
            // Re-check local instance after re-init attempt
            if (firestore) {
                attemptFetchAndRender();
            } else {
                 console.error("displayLeaderboard: Reinitialization reported success, but local Firestore still null. Leaderboard unavailable.");
                 leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
            }
        } else {
            console.error("displayLeaderboard: Reinitialization failed or AuthModule unavailable. Leaderboard unavailable.");
            leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        }
    } else {
        // AuthModule reports available AND we have a local instance.
        console.log("displayLeaderboard: Firestore available. Proceeding to fetch.");
        attemptFetchAndRender();
    }
  } else {
    console.log("displayLeaderboard: Firestore initially unavailable. Attempting reinitialization.");
    // Try to reinitialize if Firestore isn't available
    if (window.AuthModule?.reinitializeFirestore?.()) {
        console.log("displayLeaderboard: Reinitialization successful via AuthModule. Fetching leaderboard.");
         // Re-check local instance after re-init attempt
        if (firestore) {
            attemptFetchAndRender();
        } else {
             console.error("displayLeaderboard: Reinitialization reported success, but local Firestore still null. Leaderboard unavailable.");
             leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        }
    } else {
        console.error("displayLeaderboard: Reinitialization failed or AuthModule unavailable. Leaderboard unavailable.");
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
    }
  }
}

/**
 * Record a completed run score
 * @param {number} time - Run completion time in seconds
 */
function recordScore(time: number) {
  if (!isValidScoreTime(time)) {
    console.warn("Skipping score record (Invalid time value):", time);
    return;
  }

  // Always store locally first as a fallback and for immediate personal best tracking
  try {
    const localBestTime = readLocalBestTime();
    const isNewLocalBest = localBestTime === null || time < localBestTime;

    if (isNewLocalBest) {
      localStorage.setItem('snowgliderBestTime', time.toString());
      console.log("New local best time recorded:", time);
    } else {
      console.log("Score recorded, but not a new local best time:", time);
    }

    // The best time we want reflected on the leaderboard is the better of this run
    // and any previously stored local best. Syncing this value (rather than only the
    // current run) lets us backfill a best time that was recorded but never made it
    // to Firestore — e.g. a best set before sign-in or under an earlier bug. Without
    // this, a stored best could only reach the leaderboard by being beaten again.
    const effectiveBestTime = isNewLocalBest ? time : localBestTime;

    // Track completion in Analytics (if available)
    if (analytics) {
      logEvent(analytics, 'complete_run', { time: time });
    }

    // Read the signed-in user at record time so auth UI and scoring stay in sync.
    const userAtTimeOfRecord = getActiveUser();

    // If Firestore isn't available but should be, try to reinitialize it
    if (userAtTimeOfRecord && !firestore && window.navigator.onLine &&
        window.AuthModule && typeof window.AuthModule.reinitializeFirestore === 'function') {
      console.log("Firestore unavailable but user is online. Attempting to reinitialize...");
      window.AuthModule.reinitializeFirestore();
    }

    // Sync whenever the user is signed in and Firestore is available. updateUserBestTime
    // compares against the authoritative Firestore value and only writes when the time
    // is better than (or equal to) what is already stored, so syncing on every finish is
    // safe and never downgrades a faster stored time.
    if (userAtTimeOfRecord && firestore) {
      console.log("Attempting to sync best time to Firestore:", effectiveBestTime);
      // Use the snapshot of user data captured at function start time
      updateUserBestTime(userAtTimeOfRecord.uid, effectiveBestTime); // This function handles leaderboard update too

      // Track new best time in Analytics (if available)
      if (isNewLocalBest && analytics) {
        logEvent(analytics, 'new_high_score', { time: time });
      }
    } else {
      // Log reasons why Firestore update was skipped
      if (!userAtTimeOfRecord) console.log("Skipping Firestore update: User not signed in.");
      if (!firestore) {
        console.log("Skipping Firestore update: Firestore not available.");
        // Log additional diagnostic information
        if (window.navigator.onLine) {
          console.log("Device is online, but Firestore connection is unavailable. Authentication may have issues.");
        } else {
          console.log("Device appears to be offline. Check internet connection.");
        }
      }
    }

  } catch (error) {
    console.error("Error in recordScore:", error);
    // Attempt to save locally even if other parts fail
    try {
      if (isValidScoreTime(time)) {
        localStorage.setItem('snowgliderBestTime', time.toString());
      }
    } catch (e) {
      console.error("LocalStorage error during fallback save:", e);
    }
  }
}

/**
 * Check if Firestore is currently considered available.
 * Primarily checks AuthModule's status.
 * @returns {boolean}
 */
function isFirestoreAvailable() {
  // Trust AuthModule as the primary source of truth
  const authFirestoreAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore ?? false;
  // Also check our local instance hasn't been nulled due to a recent error
  return authFirestoreAvailable && !!firestore;
}

// Export ScoresModule
const ScoresModule = {
  initializeScores,
  setCurrentUser,
  recordScore,
  displayLeaderboard,
  getLeaderboard,
  updateUserBestTime,
  updateLeaderboard,
  isFirestoreAvailable,
  isValidScoreTime
};

// Export as both a module and a global for flexibility
export default ScoresModule;
window.ScoresModule = ScoresModule;

console.log("Scores module successfully loaded and exported");
