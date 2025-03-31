// auth.js - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK
/**
 * Firebase Authentication Module for SnowGlider
 * 
 * This module handles user authentication, profile management,
 * score tracking, and leaderboard functionality using Firebase services.
 * 
 * Features:
 * - Google authentication with adaptive sign-in (popup for desktop, redirect for mobile)
 * - Enhanced mobile authentication with improved touchscreen responsiveness
 * - Robust error handling and recovery for authentication issues
 * - Debug mode with visual overlay for troubleshooting (add ?debug=auth to URL)
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
 * Mobile Authentication:
 * - Automatically detects mobile devices and uses redirect-based authentication
 * - Provides visual feedback during authentication process
 * - Tracks redirect attempts in localStorage to help diagnose authentication issues
 * - Offers retry mechanism for recoverable authentication errors
 * - Debug overlay available by adding ?debug=auth to the URL
 * 
 * Usage:
 * - Call window.AuthModule.initializeAuth(firebaseConfig) to initialize
 * - Game automatically logs scores with recordScore(time)
 * - Leaderboard is displayed with displayLeaderboard()
 * - For debugging issues: window.AuthModule.debugAuth()
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
    
    // Set up cross-window/cross-tab auth state synchronization
    // This is especially important for mobile redirect flow
    setupAuthStateSynchronization();
    
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
        
        // Enhanced redirect result handling for all devices (not just mobile)
        console.log("Setting up redirect result handling");
        try {
          // Use imported getRedirectResult function directly
          console.log("Checking for authentication redirect result");
          
          // Check for redirect attempts from localStorage
          let redirectAttempted = false;
          try {
            const attempts = parseInt(localStorage.getItem('authRedirectAttempts') || '0');
            const timestamp = parseInt(localStorage.getItem('authRedirectTimestamp') || '0');
            const timeSinceRedirect = Date.now() - timestamp;
            
            // Consider a redirect was attempted if we have any attempts recorded in the last 5 minutes
            redirectAttempted = attempts > 0 && timeSinceRedirect < 5 * 60 * 1000;
            
            if (typeof logDebugInfo === 'function') {
              logDebugInfo("Checking redirect history", {
                attempts,
                timestamp,
                timeSinceRedirect: Math.round(timeSinceRedirect / 1000) + 's',
                redirectAttempted
              });
            }
          } catch (storageError) {
            console.error("Error checking localStorage for redirect attempts:", storageError);
          }
          
          // Use the getRedirectResult method to get the authentication result
          getRedirectResult(auth).then((result) => {
            if (result && result.user) {
              console.log("User successfully signed in via redirect:", result.user.displayName || result.user.email);
              if (typeof logDebugInfo === 'function') {
                logDebugInfo("Successful redirect sign-in", {
                  uid: result.user.uid,
                  provider: result.providerId,
                  displayName: result.user.displayName || 'not set'
                });
              }
              
              // Explicitly set currentUser to ensure UI updates correctly
              currentUser = result.user;
              
              // Force UI update immediately
              updateUIForLoggedInUser(result.user);
              
              // Clear redirect attempt tracking
              try {
                localStorage.removeItem('authRedirectAttempts');
                localStorage.removeItem('authRedirectTimestamp');
                
                // Signal auth success to other tabs/windows via localStorage
                // This helps mobile browsers sync auth state between windows
                localStorage.setItem('snowglider_auth_event', JSON.stringify({
                  type: 'login_success',
                  timestamp: Date.now(),
                  uid: result.user.uid
                }));
                
                // Also update the sign-in timestamp to help with polling detection
                localStorage.setItem('snowglider_last_signin', Date.now().toString());
              } catch (e) {
                // Ignore storage errors
                console.error("Error updating localStorage after auth:", e);
              }
              
              // Update UI to show signed-in state
              const loginBtn = document.getElementById('loginBtn');
              if (loginBtn) {
                loginBtn.textContent = 'Login with Google';
                loginBtn.disabled = false;
                loginBtn.classList.remove('signing-in');
              }
              
              // Trigger analytics event for successful sign-in via redirect
              if (analytics) {
                logEvent(analytics, 'login_redirect_success', {
                  method: 'google.com',
                  user_id: result.user.uid
                });
              }
            } else {
              console.log("No redirect result found or user not authenticated");
              if (typeof logDebugInfo === 'function') {
                logDebugInfo("No redirect result found", { redirectAttempted });
                
                // If we believe a redirect was attempted but no result found, this indicates a potential error
                if (redirectAttempted) {
                  logDebugInfo("POTENTIAL ERROR: Redirect was attempted but no result returned", {
                    possibleCauses: [
                      "User canceled auth",
                      "Cookie/storage restrictions",
                      "Network error during redirect",
                      "Browser privacy/tracking prevention",
                      "Firebase redirect flow interrupted"
                    ]
                  });
                }
              }
            }
          }).catch((error) => {
            console.error("Redirect result error:", error.code, error.message);
            
            if (typeof logDebugInfo === 'function') {
              logDebugInfo("Redirect result error", {
                code: error.code,
                message: error.message,
                redirectAttempted: redirectAttempted,
                stack: error.stack
              });
            }
            
            // Provide a fallback mechanism for common redirect errors
            if (error.code === 'auth/network-request-failed' || 
                error.code === 'auth/timeout' || 
                error.code === 'auth/web-storage-unsupported' ||
                error.code === 'auth/operation-not-supported-in-this-environment') {
              
              console.log("Detected redirect error that might be fixed by retrying");
              if (typeof logDebugInfo === 'function') {
                logDebugInfo("Will prompt user to retry auth due to fixable error");
              }
              
              // Add a retry button
              setTimeout(() => {
                const loginBtn = document.getElementById('loginBtn');
                if (loginBtn) {
                  loginBtn.textContent = 'Retry Login';
                  loginBtn.disabled = false;
                  loginBtn.classList.remove('signing-in');
                  loginBtn.classList.add('retry-auth');
                }
              }, 500);
            } else {
              // Reset login button state if there was an error
              const loginBtn = document.getElementById('loginBtn');
              if (loginBtn) {
                loginBtn.textContent = 'Login with Google';
                loginBtn.disabled = false;
                loginBtn.classList.remove('signing-in');
              }
            }
            
            // Log redirect errors to analytics
            if (analytics) {
              logEvent(analytics, 'login_redirect_error', {
                error_code: error.code,
                error_message: error.message,
                redirectAttempted: redirectAttempted
              });
            }
          });
        } catch (error) {
          console.error("Error setting up redirect result handling:", error);
        }
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
    // Function to handle sign-in process - shared between touchstart and click
    const handleSignIn = (e) => {
      // Always prevent default to avoid double events on mobile
      e.preventDefault();
      
      // Show a loading indicator or disable the button
      loginBtn.textContent = 'Signing In...';
      loginBtn.disabled = true;
      
      // Add visual feedback
      loginBtn.classList.add('signing-in');
      
      // Enhanced logging with debug support
      console.log("Sign-in initiated via", e.type);
      if (typeof logDebugInfo === 'function') {
        logDebugInfo(`Sign-in initiated via ${e.type}`, {
          timestamp: new Date().toISOString(),
          eventType: e.type,
          target: e.target.id,
          position: {
            clientX: e.touches ? e.touches[0].clientX : (e.clientX || 'N/A'),
            clientY: e.touches ? e.touches[0].clientY : (e.clientY || 'N/A')
          }
        });
      }
      
      // Use Google Auth Provider
      const provider = new GoogleAuthProvider();
      
      // Detect if mobile device
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      console.log("Device detection:", isMobile ? "Mobile" : "Desktop");
      if (typeof logDebugInfo === 'function') {
        logDebugInfo("Device detection", {
          isMobile: isMobile,
          userAgent: navigator.userAgent,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          pixelRatio: window.devicePixelRatio || 1
        });
      }
      
      if (isMobile) {
        // Use redirect for mobile devices
        console.log("Using redirect auth flow for mobile device");
        if (typeof logDebugInfo === 'function') {
          logDebugInfo("Using mobile auth redirect flow");
        }
        
        try {
          // Set additional scopes if needed
          provider.addScope('profile');
          provider.addScope('email');
          
          // Force re-authentication to help with potential cookie/cache issues
          provider.setCustomParameters({
            'prompt': 'select_account'
          });
          
          if (typeof logDebugInfo === 'function') {
            logDebugInfo("Preparing to call signInWithRedirect", {
              authInitialized: !!auth,
              provider: 'google.com',
              hasScopes: true
            });
          }
          
          // Add a timeout to ensure UI has time to update before redirect
          setTimeout(() => {
            // Add an attempt counter to localStorage to track redirect attempts
            try {
              const currentAttempts = parseInt(localStorage.getItem('authRedirectAttempts') || '0');
              localStorage.setItem('authRedirectAttempts', (currentAttempts + 1).toString());
              localStorage.setItem('authRedirectTimestamp', Date.now().toString());
              
              if (typeof logDebugInfo === 'function') {
                logDebugInfo("Stored redirect attempt data", {
                  attempts: currentAttempts + 1,
                  timestamp: Date.now()
                });
              }
            } catch (storageError) {
              console.error("Error accessing localStorage:", storageError);
            }
            
            // Perform the redirect
            signInWithRedirect(auth, provider)
              .catch((error) => {
                console.error("Sign in redirect error:", error);
                if (typeof logDebugInfo === 'function') {
                  logDebugInfo("Sign in redirect error", {
                    code: error.code,
                    message: error.message,
                    stack: error.stack
                  });
                }
                
                // Reset the button
                loginBtn.textContent = 'Login with Google';
                loginBtn.disabled = false;
                loginBtn.classList.remove('signing-in');
              });
          }, 300); // Short delay to update UI before redirect
          
        } catch (error) {
          console.error("Error during signInWithRedirect setup:", error);
          if (typeof logDebugInfo === 'function') {
            logDebugInfo("Error during signInWithRedirect setup", {
              code: error.code,
              message: error.message,
              stack: error.stack
            });
          }
          loginBtn.textContent = 'Login with Google';
          loginBtn.disabled = false;
          loginBtn.classList.remove('signing-in');
        }
      } else {
        // Use popup for desktop
        console.log("Using popup auth flow for desktop device");
        signInWithPopup(auth, provider)
          .then((result) => {
            console.log("User signed in successfully");
          })
          .catch((error) => {
            console.error("Sign in popup error:", error);
            // If popup blocked, try redirect as fallback
            if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user') {
              console.log("Popup blocked, trying redirect method instead");
              signInWithRedirect(auth, provider).catch(redirectError => {
                console.error("Redirect fallback failed:", redirectError);
                // Reset the button
                loginBtn.textContent = 'Login with Google';
                loginBtn.disabled = false;
                loginBtn.classList.remove('signing-in');
              });
            } else {
              // Reset the button for other errors
              loginBtn.textContent = 'Login with Google';
              loginBtn.disabled = false;
              loginBtn.classList.remove('signing-in');
            }
          });
      }
    };
    
    // Add touchstart listener with the actual sign-in process
    loginBtn.addEventListener('touchstart', handleSignIn, { passive: false });
    
    // Regular click handler for non-touch devices
    loginBtn.addEventListener('click', handleSignIn);
  }
  
  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    // Prevent default for touch events to avoid double-tap issues on mobile
    logoutBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
    }, { passive: false });
    
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Show loading state
      logoutBtn.textContent = 'Signing Out...';
      logoutBtn.disabled = true;
      
      // Sign out the user
      firebaseSignOut(auth)
        .then(() => {
          console.log("Successfully signed out");
          
          // Signal logout to other windows/tabs via localStorage
          try {
            localStorage.setItem('snowglider_auth_event', JSON.stringify({
              type: 'logout_success',
              timestamp: Date.now()
            }));
          } catch (e) {
            console.error("Error updating localStorage after logout:", e);
          }
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
    
    // First, test the Firestore connection before trying operations
    const testDocRef = doc(firestore, 'connection_test', 'test_doc');
    getDoc(testDocRef)
      .then(() => {
        // Connection works, proceed with user data operations
        proceedWithUserDataSync(user);
      })
      .catch(error => {
        console.error("Firestore connection test failed:", error);
        console.warn("Disabling Firestore operations due to connection issues");
        // Disable Firestore for this session to prevent further errors
        firestore = null;
      });
  } catch (error) {
    console.error("Error in syncUserData:", error);
    // Continue with game functionality even if Firebase fails
    firestore = null;
  }
}

// Separate function to handle user data sync after connection test
function proceedWithUserDataSync(user) {
  try {
    // Create or update user document with error handling
    const userDocRef = doc(firestore, 'users', user.uid);
    setDoc(userDocRef, {
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      lastLogin: serverTimestamp()
    }, { merge: true })
    .catch(error => {
      console.error("Error saving user data:", error);
      // Disable Firestore if we get critical errors
      if (error.code === 'permission-denied' || error.code === 'unavailable' || 
          error.code === 'failed-precondition' || error.message.includes('400')) {
        console.warn("Disabling Firestore due to critical error");
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
    console.error("Error in proceedWithUserDataSync:", error);
    firestore = null;
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
      // Disable Firestore for critical errors
      if (error.code === 'permission-denied' || error.code === 'unavailable' || 
          error.code === 'failed-precondition' || error.message.includes('400')) {
        console.warn("Disabling Firestore due to critical error in leaderboard update");
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

/**
 * Debug logger function for mobile authentication debugging
 * 
 * Usage:
 * - Add ?debug=auth to the URL to enable debug overlay
 * - Debug information will appear at the bottom of the screen
 * - Real-time auth operations and errors will be displayed
 * 
 * This is especially useful for troubleshooting mobile authentication issues
 * as it shows detailed information about the redirect flow and any errors.
 */
function logDebugInfo(message, data) {
  console.log(`[Auth Debug] ${message}`, data || '');
  
  // Check if in debug mode (via URL param)
  if (window.location.search.includes('debug=auth')) {
    // Create or update debug overlay if it doesn't exist
    let debugOverlay = document.getElementById('authDebugOverlay');
    
    if (!debugOverlay) {
      debugOverlay = document.createElement('div');
      debugOverlay.id = 'authDebugOverlay';
      debugOverlay.style.position = 'fixed';
      debugOverlay.style.bottom = '60px';
      debugOverlay.style.left = '10px';
      debugOverlay.style.right = '10px';
      debugOverlay.style.maxHeight = '200px';
      debugOverlay.style.overflowY = 'auto';
      debugOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
      debugOverlay.style.color = '#4CAF50';
      debugOverlay.style.fontFamily = 'monospace';
      debugOverlay.style.fontSize = '10px';
      debugOverlay.style.padding = '5px';
      debugOverlay.style.borderRadius = '4px';
      debugOverlay.style.zIndex = '9999';
      document.body.appendChild(debugOverlay);
    }
    
    // Add message to debug overlay
    const logEntry = document.createElement('div');
    logEntry.textContent = `${new Date().toISOString().substring(11, 19)} - ${message}`;
    if (data) {
      let dataText;
      try {
        dataText = typeof data === 'object' ? JSON.stringify(data) : data.toString();
        if (dataText.length > 100) {
          dataText = dataText.substring(0, 97) + '...';
        }
      } catch (e) {
        dataText = '[Object]';
      }
      logEntry.textContent += `: ${dataText}`;
    }
    debugOverlay.appendChild(logEntry);
    
    // Limit number of entries to prevent memory issues
    while (debugOverlay.childNodes.length > 20) {
      debugOverlay.removeChild(debugOverlay.firstChild);
    }
    
    // Auto-scroll to bottom
    debugOverlay.scrollTop = debugOverlay.scrollHeight;
  }
}

// Set up storage event listener for cross-window auth synchronization
function setupAuthStateSynchronization() {
  console.log("Setting up cross-window auth synchronization");
  if (typeof logDebugInfo === 'function') {
    logDebugInfo("Setting up cross-window auth sync", {
      isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    });
  }
  
  // Mobile-specific periodic auth check for redirects
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    // For mobile devices, set up a periodic auth state check
    console.log("Setting up mobile-specific auth state polling");
    if (typeof logDebugInfo === 'function') {
      logDebugInfo("Setting up mobile auth state polling");
    }
    
    // Check for active redirect attempts in localStorage
    const redirectAttempted = parseInt(localStorage.getItem('authRedirectAttempts') || '0') > 0;
    const redirectTimestamp = parseInt(localStorage.getItem('authRedirectTimestamp') || '0');
    const timeSinceRedirect = Date.now() - redirectTimestamp;
    
    // If we've had a recent redirect attempt (within last 5 minutes)
    if (redirectAttempted && timeSinceRedirect < 5 * 60 * 1000) {
      console.log("Detected recent redirect attempt, setting up auth refresh intervals");
      if (typeof logDebugInfo === 'function') {
        logDebugInfo("Recent redirect detected", {
          timeSinceRedirect: Math.round(timeSinceRedirect / 1000) + 's',
          attempts: parseInt(localStorage.getItem('authRedirectAttempts') || '0')
        });
      }
      
      // Set up a polling mechanism to check authentication state periodically
      // This helps in cases where storage events might not work reliably on mobile
      
      // Quick intervals for first 30 seconds after page load
      for (let i = 1; i <= 6; i++) {
        setTimeout(() => {
          forceAuthStateRefresh();
        }, i * 5000); // Check every 5 seconds for first 30 seconds
      }
      
      // Longer intervals for next 5 minutes
      for (let i = 1; i <= 10; i++) {
        setTimeout(() => {
          forceAuthStateRefresh();
        }, 30000 + i * 30000); // Check every 30 seconds for next 5 minutes
      }
    }
  }
  
  // Function to force an auth state refresh
  function forceAuthStateRefresh() {
    if (!auth) return;
    
    console.log("Forcing auth state refresh check");
    if (typeof logDebugInfo === 'function') {
      logDebugInfo("Forcing auth state refresh");
    }
    
    // Force a token refresh to trigger auth state change listeners
    if (auth.currentUser) {
      auth.currentUser.getIdToken(true)
        .then(token => {
          console.log("Token refreshed successfully");
          if (typeof logDebugInfo === 'function') {
            logDebugInfo("Token refreshed successfully");
          }
        })
        .catch(error => {
          console.error("Token refresh error:", error);
          if (typeof logDebugInfo === 'function') {
            logDebugInfo("Token refresh error", { message: error.message });
          }
        });
    } else {
      // If no current user, check for redirect result again
      try {
        getRedirectResult(auth)
          .then(result => {
            if (result && result.user) {
              console.log("Redirect result found on refresh check");
              if (typeof logDebugInfo === 'function') {
                logDebugInfo("Redirect result found on refresh", {
                  uid: result.user.uid
                });
              }
              
              // Clear redirect attempts counter
              try {
                localStorage.removeItem('authRedirectAttempts');
                localStorage.removeItem('authRedirectTimestamp');
              } catch (e) {
                console.error("Error clearing localStorage after auth:", e);
              }
              
              // Update UI to show signed-in state
              currentUser = result.user;
              updateUIForLoggedInUser(result.user);
            }
          })
          .catch(error => {
            console.error("Refresh redirect result check error:", error);
            if (typeof logDebugInfo === 'function') {
              logDebugInfo("Refresh redirect result error", {
                code: error.code,
                message: error.message
              });
            }
          });
      } catch (error) {
        console.error("Error checking redirect result:", error);
      }
    }
  }
  
  // Listen for auth events from other windows/tabs
  window.addEventListener('storage', function(event) {
    // Only react to our specific auth events
    if (event.key === 'snowglider_auth_event') {
      try {
        const authEvent = JSON.parse(event.newValue);
        const timestamp = authEvent.timestamp;
        const now = Date.now();
        const timeDiff = now - timestamp;
        
        // Only process recent events (within last 30 seconds)
        if (timeDiff <= 30000) {
          console.log(`Auth event received from another window: ${authEvent.type}`, timeDiff + 'ms ago');
          
          if (typeof logDebugInfo === 'function') {
            logDebugInfo("Cross-window auth event", {
              type: authEvent.type,
              timeDiff: timeDiff + 'ms',
              source: 'storage event'
            });
          }
          
          // Handle different auth event types
          if (authEvent.type === 'login_success') {
            // Force a re-check of authentication state for login
            if (auth) {
              console.log("Forcing auth state refresh based on cross-window login");
              
              // Update UI to reflect that we're syncing auth state
              const loginBtn = document.getElementById('loginBtn');
              if (loginBtn) {
                loginBtn.textContent = 'Syncing...';
                loginBtn.disabled = true;
              }
              
              // Force an immediate auth state refresh
              forceAuthStateRefresh();
              
              // After a short delay, return to normal state if needed
              setTimeout(() => {
                // If still not signed in after the refresh, reset button
                if (!currentUser) {
                  const loginBtn = document.getElementById('loginBtn');
                  if (loginBtn) {
                    loginBtn.textContent = 'Login with Google';
                    loginBtn.disabled = false;
                  }
                }
              }, 1500);
            }
          } else if (authEvent.type === 'logout_success') {
            // Handle logout from another window
            console.log("Detected logout from another window");
            
            // Update UI to reflect logged-out state
            if (currentUser) {
              // This handles the case where this window thinks the user is still logged in
              // but they've logged out in another window
              console.log("Syncing logout state from another window");
              
              // onAuthStateChanged should catch this eventually, but we can update the UI immediately
              updateUIForLoggedOutUser();
              
              // Don't set currentUser to null here - let onAuthStateChanged handle that
              // to ensure consistency with actual Firebase state
            }
          }
        }
      } catch (e) {
        console.error("Error processing auth event from another window:", e);
      }
    }
  });
  
  console.log("Cross-window auth synchronization set up");
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
  }),
  // Debug helper for mobile troubleshooting
  debugAuth: () => {
    logDebugInfo('Auth debug requested');
    
    // Create debug panel if in debug mode
    if (!window.location.search.includes('debug=auth')) {
      // Add debug parameter to URL
      const newUrl = window.location.href + 
        (window.location.search ? '&' : '?') + 'debug=auth';
      logDebugInfo('Debug mode not enabled. To enable, visit:', newUrl);
      return { 
        enabled: false,
        enableUrl: newUrl
      };
    }
    
    // Collect and display auth state information
    const debugData = {
      userAgent: navigator.userAgent,
      isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      services: {
        auth: !!auth,
        firestore: !!firestore,
        analytics: !!analytics
      },
      user: currentUser ? {
        uid: currentUser.uid,
        email: currentUser.email,
        isAnonymous: currentUser.isAnonymous,
        providerId: currentUser.providerId
      } : null
    };
    
    logDebugInfo('Auth state', debugData);
    return {
      enabled: true,
      data: debugData
    };
  }
};