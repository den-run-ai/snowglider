// Device records for a specific daily mountain. They never become account
// records or canonical leaderboard entries, including after sign-in.
import { isDailyRunEligible, type DailyChallenge } from './daily-challenge.js';
import { getDifficultyConfig, type Difficulty } from './difficulty.js';
import { MAX_VALID_SCORE_TIME } from './score-limits.js';
import type { getRunStamp } from './run-context.js';

export interface DailyBestResult {
  status: 'saved' | 'unchanged' | 'unavailable' | 'ineligible';
  previousMs: number | null;
  bestMs: number | null;
}

export function dailyBestKey(challenge: DailyChallenge): string {
  return `snowgliderDailyBest_${challenge.id}`;
}

function validTimeMs(timeMs: unknown, challenge: DailyChallenge): timeMs is number {
  return typeof timeMs === 'number' && Number.isSafeInteger(timeMs)
    && timeMs >= getDifficultyConfig(challenge.difficulty).minScoreTime * 1000
    && timeMs <= MAX_VALID_SCORE_TIME * 1000;
}

function readBest(challenge: DailyChallenge): number | null {
  const raw = localStorage.getItem(dailyBestKey(challenge));
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return record.challengeId === challenge.id && record.seed === challenge.seed
    && record.physicsVersion === challenge.physicsVersion && validTimeMs(record.timeMs, challenge)
    ? record.timeMs : null;
}

export function readDailyBest(challenge: DailyChallenge): number | null {
  try { return readBest(challenge); } catch { return null; }
}

/** Save only the actual completed run, with a fresh read before the write. */
export function recordDailyBest(
  challenge: DailyChallenge,
  stamp: ReturnType<typeof getRunStamp>,
  tier: Difficulty,
  time: number,
  timingCompromised = false,
): DailyBestResult {
  if (!isDailyRunEligible(challenge, stamp, tier, time, timingCompromised)) {
    return { status: 'ineligible', previousMs: null, bestMs: null };
  }
  try {
    // Preserve an unread record if storage fails; a shared URL's target is never
    // accepted here as evidence that anyone actually completed this mountain.
    const previousMs = readBest(challenge);
    const timeMs = Math.round(time * 1000);
    if (previousMs !== null && previousMs <= timeMs) {
      return { status: 'unchanged', previousMs, bestMs: previousMs };
    }
    localStorage.setItem(dailyBestKey(challenge), JSON.stringify({
      challengeId: challenge.id, seed: challenge.seed,
      physicsVersion: challenge.physicsVersion, timeMs,
    }));
    return { status: 'saved', previousMs, bestMs: timeMs };
  } catch {
    return { status: 'unavailable', previousMs: null, bestMs: null };
  }
}
