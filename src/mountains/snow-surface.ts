// mountains/snow-surface.ts - Procedural snow surface look for the terrain mesh.
//
// THREE/canvas helpers (browser-only): the tileable snow albedo + normal-map
// CanvasTextures and the per-vertex snow shading / smoothed-shading-normal passes
// that createTerrain bakes into the terrain geometry. Render-only — none of this
// touches the height field, so physics is unaffected. Extracted from the mountains
// hub (Stage R-mountains, issue #34); the forest treeline tint reads the shared
// deterministic forestDensityField so the ground ties to the tree stands.
import * as THREE from 'three';
import { forestDensityField } from './noise.js';
import { SLOPE_MODERATE, SLOPE_STEEP } from '../slope-tiers.js';

// Cavity / ambient-occlusion shading (issue #17 follow-up). The shipped slope tint
// keys off slope *magnitude* (normal tilt), so it darkens steep faces but leaves
// concave hollows — the rolls and gullies between moguls — as flat white, which is
// exactly where real snow self-shadows and pools cool light. These constants bake a
// subtle darken + blue-shift into vertices that sit BELOW their neighbours (concave),
// added on top of the slope tint. Build-time and deterministic, so zero per-frame cost.
const CAVITY_SCALE = 1.2;        // metres of concavity (neighbour-mean minus vertex) that reaches full occlusion
const CAVITY_MAX_AMT = 0.30;     // max lerp toward the occluded colour (kept subtle — powder must stay bright)
const CAVITY_COLOR = { r: 0.80, g: 0.84, b: 0.93 }; // cool, slightly-dark occluded-pocket tint (palette #93A9CC, softened)


// --- Procedural snow surface textures (issue #17) ---
// Authored for the project's legacy colour pipeline (`ColorManagement.enabled =
// false`, linear output, no tone mapping — see game/scene-setup.ts): the canvases
// are sampled as-authored with no sRGB decode, so the near-white albedo and the
// tangent-space normal map are written directly in the values the shader uses.
// Both are generated procedurally (no committed binary assets — matching the
// existing snowflake/splash canvases) and tile seamlessly so they can repeat
// across the 300x400 terrain plane without visible seams.

/**
 * A bright near-white snow albedo for deep powder. Very low-amplitude *isotropic*
 * mottling (a sum of periodic waves pointing in many directions, so no single
 * orientation dominates and it never reads as a stripe) breaks up the dead-flat
 * white without leaving "snow" range, plus a faint cold-blue cast in the dips and
 * a sparse high-frequency sparkle. Repeated at a low frequency so the broad
 * blotches read as wind-drifted powder, not a tiled pattern.
 */
export function createSnowAlbedoTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      // Tileable low-frequency mottle from mixed directions (no dominant axis),
      // normalised to ~[-1, 1].
      let n = Math.sin(2 * Math.PI * (1 * u + 2 * v));
      n += 0.7 * Math.sin(2 * Math.PI * (2 * u - 3 * v) + 1.3);
      n += 0.5 * Math.sin(2 * Math.PI * (-3 * u + 1 * v) + 2.1);
      n += 0.4 * Math.sin(2 * Math.PI * (3 * u + 3 * v) + 0.7);
      n /= 2.6;
      // Sparse crystalline sparkle (product of high-freq periodics stays tileable).
      const sparkle = Math.max(0, Math.sin(2 * Math.PI * 24 * u) * Math.sin(2 * Math.PI * 22 * v));
      const base = 250 + n * 5 + sparkle * sparkle * 4; // very bright band (~245..255)
      const cool = Math.max(0, -n) * 5;  // slightly bluer in the dips
      const idx = (y * SIZE + x) * 4;
      data[idx] = Math.min(255, base - cool);            // R
      data[idx + 1] = Math.min(255, base - cool * 0.35); // G
      data[idx + 2] = Math.min(255, base);               // B (kept full -> cool dips)
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  return tex;
}

/**
 * A tileable tangent-space normal map giving the snow its micro-relief: soft,
 * *isotropic* powder granulation so the large flat plane catches the directional
 * light as a gently broken surface instead of reading as a sheet. The previous
 * version summed ripples that were all biased toward one diagonal, which tiled
 * into visible "grey grid" stripes under the directional light (issue #17 follow-up);
 * this version spreads the wave directions (mixed signs, no dominant axis) and
 * leans on fine grain, so the relief reads as snow grain rather than corrugation.
 * The height field is a sum of integer-frequency waves (periodic => seamless);
 * normals are central differences with wraparound.
 */
export function createSnowNormalTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const height = new Float32Array(SIZE * SIZE);
  // Many *high-frequency* waves pointing in many directions. Keeping every term
  // high-frequency means the relief is sub-metre "snow tooth" that mip-maps away
  // with distance (sparkle up close, smooth far) instead of the metre-scale
  // ripples that tiled into visible diagonal bands. Mixed directions/signs keep it
  // isotropic so no orientation reads as a stripe. Integer frequencies => seamless.
  const waves: [number, number, number, number][] = [
    [13, 17, 0.22, 0.4],
    [19, -11, 0.20, 1.9],
    [-7, 23, 0.18, 2.7],
    [21, 9, 0.16, 0.9],
    [11, -19, 0.15, 1.3],
    [25, 5, 0.13, 2.1],
    [-15, 13, 0.12, 0.6],
    [9, 27, 0.11, 1.5],
  ];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      let h = 0;
      for (let k = 0; k < waves.length; k++) {
        const [fx, fz, a, p] = waves[k]!;
        h += a * Math.sin(2 * Math.PI * (fx * u + fz * v) + p);
      }
      height[y * SIZE + x] = h;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  const STRENGTH = 1.5; // height -> slope gain
  const wrap = (i: number) => (i + SIZE) % SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const hl = height[y * SIZE + wrap(x - 1)]!;
      const hr = height[y * SIZE + wrap(x + 1)]!;
      const hd = height[wrap(y - 1) * SIZE + x]!;
      const hu = height[wrap(y + 1) * SIZE + x]!;
      let nx = -(hr - hl) * STRENGTH;
      let ny = -(hu - hd) * STRENGTH;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const idx = (y * SIZE + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 20); // fine: sub-metre grain that mip-maps to smooth at distance
  // Normal maps are data, not colour: keep them out of any sRGB decode. (The
  // project disables ColorManagement, so this is belt-and-suspenders.)
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Bake per-vertex snow shading into the terrain geometry: flat areas stay bright
 * snow, steeper faces take only a faint, cool *shadow* tint (read from the mesh
 * normal's tilt). The previous crust was a strong grey-blue (0.66, 0.72, 0.82)
 * applied at up to 0.6, which — combined with the bumpy terrain — read as grey
 * patches all over the snow; this keeps pitches bright and snowy with just a soft
 * blue cast for depth, the way real powder shadows do. Applied via `vertexColors`,
 * so it adds slope-dependent depth without touching the height field — physics is
 * unaffected. Mutates `geometry` in place; call after `computeVertexNormals()`.
 *
 * When `cols`/`rows` (the PlaneGeometry grid vertex counts) are supplied, a curvature
 * /ambient-occlusion term is added on top of the slope tint: vertices that sit below
 * their grid neighbours (concave hollows) take a subtle darken + cool blue-shift, a
 * little stronger on steeper ground (gated by the shared {@link SLOPE_STEEP} boundary).
 * This is the cue the slope-magnitude tint misses — hollows read as shaded depressions
 * instead of flat white. Reads vertex *heights* but never modifies them, so the physics
 * height field / authoritative geometry are untouched.
 */
export function applySnowVertexColors(
  geometry: THREE.BufferGeometry, cols?: number, rows?: number
): void {
  const normals = geometry.attributes.normal!.array as Float32Array;
  const positions = geometry.attributes.position!.array as Float32Array;
  const count = geometry.attributes.position!.count;
  const colors = new Float32Array(count * 3);
  // The cavity/AO term needs the grid topology to find each vertex's neighbours; only
  // engage it when a matching grid is passed (the live terrain), else fall back to the
  // pure slope tint (keeps the function usable from tests / other callers unchanged).
  const cavity = !!cols && !!rows && cols * rows === count;
  const snow = { r: 1.0, g: 1.0, b: 1.0 };
  const shade = { r: 0.93, g: 0.95, b: 0.99 }; // barely-cool powder shadow (almost white)
  // Where conifer stands grow — gentle slopes inside the forest-density bands — the
  // snow picks up a faint warm/green treeline cast from the canopy and needle litter
  // showing through. It is deliberately low-amplitude (a tint, never dirt) and gated
  // to gentle, forested ground, so the open snowfields in the clearings stay bright
  // white. Driven by the SHARED forest field, so the ground visually ties to the
  // trees that Trees.addTrees clusters into the very same stands.
  const forestTint = { r: 0.83, g: 0.87, b: 0.75 };
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1]!;
    // normal.y ~1 on flats, lower on pitches; remap the useful band to 0..1.
    const tilt = Math.min(1, Math.max(0, (1 - ny) / 0.4));
    const t = tilt * 0.5; // gentle, near-white slope shading (lighting does the rest)
    let r = snow.r + (shade.r - snow.r) * t;
    let g = snow.g + (shade.g - snow.g) * t;
    let b = snow.b + (shade.b - snow.b) * t;
    // Forest treeline tint: strongest on gentle, densely-forested ground; fades out
    // on steep pitches and in the open clearings.
    const gentle = Math.max(0, 1 - tilt * 1.4);
    const stand = Math.max(0, (forestDensityField(positions[i * 3]!, positions[i * 3 + 2]!) - 0.45) / 0.55);
    const amt = gentle * stand * 0.26;
    r += (forestTint.r - r) * amt;
    g += (forestTint.g - g) * amt;
    b += (forestTint.b - b) * amt;
    // Cavity / AO: darken + cool-shift vertices that dip below their neighbours.
    if (cavity) {
      const c = i % cols;
      const row = (i / cols) | 0;
      const yC = positions[i * 3 + 1]!;
      // 4-neighbour heights, edge-clamped (matches applySmoothShadingNormals' clamping).
      const yl = positions[(row * cols + Math.max(0, c - 1)) * 3 + 1]!;
      const yr = positions[(row * cols + Math.min(cols - 1, c + 1)) * 3 + 1]!;
      const yu = positions[(Math.max(0, row - 1) * cols + c) * 3 + 1]!;
      const yd = positions[(Math.min(rows - 1, row + 1) * cols + c) * 3 + 1]!;
      // Concavity > 0 when the vertex sits below the local mean (a hollow); convex peaks
      // go negative and are left bright. Normalise to an occlusion amount in [0, 1].
      const concavity = (yl + yr + yu + yd) / 4 - yC;
      let occ = Math.min(1, Math.max(0, concavity / CAVITY_SCALE));
      // Self-shadowing reads stronger on steeper ground: scale the term from ~0.7 on
      // gentle slopes up to ~1.3 past the black-diamond pitch (shared SLOPE_* edges).
      const slopeMag = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 1e-3);
      const steep = Math.min(1, Math.max(0, (slopeMag - SLOPE_MODERATE) / (SLOPE_STEEP - SLOPE_MODERATE)));
      occ *= 0.7 + 0.6 * steep;
      const occAmt = Math.min(1, occ) * CAVITY_MAX_AMT;
      r += (CAVITY_COLOR.r - r) * occAmt;
      g += (CAVITY_COLOR.g - g) * occAmt;
      b += (CAVITY_COLOR.b - b) * occAmt;
    }
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Give the snow surface *smoothed shading normals* without moving any vertex
 * (issue #17 follow-up, per maintainer review on PR #181). The grey "grid lines"
 * that survived the texture fix are the bumpy terrain's own facet normals being
 * raked by the directional light — every little mogul/ridge gets a lit and a
 * shaded face. We can't move the positions (physics rides the exact mesh via
 * `heightMap`, and the two-formula terrain contract + invariant harness depend on
 * it), but the *shading* normals are render-only. So we low-pass a throwaway clone
 * of the height field and copy its normals onto the real geometry: the silhouette
 * stays the skiable terrain, but the light sees a soft surface and the snow reads
 * as deep powder instead of corduroy. Physics is untouched (it never reads mesh
 * normals — slope forces use the analytic `getTerrainGradient`).
 *
 * `cols`/`rows` are the vertex counts (segments + 1) of the PlaneGeometry grid.
 */
export function applySmoothShadingNormals(
  geometry: THREE.BufferGeometry, cols: number, rows: number, passes: number
): void {
  const clone = geometry.clone();
  const pos = clone.attributes.position!.array as Float32Array;
  // Pull the height (world y) of each grid vertex into a 2D buffer.
  const h = new Float32Array(cols * rows);
  for (let k = 0; k < cols * rows; k++) h[k] = pos[k * 3 + 1]!;
  // Separable 3-tap box blur, edge-clamped, repeated for a gentle low-pass.
  const tmp = new Float32Array(cols * rows);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const l = h[base + Math.max(0, c - 1)]!;
        const m = h[base + c]!;
        const rr = h[base + Math.min(cols - 1, c + 1)]!;
        tmp[base + c] = (l + m + rr) / 3;
      }
    }
    // vertical
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const u = tmp[Math.max(0, r - 1) * cols + c]!;
        const m = tmp[r * cols + c]!;
        const d = tmp[Math.min(rows - 1, r + 1) * cols + c]!;
        h[r * cols + c] = (u + m + d) / 3;
      }
    }
  }
  // Write the smoothed heights back into the clone and let three compute robust,
  // correctly-oriented normals from it; copy those onto the real geometry.
  for (let k = 0; k < cols * rows; k++) pos[k * 3 + 1] = h[k]!;
  clone.computeVertexNormals();
  const smooth = clone.attributes.normal!.array as Float32Array;
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(smooth), 3));
  clone.dispose();
}
