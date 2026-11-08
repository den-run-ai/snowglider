// Tileable, fixed-seed powder fields. These are material detail only: no terrain
// sampling, global randomness, or GPU work. A broad noise spectrum avoids the
// coherent crossed ripples produced by a small sum of sine waves.

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradient(ix: number, iy: number, period: number, seed: number, x: number, y: number): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
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
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = gradient(ix, iy, period, seed, fx, fy);
  const b = gradient(ix + 1, iy, period, seed, fx - 1, fy);
  const c = gradient(ix, iy + 1, period, seed, fx, fy - 1);
  const d = gradient(ix + 1, iy + 1, period, seed, fx - 1, fy - 1);
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
