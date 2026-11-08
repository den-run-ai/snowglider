// offline-ui.ts — start-screen offline affordances for the offline PWA contract
// (issue #358, PR 1 of the offline-mode stack).
//
// Two concerns, both PURELY presentational:
//   1. Copy constants (the badge text, the leaderboard-fallback line, and an
//      install-hint string that PR 2's install prompt reuses) — kept here as the
//      single source of truth so tests pin the exact wording.
//   2. A tiny DOM helper that mounts/toggles an unobtrusive "Offline mode" badge on
//      the start screen. It is INERT while online (created hidden; only shown when
//      offline) so there is no visible change to the online start screen — the PR-1
//      "no behavior change while online" contract.
//
// Every DOM function takes its container/element explicitly so it is headless-testable
// with jsdom and never reaches for a global `document`.

/** Badge text shown on the start screen when the player is offline. */
export const OFFLINE_BADGE_TEXT = 'Offline mode — local bests only';

/** Fallback line for the leaderboard when the global board can't be reached. */
export const LEADERBOARD_OFFLINE_TEXT = 'Global leaderboard unavailable. Showing your local best.';

// Install-affordance copy, reused by PR 2's install prompt. INSTALL-ONLY wording on
// purpose: offline app-shell caching lands in a later PR (the service worker), so
// promising "play offline" here would be a false guarantee for anyone who installs
// before that ships (Codex #360). It's honest in every stacked state.
export const INSTALL_HINT_TEXT = 'Install SnowGlider as an app';

/** DOM id of the mounted offline badge. */
export const OFFLINE_BADGE_ID = 'offlineBadge';

/**
 * The leaderboard-fallback copy to show, or null when the global board is usable.
 * Pure: `available` is `isOnline() && firestoreAvailable` (see offline-state
 * `globalFeaturesAvailable`). Kept a pure combinator so the copy decision is unit
 * tested without a DOM.
 */
export function leaderboardFallbackCopy(available: boolean): string | null {
  return available ? null : LEADERBOARD_OFFLINE_TEXT;
}

/**
 * Ensure the offline badge exists inside `container`, creating it (hidden) on first
 * call and returning it. Idempotent: a second call returns the same element without
 * duplicating it. The badge is created with `display:none` so mounting it changes
 * nothing visually until {@link setOfflineBadgeVisible} shows it.
 */
export function ensureOfflineBadge(container: HTMLElement): HTMLElement {
  const doc = container.ownerDocument;
  const existing = doc.getElementById(OFFLINE_BADGE_ID);
  if (existing) return existing;
  const badge = doc.createElement('div');
  badge.id = OFFLINE_BADGE_ID;
  badge.className = 'offline-badge';
  // Announce politely for assistive tech when the state flips, without stealing focus.
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  badge.textContent = OFFLINE_BADGE_TEXT;
  badge.style.display = 'none';
  container.appendChild(badge);
  return badge;
}

/** Show/hide the offline badge. `offline === true` reveals it; false hides it. */
export function setOfflineBadgeVisible(badge: HTMLElement | null, offline: boolean): void {
  if (!badge) return;
  badge.style.display = offline ? 'block' : 'none';
}
