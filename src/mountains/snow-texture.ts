// Tileable, fixed-seed powder fields. These are material detail only: no terrain
// sampling, global randomness, or GPU work. A broad noise spectrum avoids the
// coherent crossed ripples produced by a small sum of sine waves.

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradient(ix: number, iy: number, period: number, seed: number, x: number, y: number, periodY = period): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % periodY) + periodY) % periodY;
  let h = Math.imul(px, 0x27d4eb2d) ^ Math.imul(py, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  // Eight unit gradients; equal length keeps the diagonal samples from creating
  // brighter/darker patches than the axial samples.
  const diagonal = Math.SQRT1_2;
  switch (h & 7) {
    case 0: return x;
    case 1: return -x;
    case 2: return y;
    case 3: return -y;
    case 4: return (x + y) * diagonal;
    case 5: return (x - y) * diagonal;
    case 6: return (-x + y) * diagonal;
    default: return (-x - y) * diagonal;
  }
}

function periodicNoise(u: number, v: number, period: number, seed: number): number {
  return rectangularNoise(u, v, period, period, seed);
}

function rectangularNoise(u: number, v: number, periodX: number, periodY: number, seed: number): number {
  const x = u * periodX, y = v * periodY;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = gradient(ix, iy, periodX, seed, fx, fy, periodY);
  const b = gradient(ix + 1, iy, periodX, seed, fx - 1, fy, periodY);
  const c = gradient(ix, iy + 1, periodX, seed, fx, fy - 1, periodY);
  const d = gradient(ix + 1, iy + 1, periodX, seed, fx - 1, fy - 1, periodY);
  const sx = fade(fx), sy = fade(fy);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Low-contrast powder variation; period and first derivative match at tile edges. */
export function snowMottle(u: number, v: number): number {
  const warpX = periodicNoise(u, v, 3, 0x431) * 0.07;
  const warpY = periodicNoise(u, v, 4, 0x947) * 0.07;
  const x = u + warpX, y = v + warpY;
  return 0.62 * periodicNoise(x, y, 5, 0x138) +
    0.26 * periodicNoise(x, y, 11, 0x287) +
    0.12 * periodicNoise(x, y, 23, 0x593);
}

/** Irregular granular micro-relief, with no painted sparkle or directional waves. */
export function snowGrain(u: number, v: number): number {
  const x = u + periodicNoise(u, v, 4, 0x421) * 0.035;
  const y = v + periodicNoise(u, v, 5, 0x783) * 0.035;
  return 0.45 * periodicNoise(x, y, 17, 0x241) +
    0.35 * periodicNoise(x, y, 37, 0x369) +
    0.20 * periodicNoise(x, y, 79, 0x813);
}

/** World-space size of one terrain material tile, in metres on both axes. */
export const SNOW_RELIEF_TILE_SIZE = 32;

function moundHash(x: number, y: number, seed: number): number {
  let h = Math.imul((x + 8) % 8, 0x27d4eb2d) ^ Math.imul((y + 8) % 8, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 0x100000000;
}

// Jittered centres and individually rotated ellipses produce finite, soft outlines
// rather than a sheet of parallel ribs. Immutable CPU data; no runtime RNG/assets.
const POWDER_MOUNDS = Array.from({ length: 64 }, (_, i) => {
  const x = i % 8, y = Math.floor(i / 8);
  const angle = moundHash(x, y, 0x91a) * Math.PI;
  return {
    x: 0.1 + moundHash(x, y, 0x317) * 0.8,
    y: 0.1 + moundHash(x, y, 0x6e3) * 0.8,
    cos: Math.cos(angle), sin: Math.sin(angle),
    long: 1.3 + moundHash(x, y, 0xa41) * 1.3,
    short: 0.65 + moundHash(x, y, 0x278) * 0.75,
    height: 0.09 + moundHash(x, y, 0x563) * 0.09,
  };
});

function powderMounds(u: number, v: number): number {
  const x = u * 8, y = v * 8;
  const cx = Math.floor(x), cy = Math.floor(y);
  let height = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ix = cx + i, iy = cy + j;
      const mound = POWDER_MOUNDS[(((iy % 8) + 8) % 8) * 8 + ((ix % 8) + 8) % 8]!;
      const dx = (x - ix - mound.x) * 4, dy = (y - iy - mound.y) * 4;
      const along = (dx * mound.cos + dy * mound.sin) / mound.long;
      const across = (-dx * mound.sin + dy * mound.cos) / mound.short;
      const radius = along * along + across * across;
      if (radius < 1) height += mound.height * (1 - radius) ** 3;
    }
  }
  return height;
}

/**
 * A shallow snow skin, in metres: rounded drifts, broken wind ribs and powder grain.
 * This is a MATERIAL height only; the skiable terrain and collision mesh never read it.
 * Integer shear preserves both periodic boundaries while the long rib axis runs
 * ~18 degrees across the slope, close to the shared 20-degree prevailing wind.
 * (Terrain UV +v points toward world -z.) Noise changes the spacing, strength and
 * curvature of each rib; there is no coherent sine wave or crossed ripple lattice.
 */
export function snowRelief(u: number, v: number): { height: number; crust: number } {
  const x = u + periodicNoise(u, v, 3, 0x685) * 0.045;
  const y = v + periodicNoise(u, v, 4, 0x928) * 0.035;
  const cross = x + 3 * y;
  const n = rectangularNoise(x, cross, 7, 4, 0x472);
  const detail = rectangularNoise(x + 0.17, cross + 0.31, 13, 9, 0x835);
  const ridge = Math.exp(-n * n * 22);
  const smallRidge = Math.exp(-detail * detail * 30);
  const patch = snowMottle(u + 0.31, v - 0.18);
  const driftMask = Math.min(1, Math.max(0, (periodicNoise(u, v, 5, 0x149) + 0.12) * 3));
  const drift = fade(driftMask);
  return {
    height: periodicNoise(x, y, 5, 0x952) * 0.28 +
      powderMounds(u, v) +
      (ridge - 0.55) * 0.11 * drift +
      (smallRidge - 0.5) * 0.02 * drift +
      periodicNoise(x, y, 29, 0x712) * 0.045 + snowGrain(u, v) * 0.006,
    // Wind compresses exposed shoulders; sheltered troughs remain rough powder.
    crust: Math.max(0, (ridge - 0.55) / 0.45) *
      Math.min(1, Math.max(0.35, 0.65 + patch)) * (0.55 + 0.45 * drift),
  };
}
