// auth.js - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK (Popup-only Google Sign-In)

// Prevent Firebase from trying to auto-init via init.json that gives 404 on GitHub Pages
window.FIREBASE_MANUAL_INIT = true;
window.__FIREBASE_DEFAULTS__ = {}; // Ensure this exists early

/**
 * Firebase Authentication Module for SnowGlider
 *
 * This module handles user authentication (Google Popup), profile management,
 * and score tracking using Firebase services.
 *
 * Features:
 * - Google authentication with signInWithPopup
 * - User profile management
 * - Best time tracking with Firebase Firestore
 * - Global leaderboard
 * - Graceful fallback to localStorage when Firestore is unavailable
 */

// Service instances initialized by initializeAuth
let auth;
let firestore;
let analytics;
let currentUser = null;
let firebaseApp = null; // Keep track of the app instance

// Import Firebase modules
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup, // Using popup exclusively
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
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
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";

// Initialize Firebase Auth
function initializeAuth(firebaseConfig) {
  try {
    // Fix potential storage bucket mismatch (keep this utility)
    if (firebaseConfig.storageBucket === "sn0wglider.firebasestorage.app") {
      firebaseConfig.storageBucket = "sn0wglider.appspot.com";
      console.log("Adjusted storageBucket to:", firebaseConfig.storageBucket);
    }

    // Initialize Firebase app and services
    console.log("Initializing new Firebase app instance in AuthModule");
    // Ensure __FIREBASE_DEFAULTS__ is set to prevent auto-init attempts
    if (!window.__FIREBASE_DEFAULTS__) {
        window.__FIREBASE_DEFAULTS__ = {};
    }
    window.__FIREBASE_DEFAULTS__.config = firebaseConfig;
    window.__FIREBASE_DEFAULTS__._authTokenSyncURL = null; // Prevent token sync attempts

    firebaseApp = initializeApp(firebaseConfig);
    console.log("Firebase App initialized successfully.");

    // Initialize services with error handling
    try {
      auth = getAuth(firebaseApp);
      console.log("Firebase Auth service obtained.");
    } catch (e) {
      console.error("Failed to initialize Auth:", e);
      auth = null; // Ensure auth is null if initialization fails
    }

    // Initialize Firestore (skip on localhost/file protocol)
    const isTrulyLocal = window.location.protocol === 'file:' ||
                         (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    console.log(`Environment Check: Protocol=${window.location.protocol}, Hostname=${window.location.hostname}, isTrulyLocal=${isTrulyLocal}`);

    if (!isTrulyLocal && auth) { // Only init Firestore if not local AND auth succeeded
      try {
        firestore = getFirestore(firebaseApp);
        console.log("Firestore initialized for remote host");
      } catch (e) {
        console.error("Failed to initialize Firestore:", e);
        firestore = null; // Ensure firestore is null if initialization fails
      }
    } else {
      console.warn(`Skipping Firestore: ${isTrulyLocal ? 'Local environment' : 'Auth failed'}`);
      firestore = null;
    }

    // Initialize Analytics (only if not local AND auth succeeded)
    if (!isTrulyLocal && auth) {
      try {
        analytics = getAnalytics(firebaseApp);
        console.log("Firebase Analytics service obtained.");
      } catch (e) {
        console.error("Failed to initialize Analytics:", e);
        analytics = null; // Ensure analytics is null if initialization fails
      }
    } else {
        console.warn(`Skipping Analytics: ${isTrulyLocal ? 'Local environment' : 'Auth failed'}`);
        analytics = null;
    }

    // Set up auth persistence and state observer
    if (auth) {
      console.log("Setting auth persistence...");
      setPersistence(auth, browserLocalPersistence)
        .then(() => console.log("Auth persistence set to browserLocalPersistence."))
        .catch(e => console.error("Error setting persistence:", e));

      // Set up auth state observer - This handles UI updates after login/logout
      console.log("Attaching onAuthStateChanged listener..."); // Log before attaching
      onAuthStateChanged(auth, user => {
        // --- Edit 1: Add detailed logging inside the callback ---
        console.log(">>> onAuthStateChanged triggered <<<"); // Log entry into the callback
        if (user) {
          // User is signed in
          console.log("Auth state changed: User IS signed in", user.uid, user.email);
          currentUser = user;
          console.log("Calling updateUIForLoggedInUser..."); // Log before UI update
          updateUIForLoggedInUser(user);
          if (firestore) {
            console.log("Calling syncUserData..."); // Log before sync
            syncUserData(user); // Sync data if firestore is available
          }
          console.log("Calling resetLoginButton..."); // Log before reset
          resetLoginButton(); // Ensure button is in default state after successful login
          console.log("Finished processing signed-in state in onAuthStateChanged."); // Log completion
        } else {
          // User is signed out
          console.log("Auth state changed: User IS signed out");
          currentUser = null;
          console.log("Calling updateUIForLoggedOutUser..."); // Log before UI update
          updateUIForLoggedOutUser();
          console.log("Calling resetLoginButton..."); // Log before reset
          resetLoginButton(); // Ensure button is in default state after logout
          console.log("Finished processing signed-out state in onAuthStateChanged."); // Log completion
        }
        // --- End Edit 1 ---
      });
      console.log("onAuthStateChanged listener attached successfully."); // Confirm attachment
    } else {
      // Handle case where auth failed to initialize
      console.error("Auth service failed to initialize. Auth features disabled.");
      updateUIForLoggedOutUser(); // Show logged-out state
      resetLoginButton(); // Ensure button is usable (though login will fail)
    }
  } catch (e) {
    // Catch errors during initializeApp or other setup steps
    console.error("Firebase setup failed:", e.message, e.stack);
    auth = firestore = analytics = null; // Ensure services are null on failure
    updateUIForLoggedOutUser();
    resetLoginButton();
  }

  // Set up login/logout buttons (even if auth failed, to avoid errors)
  setupAuthButtons();
}

// Update UI when user is logged in
function updateUIForLoggedInUser(user) {
  // --- Edit 2: Add logging inside UI update function ---
  console.log("updateUIForLoggedInUser: Attempting to update UI for", user?.email);
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  const profileName = document.getElementById('profileName');
  const profileAvatar = document.getElementById('profileAvatar');

  if (!authUI || !profileUI) {
    console.error("updateUIForLoggedInUser: Could not find authUI or profileUI elements!");
    return;
  }
  console.log("updateUIForLoggedInUser: Found UI elements.");

  // Update display
  authUI.style.display = 'none';
  profileUI.style.display = 'flex';
  console.log("updateUIForLoggedInUser: Set authUI display=none, profileUI display=flex");

  if (profileName) {
    profileName.textContent = user.displayName || user.email;
    console.log("updateUIForLoggedInUser: Set profile name to", profileName.textContent);
  } else {
    console.warn("updateUIForLoggedInUser: profileName element not found.");
  }

  // Set profile image if available
  if (profileAvatar) {
    if (user.photoURL) {
      profileAvatar.src = user.photoURL;
      profileAvatar.style.display = 'block';
      console.log("updateUIForLoggedInUser: Set profile avatar src to", user.photoURL);
    } else {
      profileAvatar.style.display = 'none';
      console.log("updateUIForLoggedInUser: Hiding profile avatar (no photoURL).");
    }
  } else {
     console.warn("updateUIForLoggedInUser: profileAvatar element not found.");
  }
  console.log("updateUIForLoggedInUser: UI update complete.");
  // --- End Edit 2 ---
}

// Update UI when user is logged out
function updateUIForLoggedOutUser() {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  
  if (!authUI || !profileUI) return;
  
  authUI.style.display = 'flex';
  profileUI.style.display = 'none';
}

// Reset login button to default state
function resetLoginButton() {
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.textContent = 'Login with Google';
    loginBtn.disabled = false;
    loginBtn.classList.remove('signing-in');
    // No longer need 'retry-auth' class related to redirect failures
    loginBtn.classList.remove('retry-auth');
  }
}

// Set up login/logout button handlers
function setupAuthButtons() {
  // Login button
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    // Function to handle sign-in process using Popup
    const handleSignIn = (e) => {
      e.preventDefault(); // Prevent default button action

      // Check if auth is available before attempting login
      if (!auth) {
          console.error("Auth service not available. Cannot sign in.");
          alert("Authentication service is currently unavailable. Please try again later.");
          resetLoginButton(); // Reset button state
          return;
      }

      // Update button state
      loginBtn.textContent = 'Signing In...';
      loginBtn.disabled = true;
      loginBtn.classList.add('signing-in');

      console.log("Sign-in initiated via", e.type);

      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      provider.setCustomParameters({ 'prompt': 'select_account' }); // Prompt user to select account

      console.log("Using signInWithPopup for authentication.");
      signInWithPopup(auth, provider)
        .then(result => {
          // Success is primarily handled by onAuthStateChanged listener
          console.log("Popup sign-in successful for:", result.user.email);
          if (analytics) {
            logEvent(analytics, 'login', { method: 'GooglePopup' });
          }
          // No need to reset button here; onAuthStateChanged will update UI
        })
        .catch(error => {
          console.error("signInWithPopup error:", error.code, error.message);
          // Provide user feedback for common errors
          if (error.code === 'auth/popup-blocked') {
             alert('Popup blocked by browser. Please allow popups for this site and try again.');
          } else if (error.code === 'auth/popup-closed-by-user') {
             console.log('Sign-in cancelled: Popup closed by user.');
             // Optionally provide non-alert feedback (e.g., update a status div)
          } else {
             // Generic error message for other issues
             alert(`Error during sign-in: ${error.message}`);
          }
          // Reset button on any popup error to allow retry
          resetLoginButton();
        });
    };

    // Add listeners for both touch and click for broad compatibility
    loginBtn.addEventListener('touchstart', handleSignIn, { passive: false });
    loginBtn.addEventListener('click', handleSignIn);
  }

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    // Prevent default touch behavior if needed
    logoutBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
    }, { passive: false });

    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();

      // Check if auth is available before attempting logout
      if (!auth) {
          console.error("Auth service not available. Cannot sign out.");
          // UI should already reflect signed-out state if auth failed init
          return;
      }

      // Update button state during sign-out
      logoutBtn.textContent = 'Signing Out...';
      logoutBtn.disabled = true;

      // Sign out using Firebase function
      firebaseSignOut(auth)
        .then(() => {
            // Success is primarily handled by onAuthStateChanged listener
            console.log("Successfully signed out via button click.");
        })
        .catch(error => {
            console.error("Logout error:", error);
            alert(`Error signing out: ${error.message}`); // Inform user of logout error
        })
        .finally(() => {
          // Reset button state regardless of success/failure
          // Note: onAuthStateChanged will also trigger UI updates
          logoutBtn.disabled = false;
          logoutBtn.textContent = 'Logout';
        });
    });
  }
}

// Sync user data with Firestore (only if firestore is available)
function syncUserData(user) {
  if (!firestore || !user) {
      console.log("Skipping user data sync (Firestore unavailable or no user).");
      return;
  }

  try {
    const userDocRef = doc(firestore, 'users', user.uid);
    // Use setDoc with merge:true to create or update user profile
    setDoc(userDocRef, {
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      lastLogin: serverTimestamp() // Record last login time
    }, { merge: true })
    .then(() => {
        console.log("User data synced/updated in Firestore for:", user.uid);
        // Sync best time from localStorage after user data is confirmed/created
        const localBestTime = localStorage.getItem('snowgliderBestTime');
        if (localBestTime) {
            const bestTime = parseFloat(localBestTime);
            console.log("Found local best time, attempting to sync:", bestTime);
            updateUserBestTime(user.uid, bestTime); // Pass user ID
        }
    })
    .catch(error => {
      console.error("Error saving user data to Firestore:", error);
      // Handle potential Firestore unavailability errors
      if (error.code === 'permission-denied' || error.code === 'unavailable' ||
          error.code === 'failed-precondition') {
        console.warn("Firestore became unavailable during user data sync. Disabling Firestore features.");
        firestore = null; // Disable Firestore for subsequent operations
        displayLeaderboard(); // Update leaderboard display to show unavailable state
      }
    });
  } catch (error) {
    // Catch synchronous errors, though unlikely here
    console.error("Unexpected error in syncUserData:", error);
    firestore = null; // Assume Firestore is problematic
    displayLeaderboard();
  }
}

// Update user's best time in Firestore (only if firestore is available)
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
          // Use updateDoc if exists, setDoc if not (though setDoc with merge in syncUserData should handle creation)
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

// Update global leaderboard (only if firestore is available)
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

// Get leaderboard data (top 10 scores)
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

// Display leaderboard in game over overlay
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

// Record a completed run score
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
      updateUserBestTime(currentUser.uid, time); // This function now handles leaderboard update too

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
 * Gets the currently signed-in user object from Firebase Auth.
 * @returns {firebase.User|null} The current user object or null.
 */
function getCurrentUser() {
  return currentUser;
}

/**
 * Checks if a user is currently signed in.
 * @returns {boolean} True if a user is signed in, false otherwise.
 */
function isUserSignedIn() {
  return !!currentUser;
}

/**
 * Gets the user's ID token for server authentication (if needed).
 * @param {boolean} [forceRefresh=false] - Whether to force a token refresh.
 * @returns {Promise<string|null>} Promise resolving with the ID token, or null if no user. Rejects on error.
 */
function getUserIdToken(forceRefresh = false) {
    if (!currentUser) {
      console.log("Cannot get ID token: No user signed in.");
      return Promise.resolve(null); // Resolve with null instead of rejecting
    }

    return currentUser.getIdToken(forceRefresh)
      .then(idToken => {
          console.log("ID token retrieved successfully.");
          return idToken;
      })
      .catch(error => {
        console.error('Error getting ID token:', error);
        throw error; // Re-throw the error for the caller to handle
      });
}

// --- AuthModule Export ---
const AuthModule = {
  initializeAuth,
  recordScore,
  displayLeaderboard,
  getCurrentUser,
  isUserSignedIn,
  getUserIdToken,

  // Export utilities for debugging or potential external use
  signOut: () => { // Provide a direct way to sign out if needed
    if (auth) {
      return firebaseSignOut(auth);
    }
    console.warn("Cannot sign out: Auth service not available.");
    return Promise.resolve(); // Resolve immediately if auth isn't available
  },
  getAuthState: () => ({ // Get current auth state synchronously
    user: currentUser,
    isSignedIn: !!currentUser
  }),
  isFirebaseAvailable: () => ({ // Check availability of services
    auth: !!auth,
    firestore: !!firestore,
    analytics: !!analytics
  })
};

// Export as both a module and a global for flexibility
export default AuthModule;
window.AuthModule = AuthModule;

console.log("Auth module (popup-only) successfully loaded and exported");