// auth.ts - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK (Popup-only Google Sign-In)
//
// Phase 3.8 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file). The module keeps its existing Firebase-typed
// JSDoc (`@param`/`@returns` with `import('firebase/auth').*` etc.) — TypeScript
// reads JSDoc type annotations in `.ts` files too, so the popup-only auth flow and
// the localStorage fallback stay byte-for-byte unchanged (no TS syntax added).
// It still loads via firebase-bootstrap's `<script src="src/auth.js">` (Vite-dev
// resolves `.js`->`.ts`; the build emits `dist/src/auth.js`), and the headless
// auth test reads `src/auth.ts` now (Node does not remap `.js`->`.ts`).

// Prevent Firebase from trying to auto-init via init.json that gives 404 on GitHub Pages
window.FIREBASE_MANUAL_INIT = true;
window.__FIREBASE_DEFAULTS__ = {}; // Ensure this exists early

/**
 * Firebase Authentication Module for SnowGlider
 *
 * This module handles user authentication (Google Popup) and profile management.
 * Score tracking and leaderboard functionality have been moved to scores.js.
 *
 * Features:
 * - Google authentication with signInWithPopup
 * - User profile management
 * - Integration with ScoresModule for best time tracking
 */

// Service instances initialized by initializeAuth
let auth;
let firestore;
let analytics;
let currentUser: User | null = null;
let firebaseApp: FirebaseApp | null = null; // Keep track of the app instance

// Import Firebase modules
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup, // Using popup exclusively
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  type User,
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js";
import { initializeApp, type FirebaseApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import ScoresModule from "./scores.js";

// Initialize Firebase Auth
function initializeAuth(firebaseConfig) {
  try {
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

    // Initialize ScoresModule with Firestore and Analytics instances
    ScoresModule.initializeScores(firestore, analytics);

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
          
          // Update user in ScoresModule AFTER UI updates to ensure proper sequence
          console.log("Updating ScoresModule with current user..."); // Log before update
          ScoresModule.setCurrentUser(user);
          
          if (firestore) {
            // Use setTimeout to ensure auth state is fully stabilized before syncing
            setTimeout(() => {
              console.log("Calling syncUserData with delay..."); // Log before sync
              syncUserData(user); // Sync data if firestore is available
            }, 100); // Small delay to ensure auth state stabilizes
          }
          console.log("Calling resetLoginButton..."); // Log before reset
          resetLoginButton(); // Ensure button is in default state after successful login
          console.log("Finished processing signed-in state in onAuthStateChanged."); // Log completion
        } else {
          // User is signed out
          console.log("Auth state changed: User IS signed out");
          currentUser = null;
          
          // Clear user in ScoresModule
          ScoresModule.setCurrentUser(null);
          
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
  const profileAvatar = document.getElementById('profileAvatar') as HTMLImageElement;

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
  const loginBtn = document.getElementById('loginBtn') as HTMLButtonElement;
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
  const loginBtn = document.getElementById('loginBtn') as HTMLButtonElement;
  if (loginBtn) {
    // Function to handle sign-in process using Popup
    const handleSignIn = (e) => {
      if (e) e.preventDefault(); // Prevent default button action

      // Ignore repeat taps while a sign-in is already in flight. The button is
      // disabled below, but this also guards against any environment that fires
      // a second activation before the disabled state takes effect.
      if (loginBtn.disabled) {
        return;
      }

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

      console.log("Sign-in initiated via", e ? e.type : 'programmatic');

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
          } else if (error.code === 'auth/popup-closed-by-user' ||
                     error.code === 'auth/cancelled-popup-request') {
             // Benign: the user closed the popup, or a second sign-in superseded
             // this one (rapid double-tap). Don't alert — just allow a retry.
             console.log('Sign-in cancelled (popup closed or superseded):', error.code);
          } else {
             // Generic error message for other issues
             alert(`Error during sign-in: ${error.message}`);
          }
          // Reset button on any popup error to allow retry
          resetLoginButton();
        });
    };

    // Sign-in must work on both desktop and touch. We bind 'touchend' AND 'click':
    //  - On the game page, Controls.setupControls() (controls.js) installs a
    //    document-level touchstart preventDefault, which suppresses the synthetic
    //    click on this button — so a 'click'-only handler would never fire after the
    //    game scripts load. 'touchend' is a valid user-activation gesture for
    //    signInWithPopup that the global handler does NOT suppress.
    //  - On desktop (no touch) only 'click' fires.
    // handleSignIn calls preventDefault() (so the touchend tap won't also emit a
    // click) and bails while the button is disabled, so the pair can't open two
    // popups. We deliberately use 'touchend', not 'touchstart': touchstart fires
    // before the tap completes and is a weaker popup gesture on iOS.
    loginBtn.addEventListener('click', handleSignIn);
    loginBtn.addEventListener('touchend', handleSignIn, { passive: false });
  }

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement;
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
        if (!ScoresModule.isValidScoreTime(bestTime)) {
          console.warn("Ignoring invalid local best time during sign-in sync:", localBestTime);
          localStorage.removeItem('snowgliderBestTime');
          return;
        }
        console.log("Found local best time, attempting to sync:", bestTime);
        // Use ScoresModule to update best time
        ScoresModule.updateUserBestTime(user.uid, bestTime);
      }
    })
    .catch(error => {
      console.error("Error saving user data to Firestore:", error);
      // Handle potential Firestore unavailability errors
      if (error.code === 'permission-denied' || error.code === 'unavailable' ||
          error.code === 'failed-precondition') {
        console.warn("Firestore became unavailable during user data sync. Disabling Firestore features.");
        firestore = null; // Disable Firestore for subsequent operations
        // Update ScoresModule about Firestore unavailability
        ScoresModule.initializeScores(null, analytics);
        // Display leaderboard with unavailable message
        ScoresModule.displayLeaderboard();
      }
    });
  } catch (error) {
    // Catch synchronous errors, though unlikely here
    console.error("Unexpected error in syncUserData:", error);
    firestore = null; // Assume Firestore is problematic
    // Update ScoresModule about Firestore unavailability
    ScoresModule.initializeScores(null, analytics);
    ScoresModule.displayLeaderboard();
  }
}

/**
 * Gets the currently signed-in user object from Firebase Auth.
 * @returns {import('firebase/auth').User | null} The current user object or null.
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

/**
 * Attempts to reinitialize Firestore connection if it was lost
 * @returns {boolean} True if Firestore is now available, false otherwise
 */
function reinitializeFirestore() {
  console.log("Attempting to reinitialize Firestore connection...");
  
  if (!firebaseApp) {
    console.warn("Cannot reinitialize Firestore: No Firebase app instance");
    return false;
  }
  
  if (firestore) {
    console.log("Firestore is already available, no need to reinitialize");
    return true;
  }
  
  try {
    // Initialize Firestore (skip on localhost/file protocol)
    const isTrulyLocal = window.location.protocol === 'file:' ||
                         (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    
    if (!isTrulyLocal && auth) {
      try {
        firestore = getFirestore(firebaseApp);
        console.log("Firestore successfully reinitialized");
        
        // Update ScoresModule with new Firestore instance
        if (ScoresModule && typeof ScoresModule.initializeScores === 'function') {
          ScoresModule.initializeScores(firestore, analytics);
          console.log("ScoresModule updated with reinitialized Firestore");
        }
        
        return true;
      } catch (e) {
        console.error("Failed to reinitialize Firestore:", e);
        firestore = null;
        return false;
      }
    } else {
      console.warn(`Cannot reinitialize Firestore: ${isTrulyLocal ? 'Local environment' : 'Auth failed'}`);
      return false;
    }
  } catch (error) {
    console.error("Error in reinitializeFirestore:", error);
    return false;
  }
}

// --- AuthModule Export ---
const AuthModule = {
  initializeAuth,
  getCurrentUser,
  isUserSignedIn,
  getUserIdToken,
  reinitializeFirestore, // Add the new function

  // Delegated methods to ScoresModule 
  recordScore: (time) => ScoresModule.recordScore(time),
  displayLeaderboard: () => ScoresModule.displayLeaderboard(),
  
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
