/**
 * Versioned, UTC daily-mountain identity and untrusted invitation parsing.
 *
 * This module only describes a challenge. It never changes a run, stores a best,
 * writes a leaderboard, draws randomness, or touches browser state. The first
 * playable layer deliberately runs in the isolated practice world; its device
 * record must not enter the canonical all-level leaderboard.
 */
import { isDifficulty } from './difficulty.js';
import type { Difficulty } from './difficulty.js';
import { PHYSICS_VERSION } from './run-context.js';
import { MAX_VALID_SCORE_TIME, MIN_SCORE_TIME_BY_DIFFICULTY } from './score-limits.js';

/** Increment when the daily identity, seed mapping, or challenge rules change. */
export const DAILY_CHALLENGE_VERSION = 1;

const DAY_MS = 86_400_000;
const UINT32_RANGE = 4_294_967_296;
const FIRST_DAY = '1970-01-01';
const DEFAULT_URL = 'https://snowglider.ai/';
const MAX_SEARCH_LENGTH = 8_192;
const TIER_ORDINAL: Readonly<Record<Difficulty, number>> = {
  bunny: 0,
  blue: 1,
  black: 2,
  expert: 3,
};
const SINGLETON_PARAMS = ['daily', 'level', 'cv', 'pv', 'beat', 'seed', 'play'] as const;
const DAILY_PARAMS = new Set(['daily', 'cv', 'pv', 'beat']);
const ADJECTIVES = [
  'Alpine', 'Amber', 'Arctic', 'Crystal', 'Dawn', 'Frost', 'Glacier', 'Golden',
  'Hidden', 'Ivory', 'Moonlit', 'Northern', 'Silver', 'Snowy', 'Starlit', 'Winter',
] as const;
const LANDMARKS = [
  'Basin', 'Bowl', 'Cascade', 'Crest', 'Falls', 'Glade', 'Gully', 'Hollow',
  'Meadow', 'Pass', 'Peak', 'Ridge', 'Run', 'Saddle', 'Traverse', 'Valley',
] as const;

/** Stable challenge identity. A target time is deliberately not part of it. */
export interface DailyChallenge {
  readonly id: string;
  readonly date: string;
  readonly day: number;
  readonly difficulty: Difficulty;
  readonly physicsVersion: number;
  readonly challengeVersion: number;
  readonly seed: number;
  readonly nonce: 0;
  readonly name: string;
}

/** Invalid/unsupported links are explicit states; callers must block daily Play. */
export type DailyChallengeSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' | 'unsupported'; readonly reason: string }
  | { readonly kind: 'daily'; readonly challenge: DailyChallenge; readonly targetMs: number | null };

/** The completed run's actual provenance, independently of its invitation URL. */
export interface DailyRunStamp {
  readonly seed: number | null;
  readonly practice: boolean;
  readonly nonce: number;
  readonly physicsVersion: number;
}

function parseUtcDay(date: string): number | null {
  // Date.parse normalizes e.g. February 30, so require a round trip as well as
  // canonical syntax. Four-digit, post-epoch years keep rule arithmetic exact.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < FIRST_DAY) return null;
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString().slice(0, 10) !== date) return null;
  return milliseconds / DAY_MS;
}

/** Resolve an instant to its UTC calendar day; never use the viewer's timezone. */
export function utcDayString(now: Date | number = new Date()): string {
  const milliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(milliseconds)) throw new RangeError('A valid daily challenge clock is required.');
  const date = new Date(milliseconds).toISOString().slice(0, 10);
  if (parseUtcDay(date) === null) throw new RangeError('Daily challenge dates must be between 1970 and 9999.');
  return date;
}

/**
 * Create the currently supported challenge for a canonical date and tier.
 * Future dates are permitted here for authoring; link parsing gates them against
 * its injected clock. Invalid dates/tiers throw instead of silently falling back.
 */
export function createDailyChallenge(date: string, difficulty: Difficulty): DailyChallenge {
  const day = typeof date === 'string' ? parseUtcDay(date) : null;
  if (day === null) throw new RangeError('A daily challenge needs a real YYYY-MM-DD date from 1970 through 9999.');
  if (!isDifficulty(difficulty)) throw new TypeError('A daily challenge needs a known difficulty.');
  // Exact integer arithmetic in JS and Firestore rules: even 9999-12-31 keeps
  // this dividend below 2^53. The world seed controls layout and hazard streams;
  // a fixed nonce keeps auto-turns and avalanche behavior reproducible too.
  const seed = (day * 1_664_525 + 1_013_904_223 + TIER_ORDINAL[difficulty] * 69_069) % UINT32_RANGE;
  const adjective = ADJECTIVES[seed % ADJECTIVES.length] ?? ADJECTIVES[0];
  const landmark = LANDMARKS[Math.floor(seed / 65_536) % LANDMARKS.length] ?? LANDMARKS[0];
  return Object.freeze({
    id: `d${DAILY_CHALLENGE_VERSION}-v${PHYSICS_VERSION}-${day}-${difficulty}`,
    date,
    day,
    difficulty,
    physicsVersion: PHYSICS_VERSION,
    challengeVersion: DAILY_CHALLENGE_VERSION,
    seed,
    nonce: 0,
    name: `${adjective} ${landmark}`,
  });
}

/** Validate all derived fields at storage/share boundaries, including versions. */
export function isDailyChallenge(value: unknown): value is DailyChallenge {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DailyChallenge>;
  if (typeof candidate.date !== 'string' || !isDifficulty(candidate.difficulty)) return false;
  if (parseUtcDay(candidate.date) === null) return false;
  const expected = createDailyChallenge(candidate.date, candidate.difficulty);
  return candidate.id === expected.id && candidate.day === expected.day &&
    candidate.physicsVersion === expected.physicsVersion &&
    candidate.challengeVersion === expected.challengeVersion &&
    candidate.seed === expected.seed && candidate.nonce === 0 && candidate.name === expected.name;
}

/** Invitation times use integer milliseconds and each tier's existing bounds. */
export function isValidDailyTargetMs(value: unknown, difficulty: Difficulty): value is number {
  return isDifficulty(difficulty) && typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= MIN_SCORE_TIME_BY_DIFFICULTY[difficulty] * 1_000 &&
    value <= MAX_VALID_SCORE_TIME * 1_000;
}

/**
 * Parse only explicit, versioned daily intent. Ordinary/practice URLs return
 * `none`; orphaned daily metadata and malformed daily links fail closed. Unknown
 * parameters may coexist (campaign tags, display options), but never enter the
 * challenge identity or the URL produced by buildDailyChallengeUrl.
 */
export function parseDailyChallenge(search: string, now: Date | number = new Date()): DailyChallengeSelection {
  if (typeof search !== 'string' || search.length > MAX_SEARCH_LENGTH) {
    return { kind: 'invalid', reason: 'This challenge link is too long or malformed.' };
  }
  const params = new URLSearchParams(search);
  const hasDailyIntent = [...params.keys()].some(key => DAILY_PARAMS.has(key.toLowerCase()));
  if (!hasDailyIntent) return { kind: 'none' };
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if (SINGLETON_PARAMS.some(name => name === lower) && key !== lower) {
      return { kind: 'invalid', reason: 'This challenge link has a malformed parameter name.' };
    }
  }
  for (const name of SINGLETON_PARAMS) {
    if (params.getAll(name).length > 1) {
      return { kind: 'invalid', reason: 'This challenge link repeats a run parameter.' };
    }
  }
  if (params.has('seed')) {
    return { kind: 'invalid', reason: 'A daily mountain cannot also specify a practice seed.' };
  }
  const date = params.get('daily');
  const difficulty = params.get('level');
  const challengeVersion = params.get('cv');
  const physicsVersion = params.get('pv');
  if (date === null || parseUtcDay(date) === null) {
    return { kind: 'invalid', reason: 'This challenge needs a real YYYY-MM-DD date.' };
  }
  if (!isDifficulty(difficulty)) {
    return { kind: 'invalid', reason: 'This challenge needs a known difficulty.' };
  }
  if (challengeVersion === null || physicsVersion === null ||
    !/^[1-9]\d{0,8}$/.test(challengeVersion) || !/^[1-9]\d{0,8}$/.test(physicsVersion)) {
    return { kind: 'invalid', reason: 'This challenge needs explicit challenge and physics versions.' };
  }
  if (challengeVersion !== String(DAILY_CHALLENGE_VERSION) || physicsVersion !== String(PHYSICS_VERSION)) {
    return { kind: 'unsupported', reason: 'This challenge uses rules that this game version does not support.' };
  }
  // A matching one-shot launch is harmless; a conflicting one would build a
  // different tier than the daily identity. Do not let the menu decide silently.
  if (params.has('play') && params.get('play') !== difficulty) {
    return { kind: 'invalid', reason: 'This challenge link requests two different difficulties.' };
  }
  let today: string;
  try {
    today = utcDayString(now);
  } catch {
    return { kind: 'invalid', reason: 'The current date could not be checked for this challenge.' };
  }
  if (date > today) return { kind: 'invalid', reason: 'This daily mountain is not available yet.' };
  const target = params.get('beat');
  let targetMs: number | null = null;
  if (target !== null) {
    if (!/^[1-9]\d{0,5}$/.test(target) || !isValidDailyTargetMs(Number(target), difficulty)) {
      return { kind: 'invalid', reason: 'This challenge target is outside the supported time range.' };
    }
    targetMs = Number(target);
  }
  return { kind: 'daily', challenge: createDailyChallenge(date, difficulty), targetMs };
}

/**
 * Build a clean daily link. Preserve only the supplied HTTP(S) origin/path; drop
 * credentials, fragments and every old query parameter. The caller chooses the
 * public sharing origin. A target is an invitation, never a claimed record.
 */
export function buildDailyChallengeUrl(
  challenge: DailyChallenge,
  href: string = DEFAULT_URL,
  targetMs: number | null = null,
): string {
  if (!isDailyChallenge(challenge)) throw new TypeError('Cannot share an invalid or unsupported daily challenge.');
  if (targetMs !== null && !isValidDailyTargetMs(targetMs, challenge.difficulty)) {
    throw new RangeError('Cannot share a daily target outside its tier time bounds.');
  }
  const url = new URL(href, DEFAULT_URL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Daily challenge links require an HTTP(S) URL.');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.searchParams.set('daily', challenge.date);
  url.searchParams.set('level', challenge.difficulty);
  url.searchParams.set('cv', String(challenge.challengeVersion));
  url.searchParams.set('pv', String(challenge.physicsVersion));
  if (targetMs !== null) url.searchParams.set('beat', String(targetMs));
  return url.href;
}

/**
 * Gate a completed run's local daily record. Read the actual stamp at finish and
 * pass the scene's locked challenge/tier, never an editable URL or pending menu
 * choice. This is client consistency validation, not server anti-cheat proof.
 * Daily v1 is isolated from canonical ranking through practice=true.
 */
export function isDailyRunEligible(
  challenge: DailyChallenge,
  stamp: DailyRunStamp,
  tier: Difficulty,
  timeSeconds: number,
  timingCompromised = false,
): boolean {
  return isDailyChallenge(challenge) && stamp !== null && typeof stamp === 'object' &&
    stamp.seed === challenge.seed && stamp.practice === true && stamp.nonce === challenge.nonce &&
    stamp.physicsVersion === challenge.physicsVersion && tier === challenge.difficulty &&
    timingCompromised === false && Number.isFinite(timeSeconds) &&
    timeSeconds >= MIN_SCORE_TIME_BY_DIFFICULTY[challenge.difficulty] &&
    timeSeconds <= MAX_VALID_SCORE_TIME;
}
