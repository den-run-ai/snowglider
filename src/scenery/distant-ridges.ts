// Distant alpine panorama — layered ridge silhouettes (issue #320, PR 2; detail pass PR 3b).
//
// 3–5 concentric "curtain" rings encircling the play area, each a jagged skyline at
// increasing radius, so the mountain has a real horizon of receding snowy peaks instead of
// terrain hard-cutting against flat sky.
//
// DETAIL PASS (PR 3b, owner feedback): the original flat single-colour silhouettes read as
// dark grey featureless humps — especially at the golden-hour/dusk phase of the sun cycle,
// where the fog they haze toward is darker. This pass gives them:
//   * SNOW CAPS via a per-vertex vertical gradient — pale snow near the tall peaks, cool
//     slate-blue rock down the faces — so they read as snowy alpine peaks in EVERY lighting
//     phase (unlit vertex colours, so the white caps hold up even when the fog darkens).
//   * SHARPER, CRAGGIER RELIEF — an added high-frequency ridged octave makes distinct peaks
//     and gullies instead of smooth rolling humps, and vertical subdivisions let the snow
//     line sit mid-face as a crisp cap band.
//   * A LIGHTER, BLUER TONE — the rock base is lighter and less grey, and far layers pale
//     further toward the horizon (aerial perspective).
//
// FOG-FRIENDLY BY CONSTRUCTION: the scene's linear distance fog runs FOG_NEAR=140 →
// FOG_FAR=750 toward the horizon colour (src/sky.ts), camera far plane 1000. The rings sit at
// radius ~520–740 — in the hazy band, so they fade into the sky like "distant terrain fading
// into the horizon" (sky.ts's own intent) while the snow caps keep them legible.
//
// INVARIANTS (issue #320): render-only (unlit MeshBasicMaterial with vertex colours, no
// shadows, no per-frame update), collision-neutral & physics-neutral (pure geometry in the
// scenery group, never touches treePositions/rockPositions/pos/velocity), and
// Math.random-stream-neutral — ALL placement randomness comes from the seeded `rng`, and
// every THREE construction is wrapped in `withPrivateThreeRandom`. Teardown is handled by the
// scenery group sweep (dispose() in scenery.ts).

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';

// Angular resolution (columns) and vertical subdivisions (rows) per ring. More columns give
// craggier skylines; a few rows let the snow line sit mid-face as a crisp cap band. Still
// trivially cheap next to the forest.
const SEGMENTS = 200;
const ROWS = 5;
// The curtain's base sits well below the horizon line so its bottom edge is hidden behind the
// fogged terrain and never reads as a floating band.
const BASE_Y = -80;

// Aerial-perspective rock endpoints (lighter, bluer than the old grey): near ridges a light
// slate-blue, far ridges pale toward the horizon colour. Snow is a bright cool white for the
// caps. Fog hazes all further, but these tints set the stack depth and keep it from reading grey.
const ROCK_NEAR: [number, number, number] = hexRgb(0x8fa8c2);
const ROCK_FAR: [number, number, number] = hexRgb(0xbcd4ea);
const SNOW: [number, number, number] = hexRgb(0xf2f7fd);

function hexRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** How many ridge layers to build for a given budget, clamped to the 3–5 the plan calls for. */
function ridgeLayerCount(budget: SceneryBudget): number {
  return Math.max(3, Math.min(5, Math.floor(budget.ridgeLayers)));
}

/**
 * A seamless, craggy skyline height profile for one ridge, as a closure over precomputed
 * octaves. INTEGER frequencies keep it periodic over a full 2π turn so the ring closes without
 * a seam. A final RIDGED octave (folded `1-|sin|`, squared) sharpens the peaks into crags. All
 * randomness is drawn from the seeded `rng` (never Math.random).
 */
function makeSkyline(rng: () => number, peakBase: number): (theta: number) => number {
  const octaves: Array<{ freq: number; amp: number; phase: number }> = [];
  for (let k = 0; k < 5; k++) {
    octaves.push({
      // Integer frequency => the profile wraps seamlessly around the circle.
      freq: 2 + Math.floor(rng() * (5 + k * 5)),
      amp: (peakBase * 0.55) * (1 / (k + 1)) * (0.6 + rng() * 0.8),
      phase: rng() * Math.PI * 2,
    });
  }
  // A high-frequency ridged octave for crags: folded and squared so it spikes upward.
  const ridgeFreq = 7 + Math.floor(rng() * 9);
  const ridgePhase = rng() * Math.PI * 2;
  const ridgeAmp = peakBase * 0.5;
  return function heightAt(theta: number): number {
    let h = peakBase;
    for (const o of octaves) h += o.amp * Math.sin(o.freq * theta + o.phase);
    const fold = 1 - Math.abs(Math.sin(ridgeFreq * theta + ridgePhase));
    h += ridgeAmp * fold * fold; // squared fold => sharp crags, not rounded bumps
    // Keep a positive minimum so the silhouette never dips below its base band.
    return Math.max(14, h);
  };
}

/** Build one ridge ring mesh with a snow-capped vertical vertex gradient. THREE construction
 *  is fully guarded; vertex/colour math is pure. */
function buildRidgeLayer(index: number, layers: number, rng: () => number): THREE.Mesh {
  const radius = 520 + index * 55;              // 520 → 740 across the stack
  const peakBase = 60 + index * 18;             // farther ridges stand taller (peek over)
  const heightAt = makeSkyline(rng, peakBase);
  const aerial = layers > 1 ? index / (layers - 1) : 0; // 0 near → 1 far
  const rock = lerp3(ROCK_NEAR, ROCK_FAR, aerial);

  // Precompute each column's top height so the snow line can key off the tallest peaks: only
  // the high columns get white caps, saddles/low shoulders stay rock (realistic alpine look).
  const cols = SEGMENTS + 1;
  const topH: number[] = new Array<number>(cols).fill(0);
  let maxColH = 1e-6;
  for (let j = 0; j < cols; j++) {
    const theta = (j / SEGMENTS) * Math.PI * 2;
    const h = heightAt(theta);
    topH[j] = h;
    if (h > maxColH) maxColH = h;
  }

  // Pure vertex build (no THREE, no Math.random): ROWS+1 rows per column from BASE_Y up to the
  // skyline, coloured rock→snow by row height and column peakiness.
  const rowsPerCol = ROWS + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < cols; j++) {
    const theta = (j / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    const colH = topH[j] as number;
    const peakiness = colH / maxColH; // 1 at the tallest peaks, lower in the saddles
    for (let r = 0; r <= ROWS; r++) {
      const rr = r / ROWS;                    // 0 at base → 1 at the skyline
      positions.push(x, BASE_Y + rr * colH, z);
      // Rock, slightly darker toward the base for form; snow blended in near the tops of the
      // TALL columns only (both the row must be high AND the column must be a real peak).
      const shade = 0.82 + 0.18 * rr;
      const base: [number, number, number] = [rock[0] * shade, rock[1] * shade, rock[2] * shade];
      const snowAmt = smoothstep(0.55, 0.9, rr) * smoothstep(0.5, 0.95, peakiness);
      const c = lerp3(base, SNOW, snowAmt);
      colors.push(c[0], c[1], c[2]);
    }
  }
  for (let j = 0; j < SEGMENTS; j++) {
    for (let r = 0; r < ROWS; r++) {
      const a = j * rowsPerCol + r;
      const b = (j + 1) * rowsPerCol + r;
      const c2 = (j + 1) * rowsPerCol + r + 1;
      const d = j * rowsPerCol + r + 1;
      indices.push(a, b, c2, a, c2, d);
    }
  }

  return withPrivateThreeRandom(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    // Unlit silhouette driven entirely by the vertex colours (snow caps + rock). DoubleSide
    // renders the inner wall the camera (inside the ring) faces regardless of winding; the far
    // wall is beyond the fog/far plane. Fog still hazes the fragment colour toward the horizon.
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `ridge-${index}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Layout hints for tests (harmless metadata): columns and rows-per-column.
    mesh.userData.cols = cols;
    mesh.userData.rowsPerCol = rowsPerCol;
    mesh.matrixAutoUpdate = false; // static — never moves, so skip per-frame matrix recompute
    mesh.updateMatrix();
    return mesh;
  });
}

/**
 * Build the distant-ridge panorama: a `THREE.Group` of snow-capped jagged silhouette rings,
 * seeded off `rng` so the same tier always composes the same horizon. Static (no per-frame
 * update) and fog-hazed into the sky. The caller (createScenery) parents it under the scenery group.
 */
export function buildDistantRidges(rng: () => number, budget: SceneryBudget): THREE.Group {
  const layers = ridgeLayerCount(budget);
  const group = withPrivateThreeRandom(() => {
    const g = new THREE.Group();
    g.name = 'distant-ridges';
    return g;
  });
  for (let i = 0; i < layers; i++) {
    group.add(buildRidgeLayer(i, layers, rng));
  }
  return group;
}
