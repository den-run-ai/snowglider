/**
 * scores.js - User scoring and leaderboard module for SnowGlider
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
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  orderBy,
  query,
  limit,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js";

// Module state
let firestore = null; // Local cache of firestore instance, updated by initializeScores
let analytics = null;
let currentUser = null;

/**
 * Initialize the scores module with Firebase services
 * @param {Object|null} firestoreInstance - Initialized Firestore instance (or null)
 * @param {Object|null} analyticsInstance - Initialized Analytics instance (or null)
 */
function initializeScores(firestoreInstance, analyticsInstance) {
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
function setCurrentUser(user) {
  currentUser = user;
}

/**
 * Update user's best time in Firestore
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateUserBestTime(userId, time) {
  // Guard clauses
  if (!firestore) {
    console.log("Skipping best time update (Firestore unavailable).");
    return;
  }
  if (!userId) {
    console.warn("Skipping best time update (User ID missing).");
    return;
  }
  if (typeof time !== 'number' || isNaN(time)) {
    console.warn("Skipping best time update (Invalid time value):", time);
    return;
  }

  try {
    const userDocRef = doc(firestore, 'users', userId);
    getDoc(userDocRef)
      .then(docSnap => {
        let shouldUpdate = false;
        if (docSnap.exists()) {
          const userData = docSnap.data();
          // Update only if new time is better or no time exists yet
          if (!userData.bestTime || time < userData.bestTime) {
            shouldUpdate = true;
          }
        } else {
          // If user document doesn't exist (should be rare after syncUserData),
          // assume this is the first time, so update.
          console.warn("User document not found for best time update, will create/set time.");
          shouldUpdate = true; // Treat as a new best time
        }

        if (shouldUpdate) {
          console.log(`Updating best time for user ${userId} to ${time}`);
          // Using updateDoc is slightly safer if we only want to add/modify bestTime fields
          updateDoc(userDocRef, {
            bestTime: time,
            updatedAt: serverTimestamp() // Track when the best time was updated
          })
          .then(() => {
            console.log("Best time updated successfully in user document.");
            updateLeaderboard(userId, time); // Update leaderboard only after successful user doc update
          })
          .catch(error => {
            console.error("Error updating best time in user document:", error);
            // Handle potential Firestore unavailability
            if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
              console.warn("Firestore became unavailable during best time update.");
              firestore = null;
              displayLeaderboard();
            }
          });
        } else {
          console.log(`New time (${time}) is not better than existing best time. No update needed.`);
        }
      })
      .catch(error => {
        console.error("Error reading user data for best time comparison:", error);
        if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
          console.warn("Firestore became unavailable reading user data.");
          firestore = null;
          displayLeaderboard();
        }
      });
  } catch (error) {
    console.error("Unexpected error in updateUserBestTime:", error);
    firestore = null; // Assume Firestore is problematic
    displayLeaderboard();
  }
}

/**
 * Update global leaderboard
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateLeaderboard(userId, time) {
  // Check AuthModule first for availability
  if (!window.AuthModule?.isFirebaseAvailable?.().firestore) {
    console.log("Skipping leaderboard update (Firestore unavailable according to AuthModule).");
    if (firestore) {
        console.warn("updateLeaderboard: AuthModule reports unavailable, clearing local Firestore instance.");
        firestore = null; // Ensure local state matches AuthModule if it became unavailable
    }
    return;
  }
  // If AuthModule thinks it's available, but we don't have it locally, log warning.
  // The operation might fail, and the catch block will handle setting local firestore to null.
  if (!firestore) {
      console.warn("updateLeaderboard: AuthModule reports Firestore available, but local instance is null. Proceeding cautiously.");
  }

  try {
    // Reference to the user document (used as a foreign key in leaderboard)
    const userDocRef = doc(firestore, 'users', userId);
    // Use the user's UID as the document ID in the leaderboard collection
    const leaderboardDocRef = doc(firestore, 'leaderboard', userId);

    console.log(`Updating leaderboard entry for user ${userId} with time ${time}`);
    // Use setDoc to create or overwrite the user's entry in the leaderboard
    setDoc(leaderboardDocRef, {
      user: userDocRef, // Store a reference to the user document
      time: time,
      achievedAt: serverTimestamp() // Record when this score was achieved/updated
    })
    .then(() => {
      console.log("Leaderboard updated successfully for user:", userId);
    })
    .catch(error => {
      console.error("Error updating leaderboard:", error);
      if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
        console.warn("Firestore became unavailable during leaderboard update. Clearing local instance.");
        firestore = null; // Set local instance to null
      }
    });
  } catch (error) {
    console.error("Unexpected error in updateLeaderboard:", error);
    firestore = null; // Assume Firestore is problematic
  }
}

/**
 * Get leaderboard data (top 10 scores)
 * @returns {Promise<Array>} Promise resolving to array of score objects
 */
function getLeaderboard() {
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
    const leaderboardRef = collection(firestore, 'leaderboard');
    // Query for top 10 scores, ordered by time ascending
    const q = query(leaderboardRef, orderBy('time', 'asc'), limit(10));

    console.log("Fetching leaderboard data...");
    return getDocs(q)
      .then(snapshot => {
        const scores = [];
        snapshot.forEach(docSnap => {
          const data = docSnap.data();
          // Ensure data has expected fields before pushing
          if (data && typeof data.time === 'number' && data.user) {
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
        if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
          console.warn("Firestore became unavailable fetching leaderboard. Clearing local instance.");
          firestore = null; // Set local instance to null
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
  let firestoreIsAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore ?? false;

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

        let html = '<h3>Top 10 Times</h3><table>';
        html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';

        // Fetch user data only if firestore is still available
        const userPromises = scores.map(score => {
          if (!firestore) { // Check before each user fetch
              console.warn("displayLeaderboard: Firestore became unavailable before fetching user data for", score.userId);
              return Promise.resolve({ displayName: 'Error Loading', photoURL: null });
          }
          if (!score.userRef || typeof score.userRef.path !== 'string') {
            console.warn("Invalid user reference in leaderboard score for:", score.userId);
            return Promise.resolve({ displayName: 'Unknown User', photoURL: null });
          }

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
        });

        return Promise.all(userPromises).then(users => ({ scores, users })); // Pass both scores and users
      })
      .then(result => {
        // Handle the case where getLeaderboard resolved but Firestore became unavailable during user fetches
        if (!result) return; // Exit if previous step returned nothing (e.g., Firestore became unavailable)
        if (!firestore) {
            console.warn("displayLeaderboard: Firestore became unavailable during user data fetches.");
            leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
            return;
        }

        const { scores, users } = result;
        let html = '<h3>Top 10 Times</h3><table>';
        html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';

        scores.forEach((score, index) => {
          const user = users[index];
          html += `<tr>
            <td>${index + 1}</td>
            <td>
              ${user.photoURL ? `<img src="${user.photoURL}" alt="" class="mini-avatar">` : ''}
              ${user.displayName}
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
function recordScore(time) {
  // Always store locally first as a fallback and for immediate personal best tracking
  try {
    const localBestTimeStr = localStorage.getItem('snowgliderBestTime');
    const localBestTime = localBestTimeStr ? parseFloat(localBestTimeStr) : null;
    const isNewPersonalBest = localBestTime === null || time < localBestTime;

    if (isNewPersonalBest) {
      localStorage.setItem('snowgliderBestTime', time.toString());
      console.log("New local best time recorded:", time);
    } else {
      console.log("Score recorded, but not a new local best time:", time);
    }

    // Track completion in Analytics (if available)
    if (analytics) {
      logEvent(analytics, 'complete_run', { time: time });
    }

    // Create a local copy of the user reference to prevent race conditions
    const userAtTimeOfRecord = currentUser ? {...currentUser} : null;
    
    // If Firestore isn't available but should be, try to reinitialize it
    if (userAtTimeOfRecord && !firestore && window.navigator.onLine && 
        window.AuthModule && typeof window.AuthModule.reinitializeFirestore === 'function') {
      console.log("Firestore unavailable but user is online. Attempting to reinitialize...");
      window.AuthModule.reinitializeFirestore();
    }
    
    // Update Firestore only if user is signed in, Firestore is available, AND it's a new personal best
    if (userAtTimeOfRecord && firestore && isNewPersonalBest) {
      console.log("Attempting to update Firestore with new best time:", time);
      // Use the snapshot of user data captured at function start time
      updateUserBestTime(userAtTimeOfRecord.uid, time); // This function handles leaderboard update too

      // Track new best time in Analytics (if available)
      if (analytics) {
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
      if (!isNewPersonalBest) console.log("Skipping Firestore update: Not a new personal best.");
    }

  } catch (error) {
    console.error("Error in recordScore:", error);
    // Attempt to save locally even if other parts fail
    try {
      localStorage.setItem('snowgliderBestTime', time.toString());
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
  isFirestoreAvailable
};

// Export as both a module and a global for flexibility
export default ScoresModule;
window.ScoresModule = ScoresModule;

console.log("Scores module successfully loaded and exported");