// mountains/snow-depth.ts — persistent snow-depth field (issue #246, visual-only v1).
//
// STAGE: PR 1 of the #246 stack — the PURE FIELD LOGIC, with NO renderer integration.
// This module owns a bounded 2D grid of snow "depth" in [0..1] (1 = undisturbed powder,
// 0 = fully packed / skied-out) and the math that ages it: the skis COMPACT depth in
// cells near a pass; fresh snowfall / refill lerps packed cells back toward full over
// time. Later PRs drive it from the real ski-track cadence (PR 2) and sample it into the
// terrain material via a DataTexture (PR 3) so packed ski lines read darker/icier and
// powder reads brighter/softer — giving the slope MEMORY that `src/snowtracks.ts` (its
// own header: "temporary track feedback, NOT accumulation") explicitly names as its
// larger follow-up.
//
// THE INVARIANTS (mirror the scenery / wind / ski-trail discipline; #246 guardrails):
//   * physics-neutral    — NEVER reads or writes pos/velocity/heightMap/terrain vertices/
//                          course state. v1 carries NO physics meaning: depth does not
//                          feed the height field, friction, grip, or scoring. The phrase
//                          the stack holds to is "persistent visual snow memory, zero
//                          physics meaning."
//   * dependency-free    — PR 1 imports NOTHING (no THREE, no DOM). The grid is plain
//                          typed-array math, so it is trivially headless / Node-testable
//                          and consumes ZERO Math.random (stream-neutral by construction;
//                          the DataTexture that would draw a UUID arrives in PR 3, guarded
//                          then).
//   * bounded / deterministic — every mutation clamps to [0..1]; identical input
//                          sequences produce identical grids; grid resolution is capped.

/** Minimal positional shape (accepts a THREE.Vector3 or a plain literal). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface SnowDepthOptions {
  /** World-space footprint the grid covers (defaults match the terrain plane). */
  minX?: number;
  minZ?: number;
  sizeX?: number;
  sizeZ?: number;
  /** Grid resolution (cells). Capped for perf; ~2 world units / cell by default. */
  cols?: number;
  rows?: number;
  /** Depth recovered per second as packed cells refill toward full powder (0..1/s). */
  refillRate?: number;
  /** Depth removed at the centre of a ski pass (0..1 per pass, tapering to the rim). */
  compactionPerPass?: number;
  /** World radius of the ski compaction footprint. */
  packRadius?: number;
}

// --- Defaults --------------------------------------------------------------
// The terrain is PlaneGeometry(300, 400) centred on the origin, so the play area spans
// x∈[-150,150], z∈[-200,200]. ~2 world units / cell keeps the grid small (30k cells)
// while still resolving a ski line as a packed band. (PR 4 revisits resolution / mobile
// scaling; PR 1 just fixes a sane, capped default.)
const DEF_MIN_X = -150;
const DEF_MIN_Z = -200;
const DEF_SIZE_X = 300;
const DEF_SIZE_Z = 400;
const DEF_COLS = 150;
const DEF_ROWS = 200;
const DEF_REFILL_RATE = 0.05;        // packed snow takes ~20 s of coverage to fully refill
const DEF_COMPACTION_PER_PASS = 0.5; // one centred pass removes up to half the depth
const DEF_PACK_RADIUS = 2.4;         // a touch wider than the ski gauge so a line reads solid

// Hard caps so a bad option can't blow the grid size / per-frame cost.
const MAX_COLS = 400;
const MAX_ROWS = 520;

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The persistent snow-depth grid. `depth` is the authoritative Float32 field in [0..1]
 * (row-major, `row * cols + col`); everything else is pure math over it. No renderer
 * state lives here in PR 1 — a later PR mirrors the grid into a GPU DataTexture.
 */
export class SnowDepthField {
  readonly minX: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly refillRate: number;
  readonly compactionPerPass: number;
  readonly packRadius: number;

  /** Authoritative depth grid, row-major, values in [0..1] (1 == full powder). */
  readonly depth: Float32Array;

  constructor(opts: SnowDepthOptions = {}) {
    this.minX = Number.isFinite(opts.minX) ? opts.minX! : DEF_MIN_X;
    this.minZ = Number.isFinite(opts.minZ) ? opts.minZ! : DEF_MIN_Z;
    this.sizeX = Number.isFinite(opts.sizeX) && opts.sizeX! > 0 ? opts.sizeX! : DEF_SIZE_X;
    this.sizeZ = Number.isFinite(opts.sizeZ) && opts.sizeZ! > 0 ? opts.sizeZ! : DEF_SIZE_Z;
    this.cols = clampInt(opts.cols ?? DEF_COLS, 2, MAX_COLS);
    this.rows = clampInt(opts.rows ?? DEF_ROWS, 2, MAX_ROWS);
    this.refillRate = Math.max(0, opts.refillRate ?? DEF_REFILL_RATE);
    this.compactionPerPass = clamp01(opts.compactionPerPass ?? DEF_COMPACTION_PER_PASS);
    this.packRadius = Math.max(0, opts.packRadius ?? DEF_PACK_RADIUS);

    this.depth = new Float32Array(this.cols * this.rows).fill(1);
  }

  /** Column index for a world x, clamped to the grid. */
  private colAt(x: number): number {
    return clampInt(((x - this.minX) / this.sizeX) * (this.cols - 1), 0, this.cols - 1);
  }

  /** Row index for a world z, clamped to the grid. */
  private rowAt(z: number): number {
    return clampInt(((z - this.minZ) / this.sizeZ) * (this.rows - 1), 0, this.rows - 1);
  }

  // Convert a world radius to a cell radius on each axis (cells are anisotropic when the
  // footprint is non-square). At least 0 so a tiny radius still touches its own cell.
  private colRadius(worldRadius: number): number {
    return Math.max(0, Math.floor((worldRadius / this.sizeX) * (this.cols - 1)));
  }
  private rowRadius(worldRadius: number): number {
    return Math.max(0, Math.floor((worldRadius / this.sizeZ) * (this.rows - 1)));
  }

  /** Nearest-cell depth in [0..1] at a world position (1 == undisturbed powder). */
  sample(x: number, z: number): number {
    return this.depth[this.rowAt(z) * this.cols + this.colAt(x)]!;
  }

  /** Alias for {@link sample} — reads clearer at some call sites. */
  depthAt(x: number, z: number): number {
    return this.sample(x, z);
  }

  /**
   * Compact the snow under a ski pass centred on world (x, z): cells within `radius`
   * lose depth, most at the centre and tapering to 0 at the rim. Pure and deterministic;
   * clamps to [0..1]. `radius` / `strength` default to the field's configured pass.
   */
  compactAt(x: number, z: number, radius: number = this.packRadius, strength: number = this.compactionPerPass): void {
    const s = clamp01(strength);
    if (s <= 0 || radius <= 0) return;
    const cc = this.colAt(x);
    const cr = this.rowAt(z);
    const rc = this.colRadius(radius);
    const rr = this.rowRadius(radius);
    const c0 = Math.max(0, cc - rc), c1 = Math.min(this.cols - 1, cc + rc);
    const r0 = Math.max(0, cr - rr), r1 = Math.min(this.rows - 1, cr + rr);
    // Normalise the falloff in cell space (guard the single-cell footprint / 0 radius).
    const nrc = rc > 0 ? rc : 1;
    const nrr = rr > 0 ? rr : 1;
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const dc = (c - cc) / nrc;
        const dr = (r - cr) / nrr;
        const d2 = dc * dc + dr * dr;
        if (d2 > 1) continue;
        const falloff = 1 - Math.sqrt(d2);        // 1 at centre → 0 at the rim
        this.depth[base + c] = clamp01(this.depth[base + c]! - s * falloff);
      }
    }
  }

  /**
   * Refill packed cells back toward full powder over `dt` seconds (fresh snow settling +
   * slow recovery). Pure and deterministic given `dt`; clamps at 1 so it never overshoots.
   * PR 1 refills the whole grid; PR 4 restricts the walk to a near-player window for perf.
   */
  refill(dt: number): void {
    const step = this.refillRate * (Number.isFinite(dt) ? Math.max(0, dt) : 0);
    if (step <= 0) return;
    const d = this.depth;
    for (let i = 0; i < d.length; i++) {
      if (d[i]! < 1) d[i] = clamp01(d[i]! + step);
    }
  }

  /** Reset every cell to full powder (a fresh, un-packed slope for each new run). */
  reset(): void {
    this.depth.fill(1);
  }

  /**
   * Release any GPU resource the field owns. A no-op in PR 1 (the field is pure data);
   * reserved so callers can wire teardown now — PR 3 gives it a DataTexture to dispose.
   * Idempotent by construction.
   */
  dispose(): void {
    /* no GPU resource owned yet — see PR 3 */
  }
}
