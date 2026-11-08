// offline-state.ts — connectivity + install/standalone detection for the offline
// PWA contract (issue #358, PR 1 of the offline-mode stack).
//
// This module is deliberately PURE and GAMEPLAY-NEUTRAL: it only SAMPLES
// `navigator.onLine`, the display-mode, and (optionally) the Firebase-availability
// the boot layer already computes. It never touches the physics kernel, the seeded
// RNG streams, the render loop, or any scoring key — so importing it cannot perturb
// the byte-identical no-input baseline. It is also headless-safe: every `window` /
// `navigator` access is feature-guarded and falls back to an OPTIMISTIC "online"
// default (never a false "offline") when the global is absent (Node / SSR).
//
// PR 3 (service worker) and PR 4 (local-first sync) consume this; PR 1 wires only the
// start-screen offline badge (see offline-ui.ts).

/** Called with the new connectivity state whenever it transitions. */
export type ConnectivityListener = (online: boolean) => void;

/**
 * Resolve the Navigator to read: prefer `window.navigator` (what the rest of the
 * codebase reads, e.g. scores.ts `window.navigator.onLine`, and what jsdom overrides
 * in the test harness) and fall back to the bare `navigator` global. Node 22 exposes
 * a minimal global `navigator` WITHOUT `onLine`, so preferring `window.navigator`
 * matters for both correctness and testability.
 */
function getNavigator(): (Navigator & { standalone?: boolean }) | null {
  try {
    if (typeof window !== 'undefined' && window.navigator) {
      // Widen to expose the non-standard iOS `standalone` flag via the return type.
      return window.navigator;
    }
  } catch {
    /* window access threw */
  }
  try {
    if (typeof navigator !== 'undefined') {
      return navigator;
    }
  } catch {
    /* navigator access threw */
  }
  return null;
}

/**
 * Is the browser currently online? Reads `navigator.onLine`, which browsers keep
 * live. Falls back to `true` (optimistic) when `navigator` is unavailable or the
 * flag is not a boolean, so headless/Node contexts never masquerade as offline.
 */
export function isOnline(): boolean {
  const nav = getNavigator();
  if (nav && typeof nav.onLine === 'boolean') {
    return nav.onLine;
  }
  return true;
}

/** Convenience negation of {@link isOnline} for call sites that read more naturally. */
export function isOffline(): boolean {
  return !isOnline();
}

/**
 * Is the app running as an installed / standalone PWA (rather than a browser tab)?
 * Checks the standard `display-mode: standalone` media query and the legacy iOS
 * Safari `navigator.standalone` flag. Returns `false` when neither is available.
 * Used later to tune install-prompt copy; never gates gameplay.
 */
export function isStandalone(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      // `display-mode: standalone` (Chrome/Edge/Android) and `minimal-ui` both read as
      // installed-app chrome; either counts as "not a plain browser tab".
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    }
    // iOS Safari predates display-mode: it exposes a non-standard boolean instead.
    const nav = getNavigator();
    if (nav && nav.standalone === true) return true;
  } catch {
    /* matchMedia / navigator access threw — assume a normal tab */
  }
  return false;
}

/**
 * Are the online-only "global" features (Firebase auth, the global leaderboard,
 * analytics, GitHub feedback) usable right now? Pure combinator: they need BOTH a
 * live connection AND a working Firebase layer. `firebaseAvailable` is the value the
 * boot bridge already computes (`window.AuthModule.isFirebaseAvailable().firestore`),
 * passed in so this module stays dependency-free and headless-testable.
 */
export function globalFeaturesAvailable(firebaseAvailable: boolean): boolean {
  return isOnline() && firebaseAvailable === true;
}

/**
 * Subscribe to online/offline transitions. Registers `window` `online`/`offline`
 * listeners and invokes `listener(online)` on each change. Returns an unsubscribe
 * function that removes both listeners — call it on teardown so nothing leaks across
 * a game restart (teardown-safety invariant). A thrown listener is swallowed so one
 * bad subscriber can't break connectivity handling for the others. No-op (returns a
 * no-op unsubscribe) when `window` has no `addEventListener` (Node).
 */
export function watchConnectivity(listener: ConnectivityListener): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const onOnline = () => {
    try {
      listener(true);
    } catch {
      /* subscriber threw — isolate it */
    }
  };
  const onOffline = () => {
    try {
      listener(false);
    } catch {
      /* subscriber threw — isolate it */
    }
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
