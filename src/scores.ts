/** Account-owned personal bests, durable score saves, and per-level leaderboards. */
import {
  doc, setDoc, getDoc, collection, where, orderBy, query, limit, getDocs,
  serverTimestamp, type Firestore, DocumentReference,
} from 'https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js';
import { logEvent, type Analytics } from 'https://www.gstatic.com/firebasejs/11.5.0/firebase-analytics.js';
import type { User } from 'https://www.gstatic.com/firebasejs/11.5.0/firebase-auth.js';
import { MAX_VALID_SCORE_TIME, MIN_SCORE_TIME_BY_DIFFICULTY } from './score-limits.js';
import { withTrafficTag } from './analytics-env.js';
import { runTelemetryContext } from './run-telemetry.js';
import { CANONICAL_WORLD_SEED, PHYSICS_VERSION, getRunStamp } from './run-context.js';
import {
  DEFAULT_DIFFICULTY, getDifficultyConfig, isDifficulty, localBestTimeKey,
  leaderboardCollectionName, userBestTimeField, stampLocalBestMeta, type Difficulty,
} from './difficulty.js';
import {
  queueFailedSync, flushPendingSync, hasPendingSync, type SyncDeps,
} from './offline/sync-manager.js';
import { getPendingSync, clearPendingSync } from './offline/offline-store.js';
import { mountLeaderboardPanel } from './ui/leaderboard-panel.js';
export { readLocalBestMeta } from './difficulty.js';

let firestore: Firestore | null = null;
let analytics: Analytics | null = null;
let currentUser: User | null = null;
let offlineSyncOnlineListenerBound = false;
const inFlightSyncs = new Map<string, Promise<boolean>>();

/** Blue remains the default for existing callers. Every persistence path passes its tier. */
function isValidScoreTime(time: unknown, tier: Difficulty = DEFAULT_DIFFICULTY): time is number {
  return isDifficulty(tier) && typeof time === 'number' && Number.isFinite(time) &&
    time >= MIN_SCORE_TIME_BY_DIFFICULTY[tier] && time <= MAX_VALID_SCORE_TIME;
}

function readErrorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

/** SDK cached/pending documents cannot establish that a remote write settled. */
function isConfirmedSnapshot(snapshot: { metadata?: { fromCache: boolean; hasPendingWrites: boolean } }): boolean {
  return !snapshot.metadata?.fromCache && !snapshot.metadata?.hasPendingWrites;
}

function isOnline(): boolean {
  return typeof window === 'undefined' || window.navigator?.onLine !== false;
}

/**
 * The production game is bundled, while Firebase auth/scores also ship as copied
 * modules. Read the live game's existing seam instead of a second run-context
 * singleton. Only auth-only pages/tests without that seam use the local context.
 * A broken seam must fail closed, never silently fall back to an unseeded world.
 */
function readCompetitiveRunStamp(): ReturnType<typeof getRunStamp> | null {
  try {
    const liveGetter = window.__snowgliderGetRunStamp;
    const hasLiveContext = typeof liveGetter === 'function';
    const raw: unknown = hasLiveContext ? liveGetter() : getRunStamp();
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const seed = value.seed;
    if (value.physicsVersion !== PHYSICS_VERSION || value.practice === true) return null;
    if (value.practice !== undefined && typeof value.practice !== 'boolean') return null;
    if (seed !== null && (typeof seed !== 'number' || seed !== CANONICAL_WORLD_SEED)) return null;
    if (hasLiveContext && seed === null) return null;
    const nonce = value.nonce ?? 0;
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) return null;
    return { seed: typeof seed === 'number' ? seed : null, practice: false, nonce, physicsVersion: PHYSICS_VERSION };
  } catch { return null; }
}

/** Keep the device best for guests / ghosts without treating it as an account claim. */
function readLocalBestTime(tier: Difficulty): number | null {
  const raw = localStorage.getItem(localBestTimeKey(tier));
  if (raw === null) return null;
  const time = Number(raw);
  if (isValidScoreTime(time, tier)) return time;
  localStorage.removeItem(localBestTimeKey(tier));
  return null;
}

/** Separate from the shared device PB: account B must never inherit account A's run. */
export function accountBestTimeKey(uid: string, tier: Difficulty): string {
  return `${localBestTimeKey(tier)}_account_${encodeURIComponent(uid)}`;
}

export function getLocalBestForUser(tier: Difficulty, uid: string): number | null {
  if (!uid || !isDifficulty(tier)) return null;
  try {
    const raw = localStorage.getItem(accountBestTimeKey(uid, tier));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== 'object') return null;
    const value = record as Record<string, unknown>;
    return value.uid === uid && value.physicsVersion === PHYSICS_VERSION &&
      value.seed === CANONICAL_WORLD_SEED && isValidScoreTime(value.time, tier)
      ? value.time : null;
  } catch { return null; }
}

/** Remember an accepted canonical-world run or this account's current remote best. */
export function rememberAccountBest(uid: string, time: number, tier: Difficulty): boolean {
  if (!uid || !isValidScoreTime(time, tier)) return false;
  try {
    // Read before writing. A storage read failure must not overwrite an unread best.
    const key = accountBestTimeKey(uid, tier);
    const raw = localStorage.getItem(key);
    let previous: number | null = null;
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>;
          if (record.uid === uid && record.physicsVersion === PHYSICS_VERSION &&
              record.seed === CANONICAL_WORLD_SEED && isValidScoreTime(record.time, tier)) previous = record.time;
        }
      } catch { /* corrupt account record may be repaired by a valid result */ }
    }
    if (previous !== null && previous <= time) return true;
    localStorage.setItem(key, JSON.stringify({ uid, time, seed: CANONICAL_WORLD_SEED, physicsVersion: PHYSICS_VERSION }));
    return true;
  } catch { return false; }
}

function initializeScores(firestoreInstance: Firestore | null, analyticsInstance: Analytics | null): void {
  firestore = firestoreInstance;
  analytics = analyticsInstance;
  if (!offlineSyncOnlineListenerBound && typeof window?.addEventListener === 'function') {
    offlineSyncOnlineListenerBound = true;
    window.addEventListener('online', drainPendingSyncQueue);
  }
  if (firestore) flushOfflineScoreQueue();
}

function getActiveUser(): User | null {
  // A directly supplied anonymous Firebase identity is still a guest.
  if (currentUser) return currentUser.isAnonymous ? null : currentUser;
  try {
    const authModule = window.AuthModule;
    const user = authModule?.getAuthState?.()?.user ?? authModule?.getCurrentUser?.() ?? null;
    return user && !user.isAnonymous ? user : null;
  } catch { return null; }
}

function ownsSession(uid: string): boolean {
  const user = getActiveUser();
  return !!user && user.uid === uid;
}

function setCurrentUser(user: User | null): void {
  currentUser = user;
  if (user && !user.isAnonymous) drainPendingSyncQueue();
}

function isFirestoreAvailable(): boolean {
  try {
    return !!firestore && (window.AuthModule?.isFirebaseAvailable?.().firestore ?? false);
  } catch { return false; }
}

function ensureFirestore(): boolean {
  if (isFirestoreAvailable()) return true;
  if (!isOnline()) return false;
  try { window.AuthModule?.reinitializeFirestore?.(); }
  catch (error) { console.warn('Firestore reinitialization failed:', error); }
  return isFirestoreAvailable();
}

function buildSyncDeps(): SyncDeps {
  return {
    getActiveUser,
    isFirestoreReady: isFirestoreAvailable,
    sync: syncBestTimeWithRetry,
    isOnline,
  };
}

function flushOfflineScoreQueue(): void {
  void flushPendingSync(buildSyncDeps()).catch(error => console.warn('Score retry failed:', error));
}

function drainPendingSyncQueue(): void {
  const user = getActiveUser();
  if (!isOnline() || !user || !hasPendingSync(user.uid)) return;
  if (ensureFirestore()) flushOfflineScoreQueue();
}

/** A server confirmation, including a completion after the save UI has returned queued. */
function notifyScoreSynced(userId: string, tier: Difficulty, time: number): void {
  try {
    window.dispatchEvent(new CustomEvent('snowglider:score-synced', { detail: { userId, tier, time } }));
  } catch { /* a missing optional UI listener must not affect persistence */ }
}

/**
 * Persist retry intent BEFORE touching Firestore. An SDK write can remain pending
 * during disconnect and page close without ever rejecting. Only a confirmed user
 * best AND leaderboard write may clear the captured owner's pending record.
 */
function syncBestTimeWithRetry(uid: string, time: number, tier: Difficulty): Promise<boolean> {
  if (!ownsSession(uid) || !isValidScoreTime(time, tier) || !getDifficultyConfig(tier).ranked) {
    return Promise.resolve(false);
  }
  queueFailedSync(uid, tier, time, buildSyncDeps());
  const key = JSON.stringify([uid, tier, time]);
  const existing = inFlightSyncs.get(key);
  if (existing) return existing;
  const operation = Promise.resolve().then(() => updateUserBestTime(uid, time, tier))
    .then(confirmed => {
      if (confirmed) {
        const pending = getPendingSync(uid, tier);
        // A faster result may have replaced this marker while the write awaited.
        if (pending && pending.time >= time) clearPendingSync(uid, tier);
        notifyScoreSynced(uid, tier, time);
      }
      return confirmed;
    }).catch(error => {
      console.warn('Score sync did not complete:', error);
      return false;
    }).finally(() => { inFlightSyncs.delete(key); });
  inFlightSyncs.set(key, operation);
  return operation;
}

/** Reconcile this account's current-version personal best before its board entry. */
async function updateUserBestTime(userId: string, time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<boolean> {
  if (!isFirestoreAvailable() || !ownsSession(userId) || !isValidScoreTime(time, tier) ||
      !getDifficultyConfig(tier).ranked) return false;
  const db = firestore!;
  const field = userBestTimeField(tier);
  try {
    const ref = doc(db, 'users', userId);
    const snapshot = await getDoc(ref);
    if (!ownsSession(userId) || firestore !== db) return false;
    const stored: unknown = snapshot.exists() ? snapshot.data()[field] : null;
    let best = isValidScoreTime(stored, tier) ? Math.min(time, stored) : time;
    let userConfirmed = true;
    if (!isValidScoreTime(stored, tier) || time <= stored || !isConfirmedSnapshot(snapshot)) {
      try {
        await setDoc(ref, { [field]: best, updatedAt: serverTimestamp() }, { merge: true });
      } catch (error) {
        // Another tab may already have saved a faster run, causing the server's
        // monotonic rule to reject this stale write. Confirm that state by rereading.
        userConfirmed = false;
        if (readErrorCode(error) === 'permission-denied' && ownsSession(userId)) {
          try {
            const latest = await getDoc(ref);
            const value: unknown = latest.exists() ? latest.data()[field] : null;
            if (isConfirmedSnapshot(latest) && isValidScoreTime(value, tier) && value <= best) {
              best = value;
              userConfirmed = true;
            }
          } catch { /* retain the durable retry */ }
        }
        if (!userConfirmed) console.warn('Personal best write did not complete:', error);
      }
    }
    if (!ownsSession(userId) || firestore !== db) return false;
    if (userConfirmed) rememberAccountBest(userId, best, tier);
    const boardBest = await reconcileLeaderboard(userId, best, tier);
    if (!userConfirmed || boardBest === null) return false;
    // Older clients could finish the board write after the profile write failed.
    // Restore that faster confirmed board record to the profile too, so a fresh
    // device retrieves the same personal best as the leaderboard.
    if (boardBest < best) return updateUserBestTime(userId, boardBest, tier);
    return true;
  } catch (error) {
    console.warn('Could not sync personal best:', error);
    return false;
  }
}

/** Compare-and-write; server monotonic rules arbitrate concurrent tabs/devices. */
async function reconcileLeaderboard(userId: string, time: number, tier: Difficulty): Promise<number | null> {
  if (!isFirestoreAvailable() || !ownsSession(userId) || !isValidScoreTime(time, tier) ||
      !getDifficultyConfig(tier).ranked) return null;
  const db = firestore!;
  try {
    const userRef = doc(db, 'users', userId);
    const ref = doc(db, leaderboardCollectionName(tier), userId);
    const snapshot = await getDoc(ref);
    if (!ownsSession(userId) || firestore !== db) return null;
    const stored: unknown = snapshot.exists() ? snapshot.data().time : null;
    const best = isValidScoreTime(stored, tier) ? Math.min(stored, time) : time;
    if (isValidScoreTime(stored, tier) && stored < time && isConfirmedSnapshot(snapshot)) {
      rememberAccountBest(userId, stored, tier);
      return stored;
    }
    const user = getActiveUser();
    const displayName = user?.displayName ? String(user.displayName).slice(0, 40) : null;
    try {
      await setDoc(ref, { user: userRef, time: best, displayName, achievedAt: serverTimestamp() });
      rememberAccountBest(userId, best, tier);
      return best;
    } catch (error) {
      // Monotonic race: a better completed write already satisfies this save.
      if (readErrorCode(error) === 'permission-denied' && ownsSession(userId)) {
        try {
          const latest = await getDoc(ref);
          const value: unknown = latest.exists() ? latest.data().time : null;
          if (isConfirmedSnapshot(latest) && isValidScoreTime(value, tier) && value <= time) {
            rememberAccountBest(userId, value, tier);
            return value;
          }
        } catch { /* retain retry intent */ }
        // Keep compatibility with an older deployed allowlist during a rules
        // rollback. A denied score remains queued if this narrow retry fails too.
        if (ownsSession(userId) && firestore === db) {
          try {
            await setDoc(ref, { user: userRef, time: best, achievedAt: serverTimestamp() });
            rememberAccountBest(userId, best, tier);
            return best;
          } catch { /* the owner-bound marker remains for a later retry */ }
        }
      }
      console.warn('Leaderboard write did not complete:', error);
      return null;
    }
  } catch (error) {
    console.warn('Could not reconcile leaderboard:', error);
    return null;
  }
}

/** Backward-compatible direct board API; account reconciliation uses the confirmed time. */
async function updateLeaderboard(userId: string, time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<boolean> {
  return (await reconcileLeaderboard(userId, time, tier)) !== null;
}

export interface LeaderboardScore {
  userId: string;
  time: number;
  userRef: DocumentReference;
  displayName: string | null;
}

export interface LeaderboardResult {
  status: 'ready' | 'offline' | 'signed-out' | 'unavailable';
  scores: LeaderboardScore[];
}

/** Preserve the SDK generic type only after verifying both identity and ownership. */
function isUserReference(value: unknown, userId: string): value is DocumentReference {
  return value instanceof DocumentReference && value.path === `users/${userId}`;
}

/** Decode SDK identities and numeric fields instead of trusting untyped document data. */
function readLeaderboardDoc(data: unknown, userId: string, tier: Difficulty): LeaderboardScore | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (!isValidScoreTime(value.time, tier) || !isUserReference(value.user, userId)) return null;
  return {
    userId, time: value.time, userRef: value.user,
    displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 40) : null,
  };
}

/** An empty successfully loaded board is distinct from sign-in / connectivity errors. */
async function getLeaderboardResult(tier: Difficulty = DEFAULT_DIFFICULTY): Promise<LeaderboardResult> {
  if (!isOnline()) return { status: 'offline', scores: [] };
  const uid = getActiveUser()?.uid;
  if (!uid) return { status: 'signed-out', scores: [] };
  if (!isDifficulty(tier) || !ensureFirestore()) return { status: 'unavailable', scores: [] };
  try {
    const ref = collection(firestore!, leaderboardCollectionName(tier));
    const snapshot = await getDocs(query(ref,
      where('time', '>=', MIN_SCORE_TIME_BY_DIFFICULTY[tier]),
      orderBy('time', 'asc'), limit(10)));
    if (!ownsSession(uid)) return { status: 'signed-out', scores: [] };
    if (!isOnline() || snapshot.metadata?.fromCache) return { status: 'offline', scores: [] };
    const scores: LeaderboardScore[] = [];
    snapshot.forEach(row => {
      const score = readLeaderboardDoc(row.data(), row.id, tier);
      if (score) scores.push(score);
    });
    return { status: 'ready', scores };
  } catch (error) {
    console.warn('Leaderboard could not be loaded:', error);
    return { status: !isOnline() ? 'offline' : !ownsSession(uid) ? 'signed-out' : 'unavailable', scores: [] };
  }
}

/** Backward-compatible list API; new UI uses the status-bearing read above. */
async function getLeaderboard(tier: Difficulty = DEFAULT_DIFFICULTY): Promise<LeaderboardScore[]> {
  return (await getLeaderboardResult(tier)).scores;
}

/** Safe legacy row builder; player-controlled strings are always DOM text. */
function leaderboardRow(rank: number, name: string, photoURL: string | null,
                        time: number, isCurrentUser: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (isCurrentUser) tr.className = 'current-user-score';
  tr.insertCell().textContent = String(rank);
  const player = tr.insertCell();
  if (photoURL && /^https:\/\//.test(photoURL)) {
    const img = document.createElement('img');
    img.className = 'mini-avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = photoURL;
    player.appendChild(img);
  }
  player.appendChild(document.createTextNode(name));
  tr.insertCell().textContent = `${time.toFixed(2)}s`;
  return tr;
}

function displayLeaderboard(tier: Difficulty = DEFAULT_DIFFICULTY): void {
  const container = document.getElementById('leaderboard');
  if (container) mountLeaderboardPanel(container, tier);
}

function logScoreEvent(name: 'complete_run' | 'new_high_score', time: number, tier: Difficulty, stamp: ReturnType<typeof getRunStamp>): void {
  if (!analytics) return;
  try {
    logEvent(analytics, name, withTrafficTag({
      time, ...runTelemetryContext(tier),
      physics_version: stamp.physicsVersion, practice: stamp.practice ? 'true' : 'false',
    }));
  }
  catch (error) { console.warn('Score analytics unavailable:', error); }
}

export interface ScoreSaveResult {
  status: 'saved' | 'queued' | 'local' | 'unavailable' | 'invalid';
  localSaved: boolean;
  userId?: string;
}

/** Return queued promptly when Firestore waits indefinitely for a connection. */
async function waitForConfirmation(operation: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 4000); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Persist a run after capturing and validating its live provenance once. */
async function persistScore(time: number, tier: Difficulty, stamp: ReturnType<typeof getRunStamp>): Promise<ScoreSaveResult> {
  let localSaved = false;
  try {
    const deviceBest = readLocalBestTime(tier);
    if (deviceBest === null || time < deviceBest) {
      localStorage.setItem(localBestTimeKey(tier), String(time));
      stampLocalBestMeta(tier, stamp);
    }
    localSaved = true;
  } catch (error) { console.warn('Device best could not be saved:', error); }

  const user = getActiveUser();
  if (!user || !getDifficultyConfig(tier).ranked) return { status: 'local', localSaved };
  const uid = user.uid;
  // Only this account's own best may improve the submitted run. The shared
  // device record stays visible, but is never silently claimed on sign-in.
  const accountBest = getLocalBestForUser(tier, uid);
  const timeToSave = accountBest === null ? time : Math.min(time, accountBest);
  rememberAccountBest(uid, timeToSave, tier);
  queueFailedSync(uid, tier, timeToSave, buildSyncDeps());
  if (isOnline() && ensureFirestore() && ownsSession(uid)) {
    const confirmed = await waitForConfirmation(syncBestTimeWithRetry(uid, timeToSave, tier));
    if (confirmed) return { status: 'saved', localSaved, userId: uid };
  }
  const queued = getPendingSync(uid, tier);
  return { status: queued && queued.time <= timeToSave ? 'queued' : 'unavailable', localSaved, userId: uid };
}

/** Explicit current-run claim / retry, without logging another completed run. */
function saveScore(time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<ScoreSaveResult> {
  const stamp = readCompetitiveRunStamp();
  if (!isValidScoreTime(time, tier) || !stamp) return Promise.resolve({ status: 'invalid', localSaved: false });
  return persistScore(time, tier, stamp);
}

function recordScore(time: number, tier: Difficulty = DEFAULT_DIFFICULTY): Promise<ScoreSaveResult> {
  const stamp = readCompetitiveRunStamp();
  if (!isValidScoreTime(time, tier) || !stamp) return Promise.resolve({ status: 'invalid', localSaved: false });
  logScoreEvent('complete_run', time, tier, stamp);
  const user = getActiveUser();
  const previous = user ? getLocalBestForUser(tier, user.uid) : null;
  if (user && (previous === null || time < previous)) logScoreEvent('new_high_score', time, tier, stamp);
  return persistScore(time, tier, stamp);
}

const ScoresModule = {
  initializeScores, setCurrentUser, recordScore, saveScore, displayLeaderboard,
  getLeaderboard, getLeaderboardResult, getLocalBestForUser, rememberAccountBest,
  updateUserBestTime, syncBestTimeWithRetry, updateLeaderboard, isFirestoreAvailable,
  isValidScoreTime, leaderboardRow,
};
export default ScoresModule;
window.ScoresModule = ScoresModule;
