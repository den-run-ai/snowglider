// A tier change rebuilds the scene by navigating once. Carry the already-requested
// tier in the URL so it survives blocked storage, then remove it before gameplay or
// sharing. The enum is the only accepted input; no arbitrary state crosses a reload.
import { isDifficulty, readStoredDifficulty, type Difficulty } from '../difficulty.js';
import { buildDailyChallengeUrl, createDailyChallenge, parseDailyChallenge } from '../daily-challenge.js';

const LAUNCH_PARAM = 'play';

export function readRunLaunch(search: string): Difficulty | null {
  const values = new URLSearchParams(search).getAll(LAUNCH_PARAM);
  if (values.length !== 1) return null;
  const value = values[0];
  return isDifficulty(value) ? value : null;
}

export function runLaunchUrl(href: string, difficulty: Difficulty): string {
  const url = new URL(href);
  const daily = parseDailyChallenge(url.search);
  if (daily.kind === 'daily') {
    // Changing level keeps the date, but drops a friend's time from another
    // course. A reload rebuilds terrain and obstacles for the selected level.
    const challenge = createDailyChallenge(daily.challenge.date, difficulty);
    return buildDailyChallengeUrl(challenge, href,
      difficulty === daily.challenge.difficulty ? daily.targetMs ?? undefined : undefined);
  }
  url.searchParams.set(LAUNCH_PARAM, difficulty);
  return url.href;
}

// Captured before either the menu or scene initializes. Consuming the intent must
// not change the tier setupScene subsequently builds if boot timing changes.
const launchDifficulty = typeof window === 'undefined' ? null : readRunLaunch(window.location.search);
const dailyLaunch = typeof window === 'undefined' ? { kind: 'none' as const } : parseDailyChallenge(window.location.search);
let launchConsumed = false;

export function initialRunDifficulty(): Difficulty {
  return dailyLaunch.kind === 'daily' ? dailyLaunch.challenge.difficulty : launchDifficulty ?? readStoredDifficulty();
}

export function isRunTransition(): boolean {
  return launchDifficulty !== null;
}

export function consumeRunLaunch(): Difficulty | null {
  if (launchConsumed || launchDifficulty === null) return null;
  launchConsumed = true;
  const url = new URL(window.location.href);
  url.searchParams.delete(LAUNCH_PARAM);
  window.history.replaceState(window.history.state, '', url.href);
  return launchDifficulty;
}
