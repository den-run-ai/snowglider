// Fixed {kind, size, seed} rock samples shared by the rendered rock gallery
// (rock-gallery.ts) and the headless visual-metrics harness
// (tests/rock-visual-metrics-tests.js), so the numbers CI gates on describe the
// exact rocks the review screenshots show. Pure data + one seed helper — no THREE,
// no DOM — importable headlessly by Node tests.

export type RockGalleryKind = 'boulder' | 'cliff' | 'pinch';

export interface RockGallerySample {
  /** Stable identifier — the metrics baseline fixture is keyed by this. */
  id: string;
  kind: RockGalleryKind;
  /** createRock size argument (world units). */
  size: number;
  /** Deterministic scrape-shape seed (createRock opts.seed). */
  seed: number;
}

/**
 * The same placement-coords → scrape-seed derivation addRocks uses (mountains/rocks.ts
 * `shapeSeed`), duplicated here so the pinch samples below are the EXACT seeds a Black
 * run derives for its gate crags. Keep in sync with addRocks.
 */
export function shapeSeedFor(x: number, z: number): number {
  return (Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(z * 100), 19349663)) >>> 0;
}

// Pinch-gate crags on Black are createRock(2.2, { cliff: true, seed: shapeSeed(rx, pz) })
// placed at the corridor edge (±8u off the lane) at the PINCH_Z stations — these four
// samples use that exact derivation at representative gate coordinates, so the gallery
// and metrics judge the collidable hazard shapes the player actually threads.
const PINCH_COORDS: ReadonlyArray<readonly [number, number]> = [
  [8, -42], [-8, -78], [8, -126], [-8, -168],
];

export const ROCK_GALLERY_SAMPLES: RockGallerySample[] = [
  // Row 1: scatter boulders across the placed size range (0.5–3.0; collidable ≥ 1.25).
  { id: 'boulder-1.0', kind: 'boulder', size: 1.0, seed: 1101 },
  { id: 'boulder-1.5', kind: 'boulder', size: 1.5, seed: 1102 },
  { id: 'boulder-2.2', kind: 'boulder', size: 2.2, seed: 1103 },
  { id: 'boulder-3.0', kind: 'boulder', size: 3.0, seed: 1104 },
  // Row 2: cliff outcrop blocks (placed range 3–5u, plus the 2.2 pinch size).
  { id: 'cliff-2.2', kind: 'cliff', size: 2.2, seed: 2201 },
  { id: 'cliff-3.0', kind: 'cliff', size: 3.0, seed: 2202 },
  { id: 'cliff-4.0', kind: 'cliff', size: 4.0, seed: 2203 },
  { id: 'cliff-5.0', kind: 'cliff', size: 5.0, seed: 2204 },
  // Row 3: Black-tier pinch-gate crags (size fixed at 2.2 by addRocks).
  ...PINCH_COORDS.map(([x, z], i): RockGallerySample => ({
    id: `pinch-2.2-${i + 1}`,
    kind: 'pinch',
    size: 2.2,
    seed: shapeSeedFor(x, z),
  })),
];
