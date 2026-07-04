// offline-store.ts — hardened, throw-safe localStorage layer for the offline PWA
// contract (issue #358, PR 1 of the offline-mode stack).
//
// Why this exists: today the best-time / splits / ghost reads are scattered across
// scores.ts, course.ts, result-overlay.ts and auth.ts as bare `localStorage.*`
// calls with per-site try/catch (only difficulty.ts had a null-safe abstraction).
// Offline mode needs storage that NEVER throws — private-browsing / disabled-storage
// / quota-exceeded must degrade to "the choice simply won't persist", not crash the
// run — plus a PENDING-SYNC marker so a best earned offline can be pushed to the
// global leaderboard later (consumed by PR 4).
//
// It reuses the difficulty.ts key builders (the single source of truth for per-tier
// storage names) instead of inventing new key strings, and mirrors the existing
// score-time validation floor (score-limits.ts) so a value this layer accepts is
// exactly a value scores.ts accepts. This PR ships the layer + its tests; the
// consumers (scores.ts sync, course.ts) are rewired in the later stacked PRs.

import { MAX_VALID_SCORE_TIME } from '../score-limits.js';
import {
  localBestTimeKey,
  localBestSplitsKey,
  localGhostKey,
  isDifficulty,
  getDifficultyConfig,
  type Difficulty,
} from '../difficulty.js';

/**
 * The minimal Storage surface this layer needs. Narrowing to these three methods
 * (rather than the full DOM `Storage`) lets the headless test mocks — and any future
 * non-localStorage backing — satisfy the type structurally without stubbing
 * `length`/`key`/`clear`. `localStorage` (a full `Storage`) is assignable to it.
 */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage key holding the map of per-tier scores awaiting a global-leaderboard sync. */
export const PENDING_SYNC_KEY = 'snowgliderPendingSync';

/**
 * A score earned while offline / signed-out that should sync to the global
 * leaderboard once the player is online AND signed in with a real (non-anonymous)
 * account. Keyed by tier in the stored map so only the player's best pending result
 * per tier is retained.
 */
export interface PendingSyncEntry {
  tier: Difficulty;
  time: number;
  /** Epoch ms when the pending best was recorded, or null if not captured. */
  recordedAt: number | null;
}

/**
 * Is `time` a plausible, storable score for `tier`? Uses the TIER'S OWN plausibility
 * floor (`getDifficultyConfig(tier).minScoreTime`), mirroring result-overlay.ts
 * `isPlausibleForTier` — Blue's floor is the global 18 s, but Black/Expert legitimately
 * finish below that (their floor is 13 s), so validating a local best against the
 * global floor would wrongly purge a valid fast Black/Expert time. Every read/write
 * path here is tier-aware for exactly this reason (Codex #359). Rejects
 * NaN/Infinity/strings without throwing.
 */
export function isPlausibleTierTime(tier: Difficulty, time: unknown): time is number {
  return (
    typeof time === 'number' &&
    Number.isFinite(time) &&
    time >= getDifficultyConfig(tier).minScoreTime &&
    time <= MAX_VALID_SCORE_TIME
  );
}

/** Resolve the Storage to use: the explicit one, else ambient localStorage, else null. */
function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Accessing `localStorage` itself can throw in some sandboxed iframes.
    return null;
  }
}

/** Read a raw string, or null on absent key / unavailable storage. Never throws. */
export function safeGetItem(key: string, storage?: StorageLike | null): string | null {
  try {
    const s = resolveStorage(storage);
    return s ? s.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Write a raw string. Returns whether it persisted. Never throws. */
export function safeSetItem(key: string, value: string, storage?: StorageLike | null): boolean {
  try {
    const s = resolveStorage(storage);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    // Quota exceeded / private mode / disabled storage — the value simply won't persist.
    return false;
  }
}

/** Remove a key. Never throws. */
export function safeRemoveItem(key: string, storage?: StorageLike | null): void {
  try {
    const s = resolveStorage(storage);
    if (s) s.removeItem(key);
  } catch {
    /* storage unavailable — nothing to remove */
  }
}

/**
 * Read a tier's validated local best time, or null. Purges a corrupt/implausible
 * stored value (matching scores.ts `readLocalBestTime`) so a junk write can't wedge
 * the local best. Never throws.
 */
export function readLocalBest(tier: Difficulty, storage?: StorageLike | null): number | null {
  const key = localBestTimeKey(tier);
  const raw = safeGetItem(key, storage);
  if (raw === null || raw === '') return null;
  const value = parseFloat(raw);
  if (isPlausibleTierTime(tier, value)) return value;
  safeRemoveItem(key, storage);
  return null;
}

/**
 * Save `time` as the tier's local best only if it is valid AND strictly better than
 * (or the first) stored value. Returns whether it wrote. This is the local-first
 * write the offline path relies on; the improvement check mirrors recordScore so an
 * offline run can never regress a faster stored best. Never throws.
 */
export function saveLocalBestIfBetter(
  tier: Difficulty,
  time: unknown,
  storage?: StorageLike | null
): boolean {
  if (!isPlausibleTierTime(tier, time)) return false;
  const existing = readLocalBest(tier, storage);
  if (existing !== null && existing <= time) return false;
  return safeSetItem(localBestTimeKey(tier), String(time), storage);
}

// --- Pending-sync marker ------------------------------------------------------

/**
 * Read the pending-sync map (tier -> entry). Returns {} on absent key, junk JSON, a
 * non-object payload, or unavailable storage. Entries with an invalid time or a tier
 * that mismatches its key are dropped, so a tampered payload can't feed a forged
 * time into a later leaderboard sync. Never throws.
 */
export function readPendingSync(storage?: StorageLike | null): Record<string, PendingSyncEntry> {
  const raw = safeGetItem(PENDING_SYNC_KEY, storage);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, PendingSyncEntry> = {};
  for (const [tier, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Drop tampered/unknown tiers: a corrupt payload could carry a matching but
    // bogus key/tier pair (e.g. { evil: { tier: 'evil', time: 25 } }); only real
    // difficulty ids may pass so downstream sync can trust the drained map.
    if (!isDifficulty(tier)) continue;
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<PendingSyncEntry>;
    // The stored `tier` field must agree with its (validated) map key AND carry a time
    // plausible for THAT tier (tier-aware floor, Codex #359).
    if (entry.tier !== tier) continue;
    if (!isPlausibleTierTime(tier, entry.time)) continue;
    const recordedAt =
      typeof entry.recordedAt === 'number' && Number.isFinite(entry.recordedAt)
        ? entry.recordedAt
        : null;
    // The `entry.tier !== tier` guard above narrows `tier` to Difficulty here.
    out[tier] = { tier, time: entry.time, recordedAt };
  }
  return out;
}

/** Persist the whole pending-sync map. Returns whether it wrote. Never throws. */
export function writePendingSync(
  map: Record<string, PendingSyncEntry>,
  storage?: StorageLike | null
): boolean {
  try {
    return safeSetItem(PENDING_SYNC_KEY, JSON.stringify(map), storage);
  } catch {
    return false;
  }
}

/**
 * Mark a tier's best offline result as awaiting sync. No-ops (returns false) for an
 * invalid time. Keeps only the BEST (lowest) pending time per tier, so repeated
 * offline runs never queue a slower time over a faster one. `recordedAt` defaults to
 * `Date.now()` when available; pass an explicit value for deterministic tests.
 * Never throws.
 */
export function markPendingSync(
  tier: Difficulty,
  time: unknown,
  opts?: { recordedAt?: number | null; storage?: StorageLike | null }
): boolean {
  if (!isPlausibleTierTime(tier, time)) return false;
  const storage = opts?.storage;
  const map = readPendingSync(storage);
  const existing = map[tier];
  if (existing && existing.time <= time) return false;
  let recordedAt: number | null;
  if (opts && 'recordedAt' in opts) {
    recordedAt = typeof opts.recordedAt === 'number' && Number.isFinite(opts.recordedAt)
      ? opts.recordedAt
      : null;
  } else {
    recordedAt = typeof Date !== 'undefined' && typeof Date.now === 'function' ? Date.now() : null;
  }
  map[tier] = { tier, time, recordedAt };
  return writePendingSync(map, storage);
}

/** The pending entry for a tier, or null. */
export function getPendingSync(tier: Difficulty, storage?: StorageLike | null): PendingSyncEntry | null {
  return readPendingSync(storage)[tier] ?? null;
}

/**
 * Clear a tier's pending marker (call after a successful global-leaderboard sync).
 * Removes the whole key when nothing remains. Never throws.
 */
export function clearPendingSync(tier: Difficulty, storage?: StorageLike | null): void {
  const map = readPendingSync(storage);
  if (!(tier in map)) return;
  delete map[tier];
  if (Object.keys(map).length === 0) {
    safeRemoveItem(PENDING_SYNC_KEY, storage);
  } else {
    writePendingSync(map, storage);
  }
}

// Re-export the reused key builders so the offline layer has a single import surface
// (and to make the difficulty.ts <-> course.ts key contract explicit at call sites).
export { localBestTimeKey, localBestSplitsKey, localGhostKey };
