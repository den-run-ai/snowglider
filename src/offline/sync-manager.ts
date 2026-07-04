// sync-manager.ts — local-first score sync for the offline PWA (issue #358, PR 4).
//
// The live scoring path (scores.ts) already rides Firestore's own offline write queue
// and re-reconciles the local best on the next sign-in (syncUserData). The gap this
// closes is the run finished while Firestore is NOT initialized at all (an offline
// first-load, or a failed init) AND the player stays signed in without re-signing-in:
// that best is only in localStorage and would never reach the global board. So when a
// finish can't sync now, we drop a PENDING marker (offline-store, PR 1); on reconnect
// we flush the eligible ones through the same authoritative updateUserBestTime path.
//
// Trust rules preserved (do not weaken):
//   - Anonymous guests NEVER queue — they stay local-only until they upgrade to a real
//     provider (which reuses the uid and syncUserData backfills them).
//   - Only RANKED tiers queue (Bunny/Black/Expert are practice — local best/ghost only).
//   - Flush only when online AND Firestore is ready AND a real user is signed in; the
//     marker is left in place otherwise, so a failed/again-offline attempt is retried.
//   - The synced value flows through updateUserBestTime, which compares against the
//     authoritative Firestore best and never downgrades it.

import { getDifficultyConfig, type Difficulty } from '../difficulty.js';
import {
  markPendingSync,
  readPendingSync,
  clearPendingSync,
  type StorageLike,
} from './offline-store.js';
import { isOnline as defaultIsOnline } from './offline-state.js';
import {
  LEADERBOARD_OFFLINE_TEXT,
} from './offline-ui.js';

/** The minimal user shape the sync decision reads. */
export interface SyncUser {
  uid: string;
  isAnonymous?: boolean;
}

/** Is this a user whose scores may sync to the global leaderboard? Signed in with a
 *  real (non-anonymous) provider. Mirrors scores.ts getActiveUser's anonymous guard. */
export function isSyncEligibleUser(user: SyncUser | null | undefined): user is SyncUser {
  return !!user && typeof user.uid === 'string' && user.uid.length > 0 && user.isAnonymous !== true;
}

/**
 * Should a finished run be QUEUED for later sync? Only when it's an eligible user on a
 * ranked tier AND it can't sync right now (`canSyncNow` = Firestore ready && online).
 * When it can sync now, scores.ts's updateUserBestTime handles it (incl. the SDK's own
 * offline queue), so no marker is needed.
 */
export function shouldQueuePending(
  user: SyncUser | null | undefined,
  tier: Difficulty,
  canSyncNow: boolean
): boolean {
  return isSyncEligibleUser(user) && getDifficultyConfig(tier).ranked && !canSyncNow;
}

/** Is there at least one queued pending sync? Used by the reconnect path to decide
 *  whether it's worth reinitializing Firestore. Never throws. */
export function hasPendingSync(storage?: StorageLike | null): boolean {
  return Object.keys(readPendingSync(storage)).length > 0;
}

/** Dependencies for the queue/flush operations (injectable for headless tests). */
export interface SyncDeps {
  getActiveUser: () => SyncUser | null;
  /** Is Firestore initialized + reachable (scores.isFirestoreAvailable)? */
  isFirestoreReady: () => boolean;
  /** The authoritative sync (scores.updateUserBestTime) — safe/idempotent, never
   *  downgrades. It resolves `true` only when the personal-best write actually SETTLES,
   *  so the flush clears a marker only on that confirmed success and KEEPS it otherwise. */
  sync: (uid: string, time: number, tier: Difficulty) => Promise<boolean> | boolean | void;
  isOnline?: () => boolean;
  storage?: StorageLike | null;
}

/**
 * Queue a finished run's best time for later sync IF eligible + it couldn't sync now.
 * Returns whether a marker was written. Never throws.
 */
export function queueOfflineBest(tier: Difficulty, time: number, deps: SyncDeps): boolean {
  const online = (deps.isOnline ?? defaultIsOnline)();
  const canSyncNow = deps.isFirestoreReady() && online;
  const user = deps.getActiveUser();
  if (!shouldQueuePending(user, tier, canSyncNow)) return false;
  // Pass storage only when explicitly provided (exactOptionalPropertyTypes: an
  // undefined `storage` property is not the same as an absent one — absent means
  // "use ambient localStorage").
  return markPendingSync(tier, time, deps.storage === undefined ? {} : { storage: deps.storage });
}

/**
 * Mark a best pending because an ONLINE sync attempt did NOT confirm — the finish path
 * ran updateUserBestTime while online + Firestore-ready, but it resolved `false` (a
 * transient getDoc/setDoc/leaderboard failure) or rejected. Unlike queueOfflineBest this
 * ignores current connectivity (the attempt already happened and failed), so eligibility
 * — a real signed-in user on a ranked tier — is enough to queue a retry. Without this a
 * flaky-Firestore online finish would strand the best in localStorage with no marker, and
 * queueOfflineBest no-ops while online (Codex #362). Returns whether a marker was written.
 * Never throws.
 */
export function queueFailedSync(tier: Difficulty, time: number, deps: SyncDeps): boolean {
  const user = deps.getActiveUser();
  // canSyncNow = false: the online attempt already failed, so eligibility + ranked is enough.
  if (!shouldQueuePending(user, tier, false)) return false;
  return markPendingSync(tier, time, deps.storage === undefined ? {} : { storage: deps.storage });
}

/**
 * Flush queued pending syncs. No-ops unless online, Firestore is ready, and a real user
 * is signed in. For each queued RANKED tier it awaits the authoritative sync and clears
 * that tier's marker ONLY when the write is CONFIRMED (sync resolves anything but
 * `false`); a rejection or an explicit `false` leaves the durable marker so a transient
 * Firestore failure can never delete the only retry record (Codex #362). Returns the
 * tiers it actually cleared. Never throws.
 */
export async function flushPendingSync(deps: SyncDeps): Promise<Difficulty[]> {
  const online = (deps.isOnline ?? defaultIsOnline)();
  if (!online || !deps.isFirestoreReady()) return [];
  const user = deps.getActiveUser();
  if (!isSyncEligibleUser(user)) return [];

  const cleared: Difficulty[] = [];
  const pending = readPendingSync(deps.storage);
  // entry.tier is a validated Difficulty (readPendingSync drops unknown ids + bad times).
  for (const entry of Object.values(pending)) {
    const tier = entry.tier;
    // Belt-and-suspenders: a tier that became un-ranked (config change) can't reach the
    // global board, so drop its marker without syncing.
    if (!getDifficultyConfig(tier).ranked) {
      clearPendingSync(tier, deps.storage);
      continue;
    }
    let confirmed = false;
    try {
      // `false` ⇒ the write did not settle (guard/skip/failure) → keep the marker.
      confirmed = (await deps.sync(user.uid, entry.time, tier)) !== false;
    } catch {
      // A rejection leaves the marker for the next flush (reconnect / next sign-in).
      confirmed = false;
    }
    if (confirmed) {
      clearPendingSync(tier, deps.storage);
      cleared.push(tier);
    }
  }
  return cleared;
}

// --- Honest result-screen status copy -----------------------------------------

/** Inputs to the result-screen sync-status line. */
export interface ResultSyncState {
  online: boolean;
  firestoreAvailable: boolean;
  ranked: boolean;
  signedIn: boolean;
  anonymous: boolean;
}

/** Practice-tier copy (unranked): local best + ghost only, no global board. */
export const RESULT_UNRANKED_COPY = 'Practice tier — local best and ghost only.';
/** Offline copy: saved locally, will sync when back online + signed in. */
export const RESULT_OFFLINE_COPY = 'Saved locally. Global leaderboard will sync when you are online and signed in.';
/** Anonymous-guest copy: saved locally, sign in to sync future eligible scores. */
export const RESULT_GUEST_COPY = 'Saved locally. Sign in to sync future eligible scores.';
/**
 * Firestore-outage copy: online + signed-in + ranked, but the leaderboard read/write
 * couldn't reach Firestore. The result overlay's leaderboard panel shows "Leaderboard
 * unavailable" in this path (not a cached board), so the copy must NOT claim the last
 * online board is shown (Codex #362). The score is saved locally and queued for sync.
 */
export const RESULT_LEADERBOARD_UNAVAILABLE_COPY = 'Score saved locally. Global leaderboard is temporarily unavailable.';

/**
 * The honest sync-status line for the result screen, or null when nothing extra needs
 * saying (a normal online signed-in sync, or a signed-out online run where the existing
 * "Log in to save your score" prompt already covers it). Pure so the copy is unit
 * tested. Precedence: unranked practice > offline > anonymous guest > signed-out (defer
 * to the login prompt) > (online, signed-in, Firestore down) leaderboard-unavailable.
 */
export function resultSyncStatusCopy(state: ResultSyncState): string | null {
  if (!state.ranked) return RESULT_UNRANKED_COPY;
  if (!state.online) return RESULT_OFFLINE_COPY;
  if (state.anonymous) return RESULT_GUEST_COPY;
  // Signed-out (online, ranked): the result overlay's own login prompt already handles
  // this — don't double up.
  if (!state.signedIn) return null;
  if (!state.firestoreAvailable) return RESULT_LEADERBOARD_UNAVAILABLE_COPY;
  return null;
}

// Re-export the leaderboard offline copy so PR-4 consumers have one import surface.
export { LEADERBOARD_OFFLINE_TEXT };
