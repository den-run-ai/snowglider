import { analyticsBuildId } from './analytics-env.js';

/** Local, opt-in evidence limits. No timers, persistence, transport or scene writes. */
export const CAPTURE_LIMITS = {
  durationMs: 600_000,
  windowMs: 10_000,
  checkpointMs: 1_000,
  windows: 60,
  framesPerWindow: 4_096,
  checkpoints: 720,
} as const;

type Quality = 'high' | 'balanced' | 'low' | 'unknown';
type StopReason = 'manual' | 'duration_limit' | 'frame_limit';
type CheckpointReason = 'start' | 'sample' | 'reset' | 'stop';

interface CaptureContext {
  build: string;
  device: 'iphone' | 'ipad' | 'android' | 'desktop' | 'unknown';
  browser: 'safari' | 'chrome' | 'firefox' | 'edge' | 'unknown';
  browserMajor: number | null;
}

interface PerformanceProbe {
  viewport: { width: number | null; height: number | null; dpr: number | null; visibility: string };
  renderer: {
    available: boolean;
    calls: number | null;
    triangles: number | null;
    geometries: number | null;
    textures: number | null;
    programs: number | null;
    pixelRatio: number | null;
    width: number | null;
    height: number | null;
    quality: Quality;
    qualityMode: Quality | 'auto';
  };
}

interface FrameWindow {
  startMs: number;
  endMs: number;
  frames: number;
  sampledMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over16_7Ms: number;
  over33_3Ms: number;
  over50Ms: number;
  over100Ms: number;
  over250Ms: number;
}

interface Checkpoint {
  atMs: number;
  resetCount: number;
  reason: CheckpointReason;
  probe: PerformanceProbe | null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function quality(value: unknown): Quality {
  return value === 'high' || value === 'balanced' || value === 'low' ? value : 'unknown';
}

/** Coarse device/browser labels only: never retain the user-agent, URL or account. */
export function readCaptureContext(): CaptureContext {
  let build = 'unknown';
  try { build = analyticsBuildId(); } catch { /* An absent build label is explicit. */ }
  const result: CaptureContext = { build, device: 'unknown', browser: 'unknown', browserMajor: null };
  try {
    if (typeof navigator === 'undefined') return result;
    const ua = navigator.userAgent.slice(0, 512);
    result.device = /iPhone/i.test(ua) ? 'iphone'
      : /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ipad'
      : /Android/i.test(ua) ? 'android' : /Windows|Macintosh|Linux/i.test(ua) ? 'desktop' : 'unknown';
    const match = /(Edg|EdgiOS|EdgA|Firefox|FxiOS|Chrome|CriOS|Version)\/(\d{1,3})(?:\.|\s|$)/g;
    const versions = [...ua.matchAll(match)];
    const browser = versions.find(m => /^Edg/.test(m[1]!)) ??
      versions.find(m => /Firefox|FxiOS/.test(m[1]!)) ??
      versions.find(m => /Chrome|CriOS/.test(m[1]!)) ??
      (/Safari/.test(ua) ? versions.find(m => m[1] === 'Version') : undefined);
    if (browser) {
      result.browser = /^Edg/.test(browser[1]!) ? 'edge' : /Firefox|FxiOS/.test(browser[1]!) ? 'firefox'
        : /Chrome|CriOS/.test(browser[1]!) ? 'chrome' : 'safari';
      result.browserMajor = Number(browser[2]);
    }
  } catch { /* Keep coarse unknown fields; never export the underlying exception. */ }
  return result;
}

/** Read the existing renderer seam without a GPU query, extra render or scene traversal. */
export function readPerformanceProbe(): PerformanceProbe {
  type Renderer = {
    info?: { render?: { calls?: number; triangles?: number }; memory?: { geometries?: number; textures?: number }; programs?: unknown[] | null };
    domElement?: { width?: number; height?: number; dataset?: { renderQuality?: string; renderQualityMode?: string } };
    getPixelRatio?: () => number;
  };
  const r = typeof window === 'undefined' ? undefined
    : (window as unknown as { renderer?: Renderer }).renderer;
  const mode = r?.domElement?.dataset?.renderQualityMode;
  return {
    viewport: {
      width: typeof window === 'undefined' ? null : finite(window.innerWidth),
      height: typeof window === 'undefined' ? null : finite(window.innerHeight),
      dpr: typeof window === 'undefined' ? null : finite(window.devicePixelRatio),
      visibility: typeof document === 'undefined' ? 'unknown'
        : document.visibilityState === 'visible' ? 'visible' : 'hidden',
    },
    renderer: {
      available: !!r,
      calls: finite(r?.info?.render?.calls),
      triangles: finite(r?.info?.render?.triangles),
      geometries: finite(r?.info?.memory?.geometries),
      textures: finite(r?.info?.memory?.textures),
      programs: r?.info?.programs ? finite(r.info.programs.length) : null,
      pixelRatio: finite(r?.getPixelRatio?.()),
      width: finite(r?.domElement?.width), height: finite(r?.domElement?.height),
      quality: quality(r?.domElement?.dataset?.renderQuality),
      qualityMode: mode === 'auto' ? 'auto' : quality(mode),
    },
  };
}

const rounded = (n: number): number => Math.round(n * 100) / 100;

/** Bounded capture across run resets, fed only by Diag's existing gameplay samples. */
export class PerformanceCapture {
  private readonly context: CaptureContext;
  private readonly now: () => number;
  private readonly probe: () => PerformanceProbe;
  private readonly startedAt: number;
  private elapsedMs = 0;
  private stopped: StopReason | null = null;
  private bucket = 0;
  private frames: number[] = [];
  private windows: FrameWindow[] = [];
  private checkpoints: Checkpoint[] = [];
  private nextCheckpoint = 0;
  private resetCount = 0;
  private errors = { invalidFrames: 0, clockFailures: 0, probeFailures: 0, missingRenderer: 0, missingQuality: 0, exportFailures: 0 };
  private truncated = { frames: false, checkpoints: false, duration: false };

  constructor(
    context: CaptureContext = readCaptureContext(),
    now: () => number = () => performance.now(),
    probe: () => PerformanceProbe = readPerformanceProbe,
  ) {
    this.context = context;
    this.now = now;
    this.probe = probe;
    this.startedAt = now();
    if (!Number.isFinite(this.startedAt) || this.startedAt < 0) throw new Error('Capture clock unavailable');
    this.checkpoint('start');
  }

  get running(): boolean { return this.stopped === null; }

  private advance(): boolean {
    if (!this.running) return false;
    try {
      const elapsed = this.now() - this.startedAt;
      if (!Number.isFinite(elapsed) || elapsed < this.elapsedMs) throw new Error('clock');
      this.elapsedMs = Math.min(elapsed, CAPTURE_LIMITS.durationMs);
    } catch { this.errors.clockFailures++; }
    if (this.elapsedMs >= CAPTURE_LIMITS.durationMs) {
      this.truncated.duration = true;
      this.finish('duration_limit');
      return false;
    }
    return true;
  }

  record(dt: number): void {
    if (!this.advance()) return;
    const bucket = Math.floor(this.elapsedMs / CAPTURE_LIMITS.windowMs);
    if (bucket !== this.bucket) {
      this.closeWindow((this.bucket + 1) * CAPTURE_LIMITS.windowMs);
      this.bucket = bucket;
    }
    if (!Number.isFinite(dt) || dt <= 0 || dt * 1000 > CAPTURE_LIMITS.durationMs) this.errors.invalidFrames++;
    else if (this.frames.length >= CAPTURE_LIMITS.framesPerWindow) {
      this.truncated.frames = true;
      this.finish('frame_limit');
      return;
    } else this.frames.push(dt * 1000);
    if (this.elapsedMs >= this.nextCheckpoint) this.checkpoint('sample');
  }

  reset(): void {
    if (!this.advance()) return;
    this.resetCount++;
    this.checkpoint('reset');
  }

  stop(): void { if (this.advance()) this.finish('manual'); }

  noteExportFailure(): void { this.errors.exportFailures++; }

  private finish(reason: StopReason): void {
    this.closeWindow(this.elapsedMs);
    this.stopped = reason;
    // The next observation may arrive long after a hidden/menu gap. A cap
    // marker must not label those later renderer resources as a ten-minute sample.
    this.checkpoint('stop', reason !== 'duration_limit');
  }

  private checkpoint(reason: CheckpointReason, observe = true): void {
    this.nextCheckpoint = this.elapsedMs + CAPTURE_LIMITS.checkpointMs;
    if (this.checkpoints.length >= CAPTURE_LIMITS.checkpoints) {
      this.truncated.checkpoints = true;
      return;
    }
    let probe: PerformanceProbe | null = null;
    if (observe) {
      try {
        probe = this.probe();
        if (!probe.renderer.available) this.errors.missingRenderer++;
        if (probe.renderer.quality === 'unknown') this.errors.missingQuality++;
      } catch { this.errors.probeFailures++; }
    }
    this.checkpoints.push({ atMs: rounded(this.elapsedMs), resetCount: this.resetCount, reason, probe });
  }

  private closeWindow(endMs: number): void {
    if (!this.frames.length) return;
    const sorted = this.frames.sort((a, b) => a - b);
    const p = (fraction: number): number => {
      const at = (sorted.length - 1) * fraction;
      const low = Math.floor(at), high = Math.ceil(at);
      return rounded(sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low));
    };
    const sum = sorted.reduce((total, dt) => total + dt, 0);
    this.windows.push({
      startMs: this.bucket * CAPTURE_LIMITS.windowMs,
      endMs: rounded(Math.min(endMs, (this.bucket + 1) * CAPTURE_LIMITS.windowMs)),
      frames: sorted.length, sampledMs: rounded(sum), meanMs: rounded(sum / sorted.length),
      p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99), maxMs: rounded(sorted[sorted.length - 1]!),
      over16_7Ms: sorted.filter(dt => dt > 16.7).length,
      over33_3Ms: sorted.filter(dt => dt > 33.3).length,
      over50Ms: sorted.filter(dt => dt > 50).length,
      over100Ms: sorted.filter(dt => dt > 100).length,
      over250Ms: sorted.filter(dt => dt > 250).length,
    });
    this.frames = [];
  }

  /** Local export only. No raw frame trajectory, error text, URLs or persistent identity. */
  snapshot() {
    return {
      schemaVersion: 1,
      scope: 'active-gameplay-frame-intervals',
      exclusions: ['startup', 'terminal-frame', 'menus', 'hidden-time', 'gpu-bytes', 'thermal-sensors'],
      context: { ...this.context }, limits: { ...CAPTURE_LIMITS },
      status: this.running ? 'recording' : 'stopped', stopReason: this.stopped,
      elapsedMs: rounded(this.elapsedMs), resetCount: this.resetCount,
      pendingWindowFrames: this.frames.length,
      errors: { ...this.errors }, truncated: { ...this.truncated },
      windows: this.windows.map(window => ({ ...window })),
      checkpoints: this.checkpoints.map(point => ({ ...point, probe: point.probe && {
        viewport: { ...point.probe.viewport }, renderer: { ...point.probe.renderer },
      } })),
    };
  }
}
