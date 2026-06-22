// mountains/noise.ts - Deterministic noise primitives for terrain & placement.
//
// Pure math, no THREE / DOM dependency: the random-seeded SimplexNoise used for the
// terrain-mesh roughness, plus the *deterministic* fixed-seed fBm that drives the
// aperiodic ridge field and the forest-density field. Extracted from the mountains
// hub (Stage R-mountains, issue #34); the math is byte-identical, so the terrain
// samplers, the terrain/regression suites, and the physics-invariant harness all
// keep reading the same values.

// --- SimplexNoise implementation ---
export class SimplexNoise {
  grad3: number[][];
  p: number[];
  perm: number[];
  gradP: number[][];

  constructor() {
    this.grad3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
                 [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
                 [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
    this.p = [];
    for (let i = 0; i < 256; i++) {
      this.p[i] = Math.floor(Math.random() * 256);
    }

    // To remove the need for index wrapping, double the permutation table length
    this.perm = new Array(512);
    this.gradP = new Array(512);

    // Populate permutation table
    for(let i = 0; i < 512; i++) {
      this.perm[i] = this.p[i & 255];
      this.gradP[i] = this.grad3[this.perm[i] % 12];
    }
  }

  noise(xin: number, yin: number): number {
    // Simple 2D noise implementation - produces values between -1 and 1
    let n0, n1, n2; // Noise contributions from the three corners

    // Skew the input space to determine which simplex cell we're in
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const s = (xin + yin) * F2; // Hairy factor for 2D
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);

    const G2 = (3 - Math.sqrt(3)) / 6;
    const t = (i + j) * G2;
    const X0 = i - t; // Unskew the cell origin back to (x,y) space
    const Y0 = j - t;
    const x0 = xin - X0; // The x,y distances from the cell origin
    const y0 = yin - Y0;

    // For the 2D case, the simplex shape is an equilateral triangle.
    // Determine which simplex we are in.
    let i1, j1; // Offsets for second (middle) corner of simplex in (i,j) coords
    if (x0 > y0) {
      i1 = 1; j1 = 0; // lower triangle, XY order: (0,0)->(1,0)->(1,1)
    } else {
      i1 = 0; j1 = 1; // upper triangle, YX order: (0,0)->(0,1)->(1,1)
    }

    // A step of (1,0) in (i,j) means a step of (1-c,-c) in (x,y), and
    // a step of (0,1) in (i,j) means a step of (-c,1-c) in (x,y), where
    // c = (3-sqrt(3))/6
    const x1 = x0 - i1 + G2; // Offsets for middle corner in (x,y) unskewed coords
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2; // Offsets for last corner in (x,y) unskewed coords
    const y2 = y0 - 1 + 2 * G2;

    // Work out the hashed gradient indices of the three simplex corners
    const ii = i & 255;
    const jj = j & 255;

    // Calculate the contribution from the three corners
    let t0 = 0.5 - x0*x0-y0*y0;
    if (t0 < 0) {
      n0 = 0;
    } else {
      t0 *= t0;
      const gi0 = this.perm[ii+this.perm[jj]] % 12;
      n0 = t0 * t0 * this.dot(this.gradP[gi0], x0, y0);
    }

    let t1 = 0.5 - x1*x1-y1*y1;
    if (t1 < 0) {
      n1 = 0;
    } else {
      t1 *= t1;
      const gi1 = this.perm[ii+i1+this.perm[jj+j1]] % 12;
      n1 = t1 * t1 * this.dot(this.gradP[gi1], x1, y1);
    }

    let t2 = 0.5 - x2*x2-y2*y2;
    if (t2 < 0) {
      n2 = 0;
    } else {
      t2 *= t2;
      const gi2 = this.perm[ii+1+this.perm[jj+1]] % 12;
      n2 = t2 * t2 * this.dot(this.gradP[gi2], x2, y2);
    }

    // Add contributions from each corner to get the final noise value.
    // The result is scaled to return values in the interval [-1,1].
    return 70 * (n0 + n1 + n2);
  }

  dot(g: number[], x: number, y: number): number {
    return g[0]*x + g[1]*y;
  }
}

// --- Deterministic aperiodic ridge field (issue #188 step 3) ---
//
// The terrain ridge used to be the *periodic* `Math.sin(x * 0.2) * Math.cos(z * 0.3)`.
// A low directional sun raked that regular plaid into repeated grey "corduroy" bands
// (the `Grey corduroy` failure mode in docs/SNOW_RENDERING.md) and pinned the sun
// cycle's low-sun guard at 14° (`SUN_ELEV_MIN_DEG`, src/sky.ts). This replaces it with
// a *deterministic* domain-warped fBm so the ridges meander instead of forming a
// regular lattice — no periodicity, so nothing for a raking light to band, and a more
// natural backcountry surface. It is deliberately deterministic (a fixed-seed integer
// hash, NOT the `Math.random`-seeded SimplexNoise above) so the terrain is stable
// across page loads and the Node terrain/regression tests can pin its shape.

// Integer-lattice hash -> [0, 1). All 32-bit (Math.imul) so it is bit-exact and
// deterministic for the same (ix, iz), including negative coordinates.
function hashLattice(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth (smoothstep-interpolated) value noise in [-1, 1].
function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const u = fx * fx * (3 - 2 * fx);
  const w = fz * fz * (3 - 2 * fz);
  const n00 = hashLattice(x0, z0), n10 = hashLattice(x0 + 1, z0);
  const n01 = hashLattice(x0, z0 + 1), n11 = hashLattice(x0 + 1, z0 + 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * w) * 2 - 1;
}

// Fractional Brownian motion: 3 octaves, lacunarity 2, gain 0.5, normalized to ~[-1, 1].
function fbm(x: number, z: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise(x * freq, z * freq);
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

// The aperiodic ridge field in ~[-1, 1] that replaces `sin(x*0.2)*cos(z*0.3)`.
// A low-frequency fBm warps the domain so the ridges curve and meander (natural
// backcountry), and the warped fBm supplies the medium/fine relief.
const RIDGE_FREQ = 0.06;   // base ridge scale (octaves add detail down to ~4u)
const RIDGE_WARP_FREQ = 0.03;
const RIDGE_WARP_AMP = 8;
export function terrainRidgeField(x: number, z: number): number {
  const wx = fbm(x * RIDGE_WARP_FREQ, z * RIDGE_WARP_FREQ);
  const wz = fbm(x * RIDGE_WARP_FREQ + 5.2, z * RIDGE_WARP_FREQ - 3.7);
  return fbm((x + wx * RIDGE_WARP_AMP) * RIDGE_FREQ, (z + wz * RIDGE_WARP_AMP) * RIDGE_FREQ);
}

// --- Deterministic forest-density field (terrain ↔ trees alignment) ---
//
// A pure [0, 1] function of world (x, z) describing how heavily forested a patch is:
// broad conifer *stands* fading into open *clearings*. It reuses the same fixed-seed
// fbm as the ridge field (NOT Math.random), so two independent consumers can read it
// and agree spatially:
//   - the terrain snow shading tints gentle, forested ground with a faint warm
//     treeline cast (applySnowVertexColors), and
//   - Trees.addTrees biases placement into the same stands and leaves the clearings
//     open (src/trees.ts).
// The net effect is that the trees and the ground beneath them read as one biome
// instead of a uniform sprinkle. The low frequency makes the stands tens of units
// across; the offset keeps the bands from locking onto the ridge lattice.
const FOREST_FREQ = 0.018;
export function forestDensityField(x: number, z: number): number {
  const n = fbm(x * FOREST_FREQ + 17.3, z * FOREST_FREQ - 9.1);
  return Math.min(1, Math.max(0, n * 0.9 + 0.5));
}
