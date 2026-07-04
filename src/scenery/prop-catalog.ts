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
// Each archetype's `build(rng)` returns an Object3D whose base sits at local y=0 (so the
// placer just positions it at (x, groundY, z)). All randomness is from the seeded `rng`.
// Construction is expected to run inside `withPrivateThreeRandom` (the placer wraps it), so
// THREE UUID draws never perturb the seeded global stream.

import * as THREE from 'three';

const ROCK = 0x8d9299;       // cairn stone
const WOOD = 0x6b4a2f;       // pole / fence / stump timber
const WOOD_LIGHT = 0xb08d5a; // freshly-cut stump top
const FLAG_COLORS = [0xd94a3d, 0xf0a830, 0x3d7bd9];

function litMat(color: number, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, flatShading: true, fog: true });
}
function noShadow(obj: THREE.Object3D): void {
  obj.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false; });
}

/** A stacked-stone cairn (trail marker of piled flat rocks). */
function cairn(rng: () => number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'cairn';
  const n = 3 + Math.floor(rng() * 3);
  let y = 0;
  for (let k = 0; k < n; k++) {
    const r = 0.55 * (1 - k / (n + 1.5));
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), litMat(ROCK));
    rock.scale.y = 0.6;
    rock.position.y = y + r * 0.55;
    rock.rotation.set(rng() * 0.5, rng() * Math.PI, rng() * 0.5);
    g.add(rock);
    y += r * 0.9;
  }
  noShadow(g);
  return g;
}

/** A trail-marker pole with a small coloured flag. */
function trailMarker(rng: () => number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'trail-marker';
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6), litMat(WOOD));
  pole.position.y = 1.1;
  const flagColor = FLAG_COLORS[Math.floor(rng() * FLAG_COLORS.length)] ?? FLAG_COLORS[0]!;
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.04), litMat(flagColor, 0.7));
  flag.position.set(0.28, 1.9, 0);
  g.add(pole, flag);
  noShadow(g);
  return g;
}

/** A short wooden fence segment (two posts + a rail). */
function fence(rng: () => number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'fence';
  const mat = litMat(WOOD);
  for (const px of [-0.85, 0.85]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.14), mat);
    post.position.set(px, 0.5, 0);
    g.add(post);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.09), mat);
  rail.position.y = 0.72 + rng() * 0.06;
  g.add(rail);
  noShadow(g);
  return g;
}

/** A cut tree stump with a lighter cut top. */
function stump(rng: () => number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'stump';
  const h = 0.5 + rng() * 0.3;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.42, h, 8), litMat(WOOD));
  body.position.y = h / 2;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.05, 8), litMat(WOOD_LIGHT));
  top.position.y = h + 0.02;
  g.add(body, top);
  noShadow(g);
  return g;
}

/** A named procedural prop archetype. */
export interface PropArchetype {
  name: string;
  build(rng: () => number): THREE.Object3D;
}

/** The prop catalog. `decorative-props.ts` scatters from this list. */
export const PROP_CATALOG: readonly PropArchetype[] = [
  { name: 'cairn', build: cairn },
  { name: 'trail-marker', build: trailMarker },
  { name: 'fence', build: fence },
  { name: 'stump', build: stump },
];
