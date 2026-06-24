// auth.ts - Firebase Authentication module for SnowGlider
// Uses Firebase modular SDK (popup-based federated sign-in + anonymous guest)
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
 * This module handles user authentication and profile management. Score tracking
 * and leaderboard functionality have been moved to scores.js.
 *
 * Sign-in methods (all popup-based; see PROVIDER_BUTTONS + signInAsGuest):
 * - Google, GitHub, and Apple via signInWithPopup
 * - Anonymous "play as guest" via signInAnonymously
 * - Guests upgrade in place via linkWithPopup so their uid/best-time carries over
 *
 * Provider availability is gated by the Firebase console: GitHub needs an OAuth
 * app, Apple needs an Apple Service ID (paid Apple Developer Program). A button
 * absent from the DOM is simply skipped, so the markup can ship a provider before
 * it is enabled server-side without breaking sign-in.
 *
 * Features:
 * - Multi-provider authentication with signInWithPopup / signInAnonymously
 * - User profile management
 * - Integration with ScoresModule for best time tracking
 */

// Service instances initialized by initializeAuth
let auth: Auth | null = null;
let firestore: Firestore | null = null;
let analytics: Analytics | null = null;
let currentUser: User | null = null;
let firebaseApp: FirebaseApp | null = null; // Keep track of the app instance

// Import Firebase modules
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider, // Apple (and other generic OAuth) via OAuthProvider('apple.com')
  signInWithPopup, // Popup flow for every federated provider
  signInAnonymously, // "Play as guest" — no account required
  linkWithPopup, // Upgrade a guest in place so their uid + progress carries over
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  type User,
  type Auth,
  type AuthProvider,
  type UserCredential,
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp,
  type Firestore
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { getAnalytics, logEvent, type Analytics } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js";
import { initializeApp, type FirebaseApp, type FirebaseOptions } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import ScoresModule from "./scores.js";

// Initialize Firebase Auth
function initializeAuth(firebaseConfig: FirebaseOptions) {
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

    // Publish a minimal analytics seam on window so the game page (index.html) can log
    // events without importing Firebase. The game's existing callers
    // (game_start / game_over / game_reset in snowglider/result-overlay/lifecycle) and the
    // diagnostics telemetry sink all read `window.firebaseModules.logEvent` — but only
    // auth.html populated it, so on the main page those calls silently no-oped. Bind a
    // thin wrapper to the real Analytics instance here so they actually deliver. The
    // wrapper reads the module-scoped `analytics` at call time, so it self-disables if
    // Analytics is later cleared, and is guarded so a logging failure never throws into a
    // caller.
    if (typeof window !== 'undefined' && analytics) {
      window.firebaseModules = Object.assign(window.firebaseModules || {}, {
        logEvent: (name: string, params?: Record<string, unknown>) => {
          try { if (analytics) logEvent(analytics, name, params); }
          catch (e) { console.log('logEvent skipped:', (e as Error).message); }
        }
      });
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
        console.log(">>> onAuthStateChanged triggered <<<"); // Log entry into the callback
        if (user) {
          handleSignedInUser(user);
        } else {
          handleSignedOutUser();
        }
      });
      console.log("onAuthStateChanged listener attached successfully."); // Confirm attachment
    } else {
      // Handle case where auth failed to initialize
      console.error("Auth service failed to initialize. Auth features disabled.");
      updateUIForLoggedOutUser(); // Show logged-out state
      resetAuthButtons(); // Ensure buttons are usable (though login will fail)
    }
  } catch (e) {
    // Catch errors during initializeApp or other setup steps
    const err = e as Error;
    console.error("Firebase setup failed:", err.message, err.stack);
    auth = firestore = analytics = null; // Ensure services are null on failure
    updateUIForLoggedOutUser();
    resetAuthButtons();
  }

  // Set up login/logout buttons (even if auth failed, to avoid errors)
  setupAuthButtons();
}

// Broadcast a signed-in-state change so read-only consumers (e.g. the start-screen
// onboarding UI in src/ui/start-menu.ts) can refresh without duplicating the auth
// wiring or hooking the internal onAuthStateChanged listener. Fired on both login
// and logout, after the auth/profile UI and ScoresModule have been updated.
// Guarded so a missing/odd window (tests, non-DOM hosts) can't break auth flow.
function notifyAuthChanged() {
  try {
    window.dispatchEvent(new CustomEvent('snowglider:auth-changed'));
  } catch (e) {
    console.warn("Could not dispatch snowglider:auth-changed event:", e);
  }
}

// Apply the signed-in state. Shared by the onAuthStateChanged listener and the
// guest-upgrade path (linkWithPopup keeps the same uid and may not re-fire the
// observer), so both routes drive identical UI + scoring updates.
function handleSignedInUser(user: User) {
  console.log("Auth state changed: User IS signed in", user.uid, user.email,
    user.isAnonymous ? '(anonymous guest)' : '');
  currentUser = user;

  // Anonymous guests are intentionally kept OUT of Firestore and the global
  // leaderboard: they have no displayName/email and would show up as "Anonymous".
  // We tell ScoresModule there is no signed-in user, so a guest's best time is
  // tracked locally (localStorage) only. When they later upgrade to a real
  // provider (linkWithPopup, same uid), this runs again with isAnonymous === false
  // and syncUserData backfills that local best to the leaderboard.
  if (user.isAnonymous) {
    // Keep the provider buttons (#authUI) visible so the guest can upgrade IN
    // PLACE via linkWithPopup — those buttons are the only entry point to the
    // upgrade flow, so the full logged-in chrome (which hides #authUI) would make
    // it unreachable. Show a lightweight "Guest" indicator + logout alongside.
    updateUIForGuestUser();
    ScoresModule.setCurrentUser(null);
  } else {
    updateUIForLoggedInUser(user);
    // Update user in ScoresModule AFTER UI updates to ensure proper sequence
    ScoresModule.setCurrentUser(user);
    if (firestore) {
      // Small delay to ensure auth state is fully stabilized before syncing
      setTimeout(() => syncUserData(user), 100);
    }
  }

  resetAuthButtons(); // Ensure buttons are in default state after successful login
  notifyAuthChanged(); // Let read-only consumers (e.g. start screen) refresh
  console.log("Finished processing signed-in state.");
}

// Apply the signed-out state (also covers a failed/cleared session).
function handleSignedOutUser() {
  console.log("Auth state changed: User IS signed out");
  currentUser = null;
  ScoresModule.setCurrentUser(null); // Clear user in ScoresModule
  updateUIForLoggedOutUser();
  resetAuthButtons(); // Ensure buttons are in default state after logout
  notifyAuthChanged(); // Let read-only consumers (e.g. start screen) refresh
  console.log("Finished processing signed-out state.");
}

// --- Generated avatar (random color + content) for users without a photo ---
// Snow-themed glyphs used when there's no name to derive initials from (e.g. an
// anonymous guest). The pick + color are deterministic from a seed, so they stay
// stable for the session but vary between users.
const AVATAR_GLYPHS = ['⛄', '🎿', '🏂', '❄️', '🏔️', '🐧', '🧣', '🌨️'];

function hashString(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Deterministic, pleasant background color from a seed string.
function avatarColor(seed: string): string {
  return `hsl(${hashString(seed) % 360}, 60%, 45%)`;
}

// Up to two initials from a display name or email local-part.
function avatarInitials(name: string): string {
  const base = name.replace(/@.*/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return '';
}

// Paint #profileAvatar: the real photo if present, otherwise a generated avatar
// with a random color plus either the user's initials or a random snow glyph.
function renderAvatar(el: HTMLElement, user: {
  isAnonymous?: boolean; uid?: string | undefined;
  displayName?: string | null; email?: string | null; photoURL?: string | null;
}) {
  const seed = user.uid || user.displayName || user.email || 'guest';
  el.textContent = '';
  el.style.backgroundImage = '';
  el.classList.add('avatar');
  el.style.display = 'flex';

  if (!user.isAnonymous && user.photoURL) {
    el.style.backgroundImage = `url("${user.photoURL}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundColor = 'transparent';
    return;
  }

  el.style.backgroundColor = avatarColor(seed);
  const name = user.isAnonymous ? '' : (user.displayName || user.email || '');
  el.textContent = avatarInitials(name) || AVATAR_GLYPHS[hashString(seed) % AVATAR_GLYPHS.length];
}

// Update UI when a real (non-anonymous) user is logged in: show the compact avatar
// chip + name + logout, and fold the provider buttons away entirely.
function updateUIForLoggedInUser(user: User) {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  const profileName = document.getElementById('profileName');
  const profileAvatar = document.getElementById('profileAvatar');

  if (!authUI || !profileUI) {
    console.error("updateUIForLoggedInUser: Could not find authUI or profileUI elements!");
    return;
  }

  authUI.style.display = 'none';     // login options folded once signed in
  profileUI.style.display = 'flex';
  profileUI.classList.remove('guest', 'expanded');
  if (profileName) profileName.textContent = user.displayName || user.email || '';
  if (profileAvatar) renderAvatar(profileAvatar, user);
}

// Update UI when user is logged out: provider buttons visible, profile hidden.
function updateUIForLoggedOutUser() {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');

  if (!authUI || !profileUI) return;

  authUI.style.display = 'flex';
  profileUI.style.display = 'none';
  profileUI.classList.remove('guest', 'expanded');
}

// Update UI for an anonymous "guest" session. The login options are FOLDED behind
// the avatar chip so the panel isn't cluttered, but stay reachable: clicking the
// chip toggles #authUI back on, where a provider click upgrades the guest in place
// (linkWithPopup, same uid). A "Guest" label + logout remain visible.
function updateUIForGuestUser() {
  const authUI = document.getElementById('authUI');
  const profileUI = document.getElementById('profileUI');
  const profileName = document.getElementById('profileName');
  const profileAvatar = document.getElementById('profileAvatar');

  if (!authUI || !profileUI) {
    console.error("updateUIForGuestUser: Could not find authUI or profileUI elements!");
    return;
  }

  // Only FOLD the provider buttons when there's a chip to unfold them again.
  // Pages without #profileChip (e.g. the standalone auth.html, or any future host)
  // keep #authUI visible so the in-place guest upgrade stays reachable.
  const hasChip = !!document.getElementById('profileChip');
  authUI.style.display = hasChip ? 'none' : 'flex';
  profileUI.style.display = 'flex';
  profileUI.classList.toggle('guest', hasChip); // caret hint only when foldable
  profileUI.classList.remove('expanded');
  if (profileName) profileName.textContent = 'Guest';
  if (profileAvatar) renderAvatar(profileAvatar, { isAnonymous: true, uid: currentUser?.uid });
}

// Provider metadata for the buttons in #authUI. Each federated provider maps a
// button id -> default label + analytics method + a factory that builds a fresh
// Firebase auth provider (providers are single-use, so we build one per sign-in).
// The anonymous `guestLoginBtn` has no provider and is wired separately.
type ProviderButton = {
  id: string;
  label: string;   // full label / accessible text (also the fallback for plain buttons)
  short: string;   // compact label shown under the brand icon in #authUI
  method: string;
  makeProvider: () => AuthProvider;
};

const PROVIDER_BUTTONS: ProviderButton[] = [
  {
    id: 'loginBtn',
    label: 'Login with Google',
    short: 'Google',
    method: 'GooglePopup',
    makeProvider: () => {
      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      provider.setCustomParameters({ prompt: 'select_account' }); // Prompt account picker
      return provider;
    }
  },
  {
    id: 'githubLoginBtn',
    label: 'Login with GitHub',
    short: 'GitHub',
    method: 'GitHubPopup',
    makeProvider: () => {
      const provider = new GithubAuthProvider();
      provider.addScope('read:user'); // Public profile only; no repo scopes
      return provider;
    }
  },
  {
    id: 'appleLoginBtn',
    label: 'Sign in with Apple',
    short: 'Apple',
    method: 'ApplePopup',
    makeProvider: () => {
      const provider = new OAuthProvider('apple.com');
      provider.addScope('email');
      provider.addScope('name');
      return provider;
    }
  }
];

const GUEST_BUTTON = { id: 'guestLoginBtn', label: 'Play as Guest', short: 'Guest' };

// Every auth button that should be enabled/disabled/reset together.
function allAuthButtonMeta() {
  return [...PROVIDER_BUTTONS, GUEST_BUTTON];
}

// Set a button's visible label without clobbering its icon. Icon buttons (#authUI
// in index.html) hold an inline brand <svg> + a `.provider-label` span, so we write
// to that span; plain text buttons (auth.html, the test DOM) have no span, so we
// fall back to textContent.
function setButtonLabel(btn: HTMLElement, text: string) {
  const labelEl = btn.querySelector('.provider-label');
  if (labelEl) labelEl.textContent = text;
  else btn.textContent = text;
}

// Reset all present auth buttons to their default, enabled state. (Replaces the
// old single-button resetLoginButton; a missing button id is simply skipped.)
function resetAuthButtons() {
  allAuthButtonMeta().forEach((meta) => {
    const btn = document.getElementById(meta.id) as HTMLButtonElement | null;
    if (!btn) return;
    // Icon buttons restore the short label under the icon; plain buttons restore
    // the full label.
    setButtonLabel(btn, btn.querySelector('.provider-label') ? meta.short : meta.label);
    btn.disabled = false;
    btn.classList.remove('signing-in');
    btn.classList.remove('retry-auth'); // legacy redirect-retry class
  });
}

// Mark a sign-in as in flight: disable every auth button (so a second provider
// can't open a competing popup) and flag the active one as signing in. Icon buttons
// keep their icon and show the busy state via the `.signing-in` class; plain text
// buttons swap to "Signing In...".
function setAuthButtonsBusy(activeBtn: HTMLButtonElement) {
  allAuthButtonMeta().forEach(({ id }) => {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    if (btn === activeBtn) {
      btn.classList.add('signing-in');
      if (!btn.querySelector('.provider-label')) btn.textContent = 'Signing In...';
    }
  });
}

// Shared sign-in error handling for every provider and the guest path.
function handleSignInError(error: { code?: string; message?: string }) {
  console.error("Sign-in error:", error.code, error.message);
  if (error.code === 'auth/popup-blocked') {
    alert('Popup blocked by browser. Please allow popups for this site and try again.');
  } else if (error.code === 'auth/popup-closed-by-user' ||
             error.code === 'auth/cancelled-popup-request') {
    // Benign: the user closed the popup, or a second sign-in superseded this one
    // (rapid double-tap). Don't alert — just allow a retry.
    console.log('Sign-in cancelled (popup closed or superseded):', error.code);
  } else if (error.code === 'auth/account-exists-with-different-credential') {
    // The email is already linked to a different provider.
    alert('An account already exists with this email using a different sign-in method. ' +
          'Please sign in with that method instead.');
  } else if (error.code === 'auth/operation-not-allowed') {
    // The provider isn't enabled in the Firebase console yet (e.g. Apple before
    // its Service ID is set up). Show a friendly message instead of the raw error.
    alert("That sign-in method isn't available yet. Please use another option.");
  } else {
    alert(`Error during sign-in: ${error.message}`);
  }
  resetAuthButtons(); // Re-enable buttons on any error to allow a retry
}

// Federated (Google/GitHub/Apple) popup sign-in. If the current user is an
// anonymous guest we LINK the credential to their uid (upgrade in place) so their
// session and best time carry over; if that provider account already exists we
// fall back to a normal sign-in (the local best time still reconciles through
// syncUserData on the resulting auth-state change).
function runProviderSignIn(meta: ProviderButton, btn: HTMLButtonElement) {
  if (btn.disabled) return; // already in flight

  if (!auth) {
    console.error("Auth service not available. Cannot sign in.");
    alert("Authentication service is currently unavailable. Please try again later.");
    resetAuthButtons();
    return;
  }

  setAuthButtonsBusy(btn);
  const provider = meta.makeProvider();
  const guest = auth.currentUser;
  const upgrading = !!guest && guest.isAnonymous;
  console.log(`Sign-in initiated (${meta.method})${upgrading ? ' as guest upgrade' : ''}.`);

  // Tracks whether we upgraded the guest IN PLACE (linkWithPopup kept the same
  // uid). Only that path applies the user directly, because it may not re-fire
  // onAuthStateChanged. The credential-already-in-use fallback below is a real new
  // sign-in (different uid), which the observer DOES fire for — so we leave it off.
  let linkedInPlace = false;

  const flow: Promise<UserCredential> = upgrading
    ? linkWithPopup(guest!, provider)
        .then(result => { linkedInPlace = true; return result; })
        .catch(error => {
          if (error.code === 'auth/credential-already-in-use' ||
              error.code === 'auth/email-already-in-use') {
            console.log('Guest upgrade: provider account already exists, signing in instead.');
            return signInWithPopup(auth!, provider);
          }
          throw error;
        })
    : signInWithPopup(auth, provider);

  flow
    .then(result => {
      console.log(`Popup sign-in successful (${meta.method}) for:`, result.user.email);
      if (analytics) {
        logEvent(analytics, 'login', { method: meta.method });
      }
      if (linkedInPlace) {
        handleSignedInUser(result.user);
      }
    })
    .catch(handleSignInError);
}

// Anonymous "play as guest" — no account, no popup. onAuthStateChanged then runs
// with isAnonymous === true, which keeps the guest out of the global leaderboard.
function signInAsGuest(btn: HTMLButtonElement) {
  if (btn.disabled) return;

  if (!auth) {
    console.error("Auth service not available. Cannot start guest session.");
    alert("Authentication service is currently unavailable. Please try again later.");
    resetAuthButtons();
    return;
  }

  setAuthButtonsBusy(btn);
  console.log("Guest sign-in initiated (anonymous).");
  signInAnonymously(auth)
    .then(result => {
      console.log("Guest (anonymous) sign-in successful:", result.user.uid);
      if (analytics) {
        logEvent(analytics, 'login', { method: 'Anonymous' });
      }
    })
    .catch(handleSignInError);
}

// Bind click + touchend for an auth button. We bind both because, on the game
// page, controls.js installs a document-level touchstart preventDefault that
// suppresses the synthetic click — so touch sign-in must also fire from 'touchend',
// which is still a valid popup user-activation gesture. onActivate preventDefaults
// (so a tap won't also emit a click) and each sign-in path bails while the button
// is disabled, so the pair can't open two popups. 'touchend' (not 'touchstart') is
// deliberate: touchstart fires before the tap completes and is a weaker popup
// gesture on iOS.
function bindAuthButton(id: string, handler: (btn: HTMLButtonElement) => void) {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  const onActivate = (e: Event) => {
    if (e) e.preventDefault();
    handler(btn);
  };
  btn.addEventListener('click', onActivate);
  btn.addEventListener('touchend', onActivate, { passive: false });
}

// Set up login/logout button handlers
function setupAuthButtons() {
  // Federated provider buttons (Google always present; GitHub/Apple optional).
  PROVIDER_BUTTONS.forEach(meta => {
    bindAuthButton(meta.id, btn => runProviderSignIn(meta, btn));
  });
  // Anonymous guest button (optional).
  bindAuthButton(GUEST_BUTTON.id, signInAsGuest);

  // Profile chip: in guest mode it folds/unfolds the provider buttons (#authUI) so
  // a guest can reveal the "sign in to save" upgrade options. For a fully signed-in
  // user it does nothing (login options stay hidden).
  const profileChip = document.getElementById('profileChip');
  if (profileChip) {
    const toggleGuestUpgrade = (e: Event) => {
      if (e) e.preventDefault();
      if (!currentUser || !currentUser.isAnonymous) return;
      const authUI = document.getElementById('authUI');
      const profileUI = document.getElementById('profileUI');
      if (!authUI) return;
      const collapsed = authUI.style.display === 'none';
      authUI.style.display = collapsed ? 'flex' : 'none';
      if (profileUI) profileUI.classList.toggle('expanded', collapsed);
    };
    profileChip.addEventListener('click', toggleGuestUpgrade);
    profileChip.addEventListener('touchend', toggleGuestUpgrade, { passive: false });
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
function syncUserData(user: User) {
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
  recordScore: (time: number) => ScoresModule.recordScore(time),
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

console.log("Auth module (multi-provider popup + guest) successfully loaded and exported");
