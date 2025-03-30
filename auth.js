// auth.js - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK
/**
 * Firebase Authentication Module for SnowGlider
 * 
 * This module handles user authentication, profile management,
 * score tracking, and leaderboard functionality using Firebase services.
 * 
 * Features:
 * - Google authentication with popup sign-in
 * - User profile management
 * - Best time tracking with Firebase Firestore
 * - Global leaderboard
 * - Analytics event tracking
 * - Graceful fallback to localStorage when Firestore is unavailable
 * 
 * Special handling for local development:
 * - Firestore is automatically disabled on localhost/file:// to prevent errors
 * - All operations gracefully fall back to localStorage
 * - Authentication still works for testing
 * 
 * Usage:
 * - Call window.AuthModule.initializeAuth(firebaseConfig) to initialize
 * - Game automatically logs scores with recordScore(time)
 * - Leaderboard is displayed with displayLeaderboard()
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
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
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
    
    // Check if Firebase is already initialized in the window object
    let app;
    if (window.firebaseModules && window.firebaseModules.app) {
      console.log("Using existing Firebase app instance");
      app = window.firebaseModules.app;
      
      // Get service instances with proper error handling
      try {
        auth = getAuth(app);
      } catch (authError) {
        console.error("Failed to initialize Auth:", authError);
        auth = null;
      }
      
      // Initialize Firestore with special handling for localhost/file protocol
      try {
        // Only initialize Firestore if we're on a proper host
        // Firestore fails with 400 errors on localhost/file protocol
        if (window.location.protocol !== 'file:' && 
            !window.location.hostname.includes('localhost') && 
            !window.location.hostname.includes('127.0.0.1')) {
          firestore = getFirestore(app);
          console.log("Firestore initialized for remote host");
        } else {
          console.warn("Skipping Firestore initialization on local development environment");
          firestore = null;
        }
      } catch (firestoreError) {
        console.error("Failed to initialize Firestore:", firestoreError);
        firestore = null;
      }
      
      try {
        analytics = getAnalytics(app);
      } catch (analyticsError) {
        console.error("Failed to initialize Analytics:", analyticsError);
        analytics = null;
      }
    } else {
      // Initialize Firebase directly here
      console.log("Initializing new Firebase app instance");
      app = initializeApp(firebaseConfig);
      
      // Initialize services with error handling
      try {
        auth = getAuth(app);
      } catch (authError) {
        console.error("Failed to initialize Auth:", authError);
        auth = null;
      }
      
      // Initialize Firestore with special handling for localhost
      try {
        // Only initialize Firestore if we're on a proper host
        if (window.location.protocol !== 'file:' && 
            !window.location.hostname.includes('localhost') && 
            !window.location.hostname.includes('127.0.0.1')) {
          firestore = getFirestore(app);
          console.log("Firestore initialized for remote host");
        } else {
          console.warn("Skipping Firestore initialization on local development environment");
          firestore = null;
        }
      } catch (firestoreError) {
        console.error("Failed to initialize Firestore:", firestoreError);
        firestore = null;
      }
      
      try {
        analytics = getAnalytics(app);
      } catch (analyticsError) {
        console.error("Failed to initialize Analytics:", analyticsError);
        analytics = null;
      }
    }
    
    // Set up auth state monitoring with proper persistence
    try {
      if (auth) {
        setPersistence(auth, browserLocalPersistence);
        console.log("Auth persistence set to local");
      } else {
        console.warn("Cannot set auth persistence - auth is not initialized");
      }
    } catch (error) {
      console.error("Error setting persistence:", error);
    }

    // Observer for authentication state changes
    let unsubscribe = () => {}; // Default no-op function
    
    if (auth) {
      unsubscribe = onAuthStateChanged(auth, user => {
        if (user) {
          // User is signed in
          console.log("Auth state changed: User is signed in", user.uid);
          currentUser = user;
          updateUIForLoggedInUser(user);
          
          // Only attempt to sync user data if Firestore is available
          if (firestore) {
            syncUserData(user);
          } else {
            console.warn("Skipping user data sync - Firestore not available in local environment");
          }
          
          // Log login event to Analytics if available
          if (analytics) {
            logEvent(analytics, 'login', {
              method: user.providerData && user.providerData.length > 0 ? 
                      user.providerData[0].providerId : 'Unknown',
              user_id: user.uid // non-PII identifier
            });
          }
        } else {
          // User is signed out
          console.log("Auth state changed: User is signed out");
          currentUser = null;
          updateUIForLoggedOutUser();
        }
      });
      
      // Store unsubscribe function for cleanup if needed
      window.authUnsubscribe = unsubscribe;
    } else {
      console.warn("Cannot set up auth state listener - auth is not initialized");
      // Set up UI for logged out state since auth isn't available
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
  
  // Update display
  authUI.style.display = 'none';
  profileUI.style.display = 'flex';
  profileName.textContent = user.displayName || user.email;
  
  // Set profile image if available
  if (user.photoURL) {
    profileAvatar.src = user.photoURL;
    profileAvatar.style.display = 'block';
  } else {
    profileAvatar.style.display = 'none';
  }
}

// Update UI when user is logged out
function updateUIForLoggedOutUser() {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  
  authUI.style.display = 'flex';
  profileUI.style.display = 'none';
}

// Set up login/logout button handlers
function setupAuthButtons() {
  // Login button
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      // Show a loading indicator or disable the button
      loginBtn.textContent = 'Signing In...';
      loginBtn.disabled = true;
      
      // Use Google Auth Provider
      const provider = new GoogleAuthProvider();
      
      // Sign in with popup
      signInWithPopup(auth, provider)
        .then((result) => {
          console.log("User signed in successfully");
        })
        .catch((error) => {
          console.error("Sign in error:", error);
          // Reset the button
          loginBtn.textContent = 'Login with Google';
          loginBtn.disabled = false;
        });
    });
  }
  
  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      // Show loading state
      logoutBtn.textContent = 'Signing Out...';
      logoutBtn.disabled = true;
      
      // Sign out the user
      firebaseSignOut(auth)
        .then(() => {
          console.log("Successfully signed out");
        })
        .catch(error => {
          console.error("Logout error:", error);
        })
        .finally(() => {
          // Re-enable the button and restore text
          logoutBtn.disabled = false;
          logoutBtn.textContent = 'Logout';
        });
    });
  }
}

// Sync user data with Firestore
function syncUserData(user) {
  try {
    // Check if Firestore is available
    if (!firestore) {
      console.error("Firestore is not available");
      return;
    }
    
    // Create or update user document with error handling
    try {
      const userDocRef = doc(firestore, 'users', user.uid);
      setDoc(userDocRef, {
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        lastLogin: serverTimestamp()
      }, { merge: true })
      .catch(error => {
        console.error("Error saving user data:", error);
        // Continue game functionality without Firestore if there's an error
      });
    } catch (firestoreError) {
      console.error("Firestore operation failed:", firestoreError);
      // Do not attempt further Firestore operations
      return;
    }
    
    // Sync best time from localStorage if it exists
    const localBestTime = localStorage.getItem('snowgliderBestTime');
    if (localBestTime) {
      const bestTime = parseFloat(localBestTime);
      updateUserBestTime(user.uid, bestTime);
    }
  } catch (error) {
    console.error("Error in syncUserData:", error);
    // Continue with game functionality even if Firebase fails
  }
}

// Update user's best time in Firestore
function updateUserBestTime(userId, time) {
  if (!userId || !auth || !auth.currentUser || !firestore) return;
  
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
            .catch(error => {
              console.error("Error updating best time:", error);
            });
            
            // Also update leaderboard
            updateLeaderboard(userId, time);
          }
        } else {
          // If document doesn't exist, create it with the time
          setDoc(userDocRef, {
            bestTime: time,
            updatedAt: serverTimestamp()
          })
          .catch(error => {
            console.error("Error creating user best time document:", error);
          });
          updateLeaderboard(userId, time);
        }
      })
      .catch(error => {
        console.error("Error reading user data:", error);
      });
  } catch (error) {
    console.error("Error in updateUserBestTime:", error);
    // Continue with game functionality even if Firebase fails
  }
}

// Update global leaderboard
function updateLeaderboard(userId, time) {
  if (!firestore) {
    console.error("Firestore is not available for leaderboard update");
    return;
  }
  
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
    });
  } catch (error) {
    console.error("Error in updateLeaderboard:", error);
  }
}

// Get leaderboard data (top 10 scores)
function getLeaderboard() {
  if (!firestore) {
    console.error("Firestore is not available for leaderboard retrieval");
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
    return Promise.resolve([]); // Return empty array on error
  }
}

// Display leaderboard in game over overlay
function displayLeaderboard() {
  const leaderboardElement = document.getElementById('leaderboard');
  if (!leaderboardElement) return; // Skip if element doesn't exist
  
  leaderboardElement.innerHTML = '<h3>Loading Leaderboard...</h3>';
  
  // Check if Firestore is available
  if (!firestore) {
    console.error("Firestore is not available for leaderboard display");
    leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
    return;
  }
  
  try {
    getLeaderboard()
      .then(scores => {
        if (scores.length === 0) {
          leaderboardElement.innerHTML = '<h3>No scores recorded yet!</h3>';
          return;
        }
        
        let html = '<h3>Top 10 Times</h3><table>';
        html += '<tr><th>Rank</th><th>Player</th><th>Time</th></tr>';
        
        // Get user data for each score with error handling
        const userPromises = scores.map(score => {
          try {
            // Handle potential reference errors
            if (!score.user) {
              return Promise.resolve({
                displayName: 'Unknown',
                photoURL: null
              });
            }
            
            return getDoc(score.user)
              .then(docSnap => {
                if (!docSnap.exists()) {
                  return {
                    displayName: 'Unknown Player',
                    photoURL: null
                  };
                }
                const userData = docSnap.data();
                return {
                  displayName: userData.displayName || 'Anonymous',
                  photoURL: userData.photoURL
                };
              })
              .catch(error => {
                console.error("Error fetching user data:", error);
                return {
                  displayName: 'Unknown',
                  photoURL: null
                };
              });
          } catch (error) {
            console.error("Error processing score:", error);
            return Promise.resolve({
              displayName: 'Error',
              photoURL: null
            });
          }
        });
        
        Promise.all(userPromises)
          .then(users => {
            try {
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
            } catch (error) {
              console.error("Error rendering leaderboard:", error);
              leaderboardElement.innerHTML = '<h3>Error displaying leaderboard</h3>';
            }
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
  } catch (error) {
    console.error("Error in displayLeaderboard:", error);
    leaderboardElement.innerHTML = '<h3>Error</h3>';
  }
}

// Record a completed run score
function recordScore(time) {
  if (!currentUser) return;
  
  try {
    // Always store locally first to ensure game functionality works
    // even if Firebase operations fail
    const localBestTime = localStorage.getItem('snowgliderBestTime');
    const isNewPersonalBest = !localBestTime || time < parseFloat(localBestTime);
    
    // Update local storage
    if (isNewPersonalBest) {
      localStorage.setItem('snowgliderBestTime', time);
    }
    
    // Track completion in Analytics
    try {
      if (analytics) {
        logEvent(analytics, 'complete_run', {
          time: time,
          user_id: currentUser.uid
        });
      }
    } catch (analyticsError) {
      console.error("Analytics error:", analyticsError);
      // Continue even if analytics fails
    }
    
    // Update user's best time in Firestore only if it's a new personal best
    if (isNewPersonalBest && firestore) {
      updateUserBestTime(currentUser.uid, time);
      
      // Track new best time in Analytics
      try {
        if (analytics) {
          logEvent(analytics, 'new_high_score', {
            time: time,
            user_id: currentUser.uid
          });
        }
      } catch (analyticsError) {
        console.error("Analytics error for high score:", analyticsError);
      }
    }
  } catch (error) {
    console.error("Error in recordScore:", error);
    
    // Ensure local storage is updated even if there's an error
    try {
      localStorage.setItem('snowgliderBestTime', time);
    } catch (storageError) {
      console.error("LocalStorage error:", storageError);
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
      .then(idToken => {
        resolve(idToken);
      })
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