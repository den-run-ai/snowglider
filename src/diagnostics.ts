// diagnostics.ts — runtime physics / frame-rate telemetry for SnowGlider.
//
// WHY THIS EXISTS (the bug class it targets)
// ------------------------------------------
// PR #209 and its avalanche follow-up both fixed the *same* shape of bug: a quantity
// integrated as a **per-frame** multiplier (`v *= 1 - k`) while every neighbouring
// force is **delta-scaled** (`v += a * dt`). Mixing the two makes the steady state
// scale with frame rate — the snowman's terminal speed ballooned ~8 → ~32 m/s from 60
// to 10 FPS, fast enough to slip between (and, when a per-frame step exceeded an
// obstacle's collision radius, tunnel straight through) the trees. It was invisible to
// every existing test because none of them *varied the frame time*, and invisible in
// play because it only bites on a slow/mobile device that the developer never runs on.
//
// This module is the **runtime** counterpart to the offline stress harnesses
// (tests/verification/forward_stress_harness.js, physics_invariant_harness.js): instead
// of sweeping dt in CI, it watches the dt the *real device* actually produces and the
// physics observables that ride on it, and surfaces the same three smells live —
//   1. low-FPS frames whose per-frame STEP exceeds an obstacle radius  → tunnel risk;
//   2. terminal SPEED that climbs as FPS drops                          → fps-dependent force;
//   3. NaN/Infinity in the state.
// It turns "the game freezes / I drove through a tree" — an unreproducible field report
// — into a downloadable JSON trace (`__snowgliderDiag.dump()`) with the exact dt, speed,
// step, and fps-band breakdown, so the next bug in this class is diagnosed, not guessed.
//
// DESIGN CONSTRAINTS (mirroring sfx.ts / intro.ts / debris)
//   - **Read-only observer.** record() takes the per-frame physics RESULT plus pos —
//     it never writes pos/velocity or any kernel state, so the physics-invariant
//     harness stays byte-identical. It is wired in alongside Sfx/Flex, after the step.
//   - **Automation-safe.** Off by default under ?test= suites (window.isTestMode) and
//     webdriver runs (Playwright/Puppeteer), unless a test opts in via
//     window.testHooks.diagnosticsEnabled — so existing tests keep their exact paths.
//   - **Headless-testable.** All the analytics (percentiles, per-frame classification,
//     the running summary fold, the health verdict) are exported PURE functions that
//     need no DOM/AudioContext, so they unit-test in Node (npm run test:diagnostics).
//   - **Cheap.** O(1) per frame: a fixed ring buffer for the recent trace plus an
//     incremental summary fold (no full-history scan). The DOM overlay repaints at a
//     throttled ~6 Hz, and console warnings are rate-limited per category.
//   - **Inert without a DOM** (jsdom/Node): the overlay/keybind/window-API setup is
//     skipped, but the pure analytics still run, so the recorder is safe to construct
//     anywhere.
//
// To disable entirely: set DIAG_ENABLED = false (all methods early-exit).

const DIAG_ENABLED = true;

// --- Tunables ------------------------------------------------------------------
const RING_CAPACITY = 1200;     // ~20 s of 60 FPS trace kept for the overlay + dump
const OVERLAY_HZ = 6;           // overlay repaint rate (throttled; cheap)
const WARN_THROTTLE_SEC = 4;    // min seconds between repeats of the same warning
const MIN_SAMPLE_FRAMES = 30;   // a run must reach this many frames (~0.5s) to be sampled
// The fps→speed comparison only counts "settled" frames — at genuine cruising speed — so a
// snowman still accelerating from the spawn (vz0 = -3 m/s) doesn't pollute the band maxima.
// The floor is set near the expected terminal speed (not just above the spawn speed): a
// mid-acceleration ~5 m/s frame is NOT cruising, and comparing its band max against true
// 8 m/s cruising in another band would read normal run progression as frame-rate
// dependence (codex). Pair that with a strong BAD threshold so only an egregious,
// #209-scale low-vs-high-FPS gap emits an anomaly; a modest gap is WARN-only, since it can
// come from progression/technique rather than a frame-rate-dependent force.
const SETTLE_FRACTION = 0.85;          // settled := speed >= speedExpected * this (~6.8 m/s)
const MIN_BAND_FRAMES_FOR_RATIO = 10;  // a band needs this many settled frames to be comparable
const FPS_RATIO_BAD = 2.0;             // low/high-FPS cruise-speed gap this large => BAD (#209 was ~4x)
const FPS_RATIO_WARN = 1.5;            // a milder gap => WARN (may be progression/technique, not a bug)

// FPS bands the summary buckets frames into. The whole point of the module: if the
// max speed in a SLOWER band is materially higher than in a FAST band, a force path is
// frame-rate dependent (the #209 smell). Ordered fast → slow.
// `key` is the analytics-safe form of `label` (Firebase event-param names must be
// alphanumeric + underscore), used to flatten the FPS distribution into session_health.
export interface FpsBand { label: string; key: string; minFps: number; maxFps: number; }
export const FPS_BANDS: FpsBand[] = [
  { label: '>=50',  key: 'fps_ge50',  minFps: 50, maxFps: Infinity },
  { label: '30-50', key: 'fps_30_50', minFps: 30, maxFps: 50 },
  { label: '15-30', key: 'fps_15_30', minFps: 15, maxFps: 30 },
  { label: '<15',   key: 'fps_lt15',  minFps: 0,  maxFps: 15 },
];

export interface DiagConfig {
  /** Legacy per-frame delta clamp (the pre-accumulator loop used min(delta, 0.1)). Since
   *  the fixed-timestep refactor the loop records one sample PER FIXED SUBSTEP at
   *  FIXED_DT (1/60 s), so live samples never sit at this cap — tunnelRisk is now zero by
   *  construction. Kept for the headless harnesses that still feed variable dt directly,
   *  and as the "device below 1/cap FPS" threshold for those. */
  frameCapSec: number;
  /** Smallest obstacle collision radius the discrete point-vs-disk check guards (trees
   *  use 2.5). A per-frame step >= this could skip the disk entirely → tunnel risk. */
  collisionRadius: number;
  /** Rough expected 60 Hz cruising/terminal speed (~8 m/s). Only used to flag a frame
   *  as "fast" for the overlay; the fps-band correlation is what actually detects the bug. */
  speedExpected: number;
  /** Absolute speed ceiling (m/s) no legitimate descent should ever exceed, even buggy
   *  (#209 topped out ~32 at 10 FPS). A frame above this is a runaway regardless of frame
   *  rate, so it is caught even at a steady FPS where the fps-band ratio sees nothing. */
  speedCeiling: number;
  /** Interval (in-game seconds) between `session_health` baseline heartbeats during a long
   *  run. A run shorter than this still gets exactly one sample at run-end (reset), so even
   *  short healthy runs contribute a baseline — the comparison set for `physics_anomaly`. */
  healthSampleSec: number;
}

export const DEFAULT_CONFIG: DiagConfig = {
  frameCapSec: 0.1,
  collisionRadius: 2.5,
  speedExpected: 8,
  speedCeiling: 50,
  healthSampleSec: 30,
};

/** A structured event sink (e.g. Firebase Analytics logEvent). Injected via init() so
 *  diagnostics.ts stays decoupled from Firebase and unit-tests with a stub. Called at
 *  most once per run for a physics anomaly, and per uncaught error/rejection. */
export type DiagSink = (event: string, data: Record<string, unknown>) => void;

/** One frame's physics observables, as read from the kernel result + position. */
export interface FrameSample {
  dt: number;
  speed: number;
  x: number;
  z: number;
  technique: string;
  isInAir: boolean;
}

/** Per-frame anomaly flags derived from a sample and the previous position. */
export interface FrameFlags {
  step: number;        // planar distance moved this frame (world units)
  fps: number;         // 1/dt
  clamped: boolean;    // dt pinned at the loop cap → device below 1/cap FPS
  tunnelRisk: boolean; // step >= collisionRadius → discrete check could miss a disk
  nonFinite: boolean;  // any of dt/speed/x/z not finite
  runaway: boolean;    // speed past the absolute ceiling — impossible-for-legit-play fast
  settled: boolean;    // speed >= cruising floor — eligible for the fps-band speed compare
  fast: boolean;       // speed well above the expected 60 Hz terminal speed
}

export interface BandStat {
  label: string;
  frames: number;
  speedMax: number;
  speedSum: number;        // for the mean; kept raw so the fold stays additive
  settledFrames: number;   // frames at/above the cruising floor (used by the ratio)
  settledSpeedMax: number; // max speed among settled frames only
}

/** The incremental running summary. Folded one frame at a time so the recorder never
 *  rescans history; also the exact object frameRateHealth() + dump() consume. */
export interface DiagSummary {
  frames: number;
  durationSec: number;
  dtMaxSec: number;
  clampedFrames: number;
  stepMax: number;
  speedMax: number;
  tunnelRiskFrames: number;
  nonFiniteFrames: number;
  runawayFrames: number;
  bands: BandStat[];
}

export interface HealthVerdict {
  level: 'ok' | 'warn' | 'bad';
  reasons: string[];
}

// --- Pure analytics (no DOM; unit-tested headlessly) ---------------------------

/** Linear-interpolated percentile of an ascending-sorted array. p in [0,1]. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0]!;
  const idx = Math.min(n - 1, Math.max(0, p * (n - 1)));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

/** Classify one frame relative to the previous position + the config thresholds. */
export function classifyFrame(prev: { x: number; z: number } | null, s: FrameSample, cfg: DiagConfig): FrameFlags {
  const finite = Number.isFinite(s.dt) && Number.isFinite(s.speed) &&
    Number.isFinite(s.x) && Number.isFinite(s.z);
  const step = prev && finite ? Math.hypot(s.x - prev.x, s.z - prev.z) : 0;
  const fps = s.dt > 0 ? 1 / s.dt : Infinity;
  return {
    step,
    fps,
    clamped: finite && s.dt >= cfg.frameCapSec - 1e-9,
    tunnelRisk: step >= cfg.collisionRadius,
    nonFinite: !finite,
    runaway: finite && s.speed > cfg.speedCeiling,
    settled: finite && s.speed >= cfg.speedExpected * SETTLE_FRACTION,
    fast: finite && s.speed > cfg.speedExpected * 1.5,
  };
}

/** Empty summary seed for the fold. */
export function emptySummary(): DiagSummary {
  return {
    frames: 0, durationSec: 0, dtMaxSec: 0, clampedFrames: 0,
    stepMax: 0, speedMax: 0, tunnelRiskFrames: 0, nonFiniteFrames: 0, runawayFrames: 0,
    bands: FPS_BANDS.map((b) => ({ label: b.label, frames: 0, speedMax: 0, speedSum: 0, settledFrames: 0, settledSpeedMax: 0 })),
  };
}

/** Fold one frame into the running summary (mutates + returns `agg` for chaining).
 *  Additive/idempotent per frame, so the recorder calls it once per frame and the
 *  tests can fold an array to get the same result. */
export function foldFrame(agg: DiagSummary, s: FrameSample, flags: FrameFlags): DiagSummary {
  agg.frames += 1;
  if (Number.isFinite(s.dt)) {
    agg.durationSec += s.dt;
    if (s.dt > agg.dtMaxSec) agg.dtMaxSec = s.dt;
  }
  if (flags.clamped) agg.clampedFrames += 1;
  if (flags.tunnelRisk) agg.tunnelRiskFrames += 1;
  if (flags.runaway) agg.runawayFrames += 1;
  if (flags.nonFinite) { agg.nonFiniteFrames += 1; return agg; } // don't pollute speed stats
  if (flags.step > agg.stepMax) agg.stepMax = flags.step;
  if (s.speed > agg.speedMax) agg.speedMax = s.speed;
  // Bucket by fps so we can correlate speed against frame rate.
  for (let i = 0; i < FPS_BANDS.length; i++) {
    const b = FPS_BANDS[i]!;
    if (flags.fps >= b.minFps && flags.fps < b.maxFps) {
      const bs = agg.bands[i]!;
      bs.frames += 1;
      bs.speedSum += s.speed;
      if (s.speed > bs.speedMax) bs.speedMax = s.speed;
      // Only settled (cruising-speed) frames feed the fps→speed ratio, so an accelerating
      // snowman at the start of a run can't masquerade as frame-rate dependence.
      if (flags.settled) {
        bs.settledFrames += 1;
        if (s.speed > bs.settledSpeedMax) bs.settledSpeedMax = s.speed;
      }
      break;
    }
  }
  return agg;
}

/** Mean speed in a band (0 if the band saw no frames). */
export function bandMeanSpeed(b: BandStat): number {
  return b.frames > 0 ? b.speedSum / b.frames : 0;
}

/** The fps-dependence signal at the heart of this module: the ratio of the max SETTLED
 *  speed seen in the SLOWEST eligible band to the FASTEST eligible band. ~1 means speed is
 *  frame-rate independent (good); >> 1 means a force path scales with frame time (the
 *  #209 bug). Only "settled" frames at genuine cruising speed (>= SETTLE_FRACTION of the
 *  expected terminal speed) count, and each band needs MIN_BAND_FRAMES_FOR_RATIO of them to
 *  be eligible — so neither an accelerating start, a mid-acceleration sub-cruise frame, nor
 *  a handful of fluke frames forms the ratio. Needs both a fast (>=30 FPS) and a slow
 *  (<30 FPS) band eligible to mean anything; returns 1 (no signal) otherwise so it never
 *  false-alarms on a steady FPS or an unsettled run. A modest ratio is only WARN; BAD
 *  requires the egregious, #209-scale gap (see FPS_RATIO_BAD in frameRateHealth). */
export function fpsSpeedRatio(summary: DiagSummary): number {
  const eligible = (b: BandStat) => b.settledFrames >= MIN_BAND_FRAMES_FOR_RATIO;
  const fast = summary.bands.filter((b, i) => FPS_BANDS[i]!.minFps >= 30 && eligible(b));
  const slow = summary.bands.filter((b, i) => FPS_BANDS[i]!.maxFps <= 30 && eligible(b));
  if (fast.length === 0 || slow.length === 0) return 1;
  const fastMax = Math.max(...fast.map((b) => b.settledSpeedMax));
  const slowMax = Math.max(...slow.map((b) => b.settledSpeedMax));
  if (fastMax <= 1e-6) return 1;
  return slowMax / fastMax;
}

/** Turn a summary into an actionable verdict. Thresholds chosen to be quiet on a
 *  healthy run and loud on the #209 signature. */
export function frameRateHealth(summary: DiagSummary, cfg: DiagConfig): HealthVerdict {
  const reasons: string[] = [];
  let level: HealthVerdict['level'] = 'ok';
  const bump = (l: HealthVerdict['level']) => {
    if (l === 'bad') level = 'bad';
    else if (l === 'warn' && level === 'ok') level = 'warn';
  };

  if (summary.nonFiniteFrames > 0) {
    reasons.push(`${summary.nonFiniteFrames} non-finite frame(s) — NaN/Infinity in physics state`);
    bump('bad');
  }
  if (summary.tunnelRiskFrames > 0) {
    reasons.push(`${summary.tunnelRiskFrames} frame(s) stepped >= ${cfg.collisionRadius}u (an obstacle radius) — collision tunnel risk`);
    bump('bad');
  }
  if (summary.runawayFrames > 0) {
    reasons.push(`${summary.runawayFrames} frame(s) above the ${cfg.speedCeiling} m/s speed ceiling — runaway speed (frame-rate independent)`);
    bump('bad');
  }
  const ratio = fpsSpeedRatio(summary);
  if (ratio >= FPS_RATIO_BAD) {
    reasons.push(`cruise speed ${ratio.toFixed(1)}x higher in low-FPS frames than high-FPS — frame-rate-dependent force (the #209 class)`);
    bump('bad');
  } else if (ratio >= FPS_RATIO_WARN) {
    reasons.push(`cruise speed ${ratio.toFixed(1)}x higher at low FPS — possible frame-rate dependence (or normal run progression)`);
    bump('warn');
  }
  const clampedPct = summary.frames > 0 ? summary.clampedFrames / summary.frames : 0;
  if (clampedPct >= 0.1) {
    reasons.push(`${(clampedPct * 100).toFixed(0)}% of frames hit the ${cfg.frameCapSec * 1000}ms delta cap — device below ${Math.round(1 / cfg.frameCapSec)} FPS`);
    bump('warn');
  }
  if (reasons.length === 0) reasons.push('no frame-rate anomalies detected');
  return { level, reasons };
}

// --- Stateful recorder + DOM overlay (the live device side) --------------------

class Diagnostics {
  private cfg: DiagConfig = DEFAULT_CONFIG;
  private active = false;
  private ring: Array<FrameSample & FrameFlags> = [];
  private head = 0;
  private summary: DiagSummary = emptySummary();
  private prev: { x: number; z: number } | null = null;
  private lastWarn: Record<string, number> = {};
  private overlay: HTMLElement | null = null;
  private lastOverlayPaint = 0;
  private clockSec = 0; // accumulated in-game seconds (dt sum); avoids Date.now in tests
  private sink: DiagSink = () => {}; // structured-event transport (Firebase Analytics)
  private reportedAnomaly = false;   // physics anomaly reported once per run (debounce)
  private lastHealthEmitSec = 0;     // clock of the last session_health emit (heartbeat dedup)
  private errorHandlersInstalled = false;
  private notes: Array<{ atSec: number; category: string; detail: Record<string, unknown> }> = [];

  /** Wire up the recorder. Safe to call once at startup. Honors the automation gate and
   *  the ?debug overlay flag; without a DOM it just enables the headless recorder.
   *  `opts.report` injects the structured-event transport (e.g. Firebase Analytics). */
  init(cfg?: Partial<DiagConfig>, opts?: { report?: DiagSink }): void {
    if (!DIAG_ENABLED) return;
    this.cfg = { ...DEFAULT_CONFIG, ...(cfg || {}) };
    if (opts && opts.report) this.sink = opts.report;
    if (typeof window === 'undefined') { this.active = true; return; }

    const automated = !!window.isTestMode ||
      (typeof navigator !== 'undefined' && !!navigator.webdriver);
    const optedIn = !!(window.testHooks && window.testHooks.diagnosticsEnabled);
    // The recorder is cheap and read-only, so leave it on in normal play; only the
    // automated suites stay byte-identical unless a test opts in (matches debris/sfx).
    this.active = !automated || optedIn;
    if (!this.active) return;

    // Global error capture: there is no other window.onerror / unhandledrejection in the
    // app, so an uncaught throw in the rAF loop (a real "freezes" candidate) otherwise
    // vanishes. Route it through the same sink with the recent physics trace as context.
    this.installErrorHandlers();

    const search = (window.location && window.location.search) || '';
    const wantOverlay = /[?&]debug(=|&|$)/.test(search) || /[?&]debug=(physics|all)/.test(search);

    if (typeof document !== 'undefined') {
      if (wantOverlay) this.ensureOverlay();
      // Hotkey: backtick toggles the overlay during normal play (off under automation).
      window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === '`') this.toggleOverlay();
      });
      // Last-chance baseline flush: if the player navigates away mid-run or after a
      // game-over without pressing Reset, reset() never runs — so emit the owed
      // session_health here. pagehide is the reliable teardown hook on mobile (Safari
      // fires it where unload/beforeunload are unreliable); de-duped via flushHealthBaseline.
      window.addEventListener('pagehide', () => this.flushHealthBaseline());
      // Bug-report API: __snowgliderDiag.dump() returns the trace + verdict and, in a
      // browser, also downloads it as JSON so a tester can attach it to an issue.
      (window as unknown as { __snowgliderDiag?: unknown }).__snowgliderDiag = {
        snapshot: () => this.snapshot(),
        dump: () => this.dump(),
        reset: () => this.reset(),
        overlay: (on?: boolean) => (on === undefined ? this.toggleOverlay() : on ? this.ensureOverlay() : this.hideOverlay()),
      };
    }
  }

  /** Record one frame. READ-ONLY: never mutates pos/velocity/kernel state. Called from
   *  the main loop right after the physics step, beside Sfx/Flex. */
  record(s: FrameSample): void {
    if (!DIAG_ENABLED || !this.active) return;
    const flags = classifyFrame(this.prev, s, this.cfg);
    foldFrame(this.summary, s, flags);
    this.clockSec += Number.isFinite(s.dt) ? s.dt : 0;

    // Ring buffer of the recent trace (for the overlay + dump).
    const entry = { ...s, ...flags };
    if (this.ring.length < RING_CAPACITY) this.ring.push(entry);
    else { this.ring[this.head] = entry; this.head = (this.head + 1) % RING_CAPACITY; }

    if (!flags.nonFinite) this.prev = { x: s.x, z: s.z };
    this.maybeWarn(flags);
    this.maybeReport();
    this.maybeHeartbeat();
    this.maybePaint();
  }

  /** Structured run summary shared by `physics_anomaly` and `session_health`. Flattens the
   *  FPS-band distribution (frames per band) so a healthy baseline and an anomaly are the
   *  SAME shape and directly comparable in analytics. */
  private healthPayload(): Record<string, unknown> {
    const sm = this.summary;
    const payload: Record<string, unknown> = {
      level: frameRateHealth(sm, this.cfg).level,
      frames: sm.frames,
      durationSec: +sm.durationSec.toFixed(1),
      fps: sm.durationSec > 0 ? Math.round(sm.frames / sm.durationSec) : 0,
      dtMaxMs: Math.round(sm.dtMaxSec * 1000),
      clampedFrames: sm.clampedFrames,
      speedMax: +sm.speedMax.toFixed(1),
      stepMax: +sm.stepMax.toFixed(2),
      tunnelFrames: sm.tunnelRiskFrames,
      runawayFrames: sm.runawayFrames,
      nonFiniteFrames: sm.nonFiniteFrames,
      fpsSpeedRatio: +fpsSpeedRatio(sm).toFixed(2),
    };
    sm.bands.forEach((b, i) => { payload[`${FPS_BANDS[i]!.key}_frames`] = b.frames; });
    return payload;
  }

  /** Report a physics anomaly to the sink at most ONCE per run (debounced) — the moment
   *  the run's health verdict first reaches BAD. Aggregated across real devices this is
   *  how the #209 class would surface in the wild: low-FPS sessions correlating with
   *  runaway speed / tunnel events, instead of an unreproducible "I drove through a tree". */
  private maybeReport(): void {
    if (this.reportedAnomaly) return;
    const health = frameRateHealth(this.summary, this.cfg);
    if (health.level !== 'bad') return;
    this.reportedAnomaly = true;
    this.emit('physics_anomaly', { reasons: health.reasons.join(' | '), ...this.healthPayload() });
  }

  /** Emit a `session_health` baseline sample and stamp the heartbeat clock. Fired
   *  periodically through a long run and once at run-end (reset), so HEALTHY runs — not
   *  just anomalies — contribute the FPS-distribution baseline that gives a BAD verdict
   *  context. Carries the same shape as `physics_anomaly` (minus `reasons`). */
  private emitHealthSample(): void {
    this.lastHealthEmitSec = this.clockSec;
    this.emit('session_health', this.healthPayload());
  }

  /** Periodic heartbeat during a long run (run-end sampling is handled in reset()). */
  private maybeHeartbeat(): void {
    if (this.summary.frames < MIN_SAMPLE_FRAMES) return;
    if (this.clockSec - this.lastHealthEmitSec < this.cfg.healthSampleSec) return;
    this.emitHealthSample();
  }

  /** Generic anomaly seam for OTHER subsystems (asset loaders, avalanche, camera, …) to
   *  report into the same pipeline — so diagnostics is not limited to the physics kernel.
   *  e.g. Diag.note('asset_load_failed', { url }). Routed to the sink + console + the dump,
   *  and a no-op when the recorder is inactive (automation). */
  note(category: string, detail: Record<string, unknown> = {}): void {
    if (!DIAG_ENABLED || !this.active) return;
    this.notes.push({ atSec: +this.clockSec.toFixed(2), category, detail });
    if (this.notes.length > 50) this.notes.shift();
    this.warn(`note:${category}`, `[diag] ${category} ${JSON.stringify(detail)}`);
    this.emit('diag_note', { category, ...detail });
  }

  /** Forward to the injected sink, swallowing any sink error (telemetry must never throw
   *  into the game loop). */
  private emit(event: string, data: Record<string, unknown>): void {
    try { this.sink(event, data); } catch { /* a broken sink must not break the game */ }
  }

  /** Install window.onerror + unhandledrejection once. Captures the message/stack plus the
   *  current physics snapshot summary as context, routes it to the sink + console.error.
   *  Re-throws nothing; never swallows the browser's own default logging. */
  private installErrorHandlers(): void {
    if (this.errorHandlersInstalled || typeof window === 'undefined') return;
    this.errorHandlersInstalled = true;
    const context = () => {
      const sm = this.summary;
      return {
        frames: sm.frames,
        fps: sm.durationSec > 0 ? Math.round(sm.frames / sm.durationSec) : 0,
        speedMax: +sm.speedMax.toFixed(1),
        health: frameRateHealth(sm, this.cfg).level,
      };
    };
    window.addEventListener('error', (e: ErrorEvent) => {
      this.emit('client_error', {
        message: String(e.message || 'error'),
        source: e.filename || '',
        line: e.lineno || 0,
        stack: (e.error && e.error.stack ? String(e.error.stack) : '').slice(0, 600),
        ...context(),
      });
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg = reason && reason.message ? reason.message : String(reason);
      this.emit('unhandled_rejection', {
        message: String(msg).slice(0, 300),
        stack: (reason && reason.stack ? String(reason.stack) : '').slice(0, 600),
        ...context(),
      });
    });
  }

  /** Throttled console warnings on the anomaly categories, so a live slow-device run
   *  leaves a breadcrumb in the console even if nobody opened the overlay. */
  private maybeWarn(flags: FrameFlags): void {
    if (flags.nonFinite) this.warn('nonFinite', '[diag] non-finite physics state (NaN/Infinity) this frame');
    if (flags.runaway) {
      this.warn('runaway', `[diag] speed ${this.summary.speedMax.toFixed(1)} m/s past the ${this.cfg.speedCeiling} m/s ceiling — runaway`);
    }
    if (flags.tunnelRisk) {
      this.warn('tunnel', `[diag] per-frame step ${flags.step.toFixed(2)}u >= collision radius ${this.cfg.collisionRadius}u at ${flags.fps.toFixed(0)} FPS — possible tunnel-through`);
    }
    const ratio = fpsSpeedRatio(this.summary);
    if (ratio >= FPS_RATIO_BAD) {
      this.warn('fpsSpeed', `[diag] cruise speed ${ratio.toFixed(1)}x higher at low FPS than high FPS — frame-rate-dependent force (see __snowgliderDiag.dump())`);
    }
  }

  private warn(key: string, msg: string): void {
    const now = this.clockSec;
    if (this.lastWarn[key] !== undefined && now - this.lastWarn[key] < WARN_THROTTLE_SEC) return;
    this.lastWarn[key] = now;
    if (typeof console !== 'undefined' && console.warn) console.warn(msg);
  }

  /** The trace in chronological order (oldest first). */
  private orderedRing(): Array<FrameSample & FrameFlags> {
    if (this.ring.length < RING_CAPACITY) return this.ring.slice();
    return this.ring.slice(this.head).concat(this.ring.slice(0, this.head));
  }

  /** A structured, JSON-serialisable snapshot: config, summary, verdict, recent trace. */
  snapshot() {
    const health = frameRateHealth(this.summary, this.cfg);
    const bands = this.summary.bands.map((b) => ({
      label: b.label, frames: b.frames,
      speedMax: +b.speedMax.toFixed(2), speedMean: +bandMeanSpeed(b).toFixed(2),
    }));
    return {
      config: this.cfg,
      summary: {
        frames: this.summary.frames,
        durationSec: +this.summary.durationSec.toFixed(2),
        fps: this.summary.durationSec > 0 ? +(this.summary.frames / this.summary.durationSec).toFixed(1) : 0,
        dtMaxMs: +(this.summary.dtMaxSec * 1000).toFixed(1),
        clampedFrames: this.summary.clampedFrames,
        stepMax: +this.summary.stepMax.toFixed(2),
        speedMax: +this.summary.speedMax.toFixed(2),
        tunnelRiskFrames: this.summary.tunnelRiskFrames,
        nonFiniteFrames: this.summary.nonFiniteFrames,
        runawayFrames: this.summary.runawayFrames,
        fpsSpeedRatio: +fpsSpeedRatio(this.summary).toFixed(2),
        bands,
      },
      health,
      notes: this.notes.slice(),
      recent: this.orderedRing().slice(-120).map((e) => ({
        dt: +e.dt.toFixed(4), fps: +e.fps.toFixed(0), speed: +e.speed.toFixed(2),
        step: +e.step.toFixed(2), x: +e.x.toFixed(1), z: +e.z.toFixed(1),
        technique: e.technique, air: e.isInAir,
        flags: [e.clamped && 'clamped', e.tunnelRisk && 'tunnel', e.nonFinite && 'NaN'].filter(Boolean),
      })),
    };
  }

  /** Return the snapshot and, in a browser, download it as JSON for a bug report. */
  dump() {
    const snap = this.snapshot();
    try {
      if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `snowglider-diag-${Math.round(this.clockSec)}s.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* download is best-effort; the returned object is the source of truth */ }
    return snap;
  }

  /** Flush the just-completed run's `session_health` baseline if one is still owed —
   *  the run reached MIN_SAMPLE_FRAMES and no heartbeat/run-end sample already fired for
   *  it (de-duped on the clock, which doesn't advance after the run stops). Idempotent, so
   *  the run-end (showGameOver), pagehide, and reset paths can all call it without
   *  double-emitting. A no-op for a trivial/empty run (e.g. the reset at init). */
  private flushHealthBaseline(): void {
    if (this.active && this.summary.frames >= MIN_SAMPLE_FRAMES &&
        this.clockSec - this.lastHealthEmitSec >= 1) {
      this.emitHealthSample();
    }
  }

  /** Mark the end of a run (finish / crash / avalanche burial) without clearing state, so a
   *  one-and-done session that ends and is then abandoned — the player never presses
   *  Reset/Restart, so reset() never runs — still contributes its `session_health` baseline.
   *  Called from showGameOver; de-duped against the eventual reset() emit. */
  endRun(): void {
    if (!DIAG_ENABLED || !this.active) return;
    this.flushHealthBaseline();
  }

  reset(): void {
    // Run-end baseline sample: capture the just-completed run before clearing, so even a
    // short healthy run (too brief for a heartbeat) contributes one session_health. Skipped
    // for a trivial/empty reset (e.g. the reset at init) and de-duped against a heartbeat or
    // an endRun()/pagehide flush that already fired for this run.
    this.flushHealthBaseline();
    this.ring = [];
    this.head = 0;
    this.summary = emptySummary();
    this.prev = null;
    this.lastWarn = {};
    this.clockSec = 0;
    this.reportedAnomaly = false; // a fresh run can report its own anomaly
    this.lastHealthEmitSec = 0;
    this.notes = [];
  }

  // --- DOM overlay (live HUD) ---
  private ensureOverlay(): void {
    if (typeof document === 'undefined' || this.overlay) return;
    const el = document.createElement('div');
    el.id = 'diagOverlay';
    el.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
      'font:11px/1.4 monospace', 'color:#cfe', 'background:rgba(0,0,0,0.62)',
      'padding:7px 9px', 'border-radius:6px', 'white-space:pre', 'pointer-events:none',
      'max-width:46ch',
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
    this.overlay = el;
    this.paint(true);
  }

  private hideOverlay(): void {
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
  }

  private toggleOverlay(): void {
    if (this.overlay) this.hideOverlay(); else this.ensureOverlay();
  }

  private maybePaint(): void {
    if (!this.overlay) return;
    if (this.clockSec - this.lastOverlayPaint < 1 / OVERLAY_HZ) return;
    this.paint(false);
  }

  private paint(force: boolean): void {
    if (!this.overlay) return;
    this.lastOverlayPaint = this.clockSec;
    const sm = this.summary;
    const health = frameRateHealth(sm, this.cfg);
    const fpsAvg = sm.durationSec > 0 ? sm.frames / sm.durationSec : 0;
    const recent = this.orderedRing();
    const last = recent[recent.length - 1];
    const icon = health.level === 'bad' ? '🔴' : health.level === 'warn' ? '🟡' : '🟢';
    const bandLines = sm.bands
      .filter((b) => b.frames > 0)
      .map((b) => `   ${b.label.padEnd(6)} f=${String(b.frames).padStart(5)} vmax=${b.speedMax.toFixed(1).padStart(5)} vavg=${bandMeanSpeed(b).toFixed(1).padStart(5)}`)
      .join('\n');
    const lines = [
      `${icon} SnowGlider physics diag  (\` toggles)`,
      `fps  now=${last ? last.fps.toFixed(0) : '–'}  avg=${fpsAvg.toFixed(0)}  dtMax=${(sm.dtMaxSec * 1000).toFixed(0)}ms  clamp=${sm.clampedFrames}`,
      `spd  now=${last ? last.speed.toFixed(1) : '–'}  max=${sm.speedMax.toFixed(1)}  stepMax=${sm.stepMax.toFixed(2)}/${this.cfg.collisionRadius}`,
      `risk tunnel=${sm.tunnelRiskFrames}  runaway=${sm.runawayFrames}  NaN=${sm.nonFiniteFrames}  fps→spd=${fpsSpeedRatio(sm).toFixed(2)}x`,
      `speed by fps band:`,
      bandLines || '   (single band)',
      health.level === 'ok' ? '' : health.reasons.map((r) => ` ! ${r}`).join('\n'),
    ];
    this.overlay.textContent = lines.filter((l) => l !== '').join('\n');
    void force;
  }
}

export const Diag = new Diagnostics();
