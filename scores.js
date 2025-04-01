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
let firestore = null;
let analytics = null;
let currentUser = null;

/**
 * Initialize the scores module with Firebase services
 * @param {Object} firestoreInstance - Initialized Firestore instance
 * @param {Object} analyticsInstance - Initialized Analytics instance
 */
function initializeScores(firestoreInstance, analyticsInstance) {
  firestore = firestoreInstance;
  analytics = analyticsInstance;
  console.log("Scores module initialized:", 
    { firestore: !!firestore, analytics: !!analytics });
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
  // Guard clauses
  if (!firestore) {
    console.log("Skipping leaderboard update (Firestore unavailable).");
    return;
  }
  if (!userId) {
    console.warn("Skipping leaderboard update (User ID missing).");
    return;
  }
  if (typeof time !== 'number' || isNaN(time)) {
    console.warn("Skipping leaderboard update (Invalid time value):", time);
    return;
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
      // Handle potential Firestore unavailability
      if (error.code === 'permission-denied' || error.code === 'unavailable' ||
          error.code === 'failed-precondition') {
        console.warn("Firestore became unavailable during leaderboard update.");
        firestore = null;
        displayLeaderboard(); // Update UI to reflect unavailability
      }
    });
  } catch (error) {
    console.error("Unexpected error in updateLeaderboard:", error);
    firestore = null; // Assume Firestore is problematic
    displayLeaderboard();
  }
}

/**
 * Get leaderboard data (top 10 scores)
 * @returns {Promise<Array>} Promise resolving to array of score objects
 */
function getLeaderboard() {
  if (!firestore) {
    console.log("Cannot get leaderboard (Firestore unavailable).");
    return Promise.resolve([]); // Return empty array immediately
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
        // Handle potential Firestore unavailability
        if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
          console.warn("Firestore became unavailable fetching leaderboard.");
          firestore = null;
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
  if (!leaderboardElement) return; // Exit if element doesn't exist

  leaderboardElement.innerHTML = '<h3>Loading Leaderboard...</h3>'; // Initial state

  if (!firestore) {
    leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
    console.log("Displaying leaderboard unavailable message.");
    return;
  }

  getLeaderboard()
    .then(scores => {
      if (!firestore) { // Check again in case firestore became unavailable during getLeaderboard
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        return;
      }
      if (scores.length === 0) {
        leaderboardElement.innerHTML = '<h3>No scores recorded yet!</h3>';
        return;
      }

      let html = '<h3>Top 10 Times</h3><table>';
      html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';

      // Fetch user data for each score using the stored DocumentReference
      const userPromises = scores.map(score => {
        // Check if userRef is a valid DocumentReference
        if (!score.userRef || typeof score.userRef.path !== 'string') {
          console.warn("Invalid user reference in leaderboard score for:", score.userId);
          return Promise.resolve({ displayName: 'Unknown User', photoURL: null }); // Default data
        }
        return getDoc(score.userRef)
          .then(docSnap => {
            if (docSnap.exists()) {
              const userData = docSnap.data();
              return {
                // Use display name, fallback to 'Anonymous' if empty/missing
                displayName: userData.displayName || 'Anonymous',
                photoURL: userData.photoURL || null // Ensure photoURL is null if missing
              };
            } else {
              // Handle case where user document was deleted but leaderboard entry remains
              console.warn("User document not found for leaderboard entry:", score.userId);
              return { displayName: 'Unknown User', photoURL: null };
            }
          })
          .catch(error => {
            console.error("Error fetching user data for leaderboard entry:", score.userId, error);
            // Handle potential Firestore unavailability during user data fetch
            if (error.code === 'permission-denied' || error.code === 'unavailable' || error.code === 'failed-precondition') {
              console.warn("Firestore became unavailable fetching user data for leaderboard.");
              firestore = null; // Disable Firestore
              // We might want to re-render the leaderboard as unavailable here,
              // but for simplicity, we'll just show 'Error' for this user.
            }
            return { displayName: 'Error Loading', photoURL: null }; // Indicate error fetching this user
          });
      });

      // Wait for all user data fetches to complete
      Promise.all(userPromises)
        .then(users => {
          // Check firestore status again before rendering
          if (!firestore) {
            leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
            return;
          }
          scores.forEach((score, index) => {
            const user = users[index]; // Get the resolved user data
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
          console.log("Leaderboard display updated.");
        })
        .catch(error => {
          // This catch is for Promise.all itself, unlikely unless there's a programming error
          console.error("Error processing leaderboard user data:", error);
          leaderboardElement.innerHTML = '<h3>Error displaying leaderboard user data</h3>';
        });
    })
    .catch(error => {
      // Catch errors from the initial getLeaderboard() call
      console.error("Failed to get leaderboard data for display:", error);
      leaderboardElement.innerHTML = '<h3>Failed to load leaderboard</h3>';
      // If firestore became null during getLeaderboard, update message
      if (!firestore) {
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
      }
    });
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

    // Update Firestore only if user is signed in, Firestore is available, AND it's a new personal best
    if (currentUser && firestore && isNewPersonalBest) {
      console.log("Attempting to update Firestore with new best time:", time);
      updateUserBestTime(currentUser.uid, time); // This function handles leaderboard update too

      // Track new best time in Analytics (if available)
      if (analytics) {
        logEvent(analytics, 'new_high_score', { time: time });
      }
    } else {
      if (!currentUser) console.log("Skipping Firestore update: User not signed in.");
      if (!firestore) console.log("Skipping Firestore update: Firestore not available.");
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
 * Get the Firestore instance status
 * @returns {boolean} True if Firestore is available
 */
function isFirestoreAvailable() {
  return !!firestore;
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