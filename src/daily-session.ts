// A daily selection is locked when the scene is built. URL edits, midnight,
// sign-in and result-screen tier browsing cannot relabel an already-built run.
import { parseDailyChallenge, type DailyChallenge, type DailyChallengeSelection } from './daily-challenge.js';
import { CANONICAL_WORLD_SEED, parseRunSeedParam, setWorldContext } from './run-context.js';

let selection: DailyChallengeSelection = { kind: 'none' };

/** Capture the invitation before the first world-generation draw. */
export function configureDailySession(search: string, now = new Date()): DailyChallengeSelection {
  selection = parseDailyChallenge(search, now);
  const urlSeed = parseRunSeedParam(search);
  // Daily and invalid invitations cannot enter canonical score/ghost storage.
  setWorldContext(selection.kind === 'daily' ? selection.challenge.seed : urlSeed ?? CANONICAL_WORLD_SEED,
    selection.kind !== 'none' || urlSeed !== null);
  return selection;
}

export function getDailySelection(): DailyChallengeSelection {
  return selection;
}

export function getDailyChallenge(): DailyChallenge | null {
  return selection.kind === 'daily' ? selection.challenge : null;
}

export function clearDailySession(): void {
  selection = { kind: 'none' };
}
