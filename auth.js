// auth.js - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK

// Prevent Firebase from trying to auto-init via init.json that gives 404 on GitHub Pages
window.FIREBASE_MANUAL_INIT = true;
window.__FIREBASE_DEFAULTS__ = {};

/**
 * Firebase Authentication Module for SnowGlider
 * 
 * This module handles user authentication, profile management,
 * and score tracking using Firebase services.
 * 
 * Features:
 * - Google authentication with adaptive sign-in (popup for desktop, redirect for mobile)
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

// Import Firebase modules
import { 
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  getRedirectResult
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
    // Fix potential storage bucket mismatch
    if (firebaseConfig.storageBucket === "sn0wglider.firebasestorage.app") {
      firebaseConfig.storageBucket = "sn0wglider.appspot.com";
    }
    
    // Initialize Firebase app and services
    let app;
    if (window.firebaseModules && window.firebaseModules.app) {
      console.log("Using existing Firebase app instance");
      app = window.firebaseModules.app;
    } else {
      console.log("Initializing new Firebase app instance");
      app = initializeApp(firebaseConfig);
    }
    
    // Initialize services with error handling
    try {
      auth = getAuth(app);
    } catch (e) {
      console.error("Failed to initialize Auth:", e);
      auth = null;
    }
    
    // Initialize Firestore (skip on localhost/file protocol)
    const isLocalhost = window.location.protocol === 'file:' || 
                       window.location.hostname.includes('localhost') || 
                       window.location.hostname.includes('127.0.0.1');
    
    if (!isLocalhost) {
      try {
        firestore = getFirestore(app);
        console.log("Firestore initialized for remote host");
      } catch (e) {
        console.error("Failed to initialize Firestore:", e);
        firestore = null;
      }
    } else {
      console.warn("Skipping Firestore on local environment");
      firestore = null;
    }
    
    // Initialize Analytics
    try {
      analytics = getAnalytics(app);
    } catch (e) {
      console.error("Failed to initialize Analytics:", e);
      analytics = null;
    }
    
    // Set up auth persistence
    if (auth) {
      setPersistence(auth, browserLocalPersistence)
        .catch(e => console.error("Error setting persistence:", e));
      
      // Check for redirect authentication result
      try {
        getRedirectResult(auth)
          .then(result => {
            if (result && result.user) {
              console.log("User signed in via redirect:", result.user.displayName || result.user.email);
              currentUser = result.user;
              updateUIForLoggedInUser(result.user);
              // Clear all redirect related flags
              localStorage.removeItem('authRedirectAttempts');
              localStorage.removeItem('snowglider_auth_redirect_pending');
              localStorage.setItem('snowglider_auth_last_signin', Date.now().toString());
            } else {
              // Check if a redirect was attempted but no result
              const redirectPending = localStorage.getItem('snowglider_auth_redirect_pending');
              if (redirectPending === 'true') {
                console.log("A redirect auth was previously attempted but no user result returned");
                // Only clear if it's been more than 2 minutes since redirect
                const redirectTime = parseInt(localStorage.getItem('snowglider_auth_redirect_time') || '0');
                if (Date.now() - redirectTime > 120000) { // 2 minutes timeout
                  localStorage.removeItem('snowglider_auth_redirect_pending');
                  localStorage.removeItem('snowglider_auth_redirect_time');
                }
              }
            }
          })
          .catch(error => {
            console.error("Redirect result error:", error.code, error.message);
            resetLoginButton();
            // Clean up redirect indicators on error
            localStorage.removeItem('snowglider_auth_redirect_pending');
          });
      } catch (e) {
        console.error("Error checking redirect result:", e);
        // We continue normal flow even if there's an error here
      }
    }
    
    // Set up auth state observer
    if (auth) {
      onAuthStateChanged(auth, user => {
        if (user) {
          // User is signed in
          console.log("Auth state changed: User is signed in", user.uid);
          currentUser = user;
          updateUIForLoggedInUser(user);
          
          // For mobile redirect authentication, update redirect status
          const redirectPending = localStorage.getItem('snowglider_auth_redirect_pending');
          if (redirectPending === 'true') {
            console.log("Clearing redirect pending flag after successful sign-in");
            localStorage.removeItem('snowglider_auth_redirect_pending');
            localStorage.removeItem('snowglider_auth_redirect_time');
            localStorage.setItem('snowglider_auth_success', 'true');
          }
          
          if (firestore) {
            syncUserData(user);
          }
          
          // Log analytics event
          if (analytics) {
            logEvent(analytics, 'login', {
              method: user.providerData && user.providerData.length > 0 ? 
                      user.providerData[0].providerId : 'Unknown'
            });
          }
        } else {
          // User is signed out
          console.log("Auth state changed: User is signed out");
          currentUser = null;
          updateUIForLoggedOutUser();
        }
      });
    } else {
      updateUIForLoggedOutUser();
    }
  } catch (e) {
    console.error("Firebase setup failed:", e.message);
  }
  
  // Set up login/logout buttons
  setupAuthButtons();
}

// Update UI when user is logged in
function updateUIForLoggedInUser(user) {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  const profileName = document.getElementById('profileName');
  const profileAvatar = document.getElementById('profileAvatar');
  
  if (!authUI || !profileUI) return;
  
  // Update display
  authUI.style.display = 'none';
  profileUI.style.display = 'flex';
  
  if (profileName) {
    profileName.textContent = user.displayName || user.email;
  }
  
  // Set profile image if available
  if (profileAvatar) {
    if (user.photoURL) {
      profileAvatar.src = user.photoURL;
      profileAvatar.style.display = 'block';
    } else {
      profileAvatar.style.display = 'none';
    }
  }
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
  }
}

// Set up login/logout button handlers
function setupAuthButtons() {
  // Login button
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    // Function to handle sign-in process
    const handleSignIn = (e) => {
      e.preventDefault();
      
      // Update button state
      loginBtn.textContent = 'Signing In...';
      loginBtn.disabled = true;
      loginBtn.classList.add('signing-in');
      
      // Log the sign-in attempt
      console.log("Sign-in initiated via", e.type);
      
      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      
      // Force re-authentication
      provider.setCustomParameters({
        'prompt': 'select_account'
      });
      
      // Detect if mobile device
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      console.log("Device detection:", isMobile ? "Mobile" : "Desktop");
      
      // Explicitly set host for GitHub Pages to handle custom domain
      const isCustomDomain = window.location.hostname !== 'sn0wglider.firebaseapp.com' && 
                            !window.location.hostname.includes('github.io');
      if (isCustomDomain) {
        console.log("Custom domain detected, manually setting auth redirect domain");
        provider.setCustomParameters({
          'prompt': 'select_account',
          'auth_domain': 'sn0wglider.firebaseapp.com'
        });
      }
      
      if (isMobile) {
        // Track redirect attempt with more detailed information
        try {
          localStorage.setItem('authRedirectAttempts', '1');
          localStorage.setItem('snowglider_auth_redirect_pending', 'true');
          localStorage.setItem('snowglider_auth_redirect_time', Date.now().toString());
        } catch (e) {
          console.error("Error accessing localStorage:", e);
        }
        
        // Use redirect for mobile
        signInWithRedirect(auth, provider)
          .catch(error => {
            console.error("Sign in redirect error:", error);
            resetLoginButton();
            // Clean up redirect indicators on error
            try {
              localStorage.removeItem('snowglider_auth_redirect_pending');
            } catch (e) {
              console.error("Error cleaning localStorage:", e);
            }
          });
      } else {
        // Use popup for desktop
        signInWithPopup(auth, provider)
          .catch(error => {
            console.error("Sign in popup error:", error);
            
            // If popup blocked, try redirect
            if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user') {
              console.log("Popup blocked, trying redirect instead");
              signInWithRedirect(auth, provider)
                .catch(e => {
                  console.error("Redirect fallback failed:", e);
                  resetLoginButton();
                });
            } else {
              resetLoginButton();
            }
          });
      }
    };
    
    // Add listeners with improved mobile support
    loginBtn.addEventListener('touchstart', handleSignIn, { passive: false });
    loginBtn.addEventListener('click', handleSignIn);
  }
  
  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
    }, { passive: false });
    
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Update button state
      logoutBtn.textContent = 'Signing Out...';
      logoutBtn.disabled = true;
      
      // Sign out
      firebaseSignOut(auth)
        .then(() => console.log("Successfully signed out"))
        .catch(error => console.error("Logout error:", error))
        .finally(() => {
          logoutBtn.disabled = false;
          logoutBtn.textContent = 'Logout';
        });
    });
  }
}

// Sync user data with Firestore
function syncUserData(user) {
  if (!firestore || !user) return;
  
  try {
    // Create or update user document
    const userDocRef = doc(firestore, 'users', user.uid);
    setDoc(userDocRef, {
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      lastLogin: serverTimestamp()
    }, { merge: true })
    .catch(error => {
      console.error("Error saving user data:", error);
      if (error.code === 'permission-denied' || error.code === 'unavailable' || 
          error.code === 'failed-precondition') {
        firestore = null;
      }
    });
    
    // Sync best time from localStorage if it exists
    const localBestTime = localStorage.getItem('snowgliderBestTime');
    if (localBestTime) {
      const bestTime = parseFloat(localBestTime);
      updateUserBestTime(user.uid, bestTime);
    }
  } catch (error) {
    console.error("Error in syncUserData:", error);
    firestore = null;
  }
}

// Update user's best time in Firestore
function updateUserBestTime(userId, time) {
  if (!userId || !firestore) return;
  
  try {
    const userDocRef = doc(firestore, 'users', userId);
    getDoc(userDocRef)
      .then(docSnap => {
        if (docSnap.exists()) {
          const userData = docSnap.data();
          // Only update if time is better than stored time or no time exists
          if (!userData.bestTime || time < userData.bestTime) {
            updateDoc(userDocRef, {
              bestTime: time,
              updatedAt: serverTimestamp()
            })
            .catch(error => console.error("Error updating best time:", error));
            
            // Update leaderboard
            updateLeaderboard(userId, time);
          }
        } else {
          // If document doesn't exist, create it with the time
          setDoc(userDocRef, {
            bestTime: time,
            updatedAt: serverTimestamp()
          })
          .catch(error => console.error("Error creating user best time document:", error));
          updateLeaderboard(userId, time);
        }
      })
      .catch(error => console.error("Error reading user data:", error));
  } catch (error) {
    console.error("Error in updateUserBestTime:", error);
  }
}

// Update global leaderboard
function updateLeaderboard(userId, time) {
  if (!firestore) return;
  
  try {
    const userDocRef = doc(firestore, 'users', userId);
    const leaderboardDocRef = doc(firestore, 'leaderboard', userId);
    
    // Add entry to leaderboard
    setDoc(leaderboardDocRef, {
      user: userDocRef,
      time: time,
      achievedAt: serverTimestamp()
    })
    .catch(error => {
      console.error("Error updating leaderboard:", error);
      if (error.code === 'permission-denied' || error.code === 'unavailable' || 
          error.code === 'failed-precondition') {
        firestore = null;
      }
    });
  } catch (error) {
    console.error("Error in updateLeaderboard:", error);
    firestore = null;
  }
}

// Get leaderboard data (top 10 scores)
function getLeaderboard() {
  if (!firestore) {
    return Promise.resolve([]); // Return empty array
  }
  
  try {
    const leaderboardRef = collection(firestore, 'leaderboard');
    const q = query(leaderboardRef, orderBy('time', 'asc'), limit(10));
    
    return getDocs(q)
      .then(snapshot => {
        const scores = [];
        snapshot.forEach(docSnap => {
          const data = docSnap.data();
          scores.push({
            userId: docSnap.id,
            time: data.time,
            user: data.user
          });
        });
        return scores;
      })
      .catch(error => {
        console.error("Error fetching leaderboard:", error);
        return []; // Return empty array on error
      });
  } catch (error) {
    console.error("Error in getLeaderboard:", error);
    return Promise.resolve([]); 
  }
}

// Display leaderboard in game over overlay
function displayLeaderboard() {
  const leaderboardElement = document.getElementById('leaderboard');
  if (!leaderboardElement) return;
  
  leaderboardElement.innerHTML = '<h3>Loading Leaderboard...</h3>';
  
  if (!firestore) {
    leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
    return;
  }
  
  getLeaderboard()
    .then(scores => {
      if (scores.length === 0) {
        leaderboardElement.innerHTML = '<h3>No scores recorded yet!</h3>';
        return;
      }
      
      let html = '<h3>Top 10 Times</h3><table>';
      html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';
      
      // Get user data for each score
      const userPromises = scores.map(score => {
        if (!score.user) {
          return Promise.resolve({
            displayName: 'Unknown',
            photoURL: null
          });
        }
        
        return getDoc(score.user)
          .then(docSnap => {
            if (!docSnap.exists()) {
              return { displayName: 'Unknown Player', photoURL: null };
            }
            const userData = docSnap.data();
            return {
              displayName: userData.displayName || 'Anonymous',
              photoURL: userData.photoURL
            };
          })
          .catch(() => ({ displayName: 'Unknown', photoURL: null }));
      });
      
      Promise.all(userPromises)
        .then(users => {
          scores.forEach((score, index) => {
            const user = users[index] || { displayName: 'Unknown', photoURL: null };
            html += `<tr>
              <td>${index + 1}</td>
              <td>
                ${user.photoURL ? `<img src="${user.photoURL}" alt="" class="mini-avatar">` : ''}
                ${user.displayName}
              </td>
              <td>${typeof score.time === 'number' ? score.time.toFixed(2) : '??'}s</td>
            </tr>`;
          });
          
          html += '</table>';
          leaderboardElement.innerHTML = html;
        })
        .catch(error => {
          console.error("Error processing user data:", error);
          leaderboardElement.innerHTML = '<h3>Error loading user data</h3>';
        });
    })
    .catch(error => {
      console.error("Error getting leaderboard:", error);
      leaderboardElement.innerHTML = '<h3>Failed to load leaderboard</h3>';
    });
}

// Record a completed run score
function recordScore(time) {
  if (!currentUser) return;
  
  try {
    // Always store locally first
    const localBestTime = localStorage.getItem('snowgliderBestTime');
    const isNewPersonalBest = !localBestTime || time < parseFloat(localBestTime);
    
    // Update local storage
    if (isNewPersonalBest) {
      localStorage.setItem('snowgliderBestTime', time);
    }
    
    // Track completion in Analytics
    if (analytics) {
      logEvent(analytics, 'complete_run', { time: time });
    }
    
    // Update user's best time in Firestore only if it's a new personal best
    if (isNewPersonalBest && firestore) {
      updateUserBestTime(currentUser.uid, time);
      
      // Track new best time in Analytics
      if (analytics) {
        logEvent(analytics, 'new_high_score', { time: time });
      }
    }
  } catch (error) {
    console.error("Error in recordScore:", error);
    
    // Ensure local storage is updated even if there's an error
    try {
      localStorage.setItem('snowgliderBestTime', time);
    } catch (e) {
      console.error("LocalStorage error:", e);
    }
  }
}

/**
 * Gets the currently signed-in user
 * @returns {Object|null} The current user object or null if not signed in
 */
function getCurrentUser() {
  return currentUser;
}

/**
 * Check if a user is currently signed in
 * @returns {boolean} True if a user is signed in, false otherwise
 */
function isUserSignedIn() {
  return !!currentUser;
}

/**
 * Get the user's ID token for server authentication
 * @param {boolean} forceRefresh Whether to force a token refresh
 * @returns {Promise<string>} Promise that resolves with the ID token
 */
function getUserIdToken(forceRefresh = false) {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      reject(new Error('No user is signed in'));
      return;
    }
    
    currentUser.getIdToken(forceRefresh)
      .then(idToken => resolve(idToken))
      .catch(error => {
        console.error('Error getting ID token:', error);
        reject(error);
      });
  });
}

// Export the module functions
window.AuthModule = {
  initializeAuth,
  recordScore,
  displayLeaderboard,
  getCurrentUser,
  isUserSignedIn,
  getUserIdToken,
  
  // Export utilities for testing and debugging
  signOut: () => {
    if (auth) {
      return firebaseSignOut(auth);
    }
    return Promise.resolve();
  },
  getAuthState: () => ({
    user: currentUser, 
    isSignedIn: !!currentUser
  }),
  // Add function to check if Firebase services are available
  isFirebaseAvailable: () => ({
    auth: !!auth,
    firestore: !!firestore,
    analytics: !!analytics
  })
};