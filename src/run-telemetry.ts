import type { Difficulty } from './difficulty.js';
import { getDailySelection } from './daily-session.js';
import { getRunStamp } from './run-context.js';

/** Low-cardinality run context, without IDs, dates, seeds, targets or nonces. */
export function runTelemetryContext(
  difficulty: Difficulty,
  timingCompromised = false,
): Record<string, string | number> {
  const stamp = getRunStamp();
  const selection = getDailySelection();
  // The scene's locked invitation must describe the actual run. Never infer
  // entry from the current URL, or label an unrelated practice world as daily.
  const daily = selection.kind === 'daily' && stamp.practice &&
    selection.challenge.difficulty === difficulty &&
    selection.challenge.seed === stamp.seed &&
    selection.challenge.nonce === stamp.nonce &&
    selection.challenge.physicsVersion === stamp.physicsVersion;
  return {
    difficulty,
    physics_version: stamp.physicsVersion,
    practice: stamp.practice ? 'true' : 'false',
    timing_compromised: timingCompromised ? 'true' : 'false',
    run_mode: daily ? 'daily' : stamp.practice ? 'practice' : 'regular',
    challenge_entry: daily ? (selection.targetMs === null ? 'daily' : 'friend') : 'none',
  };
}

type RunAttempt = 'first' | 'second' | 'later';
type RunEventName = 'game_start' | 'game_reset' | 'complete_run' | 'game_over';
interface PendingEvent {
  name: RunEventName;
  params: Record<string, string | number>;
}
interface TrackedRun {
  started: boolean;
  ended: boolean;
  context: Record<string, string | number>;
  queued: PendingEvent[];
  discarded: boolean;
}

// Key by the existing game state, so disposal releases the tracker with the game.
// Resetting physics/intro preparation is not itself a playable start.
const runs = new WeakMap<object, TrackedRun>();
const TAB_RUNS_KEY = 'snowgliderTabRuns';
let tabRuns = 0;
// Auth/Analytics may finish loading after play or even after the result. Retain
// only bounded, primitive event data in memory, never game state or identity.
const pendingRuns = new Set<TrackedRun>();
const MAX_PENDING_RUNS = 16;
let flushing = false;

function nextRunAttempt(): RunAttempt {
  try {
    const stored = typeof window === 'undefined' ? null : window.sessionStorage.getItem(TAB_RUNS_KEY);
    if (stored !== null && /^[0-3]$/.test(stored)) tabRuns = Math.max(tabRuns, Number(stored));
  } catch { /* In-memory counting still works when browser storage is denied. */ }
  tabRuns = Math.min(3, tabRuns + 1);
  try { window.sessionStorage.setItem(TAB_RUNS_KEY, String(tabRuns)); }
  catch { /* Telemetry must never prevent play in a restricted browser. */ }
  return tabRuns === 1 ? 'first' : tabRuns === 2 ? 'second' : 'later';
}

/** Flush on active frames and auth readiness, without delaying gameplay. */
export function flushRunTelemetry(): void {
  if (flushing || pendingRuns.size === 0) return;
  try {
    if (typeof window === 'undefined' || window.location.protocol === 'file:') return;
    const analytics = window.firebaseModules;
    if (typeof analytics?.logEvent !== 'function') return;
    flushing = true;
    for (const run of pendingRuns) {
      try {
        for (const event of run.queued) analytics.logEvent(event.name, event.params);
      } catch {
        // A thrown start cannot be followed by an orphan finish or retried as a
        // duplicate. Drop the remainder of this whole attempt, not just an event.
        run.discarded = true;
      }
      run.queued.length = 0;
      pendingRuns.delete(run);
    }
  } catch { /* Optional Analytics must never interrupt the run or its result. */ }
  finally { flushing = false; }
}

function logRunEvent(run: TrackedRun, name: RunEventName,
                     params: Record<string, string | number>): void {
  if (run.discarded) return;
  run.queued.push({ name, params });
  pendingRuns.add(run);
  if (pendingRuns.size > MAX_PENDING_RUNS) {
    const oldest = pendingRuns.values().next().value;
    if (oldest) {
      oldest.discarded = true;
      oldest.queued.length = 0;
      pendingRuns.delete(oldest);
    }
  }
  flushRunTelemetry();
}

/** Prepare an attempt without claiming that the intro/assets have handed off.
 * Only replacing a previously playable attempt counts as the legacy reset event. */
export function prepareRunTelemetry(state: object, timingCompromised = false): void {
  const previous = runs.get(state);
  if (previous?.started) {
    logRunEvent(previous, 'game_reset', {
      ...previous.context,
      timing_compromised: timingCompromised ? 'true' : 'false',
    });
  }
  runs.set(state, { started: false, ended: false, context: {}, queued: [], discarded: false });
}

/** Called from the first active, visible loop frame, including Reset/Restart.
 * Repeated frames, visibility resumes and late start callbacks are idempotent. */
export function startRunTelemetry(state: object, difficulty: Difficulty): void {
  flushRunTelemetry();
  const current = runs.get(state);
  if (current?.started || current?.ended) return;
  const context = { ...runTelemetryContext(difficulty), run_attempt: nextRunAttempt(), funnel_version: 2 };
  const run: TrackedRun = { started: true, ended: false, context, queued: [], discarded: false };
  runs.set(state, run);
  logRunEvent(run, 'game_start', context);
}

export interface RunEndTelemetry {
  outcome: 'finish' | 'crash';
  time: number;
  timingCompromised?: boolean;
  scoreEligible?: boolean;
  reason?: string;
}

/** One terminal event per playable attempt, independent of auth/score saving.
 * Finish means reaching the end; score_eligible distinguishes ranked results
 * from practice, compromised timing or invalid score times. */
export function endRunTelemetry(state: object, result: RunEndTelemetry): void {
  const run = runs.get(state);
  if (!run?.started || run.ended) return;
  run.ended = true;
  const params: Record<string, string | number> = {
    ...run.context,
    timing_compromised: result.timingCompromised === true ? 'true' : 'false',
  };
  if (Number.isFinite(result.time) && result.time >= 0) params.time = result.time;
  if (result.outcome === 'finish') {
    params.score_eligible = result.scoreEligible === true ? 'true' : 'false';
    logRunEvent(run, 'complete_run', params);
  } else {
    if (result.reason) params.reason = result.reason;
    logRunEvent(run, 'game_over', params);
  }
}
