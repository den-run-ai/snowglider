// mountains/snow-depth.ts — persistent snow-depth field (issue #246, visual-only v1).
//
// STAGE: PRs 3–4 of the #246 stack — the field owns a GPU DataTexture and modulates the
// terrain material (PR 3), and bounds its per-frame cost to a near-player window with a
// dirty-row texture upload + resolution scaling (PR 4). This module owns a bounded 2D grid
// of snow "depth" in [0..1]
// (1 = undisturbed powder, 0 = fully packed / skied-out) and the math that ages it: the
// skis COMPACT depth in cells near a pass (PR 2 drives this off the ski-track cadence);
// fresh snowfall / refill raises packed cells back toward full at a constant per-second
// rate (a linear recovery, not a proportional lerp — v1 keeps it simple). PR 3 mirrors the
// grid into a single-channel DataTexture that the terrain material samples
// (`applySnowDepthModulation` via `onBeforeCompile`) so packed ski lines read darker/icier
// and powder reads brighter/softer — giving the slope MEMORY that `src/snowtracks.ts` (its
// own header: "temporary track feedback, NOT accumulation") explicitly names as its
// larger follow-up.
//
// THE INVARIANTS (mirror the scenery / wind / ski-trail discipline; #246 guardrails):
//   * physics-neutral    — NEVER reads or writes pos/velocity/heightMap/terrain vertices/
//                          course state, and the shader modulation moves NO vertex (albedo
//                          + roughness only). v1 carries NO physics meaning: depth does not
//                          feed the height field, friction, grip, or scoring. The phrase
//                          the stack holds to is "persistent visual snow memory, zero
//                          physics meaning."
//   * Math.random-neutral— the only Three.js construction (the DataTexture) is wrapped in a
//                          private, deterministic random guard so its UUID draw cannot
//                          perturb the seeded placement stream (mirrors trees.ts
//                          `depthUuidRandom` / scenery `withPrivateThreeRandom`). The grid
//                          math itself draws no randomness.
//   * headless-safe      — the DataTexture is a plain data holder (no GPU/canvas/DOM), so
//                          the Node suites still construct and drive the field directly.
//   * bounded / deterministic — every mutation clamps to [0..1]; identical input
//                          sequences produce identical grids; grid resolution is capped.
import * as THREE from 'three';

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
  /** Depth removed at the centre of one explicit `compactAt` pass (0..1, tapers to rim). */
  compactionPerPass?: number;
  /** World distance between stamps the frame driver `update()` lays along the travelled
   *  path (distance-based ⇒ frame-rate independent and gap-free). */
  stampSpacing?: number;
  /** Depth removed at the centre of each `update()` stamp (0..1); passes overlap so a
   *  single ski pass builds a solid line and repeats deepen it. */
  stampStrength?: number;
  /** World radius of the ski compaction footprint. */
  packRadius?: number;
  /** World radius of the near-player refill window `update()` walks each frame (PR 4 perf:
   *  only cells this close to the player age back toward powder; far tracks persist). */
  updateRadius?: number;
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
const DEF_STAMP_SPACING = 1.1;       // world units between driver stamps (matches SnowTrails)
const DEF_STAMP_STRENGTH = 0.2;      // per-stamp centre pack; overlapping stamps build the line
const DEF_PACK_RADIUS = 2.4;         // a touch wider than the ski gauge so a line reads solid
const DEF_UPDATE_RADIUS = 30;        // near-player refill window (PR 4 perf: bounds per-frame work)

// Cap the stamps laid in one frame so a teleport / huge dt can't spin the interpolation
// loop (a jump/restart already breaks the line via the anchor reset, so this is a backstop).
const MAX_STAMPS_PER_FRAME = 512;

// Hard caps so a bad option can't blow the grid size / per-frame cost.
const MAX_COLS = 400;
const MAX_ROWS = 520;

// Don't stamp a compaction pass when essentially stopped (matches SnowTrails.MIN_SPEED).
const MIN_COMPACT_SPEED = 1.2;

// Private xorshift32 stream used ONLY to feed the DataTexture's UUID draw so it can't
// perturb the caller's seeded global Math.random stream (Math.random-neutral invariant).
// A distinct seed constant from trees.ts `depthUuidRandom` and scenery's `threeUuidRandom`
// keeps the guards from ever sharing a stream.
let snowDepthUuidState = 0x1b8f2d43;
function withPrivateThreeRandom<T>(fn: () => T): T {
  const saved = Math.random;
  Math.random = function snowDepthUuidRandom(): number {
    snowDepthUuidState ^= snowDepthUuidState << 13;
    snowDepthUuidState ^= snowDepthUuidState >>> 17;
    snowDepthUuidState ^= snowDepthUuidState << 5;
    return (snowDepthUuidState >>> 0) / 0x100000000;
  };
  try {
    return fn();
  } finally {
    Math.random = saved;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// NaN-SAFE clamp to [0..1]. `NaN > 0` is false, so a NaN (from a bad caller/config value)
// falls through to 0 instead of poisoning the grid — this is what keeps the promised
// [0..1] depth invariant airtight for JS callers that TypeScript can't police.
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

// A finite tuning value, or the fallback when a caller passes NaN/Infinity/undefined.
function finiteOr(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) ? (v as number) : fallback;
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
  readonly stampSpacing: number;
  readonly stampStrength: number;
  readonly packRadius: number;
  readonly updateRadius: number;

  /** Authoritative depth grid, row-major, values in [0..1] (1 == full powder). */
  readonly depth: Float32Array;
  /** Uint8 mirror uploaded to the GPU (0..255 == 0..1), synced from `depth` on flush. */
  private readonly bytes: Uint8Array;
  /** Single-channel DataTexture the terrain material samples (see applySnowDepthModulation). */
  readonly texture: THREE.DataTexture;

  // Dirty-ROW range accumulated since the last flush (PR 4 upload discipline): only these
  // rows are re-synced to the byte mirror, instead of copying the whole 30k-cell grid every
  // moving frame. `dirtyMaxRow < 0` means clean → flush() is a zero-cost no-op.
  private dirtyMinRow = Infinity;
  private dirtyMaxRow = -1;
  /** Count of texture re-uploads (for the perf-scaling debug seam / tests). */
  private uploads = 0;

  // Frame-driver stamping state: the last point a stamp was laid at, plus the arc-length
  // carried over toward the next stamp, so `update()` spaces stamps by travelled DISTANCE
  // (continuous, frame-rate independent) instead of stamping once per frame. `lastX` null
  // means "no active line" — set on spawn/reset and whenever the skis leave the snow
  // (airborne / stopped), so a jump or restart never draws a stamp across the gap.
  private lastX: number | null = null;
  private lastZ = 0;
  private stampCarry = 0;

  constructor(opts: SnowDepthOptions = {}) {
    this.minX = Number.isFinite(opts.minX) ? opts.minX! : DEF_MIN_X;
    this.minZ = Number.isFinite(opts.minZ) ? opts.minZ! : DEF_MIN_Z;
    this.sizeX = Number.isFinite(opts.sizeX) && opts.sizeX! > 0 ? opts.sizeX! : DEF_SIZE_X;
    this.sizeZ = Number.isFinite(opts.sizeZ) && opts.sizeZ! > 0 ? opts.sizeZ! : DEF_SIZE_Z;
    this.cols = clampInt(opts.cols ?? DEF_COLS, 2, MAX_COLS);
    this.rows = clampInt(opts.rows ?? DEF_ROWS, 2, MAX_ROWS);
    this.refillRate = Math.max(0, finiteOr(opts.refillRate, DEF_REFILL_RATE));
    this.compactionPerPass = clamp01(finiteOr(opts.compactionPerPass, DEF_COMPACTION_PER_PASS));
    // Spacing must be > 0 or the stamp loop can't advance; fall back to the default.
    const spacing = finiteOr(opts.stampSpacing, DEF_STAMP_SPACING);
    this.stampSpacing = spacing > 0 ? spacing : DEF_STAMP_SPACING;
    this.stampStrength = clamp01(finiteOr(opts.stampStrength, DEF_STAMP_STRENGTH));
    this.packRadius = Math.max(0, finiteOr(opts.packRadius, DEF_PACK_RADIUS));
    this.updateRadius = Math.max(0, finiteOr(opts.updateRadius, DEF_UPDATE_RADIUS));

    const cells = this.cols * this.rows;
    this.depth = new Float32Array(cells).fill(1);
    this.bytes = new Uint8Array(cells).fill(255);

    // The DataTexture draws a UUID via Math.random on construction — guard it so a scene
    // built on the seeded stream stays byte-identical (Math.random-neutral).
    this.texture = withPrivateThreeRandom(() => {
      const tex = new THREE.DataTexture(this.bytes, this.cols, this.rows, THREE.RedFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      // This is DATA (depth 0..1), not colour — no sRGB decode on sample (review nit).
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      return tex;
    });
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

  /** Widen the dirty-row range to include row `r` (flush re-uploads only these rows). */
  private markRow(r: number): void {
    if (r < this.dirtyMinRow) this.dirtyMinRow = r;
    if (r > this.dirtyMaxRow) this.dirtyMaxRow = r;
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
    // `!(x > 0)` style guards reject NaN (and <= 0) in one check; a non-finite centre
    // (x/z) would map to a clamped cell but never mutate one usefully, so bail early.
    if (!(s > 0) || !(radius > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return;
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
        const next = clamp01(this.depth[base + c]! - s * falloff);
        if (next !== this.depth[base + c]) { this.depth[base + c] = next; this.markRow(r); }
      }
    }
  }

  /** The per-second linear refill amount for `dt` (clamped `dt >= 0`), or 0 if disabled. */
  private refillStep(dt: number): number {
    return this.refillRate * (Number.isFinite(dt) ? Math.max(0, dt) : 0);
  }

  /** Raise a rectangular block of rows/cols toward full powder by `step` (marks dirty rows). */
  private refillBlock(step: number, r0: number, r1: number, c0: number, c1: number): void {
    if (step <= 0) return;
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      let rowTouched = false;
      for (let c = c0; c <= c1; c++) {
        const cur = this.depth[base + c]!;
        if (cur < 1) { this.depth[base + c] = clamp01(cur + step); rowTouched = true; }
      }
      if (rowTouched) this.markRow(r);
    }
  }

  /**
   * Refill EVERY packed cell back toward full powder over `dt` seconds — a LINEAR recovery at
   * a constant `refillRate` per second (`depth += refillRate * dt`), NOT a proportional lerp.
   * Pure and deterministic given `dt`; clamps at 1 so it never overshoots. This walks the whole
   * grid; the frame driver uses the cheaper near-player {@link refillNear} instead (PR 4).
   */
  refill(dt: number): void {
    this.refillBlock(this.refillStep(dt), 0, this.rows - 1, 0, this.cols - 1);
  }

  /**
   * Refill only the cells within `updateRadius` of world (x, z) — the near-player window the
   * frame driver walks each frame (PR 4). Bounds per-frame cost to the window regardless of
   * grid size; the trade-off is that tracks farther than `updateRadius` behind the player stop
   * aging and simply persist (which reads as lasting ski memory). Same linear recovery + clamp.
   */
  refillNear(dt: number, x: number, z: number): void {
    const step = this.refillStep(dt);
    if (step <= 0 || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const cc = this.colAt(x), cr = this.rowAt(z);
    const rc = this.colRadius(this.updateRadius), rr = this.rowRadius(this.updateRadius);
    this.refillBlock(step,
      Math.max(0, cr - rr), Math.min(this.rows - 1, cr + rr),
      Math.max(0, cc - rc), Math.min(this.cols - 1, cc + rc));
  }

  /**
   * One cosmetic frame driven from the main loop's render-frame zone (PR 2): refill the
   * field, then — only while grounded and actually moving — lay compaction stamps ALONG the
   * segment the skis travelled since the last frame. The grounded/moving gate mirrors the
   * ski-track stamping cadence in `snowtracks.ts`, so the two share the same "a ski is on
   * the snow" trigger.
   *
   * FRAME-RATE INDEPENDENT + GAP-FREE (Codex #350): stamps are spaced by travelled DISTANCE
   * (`stampSpacing`), interpolated along the previous→current segment — exactly like
   * `SnowTrails.update`. So the packed line is continuous at any speed, is identical whether
   * a 10 m move happens in one 60 Hz frame or ten 144 Hz frames, and doesn't dot/gap on a
   * low-FPS hitch or over-pack a stale point on a no-substep >60 Hz frame. When the skis
   * leave the snow (airborne / stopped / off-grid) the anchor is dropped, so a jump or
   * restart never draws a stamp across the gap.
   *
   * Pure: reads the position + horizontal speed, never writes them, so the physics-invariant
   * path is byte-identical. Reduced-motion is intentionally NOT gated here — a packed line is
   * a static mark, not an animation.
   */
  update(dt: number, player: Vec3Like, isInAir: boolean, speed: number): void {
    const hasPos = player && Number.isFinite(player.x) && Number.isFinite(player.z);
    // PR 4: refill only the near-player window (bounded per-frame cost), not the whole grid.
    if (hasPos) this.refillNear(dt, player.x, player.z);
    const laying = hasPos && !isInAir && Number.isFinite(speed) && speed > MIN_COMPACT_SPEED;
    if (laying) this.stampAlongPath(player.x, player.z);
    else this.lastX = null; // break the line: the next grounded stamp starts a fresh anchor
    this.flush();
  }

  /**
   * Sync the changed depth cells into the GPU byte mirror and flag the texture for re-upload —
   * a no-op on a clean frame (airborne, stopped, fully-refilled), so the common case costs
   * nothing. PR 4 upload discipline: only the dirty ROW range is re-copied into the byte
   * mirror, so a moving frame's CPU work tracks the near-player window, not the whole
   * 30k-cell grid. The GPU upload is a full re-upload (see the note in the body on why
   * `addUpdateRange` is unsafe for this RedFormat texture).
   */
  flush(): void {
    if (this.dirtyMaxRow < 0) return; // clean → zero cost
    const r0 = this.dirtyMinRow, r1 = this.dirtyMaxRow;
    const d = this.depth, b = this.bytes;
    const start = r0 * this.cols, end = (r1 + 1) * this.cols;
    // Re-sync ONLY the dirty rows into the byte mirror — that is the real per-frame win
    // (O(window), not O(30k)). The GPU upload itself is a full re-upload via needsUpdate:
    // three's DataTexture `addUpdateRange` uploader assumes an RGBA (4-byte) component
    // stride, so a partial range on this single-channel RedFormat texture would upload
    // misaligned texels (Codex #352). A full 30 KB re-upload from the always-consistent
    // `bytes` mirror is trivial and correct, so we deliberately DON'T use addUpdateRange.
    for (let i = start; i < end; i++) b[i] = Math.round(d[i]! * 255);
    this.texture.needsUpdate = true;
    this.dirtyMinRow = Infinity;
    this.dirtyMaxRow = -1;
    this.uploads++;
  }

  /** Lightweight read-only telemetry for the perf-scaling / diagnostics seam (PR 4). */
  stats(): { cols: number; rows: number; cells: number; packedCells: number; uploads: number } {
    let packed = 0;
    const d = this.depth;
    for (let i = 0; i < d.length; i++) if (d[i]! < 1) packed++;
    return { cols: this.cols, rows: this.rows, cells: d.length, packedCells: packed, uploads: this.uploads };
  }

  /**
   * Lay compaction stamps from the last stamp point to (x, z), one every `stampSpacing`
   * world units of arc length, carrying the leftover distance to the next frame. The first
   * stamp of a line drops at the anchor. Deterministic; no randomness.
   */
  private stampAlongPath(x: number, z: number): void {
    if (this.lastX === null) {
      this.compactAt(x, z, this.packRadius, this.stampStrength);
      this.lastX = x; this.lastZ = z; this.stampCarry = 0;
      return;
    }
    const dx = x - this.lastX, dz = z - this.lastZ;
    const seg = Math.hypot(dx, dz);
    if (!(seg > 1e-6)) return; // no travel this frame; keep the anchor + carry
    const ux = dx / seg, uz = dz / seg;
    let d = this.stampSpacing - this.stampCarry; // arc distance from lastX to the next stamp
    let placed = 0, last = 0;
    while (d <= seg && placed < MAX_STAMPS_PER_FRAME) {
      this.compactAt(this.lastX + ux * d, this.lastZ + uz * d, this.packRadius, this.stampStrength);
      last = d;
      d += this.stampSpacing;
      placed++;
    }
    // Carry the distance since the last stamp (or accumulate the whole segment if none fit).
    this.stampCarry = placed > 0 ? seg - last : this.stampCarry + seg;
    this.lastX = x; this.lastZ = z;
  }

  /** Reset to full powder AND drop the stamp anchor, so a new run starts on a pristine slope
   *  with no line drawn from the old finish position to the new spawn. */
  reset(): void {
    this.depth.fill(1);
    this.bytes.fill(255);
    this.dirtyMinRow = Infinity;
    this.dirtyMaxRow = -1;
    this.texture.needsUpdate = true;
    this.lastX = null;
    this.stampCarry = 0;
  }

  /** Release the DataTexture. Idempotent (three's dispose tolerates a second call). */
  dispose(): void {
    this.texture.dispose();
  }
}

// --- Terrain-material shader modulation (PR 3) -----------------------------
// How strongly a fully-packed cell (depth 0) shifts the snow surface. Authored for the
// project's legacy linear pipeline (ColorManagement disabled), in the spirit of the
// snow-palette constants: packed snow reads a touch darker with a faint cool (icy) tint,
// and less rough than powder so it catches a sharper specular glint.
const PACKED_TINT = 'vec3(0.86, 0.90, 0.98)'; // multiply diffuse toward icy grey-blue
const PACKED_ROUGHNESS = '0.58';               // vs the ~0.92 matte powder surface

/**
 * Wire a {@link SnowDepthField} into a terrain MeshStandardMaterial via `onBeforeCompile`
 * so the fragment shader samples per-cell depth and modulates albedo + roughness. The
 * terrain mesh sits at the origin with its rotation baked into the geometry, so the vertex
 * `position.xz` IS the world XZ used to index the field — no model matrix needed.
 *
 * Render-only: the injection reads a texture and scales `diffuseColor` / `roughnessFactor`;
 * it never moves a vertex, so the terrain height contract (mesh vertex == getTerrainHeight)
 * is untouched. A stable `customProgramCacheKey` keeps the modulated program from colliding
 * with an unmodulated MeshStandardMaterial (mirrors trees.ts `applyTreeSway`). While the
 * field is full powder (depth 1) the modulation is the identity, so an un-skied slope
 * renders byte-identically to before.
 */
export function applySnowDepthModulation(material: THREE.Material, field: SnowDepthField): void {
  const vertexHead = `#include <common>
varying vec2 vSnowDepthUv;
uniform vec2 uSnowFieldMin;
uniform vec2 uSnowFieldSize;`;
  const vertexCompute = `#include <begin_vertex>
  vSnowDepthUv = (position.xz - uSnowFieldMin) / uSnowFieldSize;`;
  const fragmentHead = `#include <common>
varying vec2 vSnowDepthUv;
uniform sampler2D uSnowDepthTex;`;
  // Sample once right after the base colour is established, then reuse for roughness.
  const fragmentColor = `#include <map_fragment>
  float snowDepthSample = texture2D(uSnowDepthTex, vSnowDepthUv).r;
  float snowPacked = clamp(1.0 - snowDepthSample, 0.0, 1.0);
  diffuseColor.rgb *= mix(vec3(1.0), ${PACKED_TINT}, snowPacked);`;
  const fragmentRoughness = `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, ${PACKED_ROUGHNESS}, snowPacked);`;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnowDepthTex = { value: field.texture };
    shader.uniforms.uSnowFieldMin = { value: new THREE.Vector2(field.minX, field.minZ) };
    shader.uniforms.uSnowFieldSize = { value: new THREE.Vector2(field.sizeX, field.sizeZ) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', vertexHead)
      .replace('#include <begin_vertex>', vertexCompute);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragmentHead)
      .replace('#include <map_fragment>', fragmentColor)
      .replace('#include <roughnessmap_fragment>', fragmentRoughness);
  };
  // onBeforeCompile edits are not part of three's default program cache key; a stable key
  // keeps the modulated terrain program distinct from any unmodulated MeshStandardMaterial.
  material.customProgramCacheKey = () => 'terrain-snow-depth-v1';
}
