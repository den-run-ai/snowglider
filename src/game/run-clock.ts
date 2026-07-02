// Run-clock guard for SnowGlider: freezes the wall-clock run timer and the physics
// stepper TOGETHER while the document is hidden, so a tab switch / phone lock /
// incoming call is a clean pause instead of a corrupted run.
//
// WHY BOTH (the bug + the cheat it must not introduce)
// ----------------------------------------------------
// The run clock is wall time — `(performance.now() - state.startTime) / 1000` — read
// by the HUD timer, the split/ghost clock (course.ts, on the fixed grid in
// main-loop.ts), and the finish time (result-overlay.ts). Physics, however, advances
// only in fixed 1/60 s steps whose per-frame backlog is capped at MAX_SUBSTEPS *
// FIXED_DT (~133 ms). So any stall — tab switch, phone lock, long GC — used to freeze
// the snowman but not the clock: on resume the run time and every later split were
// inflated by the hidden span, and the ghost (played back at `ghostPositionAt(elapsed)`
// on the same wall clock) teleported ahead. Player-hostile only, and worst on mobile.
//
// The fix shifts `state.startTime` forward by the hidden duration on resume — the same
// idiom the intro fly-over uses to keep the cinematic out of the first run's time
// (snowglider.ts). Because EVERY consumer (HUD, splits, ghost record AND playback,
// finish time, leaderboard submission) derives from the single `elapsed`, one shift
// fixes all of them coherently. The main loop must ALSO skip physics while hidden
// (`isPaused()`, checked at the top of animate()): most browsers stop rAF in background
// tabs, but some throttle it to ~1 fps instead, and a throttled-but-running loop with a
// paused clock would bank up to 133 ms of physics per wall-second against a stopped
// timer — free distance, a cheat vector this fix must not introduce. Pausing both
// together makes tab-hide a true pause.
//
// This is also most of the machinery for an explicit pause (issue #39): an Esc/P key
// can drive the same "freeze clock + skip stepping" contract.

/** The main loop reads this each frame: while true, skip stepping AND rendering. */
export interface RunClockGuard {
  isPaused(): boolean;
}

export interface RunClockGuardOptions {
  /** Ties the visibilitychange listener to the game's teardown (disposeGame). */
  signal?: AbortSignal;
  /** Injectable document / clock so the headless suite can drive visibility flips
   *  and assert exact shifts (tests/run-clock-tests.js); default to the real ones. */
  doc?: Document;
  now?: () => number;
}

/**
 * Install the visibilitychange handler that pauses the run clock while hidden.
 * @param {Object} state - The live run state; only `gameActive` (read) and
 *   `startTime` (shifted on resume) are touched.
 */
export function createRunClockGuard(
  state: { gameActive: boolean; startTime: number },
  opts: RunClockGuardOptions = {}
): RunClockGuard {
  const doc = opts.doc ?? document;
  const now = opts.now ?? (() => performance.now());

  // performance.now() at the moment the document went hidden mid-run; null whenever
  // we are not paused. Captured only while a run is active, so hiding on the start
  // menu / game-over screen never shifts the next run's clock.
  let hiddenAt: number | null = null;

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      if (state.gameActive && hiddenAt === null) hiddenAt = now();
    } else if (hiddenAt !== null) {
      // Hidden time doesn't count: every elapsed-time consumer derives from
      // startTime, so this one shift keeps HUD/splits/ghost/finish coherent.
      state.startTime += now() - hiddenAt;
      hiddenAt = null;
    }
  }, opts.signal ? { signal: opts.signal } : undefined);

  return { isPaused: () => hiddenAt !== null };
}
