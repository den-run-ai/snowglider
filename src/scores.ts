/**
 * scores.ts - User scoring and leaderboard module for SnowGlider
 *
 * Phase 3.8 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
 * (implied for a real `.ts` file); the module keeps its existing Firebase-typed
 * JSDoc (TypeScript reads JSDoc in `.ts` too), so score validation, the
 * localStorage best-time store and the leaderboard sync/fallback stay byte-for-byte
 * unchanged (no TS syntax added). It loads via firebase-bootstrap's
 * `<script src="src/scores.js">` (Vite-dev resolves `.js`->`.ts`; the build emits
 * `dist/src/scores.js`); the headless scores test reads `src/scores.ts` now.
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
  doc,
  setDoc,
  getDoc,
  collection,
  where,
  orderBy,
  query,
  limit,
  getDocs,
  serverTimestamp,
  type Firestore,
  type DocumentReference
} from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
import { logEvent, type Analytics } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js";
import type { User } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js";
// Plausibility floor + upper cap: single source of truth (see score-limits.ts). The
// floor was measured empirically (issue #229, PR A); firestore.rules duplicates the same
// literals because rules can't import JS, and a drift test keeps them in lockstep.
import { MIN_VALID_SCORE_TIME, MAX_VALID_SCORE_TIME } from './score-limits.js';
import { withTrafficTag } from './analytics-env.js';
// Per-tier scoring storage names. Blue maps to the original un-suffixed names, so the
// default-tier paths/fields/keys (and every existing caller/test that passes no tier)
// are byte-for-byte unchanged.
import {
  DEFAULT_DIFFICULTY,
  localBestTimeKey,
  leaderboardCollectionName,
  userBestTimeField,
  type Difficulty
} from './difficulty.js';
import { getRunStamp } from './run-context.js';
// Local-first offline sync (issue #358, PR 4): queue an eligible best that couldn't
// sync now, and flush the queue on reconnect. The pending marker is durable across a
// tab close (localStorage) — it fills the gap where Firestore was not initialized at
// finish time (offline first-load), which the SDK's own offline write-queue can't cover.
import { queueOfflineBest, queueFailedSync, flushPendingSync, hasPendingSync, type SyncDeps } from './offline/sync-manager.js';

// Module state
let firestore: Firestore | null = null; // Local cache of firestore instance, updated by initializeScores
let analytics: Analytics | null = null;
let currentUser: User | null = null;

// Type-guard form: accepts `unknown` (Firestore reads and localStorage parses flow
// through here as untyped data) and narrows to `number` on success, so callers can
// decode a raw field and use it as a number without an unsafe cast. The body already
// did the `typeof === 'number'` check, so this is purely a signature tightening.
function isValidScoreTime(time: unknown): time is number {
  return typeof time === 'number' &&
    Number.isFinite(time) &&
    time >= MIN_VALID_SCORE_TIME &&
    time <= MAX_VALID_SCORE_TIME;
}


/** Sidecar key for the run-provenance stamp next to a tier's local best time. */
function localBestMetaKey(tier: Difficulty = DEFAULT_DIFFICULTY): string {
  return `${localBestTimeKey(tier)}_meta`;
}

/** Stamp the just-recorded local best with its run provenance (#400): the run
 *  seed (null while unseeded) and the PHYSICS_VERSION that produced the time,
 *  so a future replay/ranked mode knows whether the record is reproducible and
 *  against which kernel. A SIDECAR key: the legacy bare-number best-time value
 *  and every existing reader stay byte-for-byte unchanged. Best-effort — a
 *  blocked storage write must never break score recording. */
function stampLocalBestMeta(tier: Difficulty = DEFAULT_DIFFICULTY): void {
  try {
    localStorage.setItem(localBestMetaKey(tier), JSON.stringify(getRunStamp()));
  } catch { /* storage may be unavailable; the time itself already saved */ }
}

/** Read a tier's run-provenance stamp ({seed, physicsVersion}) or null. */
export function readLocalBestMeta(tier: Difficulty = DEFAULT_DIFFICULTY): { seed: number | null; physicsVersion: number } | null {
  try {
    const raw = localStorage.getItem(localBestMetaKey(tier));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { seed?: unknown; physicsVersion?: unknown };
    if (typeof rec.physicsVersion !== 'number') return null;
    return {
      seed: typeof rec.seed === 'number' ? rec.seed : null,
      physicsVersion: rec.physicsVersion,
    };
  } catch {
    return null;
  }
}

function readLocalBestTime(tier: Difficulty = DEFAULT_DIFFICULTY) {
  const key = localBestTimeKey(tier);
  const localBestTimeStr = localStorage.getItem(key);
  if (!localBestTimeStr) {
    return null;
  }

  const localBestTime = parseFloat(localBestTimeStr);
  if (isValidScoreTime(localBestTime)) {
    return localBestTime;
  }

  console.warn("Ignoring invalid local best time:", localBestTimeStr);
  localStorage.removeItem(key);
  return null;
}

/**
 * Initialize the scores module with Firebase services
 * @param {Object|null} firestoreInstance - Initialized Firestore instance (or null)
 * @param {Object|null} analyticsInstance - Initialized Analytics instance (or null)
 */
function initializeScores(firestoreInstance: Firestore | null, analyticsInstance: Analytics | null) {
  firestore = firestoreInstance; // Update local cache
  analytics = analyticsInstance;
  console.log("Scores module initialized/updated:",
    { firestore: !!firestore, analytics: !!analytics });

  if (!firestore) {
    console.warn("ScoresModule received null Firestore instance.");
  } else {
    console.log("ScoresModule received valid Firestore instance.");
  }

  // Offline-sync wiring (issue #358, PR 4): listen for reconnects, and flush any queued
  // pending best now that Firestore may be available.
  ensureOnlineFlushListener();
  if (firestore) {
    flushOfflineScoreQueue();
  }
}

// --- Local-first offline sync wiring (issue #358, PR 4) -----------------------
// Bridges the pure sync-manager to this module's live user/Firestore state.
let offlineSyncOnlineListenerBound = false;

function buildSyncDeps(): SyncDeps {
  return {
    getActiveUser,
    isFirestoreReady: () => isFirestoreAvailable(),
    sync: (uid, time, tier) => updateUserBestTime(uid, time, tier),
    // Match scores.ts's existing online check (window.navigator.onLine).
    isOnline: () => typeof window !== 'undefined' && !!window.navigator && window.navigator.onLine,
  };
}

function flushOfflineScoreQueue() {
  // Fire-and-forget: the flush awaits each per-tier sync internally and only clears a
  // marker on a confirmed write, so we don't need its result here.
  void flushPendingSync(buildSyncDeps()).catch((error) => {
    console.warn('Offline score-queue flush failed:', error);
  });
}

/**
 * Attempt the authoritative best-time sync and, if it does NOT confirm (a transient
 * getDoc/setDoc/leaderboard failure resolves `false`, or the promise rejects), queue the
 * best for a later reconnect/auth-restore retry. Shared by the finish path (recordScore)
 * and the sign-in backfill (auth.ts syncUserData) so a flaky-Firestore write is never
 * silently dropped — either caller's failed online write is retried instead of leaving
 * the best local-only (Codex #362). Fire-and-forget; queueFailedSync is internally guarded
 * (real signed-in user + ranked tier).
 */
function syncBestTimeWithRetry(uid: string, time: number, tier: Difficulty): void {
  void updateUserBestTime(uid, time, tier)
    .then((confirmed) => {
      // Queue under the ORIGINAL uid captured here — not getActiveUser() at resolve time,
      // which may be a different account (or none) if the player switched mid-write (Codex #362).
      if (confirmed === false) queueFailedSync(uid, tier, time, buildSyncDeps());
    })
    .catch(() => {
      queueFailedSync(uid, tier, time, buildSyncDeps());
    });
}

// Drain the pending-sync queue (issue #358, PR 4). Driven by BOTH the `online` event
// (offline→online) AND a real user arriving via setCurrentUser (a persisted login
// restored on reload settles AFTER initializeScores' early flush already no-opped with
// no active user — Codex #362). When there's queued work but Firestore was never
// initialized (an offline first-load), the flush would no-op — so reinitialize Firestore
// first: its initializeScores() re-runs this module's flush once the instance is live.
// Otherwise flush directly. Guarded on a signed-in user + actual pending work so a plain
// reconnect/sign-in doesn't churn a reinit. `reinitializeFirestore` early-returns once
// Firestore exists and never calls setCurrentUser, so there's no reinit→init→flush loop.
function drainPendingSyncQueue() {
  try {
    const activeUser = getActiveUser();
    // Only reinitialize when THIS user actually has queued work (hasPendingSync scoped to
    // their uid) — a foreign user's leftover marker must not churn a reinit for someone
    // who has nothing to sync (Codex #362).
    if (!firestore && activeUser && hasPendingSync(activeUser.uid)) {
      const authModule = window.AuthModule as { reinitializeFirestore?: () => unknown } | null | undefined;
      if (authModule && typeof authModule.reinitializeFirestore === 'function') {
        console.log('Reconnected with a pending offline best; reinitializing Firestore to sync it.');
        authModule.reinitializeFirestore();
        return;
      }
    }
  } catch (error) {
    console.warn('Reconnect reinit check failed:', error);
  }
  flushOfflineScoreQueue();
}

function ensureOnlineFlushListener() {
  if (offlineSyncOnlineListenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  offlineSyncOnlineListenerBound = true;
  window.addEventListener('online', drainPendingSyncQueue);
}

/**
 * Set the current user for score tracking
 * @param {Object} user - Firebase auth user object
 */
function setCurrentUser(user: User | null) {
  currentUser = user;
  // A persisted login restored on reload calls this AFTER initializeScores' early flush
  // already no-opped (no active user yet), and setCurrentUser used to do nothing further
  // — so an already-online session with a pending offline best stayed stuck until some
  // later reconnect/reinit (Codex #362). Now that a real (non-anonymous) user is present,
  // drain the queue. drainPendingSyncQueue is internally guarded on online + Firestore
  // (reinit if needed) + a real active user + actual pending work, so this is a no-op on
  // logout, guests, offline, or an empty queue.
  if (user && !user.isAnonymous) {
    drainPendingSyncQueue();
  }
}

function getActiveUser(): User | null {
  if (currentUser) {
    return currentUser;
  }

  // window.AuthModule is the untyped (any) boot bridge; narrow it to the two accessors
  // used here so callers get a typed User back instead of any — otherwise type-checking
  // is silently disabled on every .uid/.displayName access at this function's call sites.
  const authModule = window.AuthModule as {
    getAuthState?: () => { user?: User | null } | null;
    getCurrentUser?: () => User | null;
  } | null | undefined;
  if (!authModule) {
    return null;
  }

  try {
    const authStateUser: User | null =
      authModule.getAuthState?.()?.user || authModule.getCurrentUser?.() || null;
    // Anonymous "guest" users have no leaderboard identity: AuthModule still
    // reports them as signed in (so the UI shows logged-in chrome), but their best
    // time must stay local until they upgrade to a real provider (which reuses the
    // same uid and re-fires this path with isAnonymous === false). Skipping them
    // here ensures a guest finishing a run never writes to users/leaderboard.
    if (authStateUser && !authStateUser.isAnonymous) {
      currentUser = authStateUser;
      return authStateUser;
    }
  } catch (error) {
    console.warn("Unable to refresh current user from AuthModule:", error);
  }

  return null;
}

/**
 * Update user's best time in Firestore
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateUserBestTime(userId: string, time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<boolean> {
  // Guard clauses. Resolve `false` (not a confirmed sync) so the offline-queue flush
  // keeps its pending marker rather than clearing it on a skip.
  if (!firestore) {
    console.log("Skipping best time update (Firestore unavailable).");
    return Promise.resolve(false);
  }
  if (!userId) {
    console.warn("Skipping best time update (User ID missing).");
    return Promise.resolve(false);
  }
  if (!isValidScoreTime(time)) {
    console.warn("Skipping best time update (Invalid time value):", time);
    return Promise.resolve(false);
  }

  // Per-tier best-time field on the user doc (Blue == 'bestTime', unchanged).
  const bestField = userBestTimeField(tier);

  let userDocRef: DocumentReference;
  try {
    userDocRef = doc(firestore, 'users', userId);
  } catch (error) {
    console.error("Unexpected error in updateUserBestTime:", error);
    return Promise.resolve(false);
  }

  // Read the stored best, then write only when this run ties or beats it. This is a
  // plain getDoc + setDoc, not a transaction: setDoc queues offline and flushes on
  // reconnect on its own, so a finish during a network blip still syncs without any
  // custom retry timer/backoff. The narrow read-then-write race (two tabs finishing
  // within the same few hundred ms) is self-healing — the next finish, or the on-login
  // syncUserData reconciliation in auth.js, re-applies the authoritative best. The
  // RETURNED promise resolves true only when the personal-best write actually settles,
  // so the offline-queue flush (sync-manager.ts) clears its durable marker on a
  // confirmed sync and KEEPS it on any failure (Codex #362).
  return getDoc(userDocRef)
    .then(docSnap => {
      const storedBest: unknown = docSnap.exists() ? docSnap.data()[bestField] : null;
      // isValidScoreTime is a type guard: aliasing its result in `hasStoredBest`
      // narrows `storedBest` to `number` wherever hasStoredBest gates its use below.
      const hasStoredBest = isValidScoreTime(storedBest);
      if (storedBest !== null && storedBest !== undefined && !hasStoredBest) {
        console.warn(`Ignoring invalid stored best for user ${userId}:`, storedBest);
      }
      // The authoritative best is the better of the stored value and this run. This is
      // the value the leaderboard must reflect — never the raw run time, which may be
      // slower than a best already stored from another device/tab.
      const authoritativeBest = hasStoredBest ? Math.min(storedBest, time) : time;

      let userWrite: Promise<void>;
      if (!hasStoredBest || time <= storedBest) {
        console.log(`Updating best time for user ${userId} to ${time} (${bestField})`);
        userWrite = setDoc(userDocRef, {
          [bestField]: time,
          updatedAt: serverTimestamp() // Track when the best time was updated
        }, { merge: true });
      } else {
        console.log(`New time (${time}) is not better than stored best (${storedBest}). User doc unchanged.`);
        userWrite = Promise.resolve();
      }

      // Reconcile the leaderboard toward the authoritative best AFTER the user write
      // settles, in a SEPARATE write so a leaderboard-only permission/rule failure
      // can't abort the personal-best sync above. Chaining onto the setDoc promise
      // (rather than firing in parallel) is what makes an offline finish durable: when
      // setDoc stays queued until reconnect, the leaderboard read+write run only once
      // we are back online, so the backfill rides the SDK's own offline queue instead
      // of being dropped by an immediate read against an uncached leaderboard doc. We
      // still reconcile when the user write failed or was skipped, so a missing entry —
      // the original bug — is backfilled, and passing authoritativeBest (not the raw
      // run time) means a slower local run never downgrades the board. The leaderboard
      // backfill stays fire-and-forget (its own offline-queue durability); the returned
      // success reflects the PERSONAL-BEST write settling.
      return userWrite
        .then(() =>
          // Confirmed only when the leaderboard backfill ALSO settles, so a queued
          // offline best is not marked flushed until it actually reaches the board
          // (Codex #362). updateLeaderboard is still a SEPARATE write — its failure
          // doesn't abort the personal-best write above, it only withholds the
          // "confirmed" signal so the flush keeps its retry marker.
          updateLeaderboard(userId, authoritativeBest, tier)
        )
        .catch(error => {
          console.warn("Best time write did not complete:", error);
          // Still reconcile the board (original behavior), but a failed user write means
          // this sync is not confirmed — resolve false so the flush keeps its marker.
          return updateLeaderboard(userId, authoritativeBest, tier).then(() => false);
        });
    })
    .catch(error => {
      // getDoc can reject when offline with nothing cached (or on a permission/rules
      // issue). Nothing is written now; the local best stays in localStorage and the
      // on-login syncUserData reconciliation re-applies it on the next sign-in.
      console.warn("Could not sync best time now; will reconcile on next sign-in.", error);
      return false;
    });
}

/**
 * Update the global leaderboard entry for a user (compare-and-write).
 *
 * Runs as a separate getDoc + setDoc from the user best-time write in updateUserBestTime,
 * so a leaderboard-only permission/rule failure does not abort the personal-best sync.
 * It writes only when this time improves (or creates) the entry, so a slower run never
 * downgrades a faster existing entry. The setDoc queues offline and flushes on reconnect.
 * @param {string} userId - Firebase user ID
 * @param {number} time - Run completion time in seconds
 */
function updateLeaderboard(userId: string, time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<boolean> {
  // Resolves `true` only when the board is in the desired state after this call (either
  // written, or it already held a faster/equal entry). Resolves `false` on any read/write
  // failure, so the offline-queue flush keeps its pending marker until BOTH the user-doc
  // write AND this leaderboard backfill have settled (Codex #362).
  if (!isValidScoreTime(time)) {
    console.warn("Skipping leaderboard update (Invalid time value):", time);
    return Promise.resolve(false);
  }

  // Check AuthModule first for availability
  if (!window.AuthModule?.isFirebaseAvailable?.().firestore) {
    console.log("Skipping leaderboard update (Firestore unavailable according to AuthModule).");
    if (firestore) {
        console.warn("updateLeaderboard: AuthModule reports unavailable, clearing local Firestore instance.");
        firestore = null; // Ensure local state matches AuthModule if it became unavailable
    }
    return Promise.resolve(false);
  }
  // If AuthModule thinks it's available, but we don't have it locally, bail out;
  // doc() needs a valid Firestore instance.
  if (!firestore) {
      console.warn("updateLeaderboard: AuthModule reports Firestore available, but local instance is null. Skipping.");
      return Promise.resolve(false);
  }

  let userDocRef: DocumentReference;
  let leaderboardDocRef: DocumentReference;
  try {
    // Reference to the user document (used as a foreign key in leaderboard)
    userDocRef = doc(firestore, 'users', userId);
    // Use the user's UID as the document ID in the tier's leaderboard collection
    // (Blue == 'leaderboard', unchanged).
    leaderboardDocRef = doc(firestore, leaderboardCollectionName(tier), userId);
  } catch (error) {
    console.error("Unexpected error in updateLeaderboard:", error);
    return Promise.resolve(false);
  }

  // Read the current entry, then write only when this time improves (or creates) it,
  // so a slower run can never downgrade a faster board entry.
  return getDoc(leaderboardDocRef)
    .then(leaderboardSnap => {
      const leaderboardBest: unknown = leaderboardSnap.exists() ? leaderboardSnap.data().time : null;
      if (leaderboardBest !== null && !isValidScoreTime(leaderboardBest)) {
        console.warn(`Replacing invalid leaderboard entry for user ${userId}:`, leaderboardBest);
      }
      if (isValidScoreTime(leaderboardBest) && time > leaderboardBest) {
        console.log(`Leaderboard already has a faster entry for user ${userId}. No update needed.`);
        return true; // desired state already present — nothing to retry
      }
      console.log(`Updating leaderboard entry for user ${userId} with time ${time}`);
      // Denormalize the player's display name onto the board entry: the rules
      // (deliberately) deny cross-user /users profile reads, so the name must
      // travel on the leaderboard doc itself for other players to see it.
      // Nullable, truncated to the rules' 40-char cap, and only taken from the
      // signed-in user whose entry this is. Escaped on output (leaderboardRow).
      const activeUser = getActiveUser();
      const displayName = (activeUser && activeUser.uid === userId && activeUser.displayName)
        ? String(activeUser.displayName).slice(0, 40)
        : null;
      return setDoc(leaderboardDocRef, {
        user: userDocRef, // Store a reference to the user document
        time: time,
        displayName: displayName,
        achievedAt: serverTimestamp() // Record when this score was achieved/updated
      })
        .then(() => { console.log("Leaderboard updated successfully for user:", userId); return true; })
        .catch(error => {
          // Rules-skew fallback (codex #277): CI deploys firestore.rules AFTER
          // GitHub Pages, so a freshly-deployed client can briefly write against
          // the previous rules, whose key allowlist rejects the displayName field
          // (permission-denied) — and would keep rejecting it if that rules deploy
          // failed outright. Retry once in the old-rules shape (no displayName) so
          // the SCORE is never lost to the skew; the name backfills on a later
          // finish once the new rules are live (a same-time rewrite is allowed).
          if ((error as { code?: string })?.code === 'permission-denied') {
            console.warn("Leaderboard write with displayName rejected; retrying without it (rules skew?).");
            return setDoc(leaderboardDocRef, {
              user: userDocRef,
              time: time,
              achievedAt: serverTimestamp()
            })
              .then(() => { console.log("Leaderboard updated (no displayName) for user:", userId); return true; })
              .catch(retryError => { console.warn("Leaderboard write did not complete:", retryError); return false; });
          }
          console.warn("Leaderboard write did not complete:", error);
          return false;
        });
    })
    .catch(error => {
      // Read failed (offline with nothing cached, permissions, etc.); skip this
      // update. The personal-best write above is unaffected, and the next finish or
      // the on-login syncUserData reconciliation re-applies the authoritative best.
      console.warn("Could not read leaderboard entry for comparison; skipping update.", error);
      return false;
    });
}

/**
 * Get leaderboard data (top 10 scores)
 * @returns {Promise<Array>} Promise resolving to array of score objects
 */
/** A leaderboard row assembled from a Firestore `leaderboard` document. */
export interface LeaderboardScore {
  userId: string;     // the leaderboard document id (== the user's uid)
  time: number;       // best run time in seconds
  userRef: DocumentReference; // reference to the user doc (denormalized foreign key)
  displayName: string | null; // denormalized at write time; null on legacy/guestless entries
}

/** The trusted shape decoded from a raw Firestore `leaderboard` document. */
interface LeaderboardDoc {
  user: DocumentReference;
  time: number;
  displayName: string | null;
}

/**
 * Decode+validate a raw Firestore leaderboard document at the trust boundary, so the
 * untyped `DocumentData` never flows into the app as `any`. Returns null for anything
 * that isn't a valid, complete entry (invalid/absent time, missing user ref).
 */
function readLeaderboardDoc(data: unknown): LeaderboardDoc | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!isValidScoreTime(d.time)) return null; // narrows d.time to number
  if (!d.user) return null;
  return {
    user: d.user as DocumentReference,
    time: d.time,
    displayName: typeof d.displayName === 'string' ? d.displayName : null,
  };
}

function getLeaderboard(tier: Difficulty = DEFAULT_DIFFICULTY): Promise<LeaderboardScore[]> {
  // Check AuthModule first for availability
   if (!window.AuthModule?.isFirebaseAvailable?.().firestore) {
    console.log("Cannot get leaderboard (Firestore unavailable according to AuthModule).");
     if (firestore) {
        console.warn("getLeaderboard: AuthModule reports unavailable, clearing local Firestore instance.");
        firestore = null; // Ensure local state matches AuthModule
    }
    return Promise.resolve([]);
  }
   // If AuthModule thinks it's available, but we don't have it locally, log warning.
   if (!firestore) {
       console.warn("getLeaderboard: AuthModule reports Firestore available, but local instance is null. Attempting fetch anyway.");
   }

  try {
    // firestore is non-null on the normal path; if AuthModule lied (warned above)
    // this best-effort call throws and is handled by the surrounding catch.
    const leaderboardRef = collection(firestore!, leaderboardCollectionName(tier));
    // Query for top 10 scores, ordered by time ascending
    const q = query(
      leaderboardRef,
      where('time', '>=', MIN_VALID_SCORE_TIME),
      orderBy('time', 'asc'),
      limit(10)
    );

    console.log("Fetching leaderboard data...");
    return getDocs(q)
      .then(snapshot => {
        const scores: LeaderboardScore[] = [];
        snapshot.forEach(docSnap => {
          // Decode the raw DocumentData through the trust boundary — invalid/incomplete
          // entries (bad time, missing user ref) are dropped rather than flowing as `any`.
          const decoded = readLeaderboardDoc(docSnap.data());
          if (decoded) {
            scores.push({
              userId: docSnap.id, // The user ID is the document ID
              time: decoded.time,
              userRef: decoded.user, // DocumentReference to the user doc
              // Denormalized name (may be absent on entries written before the
              // field existed — the renderer falls back to 'Anonymous').
              displayName: decoded.displayName
            });
          } else {
            console.warn("Skipping invalid leaderboard entry:", docSnap.id, docSnap.data());
          }
        });
        console.log("Leaderboard data fetched:", scores.length, "entries");
        return scores;
      })
      .catch((error: { code?: string }) => {
        console.error("Error fetching leaderboard:", error);
        // Only set Firestore to null for serious connectivity issues, not permissions
        if (error.code === 'unavailable' || error.code === 'failed-precondition') {
          console.warn("Firestore became unavailable fetching leaderboard. Clearing local instance.");
          firestore = null; // Set local instance to null
        } else if (error.code === 'permission-denied') {
          console.warn("Permission issues with Firestore leaderboard access. Continuing with limited functionality.");
          // Don't disable Firestore entirely for permission issues
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
 * Build one leaderboard table row with DOM APIs — never string-concatenated markup.
 * Player names and avatar URLs are user-controlled data (today the viewer's own auth
 * profile; other players' strings once display names are denormalized onto the
 * leaderboard docs), so the name is set via textContent and the avatar via property
 * assignment, which cannot inject markup. The avatar scheme is allowlisted to https:
 * so a javascript:/data: URL never reaches an attribute.
 * @param {number} rank - 1-based leaderboard position
 * @param {string} name - Player display name (untrusted)
 * @param {string|null} photoURL - Avatar URL (untrusted)
 * @param {number} time - Run time in seconds
 * @param {boolean} isCurrentUser - Highlight the signed-in viewer's own row
 */
function leaderboardRow(rank: number, name: string, photoURL: string | null,
                        time: number, isCurrentUser: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (isCurrentUser) tr.className = 'current-user-score';

  tr.insertCell().textContent = String(rank);

  const playerTd = tr.insertCell();
  if (photoURL && /^https:\/\//.test(photoURL)) {
    const img = document.createElement('img');
    img.className = 'mini-avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = photoURL;
    playerTd.appendChild(img);
  }
  playerTd.appendChild(document.createTextNode(name));

  tr.insertCell().textContent = `${time.toFixed(2)}s`;
  return tr;
}

/**
 * Display leaderboard in game over overlay
 */
function displayLeaderboard(tier: Difficulty = DEFAULT_DIFFICULTY) {
  const leaderboardElement = document.getElementById('leaderboard');
  if (!leaderboardElement) return;

  leaderboardElement.innerHTML = '<h3>Loading Leaderboard...</h3>';

  if (!window.navigator.onLine) {
    leaderboardElement.innerHTML = '<h3>Leaderboard unavailable (offline)</h3>';
    return;
  }

  // --- Revised Logic ---
  const firestoreIsAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore ?? false;

  // Function to attempt fetching and rendering the leaderboard
  const attemptFetchAndRender = () => {
    // Double-check AuthModule status AND local instance before fetching
    if (!window.AuthModule?.isFirebaseAvailable?.().firestore || !firestore) {
        console.warn("attemptFetchAndRender: Pre-fetch check failed. Firestore unavailable.");
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        return; // Stop if unavailable before starting fetch
    }

    console.log("attemptFetchAndRender: Firestore available, fetching leaderboard...");
    getLeaderboard(tier)
      .then(scores => {
        // Check availability *after* the async call, primarily the local instance
        // as getLeaderboard's catch block should have nulled it on error.
        if (!firestore) {
          console.warn("displayLeaderboard: Firestore became unavailable during getLeaderboard fetch.");
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
          return;
        }

        if (scores.length === 0) {
          leaderboardElement.innerHTML = '<h3>No scores recorded yet!</h3>';
          return;
        }

        // Names come denormalized on the leaderboard docs themselves (written by
        // updateLeaderboard): the rules deny cross-user /users profile reads, so a
        // per-entry getDoc can never work — the doc's own displayName is the only
        // name other players can see. Entries written before the field existed
        // fall back to 'Anonymous'.
        const activeUser = getActiveUser();
        // Build the table with DOM APIs (leaderboardRow) rather than an innerHTML
        // string, so user-controlled names/avatars render as text, never as markup.
        const heading = document.createElement('h3');
        heading.textContent = 'Top 10 Times';
        const table = document.createElement('table');
        const headerRow = document.createElement('tr');
        table.appendChild(headerRow);
        for (const label of ['Rank', 'Player', 'Time']) {
          const th = document.createElement('th');
          th.textContent = label;
          headerRow.appendChild(th);
        }

        scores.forEach((score, index) => {
          // Show current user differently (match by userId): their row prefers the
          // live auth profile name, which is fresher than the denormalized copy.
          const isCurrentUser = !!(activeUser && score.userId === activeUser.uid);
          const displayName = isCurrentUser ?
            (activeUser?.displayName || 'You') :
            (score.displayName ?? 'Anonymous');
          table.appendChild(
            leaderboardRow(index + 1, displayName, null, score.time, isCurrentUser));
        });

        leaderboardElement.replaceChildren(heading, table);
        console.log("Leaderboard display updated successfully.");
      })
      .catch(error => {
        console.error("Failed during leaderboard display process:", error);
        // Check local firestore status after the error
        if (!firestore) {
          leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        } else {
          // Firestore might still be technically available, but some other error occurred
          leaderboardElement.innerHTML = '<h3>Failed to load leaderboard data</h3>';
        }
      });
  }; // End of attemptFetchAndRender

  // --- Control Flow ---
  if (firestoreIsAvailable) {
    // If AuthModule says Firestore is available, ensure our local instance is synced.
    // initializeScores should have been called by AuthModule if it just became available.
    if (!firestore) {
        console.warn("displayLeaderboard: AuthModule reports Firestore available, but local instance is null. Attempting reinitialization first.");
        // Try re-initializing via AuthModule, which should call initializeScores on success
        if (window.AuthModule?.reinitializeFirestore?.()) {
            console.log("displayLeaderboard: Reinitialization successful via AuthModule. Fetching leaderboard.");
            // Re-check local instance after re-init attempt
            if (firestore) {
                attemptFetchAndRender();
            } else {
                 console.error("displayLeaderboard: Reinitialization reported success, but local Firestore still null. Leaderboard unavailable.");
                 leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
            }
        } else {
            console.error("displayLeaderboard: Reinitialization failed or AuthModule unavailable. Leaderboard unavailable.");
            leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        }
    } else {
        // AuthModule reports available AND we have a local instance.
        console.log("displayLeaderboard: Firestore available. Proceeding to fetch.");
        attemptFetchAndRender();
    }
  } else {
    console.log("displayLeaderboard: Firestore initially unavailable. Attempting reinitialization.");
    // Try to reinitialize if Firestore isn't available
    if (window.AuthModule?.reinitializeFirestore?.()) {
        console.log("displayLeaderboard: Reinitialization successful via AuthModule. Fetching leaderboard.");
         // Re-check local instance after re-init attempt
        if (firestore) {
            attemptFetchAndRender();
        } else {
             console.error("displayLeaderboard: Reinitialization reported success, but local Firestore still null. Leaderboard unavailable.");
             leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
        }
    } else {
        console.error("displayLeaderboard: Reinitialization failed or AuthModule unavailable. Leaderboard unavailable.");
        leaderboardElement.innerHTML = '<h3>Leaderboard unavailable</h3>';
    }
  }
}

/**
 * Record a completed run score
 * @param {number} time - Run completion time in seconds
 */
function recordScore(time: number, tier: Difficulty = DEFAULT_DIFFICULTY) {
  if (!isValidScoreTime(time)) {
    console.warn("Skipping score record (Invalid time value):", time);
    return;
  }

  // Always store locally first as a fallback and for immediate personal best tracking
  try {
    const localBestTime = readLocalBestTime(tier);
    const isNewLocalBest = localBestTime === null || time < localBestTime;

    if (isNewLocalBest) {
      localStorage.setItem(localBestTimeKey(tier), time.toString());
      stampLocalBestMeta(tier);
      console.log("New local best time recorded:", time);
    } else {
      console.log("Score recorded, but not a new local best time:", time);
    }

    // The best time we want reflected on the leaderboard is the better of this run
    // and any previously stored local best. Syncing this value (rather than only the
    // current run) lets us backfill a best time that was recorded but never made it
    // to Firestore — e.g. a best set before sign-in or under an earlier bug. Without
    // this, a stored best could only reach the leaderboard by being beaten again.
    const effectiveBestTime = isNewLocalBest ? time : localBestTime;

    // Track completion in Analytics (if available)
    if (analytics) {
      logEvent(analytics, 'complete_run', withTrafficTag({ time: time }));
    }

    // Read the signed-in user at record time so auth UI and scoring stay in sync.
    const userAtTimeOfRecord = getActiveUser();

    // If Firestore isn't available but should be, try to reinitialize it
    if (userAtTimeOfRecord && !firestore && window.navigator.onLine &&
        window.AuthModule && typeof window.AuthModule.reinitializeFirestore === 'function') {
      console.log("Firestore unavailable but user is online. Attempting to reinitialize...");
      window.AuthModule.reinitializeFirestore();
    }

    // Sync whenever the user is signed in and Firestore is available. updateUserBestTime
    // compares against the authoritative Firestore value and only writes when the time
    // is better than (or equal to) what is already stored, so syncing on every finish is
    // safe and never downgrades a faster stored time.
    if (userAtTimeOfRecord && firestore) {
      console.log("Attempting to sync best time to Firestore:", effectiveBestTime, `(${tier})`);
      // Fire-and-forget for the finish UI, but a non-confirming result is queued for retry:
      // this sync resolves `false` when it doesn't settle (transient getDoc/setDoc/leaderboard
      // failure), and while online + Firestore-ready the queueOfflineBest() call below writes
      // no marker — so without a retry a flaky-Firestore online finish would strand the best
      // in localStorage. syncBestTimeWithRetry queues it on a non-confirming result (Codex #362).
      syncBestTimeWithRetry(userAtTimeOfRecord.uid, effectiveBestTime, tier); // handles leaderboard update too

      // Track new best time in Analytics (if available)
      if (isNewLocalBest && analytics) {
        logEvent(analytics, 'new_high_score', withTrafficTag({ time: time }));
      }
    } else {
      // Log reasons why Firestore update was skipped
      if (!userAtTimeOfRecord) console.log("Skipping Firestore update: User not signed in.");
      if (!firestore) {
        console.log("Skipping Firestore update: Firestore not available.");
        // Log additional diagnostic information
        if (window.navigator.onLine) {
          console.log("Device is online, but Firestore connection is unavailable. Authentication may have issues.");
        } else {
          console.log("Device appears to be offline. Check internet connection.");
        }
      }
    }

    // Local-first offline queue (issue #358, PR 4): if this run is eligible (a real
    // signed-in user on a ranked tier) but couldn't sync now (Firestore uninitialized
    // / offline), mark it pending so a reconnect flushes it. No-ops for anonymous
    // guests (getActiveUser excludes them), unranked tiers, and normal online syncs.
    queueOfflineBest(tier, effectiveBestTime, buildSyncDeps());

  } catch (error) {
    console.error("Error in recordScore:", error);
    // Attempt to save locally even if other parts fail
    try {
      if (isValidScoreTime(time)) {
        localStorage.setItem(localBestTimeKey(tier), time.toString());
        stampLocalBestMeta(tier);
      }
    } catch (e) {
      console.error("LocalStorage error during fallback save:", e);
    }
  }
}

/**
 * Check if Firestore is currently considered available.
 * Primarily checks AuthModule's status.
 * @returns {boolean}
 */
function isFirestoreAvailable() {
  // Trust AuthModule as the primary source of truth
  const authFirestoreAvailable = window.AuthModule?.isFirebaseAvailable?.().firestore ?? false;
  // Also check our local instance hasn't been nulled due to a recent error
  return authFirestoreAvailable && !!firestore;
}

// Export ScoresModule
const ScoresModule = {
  initializeScores,
  setCurrentUser,
  recordScore,
  displayLeaderboard,
  getLeaderboard,
  updateUserBestTime,
  // Authoritative sync that queues the best for retry if the write doesn't confirm.
  // The sign-in backfill (auth.ts) uses this so a failed backfill isn't dropped (Codex #362).
  syncBestTimeWithRetry,
  updateLeaderboard,
  isFirestoreAvailable,
  isValidScoreTime,
  // Deliberate test seam (not a game API): lets the headless suite exercise the
  // row builder's avatar scheme-allowlist branch directly — no leaderboard data
  // path supplies a photoURL yet, so the guard is unreachable from the public API.
  leaderboardRow
};

// Export as both a module and a global for flexibility
export default ScoresModule;
window.ScoresModule = ScoresModule;

console.log("Scores module successfully loaded and exported");
