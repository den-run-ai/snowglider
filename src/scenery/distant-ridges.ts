// Distant alpine panorama — layered ridge silhouettes (issue #320, PR 2).
//
// The first VISUAL scenery layer: 3–5 concentric "curtain" rings encircling the play
// area, each a jagged skyline silhouette at increasing radius. They give the mountain a
// real horizon of receding peaks instead of terrain hard-cutting against flat sky.
//
// FOG-FRIENDLY BY CONSTRUCTION (the whole reason this is the safe first visual): the
// scene's linear distance fog runs FOG_NEAR=140 → FOG_FAR=750 toward the horizon colour
// (src/sky.ts), and the camera far plane is 1000. Placing the rings at radius ~520–740
// puts them squarely in the hazy band — near enough to read, far enough that fog fades
// them into the sky exactly like "distant terrain fading into the horizon" (sky.ts's own
// design intent). Farther layers are both taller (so they peek over nearer ones) and
// tinted paler (aerial perspective), so the stack recedes convincingly.
//
// INVARIANTS (issue #320): render-only (unlit MeshBasicMaterial, no shadows, no per-frame
// update), collision-neutral & physics-neutral (pure geometry in the scenery group, never
// touches treePositions/rockPositions/pos/velocity), and Math.random-stream-neutral — ALL
// placement randomness comes from the seeded `rng`, and every THREE construction is wrapped
// in `withPrivateThreeRandom` so object-UUID draws can't perturb a caller's seeded stream.
// Teardown is handled by the scenery group sweep (dispose() in scenery.ts).

import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery-rng.js';
import type { SceneryBudget } from './scenery-budget.js';

// Ring geometry resolution. 160 segments keeps the skyline smooth at this distance while
// staying cheap (a handful of rings × 160 quads is trivial next to the forest).
const SEGMENTS = 160;
// The curtain's base sits well below the horizon line so its bottom edge is hidden behind
// the fogged terrain and never reads as a floating band.
const BASE_Y = -80;
// Aerial-perspective endpoints: near ridges a muted slate-blue, far ridges pale toward the
// horizon colour (0xc8e1f5). Fog hazes both further, but the base tint sets the stack depth.
const NEAR_COLOR = 0x8ea6bd;
const FAR_COLOR = 0xbcd4ea;

/** How many ridge layers to build for a given budget, clamped to the 3–5 the plan calls for. */
function ridgeLayerCount(budget: SceneryBudget): number {
  return Math.max(3, Math.min(5, Math.floor(budget.ridgeLayers)));
}

/**
 * A seamless jagged skyline height profile for one ridge, as a closure over precomputed
 * octaves. INTEGER frequencies keep it periodic over a full 2π turn so the ring closes
 * without a seam. All randomness is drawn from the seeded `rng` (never Math.random).
 */
function makeSkyline(rng: () => number, peakBase: number): (theta: number) => number {
  const octaves: Array<{ freq: number; amp: number; phase: number }> = [];
  for (let k = 0; k < 4; k++) {
    octaves.push({
      // Integer frequency => the profile wraps seamlessly around the circle.
      freq: 2 + Math.floor(rng() * (6 + k * 4)),
      amp: (peakBase * 0.5) * (1 / (k + 1)) * (0.6 + rng() * 0.8),
      phase: rng() * Math.PI * 2,
    });
  }
  return function heightAt(theta: number): number {
    let h = peakBase;
    for (const o of octaves) h += o.amp * Math.sin(o.freq * theta + o.phase);
    // Keep a positive minimum so the silhouette never dips below its base band.
    return Math.max(12, h);
  };
}

/** Build one ridge ring mesh. THREE construction is fully guarded; vertex math is pure. */
function buildRidgeLayer(index: number, layers: number, rng: () => number): THREE.Mesh {
  const radius = 520 + index * 55;              // 520 → 740 across the stack
  const peakBase = 60 + index * 18;             // farther ridges stand taller (peek over)
  const heightAt = makeSkyline(rng, peakBase);

  // Pure vertex build (no THREE, no Math.random): a two-row triangle strip around the ring,
  // bottom row at BASE_Y, top row following the skyline profile.
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= SEGMENTS; j++) {
    const theta = (j / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    positions.push(x, BASE_Y, z);                // vertex 2j   (bottom)
    positions.push(x, BASE_Y + heightAt(theta), z); // vertex 2j+1 (top)
  }
  for (let j = 0; j < SEGMENTS; j++) {
    const b0 = 2 * j, t0 = 2 * j + 1, b1 = 2 * (j + 1), t1 = 2 * (j + 1) + 1;
    indices.push(b0, t0, t1, b0, t1, b1);
  }

  const t = layers > 1 ? index / (layers - 1) : 0;
  return withPrivateThreeRandom(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const color = new THREE.Color(NEAR_COLOR).lerp(new THREE.Color(FAR_COLOR), t);
    // Unlit silhouette: MeshBasicMaterial casts/receives no shadows and ignores lighting,
    // so the ridge is a flat fog-hazed cutout. DoubleSide renders the inner wall the camera
    // (inside the ring) faces regardless of winding; the far wall is beyond the fog/far plane.
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `ridge-${index}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false; // static — never moves, so skip per-frame matrix recompute
    mesh.updateMatrix();
    return mesh;
  });
}

/**
 * Build the distant-ridge panorama: a `THREE.Group` of jagged silhouette rings, seeded off
 * `rng` so the same tier always composes the same horizon. Static (no per-frame update) and
 * fog-hazed into the sky. The caller (createScenery) parents it under the scenery group.
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
