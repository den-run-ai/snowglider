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

/** The main loop reads this each frame: while isPaused(), skip stepping AND
 *  rendering; on the first frame after a resume, consumeResumed() tells the loop to
 *  reseed its frame clock (the stopped-rAF case has no paused frame — see below). */
export interface RunClockGuard {
  isPaused(): boolean;
  /** True exactly once after each hidden->visible resume, then self-clears. */
  consumeResumed(): boolean;
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
 * @param {Object} state - The live run state; only `startTime` is touched (shifted,
 *   clamped to now, on resume). `gameActive` stays in the type for the callers'
 *   convenience but is no longer read — see the capture-always note below.
 */
export function createRunClockGuard(
  state: { gameActive: boolean; startTime: number },
  opts: RunClockGuardOptions = {}
): RunClockGuard {
  const doc = opts.doc ?? document;
  const now = opts.now ?? (() => performance.now());

  // performance.now() at the moment the document went hidden; null whenever we are
  // not hidden. Captured UNCONDITIONALLY — not only while a run is active — because
  // a run can BECOME active while the document is already hidden (the player clicks
  // Start, then switches tabs during the first-start loading delay; the deferred
  // startGameplayLoop timer still fires in the background). Gating the capture on
  // gameActive would leave that run unguarded: no interval to shift out on resume
  // and no physics gate on throttled hidden frames (codex review round 2, PR #278).
  // While no run is active the loop isn't running, so a menu/game-over pause is
  // inert, and the resume shift below is clamped so it can never push startTime
  // past `now` (a fresh run re-seeds startTime at start anyway).
  let hiddenAt: number | null = null;
  // Set on each hidden->visible resume, consumed by the loop's next frame. On
  // browsers that STOP rAF for hidden tabs (the common case) no paused frame ever
  // runs, so the loop's `lastTime = time` reset in its isPaused() branch never
  // executes — the resumed frame would then compute frameDelta from the PRE-HIDE
  // lastTime (capped at the ~133 ms spiral guard) against a clock whose hidden
  // interval was just removed. Repeated hide/resume could farm that into free
  // distance (codex review, PR #278). consumeResumed() lets the loop reseed its
  // frame clock on the first visible frame whether or not rAF fired while hidden.
  let resumed = false;

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      if (hiddenAt === null) hiddenAt = now();
    } else if (hiddenAt !== null) {
      // Hidden time doesn't count: every elapsed-time consumer derives from
      // startTime, so this one shift keeps HUD/splits/ghost/finish coherent.
      // Clamped to `now` for the run-started-while-hidden case: if startTime was
      // seeded AFTER the hide began, shifting by the full hidden span would push
      // it into the future (negative elapsed) — the correct resume point for a
      // run with zero visible play time is elapsed exactly 0.
      const t = now();
      state.startTime = Math.min(state.startTime + (t - hiddenAt), t);
      hiddenAt = null;
      resumed = true;
    }
  }, opts.signal ? { signal: opts.signal } : undefined);

  return {
    isPaused: () => hiddenAt !== null,
    consumeResumed: () => {
      const wasResumed = resumed;
      resumed = false;
      return wasResumed;
    }
  };
}
