// Decorative prop catalog — procedural prop archetypes (issue #320, PR 6).
//
// A registry of small, procedurally-built decorative props (cairns, trail markers, fences,
// stumps) that `decorative-props.ts` scatters on the flanks to add human/backcountry detail.
//
// WHY PROCEDURAL (not GLTF): the plan floated a GLTF prop catalog, but (1) the raw-source
// import map only maps `"three"` — NOT `three/addons/*` — so a GLTFLoader import would 404 on
// the deployed/puppeteer test pages (the same hazard sky.ts avoids), and (2) shipping real
// props needs licensed binary assets. Building props from primitives — like every other
// scenery layer — sidesteps both, ships now, and keeps one consistent low-poly style. A shared
// `src/assets/gltf-cache.ts` + `public/assets/props/**` remain a documented future extension.
//
// GEOMETRY POOLING (Codex review on #327): every archetype builds only Meshes that reference a
// SHARED `PropPool` of geometries + materials — created ONCE per scatter, not per prop. So N
// scattered props add a FIXED handful of BufferGeometry objects, never N×(2..5). This keeps the
// live geometry count bounded under the `tests/e2e/perf-budget.spec.ts` ceiling (the same pooled
// invariant trees.ts holds); a per-prop-geometry regression would blow it into the hundreds.
//
// Each archetype's `build(rng, pool)` returns an Object3D whose base sits at local y=0 (so the
// placer just positions it at (x, groundY, z)). All randomness is from the seeded `rng`.
// Construction runs inside `withPrivateThreeRandom` (the placer wraps it), so THREE UUID draws
// never perturb the seeded global stream.

import * as THREE from 'three';

const ROCK = 0x8d9299;       // cairn stone
const WOOD = 0x6b4a2f;       // pole / fence / stump timber
const WOOD_LIGHT = 0xb08d5a; // freshly-cut stump top
const FLAG_COLORS = [0xd94a3d, 0xf0a830, 0x3d7bd9];

/** Shared geometries + materials referenced by every scattered prop of a given scatter. Created
 *  ONCE per `buildDecorativeProps` call (inside the private-RNG guard). The scenery dispose sweep
 *  frees each unique resource once; the pool is call-local, so a remount builds a fresh one. */
export interface PropPool {
  rockGeo: THREE.BufferGeometry;
  poleGeo: THREE.BufferGeometry;
  flagGeo: THREE.BufferGeometry;
  postGeo: THREE.BufferGeometry;
  railGeo: THREE.BufferGeometry;
  stumpBodyGeo: THREE.BufferGeometry;  // unit height (1) — scaled per instance
  stumpTopGeo: THREE.BufferGeometry;
  rockMat: THREE.MeshStandardMaterial;
  woodMat: THREE.MeshStandardMaterial;
  woodLightMat: THREE.MeshStandardMaterial;
  flagMats: THREE.MeshStandardMaterial[];
}

function litMat(color: number, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, flatShading: true, fog: true });
}

/** Build the shared geometry/material pool. Call inside `withPrivateThreeRandom`. */
export function createPropPool(): PropPool {
  return {
    rockGeo: new THREE.IcosahedronGeometry(1, 0),
    poleGeo: new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6),
    flagGeo: new THREE.BoxGeometry(0.5, 0.3, 0.04),
    postGeo: new THREE.BoxGeometry(0.14, 1.0, 0.14),
    railGeo: new THREE.BoxGeometry(1.9, 0.14, 0.09),
    stumpBodyGeo: new THREE.CylinderGeometry(0.33, 0.42, 1, 8),
    stumpTopGeo: new THREE.CylinderGeometry(0.33, 0.33, 0.05, 8),
    rockMat: litMat(ROCK),
    woodMat: litMat(WOOD),
    woodLightMat: litMat(WOOD_LIGHT),
    flagMats: FLAG_COLORS.map((c) => litMat(c, 0.7)),
  };
}

function noShadow(obj: THREE.Object3D): void {
  obj.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false; });
}

/** A stacked-stone cairn (trail marker of piled flat rocks). Shared rock geo, scaled per stone. */
function cairn(rng: () => number, pool: PropPool): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'cairn';
  const n = 3 + Math.floor(rng() * 3);
  let y = 0;
  for (let k = 0; k < n; k++) {
    const r = 0.55 * (1 - k / (n + 1.5));
    const rock = new THREE.Mesh(pool.rockGeo, pool.rockMat);
    rock.scale.set(r, r * 0.6, r);
    rock.position.y = y + r * 0.55;
    rock.rotation.set(rng() * 0.5, rng() * Math.PI, rng() * 0.5);
    g.add(rock);
    y += r * 0.9;
  }
  noShadow(g);
  return g;
}

/** A trail-marker pole with a small coloured flag. */
function trailMarker(rng: () => number, pool: PropPool): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'trail-marker';
  const pole = new THREE.Mesh(pool.poleGeo, pool.woodMat);
  pole.position.y = 1.1;
  const flagMat = pool.flagMats[Math.floor(rng() * pool.flagMats.length)] ?? pool.flagMats[0]!;
  const flag = new THREE.Mesh(pool.flagGeo, flagMat);
  flag.position.set(0.28, 1.9, 0);
  g.add(pole, flag);
  noShadow(g);
  return g;
}

/** A short wooden fence segment (two posts + a rail). */
function fence(rng: () => number, pool: PropPool): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'fence';
  for (const px of [-0.85, 0.85]) {
    const post = new THREE.Mesh(pool.postGeo, pool.woodMat);
    post.position.set(px, 0.5, 0);
    g.add(post);
  }
  const rail = new THREE.Mesh(pool.railGeo, pool.woodMat);
  rail.position.y = 0.72 + rng() * 0.06;
  g.add(rail);
  noShadow(g);
  return g;
}

/** A cut tree stump with a lighter cut top. Shared unit-height body geo, scaled to height. */
function stump(rng: () => number, pool: PropPool): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'stump';
  const h = 0.5 + rng() * 0.3;
  const body = new THREE.Mesh(pool.stumpBodyGeo, pool.woodMat);
  body.scale.y = h;
  body.position.y = h / 2;
  const top = new THREE.Mesh(pool.stumpTopGeo, pool.woodLightMat);
  top.position.y = h + 0.02;
  g.add(body, top);
  noShadow(g);
  return g;
}

/** A named procedural prop archetype. `build` references the shared pool (no per-prop geometry). */
export interface PropArchetype {
  name: string;
  build(rng: () => number, pool: PropPool): THREE.Object3D;
}

/** The prop catalog. `decorative-props.ts` scatters from this list. */
export const PROP_CATALOG: readonly PropArchetype[] = [
  { name: 'cairn', build: cairn },
  { name: 'trail-marker', build: trailMarker },
  { name: 'fence', build: fence },
  { name: 'stump', build: stump },
];
