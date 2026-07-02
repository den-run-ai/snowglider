// mountains/trees.ts - Tree creation and placement (scenery on the terrain).
//
// Stage R-mountains (issue #34): trees moved into `src/mountains/*` as a peer of
// `rocks.ts` (both scatter scenery on the terrain by reading the analytic samplers),
// behind the thin `src/trees.ts` facade so every `./trees.js` importer keeps
// resolving. Doing so let trees import the terrain samplers from the leaf modules
// (`./terrain.js` height/gradient, `./noise.js` forest-density) directly instead of
// the `Mountains` facade object — which **removes the old trees <-> mountains
// circular import** (terrain-mesh.ts imports `./trees.js`, and trees no longer
// imports back up to the facade). Behaviour is unchanged.
//
// Phase 3.3 (issue #84): renamed `.js` -> `.ts`. The placement/collision data shapes
// and helper signatures are real `interface`/`type` declarations; the tree math is
// byte-identical (every edit type-only/erasable), so esbuild (Vite) and Node's native
// type-stripping run it exactly as before.
import * as THREE from 'three';
import { getTerrainHeight as sampleTerrainHeight, getTerrainGradient as sampleTerrainGradient } from './terrain.js';
import { forestDensityField } from './noise.js';
// The run's centerline: the clear corridor + density zones follow it (Black). Returns
// exactly 0 for straight tiers, so `Math.abs(x - lane)` collapses to today's `Math.abs(x)`
// and the placement (and its Math.random() sequence) stays byte-identical for Bunny/Blue.
import { activeLaneX, getActiveCourseLine } from '../course-line.js';
import { Wind } from '../wind.js';
// EZ-Tree evergreens (issue #282; default for players, stylized under automation/
// headless — see ez-forest.ts flag section): ez-forest.ts provides low-poly conifer
// archetype geometry; this file renders it through the same instanced/tint/sway/
// snow pipeline. The stylized path is byte-identical whenever the flag is off.
import { isEzForestEnabled, setEzForestEnabled, ensureEzArchetypes, resetEzForest, EZ_SPECIES_COUNT } from './ez-forest.js';
import type { EzArchetype, EzDetail } from './ez-forest.js';

/** A placed tree's world position and size; addTrees returns these for collision. */
export interface TreePosition {
  x: number;
  y: number;
  z: number;
  scale: number;
}

/** Terrain gradient (slope components) returned by the Mountains sampler. */
export interface TerrainGradient {
  x: number;
  z: number;
}

// --- Procedural tree textures (issue #17, Stage 4) ---
// One bark normal map and one foliage normal map, shared across every tree (built
// once, cached) so the few hundred trunks/cones reuse a single GPU upload each
// instead of per-tree canvases. Lazily created and guarded on `document` so
// createTree still runs headless (terrain-tests mocks it, but keep it safe).
// Normal maps add surface relief while the existing per-tree HSL colours stay the
// albedo. Authored for the legacy linear pipeline; flagged NoColorSpace. Mirrors
// the snow/rock texture pattern in mountains.ts.
let barkNormalTexture: THREE.CanvasTexture | null = null;
let barkAlbedoTexture: THREE.CanvasTexture | null = null;
let foliageNormalTexture: THREE.CanvasTexture | null = null;

/** Build a tileable tangent-space normal map from a height(u,v) sampler. */
function buildNormalTexture(size: number, strength: number, heightAt: (u: number, v: number) => number): THREE.CanvasTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = heightAt(x / size, y / size);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const wrap = (i: number) => (i + size) % size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hl = h[y * size + wrap(x - 1)]!, hr = h[y * size + wrap(x + 1)]!;
      const hd = h[wrap(y - 1) * size + x]!, hu = h[wrap(y + 1) * size + x]!;
      const nx = -(hr - hl) * strength, ny = -(hu - hd) * strength;
      const len = Math.hypot(nx, ny, 1);
      const idx = (y * size + x) * 4;
      data[idx] = (nx / len * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny / len * 0.5 + 0.5) * 255;
      data[idx + 2] = (1 / len * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// Shared conifer-bark height sampler: vertical ridges around the trunk, plus
// horizontal banding and wandering cracks up its length. It feeds both normal and
// albedo maps so dark grooves line up with the relief.
function barkHeightAt(u: number, v: number): number {
  let h = 0.5 * Math.sin(2 * Math.PI * 8 * u);
  h += 0.3 * Math.sin(2 * Math.PI * 17 * u + 1.3);
  h += 0.2 * Math.sin(2 * Math.PI * 31 * u + 0.7);
  h += 0.25 * Math.sin(2 * Math.PI * 5 * v + 2.0) * Math.sin(2 * Math.PI * 3 * u);
  const crack = Math.sin(2 * Math.PI * (2 * v + 0.8 * Math.sin(2 * Math.PI * u)));
  h -= 0.45 * Math.pow(Math.max(0, crack), 8);
  return h;
}

/** Bark relief: vertical ridges, horizontal banding, and crack grooves. */
function getBarkNormal(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (!barkNormalTexture) {
    barkNormalTexture = buildNormalTexture(128, 2.5, barkHeightAt);
    barkNormalTexture.repeat.set(1, 3); // wrap once around, repeat up the trunk
  }
  return barkNormalTexture;
}

/** Grayscale bark streak map, multiplied by the per-instance bark tint. */
function getBarkAlbedo(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (!barkAlbedoTexture) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h = barkHeightAt(x / size, y / size);
        const brightness = Math.min(255, Math.max(120, 225 + h * 32));
        const idx = (y * size + x) * 4;
        data[idx] = brightness;
        data[idx + 1] = brightness;
        data[idx + 2] = brightness;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.repeat.set(1, 3);
    barkAlbedoTexture = tex;
  }
  return barkAlbedoTexture;
}

/** Isotropic dapple = needle clumps on the foliage cones. */
function getFoliageNormal(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (!foliageNormalTexture) {
    foliageNormalTexture = buildNormalTexture(128, 2.2, (u, v) => {
      let h = 0.5 * Math.sin(2 * Math.PI * (6 * u + 4 * v) + 0.5);
      h += 0.35 * Math.sin(2 * Math.PI * (11 * u - 9 * v) + 1.9);
      h += 0.25 * Math.sin(2 * Math.PI * 19 * u) * Math.sin(2 * Math.PI * 17 * v);
      h += 0.18 * Math.sin(2 * Math.PI * (29 * u + 23 * v) + 0.9);
      return h;
    });
    foliageNormalTexture.repeat.set(3, 3);
  }
  return foliageNormalTexture;
}

// --- Shared tree geometry & material pools (Three.js perf, issue: GPU waste) ---
// The forest is a few hundred trees, each a Group of ~20-40 meshes. The original
// code minted a fresh CylinderGeometry/ConeGeometry/SphereGeometry AND a fresh
// MeshStandardMaterial for almost every one — thousands of unique GPU geometries
// and materials that all have to be uploaded once and re-bound every frame
// (including the shadow pass). The avalanche boulders and ski tracks already use
// the right pattern (one shared geometry/material), so the trees were the odd one
// out. Here every mesh draws from a tiny pool instead:
//   - base geometries are authored at a canonical size and resized per mesh via
//     `mesh.scale`, so all trunks/cones/branches/snow share one buffer each;
//   - colour variety comes from a small quantised material palette (a handful of
//     bark/foliage shades) picked at random, instead of one material per mesh.
// The scene graph is unchanged (each tree stays a Group of individual meshes, so
// collision and the visual-tree count are untouched); only the GPU resource count
// collapses from thousands to ~20. Pools are built lazily and live for the app
// lifetime (like the normal maps) — nothing to dispose.
let trunkGeometry: THREE.CylinderGeometry | null = null;
let coneGeometry: THREE.ConeGeometry | null = null;
let branchGeometry: THREE.CylinderGeometry | null = null;
let snowCapGeometry: THREE.SphereGeometry | null = null;
let snowPatchGeometry: THREE.SphereGeometry | null = null;
let trunkColors: THREE.Color[] | null = null;
let foliageColors: THREE.Color[] | null = null;
let trunkMaterials: THREE.MeshStandardMaterial[] | null = null;
let foliageMaterials: THREE.MeshStandardMaterial[] | null = null;
let snowMaterial: THREE.MeshStandardMaterial | null = null;
let barkInstancedMaterial: THREE.MeshStandardMaterial | null = null;
let foliageInstancedMaterial: THREE.MeshStandardMaterial | null = null;
// Shadow-caster (depth) materials carrying the SAME sway, one per profile variant
// (see getSwayDepthMaterial; ez archetypes add root-height/alpha-mapped variants,
// so the memo is keyed by a composed string). Kept beside the visible ones so
// resetTreePools frees them too.
// 'anchored' (issue #282 PR 3): weight comes from a per-instance `aSwayWeight`
// attribute instead of the vertex's local height — used by the EZ tree snow, whose
// unit-sphere geometry carries no height information but whose INSTANCES sit at a
// known height on their host archetype. Lean-only (no flutter): snow has mass.
type SwayProfile = 'rooted' | 'canopy' | 'flutter' | 'anchored';
/** Optional sway/depth variations used by the EZ archetype materials. */
interface SwayOptions {
  /** Local-space height the bend is rooted against (weight 0 at y=0 → 1 at height). */
  rootHeight?: number;
  /** Alpha-card map for alpha-tested shadow silhouettes (needle cards). */
  map?: THREE.Texture | null;
  alphaTest?: number;
}
const swayDepthMaterials: Record<string, THREE.MeshDepthMaterial> = {};

/** Canonical trunk: height 4 with a root flare at the base. */
function getTrunkGeometry(): THREE.CylinderGeometry {
  if (!trunkGeometry) trunkGeometry = new THREE.CylinderGeometry(0.38, 0.72, 4, 10);
  return trunkGeometry;
}

/** Canonical foliage cone (radius 2.2, height 2.5); resized per layer via scale.
 *  A fixed rim wobble breaks the perfect low-poly cone silhouette; each tree's
 *  visual yaw points that shared irregularity in a different direction. */
function getConeGeometry(): THREE.ConeGeometry {
  if (!coneGeometry) {
    const geo = new THREE.ConeGeometry(2.2, 2.5, 10);
    const positions = geo.attributes.position!.array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!;
      const z = positions[i + 2]!;
      const r = Math.hypot(x, z);
      if (r < 1e-4) continue;
      const theta = Math.atan2(z, x);
      const wobble = 1 + 0.06 * Math.sin(3 * theta + 1.7) + 0.05 * Math.sin(5 * theta + 0.4);
      positions[i] = x * wobble;
      positions[i + 2] = z * wobble;
    }
    geo.computeVertexNormals();
    coneGeometry = geo;
  }
  return coneGeometry;
}

/** Unit branch laid along +X (pre-rotated), so scale = (length, thickness, thickness). */
function getBranchGeometry(): THREE.CylinderGeometry {
  if (!branchGeometry) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 4);
    geo.rotateZ(Math.PI / 2); // bake the horizontal orientation into the shared buffer
    branchGeometry = geo;
  }
  return branchGeometry;
}

/** Unit half-dome snow cap; matches the old top-cap sphere wedge at radius 1. */
function getSnowCapGeometry(): THREE.SphereGeometry {
  if (!snowCapGeometry) snowCapGeometry = new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 3);
  return snowCapGeometry;
}

/** Unit snow patch (hemisphere wedge at radius 1); scaled down per placement. */
function getSnowPatchGeometry(): THREE.SphereGeometry {
  if (!snowPatchGeometry) snowPatchGeometry = new THREE.SphereGeometry(1, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  return snowPatchGeometry;
}

// --- Colour palettes (the source of truth for both the Group shim and instances) ---
// The forest is rendered with InstancedMesh (one draw per geometry/material), and
// within a material family the *only* per-tree variation is the base colour. So the
// palettes live here as bare `THREE.Color[]` and feed BOTH the legacy palette
// materials (`getTrunkMaterials`/`getFoliageMaterials`, kept for the Group-returning
// `createTree` shim + API compatibility) and the per-instance `setColorAt` calls in
// `buildForest`. Same HSL values as before → identical look, now via `instanceColor`.

// First weathered shade in the bark palette. Live trees mostly pick from the rich
// browns below it; the weathered shades are reserved for future non-live wood uses.
const TRUNK_WEATHERED_START = 6;

/** Bark palette: richer live browns plus weathered grey-brown/silver wood. */
function getTrunkColors(): THREE.Color[] {
  if (!trunkColors) {
    const defs: Array<[number, number, number]> = [
      [0.075, 0.50, 0.26],
      [0.085, 0.48, 0.30],
      [0.095, 0.45, 0.33],
      [0.105, 0.50, 0.28],
      [0.115, 0.42, 0.31],
      [0.090, 0.32, 0.24],
      [0.080, 0.14, 0.36],
      [0.070, 0.09, 0.44],
      [0.600, 0.04, 0.50]
    ];
    trunkColors = defs.map(([h, s, l]) => new THREE.Color().setHSL(h, s, l));
  }
  return trunkColors;
}

const FOLIAGE_DEEP_START = 8;
const FOLIAGE_FROST_START = 12;

/** Foliage palette: alpine greens, deep spruce greens, and frosted blue-greens. */
function getFoliageColors(): THREE.Color[] {
  if (!foliageColors) {
    const defs: Array<[number, number, number]> = [
      [0.355, 0.62, 0.24], [0.360, 0.72, 0.28], [0.370, 0.60, 0.21], [0.375, 0.78, 0.25],
      [0.380, 0.66, 0.30], [0.390, 0.72, 0.22], [0.400, 0.58, 0.26], [0.410, 0.68, 0.24],
      [0.380, 0.55, 0.15], [0.390, 0.60, 0.13], [0.400, 0.50, 0.17], [0.420, 0.55, 0.15],
      [0.440, 0.38, 0.30], [0.450, 0.33, 0.26], [0.460, 0.30, 0.33], [0.470, 0.36, 0.28]
    ];
    foliageColors = defs.map(([h, s, l]) => new THREE.Color().setHSL(h, s, l));
  }
  return foliageColors;
}

/** Legacy per-shade bark materials (Group shim / API compat); built from the palette. */
function getTrunkMaterials(): THREE.MeshStandardMaterial[] {
  if (!trunkMaterials) {
    const normalMap = getBarkNormal();
    const map = getBarkAlbedo();
    trunkMaterials = getTrunkColors().map(color => new THREE.MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.9,
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8)
    }));
  }
  return trunkMaterials;
}

/** Legacy per-shade foliage materials (Group shim / API compat); built from the palette. */
function getFoliageMaterials(): THREE.MeshStandardMaterial[] {
  if (!foliageMaterials) {
    const normalMap = getFoliageNormal();
    foliageMaterials = getFoliageColors().map(color => new THREE.MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.8,
      normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6)
    }));
  }
  return foliageMaterials;
}

/** The single shared cool-white snow material (no instanceColor). */
function getSnowMaterial(): THREE.MeshStandardMaterial {
  if (!snowMaterial) {
    snowMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.97, 0.98, 1.0),
      roughness: 0.82
    });
    applyTreeSway(snowMaterial, 'canopy');
  }
  return snowMaterial;
}

// --- Wind sway (issue #253, Phase A) ---------------------------------------------
// The forest leans and flutters in the shared, deterministic wind field (src/wind.ts) —
// the same field that drifts the snowfall and streams the scarf. This is a GPU vertex
// sway (an `onBeforeCompile` injection on the instanced tree materials), NOT a per-frame
// CPU walk of the hundreds of instances: the shader displaces each vertex downwind in
// the material-space that sits between the instance transform and the view transform, so
// the whole forest sways for the cost of three uniform writes per frame.
//
// Cosmetic only: it moves vertices in the shader and never touches any position/collision
// data (`treePositions` is unchanged), so the physics invariant stays byte-identical.
// Honours `prefers-reduced-motion` (amplitude -> 0) like the snow drift / Flex / Sky.
//
// Three sway profiles keep trees looking rooted without needing any per-instance data
// (which would have to live on the *shared* pooled geometry and break its one-forest
// assumption): the TRUNK material is "rooted" — the bend is weighted 0 at the trunk base
// and 1 at its top, so the tree pivots at the ground — while snow-laden parts use a
// damped "canopy" lean. Live foliage uses the same canopy lean plus a small
// crosswind flutter so needle layers flex under gusts. A spatial phase from each
// vertex's world x/z desyncs neighbouring trees so the stand doesn't wave in
// lockstep. One shared uniform set drives every material.
const treeWindUniforms = {
  uWindDir: { value: new THREE.Vector2(1, 0) }, // unit downwind direction (world x, z)
  uWindAmp: { value: 0 },                        // world-unit lean at full weight; 0 = calm
  uWindSwayTime: { value: 0 }                    // seconds, drives the flutter oscillation
};
let treeSwayClock = 0;

// Amplitude band mapped from Wind.strength() (0..1): even the steady breeze nudges the
// canopy, a full gust leans it a bit more, and it never exceeds ~a third of a unit — a
// gentle sway on the ~8-14 unit-tall trees, not a storm.
const TREE_SWAY_MIN_AMP = 0.08;
const TREE_SWAY_MAX_AMP = 0.35;

/** Map a normalized wind strength (0..1) to the canopy sway amplitude. The MIN_AMP floor
 *  is a *breeze* minimum, so a genuinely calm field (strength 0 — e.g. a
 *  `Wind.configure({ baseStrength: 0, gustRange: 0 })` profile) must read as fully still,
 *  matching the snow/scarf consumers rather than fluttering on its own. Any positive wind
 *  gets at least the floor, ramping to MAX_AMP at full strength. The live game's default
 *  field never reaches 0 (baseStrength keeps strength ≳ 0.33), so normal play is unchanged.
 *  Pure + exported for the headless trees test. */
function treeSwayAmplitude(strength: number): number {
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
  return s > 0 ? TREE_SWAY_MIN_AMP + (TREE_SWAY_MAX_AMP - TREE_SWAY_MIN_AMP) * s : 0;
}

/** Honour prefers-reduced-motion (same gate as snow drift / Flex / Sky): a calm forest
 *  when the user asks for reduced motion. Guarded so it is a no-op (motion on) headless. */
function prefersReducedTreeMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Vertex-shader head: the wind uniforms + tuning defines, prepended at `<common>` so they
// are in scope by the time `<project_vertex>` runs. `TREE_TRUNK_HALF` is the trunk
// geometry's local half-height (see getTrunkGeometry: CylinderGeometry height 4) — the
// rooted weight normalises `position.y` (local, scale-independent) against it.
const TREE_SWAY_HEAD_BASE = `#include <common>
  uniform vec2 uWindDir;
  uniform float uWindAmp;
  uniform float uWindSwayTime;
  #define TREE_SWAY_RATE 1.1
  #define TREE_TRUNK_HALF 2.0`;

// Expanded default three r0.184 `<project_vertex>` with the sway applied in model space —
// after `instanceMatrix`, before `modelViewMatrix`. The forest InstancedMeshes have an
// identity model matrix, so model space is world space here and the lean is added to the
// world x/z. Rooted (trunk) vs. uniform (canopy) is selected by `TREE_SWAY_ROOTED`,
// while `TREE_SWAY_FLUTTER` adds live-needle crosswind motion. Pinned to the stock
// chunk; if a three upgrade rewrites `<project_vertex>` this replace must be revisited
// (docs/THREEJS_UPGRADE.md).
const TREE_SWAY_PROJECT_VERTEX = `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  {
    #if defined( TREE_SWAY_INSTANCE_WEIGHT )
      float swayWeight = aSwayWeight;
    #elif defined( TREE_SWAY_ROOT_HEIGHT )
      float swayWeight = clamp( position.y / TREE_SWAY_ROOT_HEIGHT, 0.0, 1.0 );
    #elif defined( TREE_SWAY_ROOTED )
      float swayWeight = clamp( ( position.y + TREE_TRUNK_HALF ) / ( 2.0 * TREE_TRUNK_HALF ), 0.0, 1.0 );
    #else
      float swayWeight = 1.0;
    #endif
    float swayPhase = dot( mvPosition.xz, vec2( 0.35, 0.27 ) );
    float swayOsc = sin( uWindSwayTime * TREE_SWAY_RATE + swayPhase )
                  + 0.3 * sin( uWindSwayTime * TREE_SWAY_RATE * 2.1 + swayPhase * 1.7 );
    float ampVar = 0.82 + 0.18 * sin( swayPhase * 5.7 + 2.1 );
    float lean = uWindAmp * ampVar * swayWeight * ( 0.75 + 0.25 * swayOsc );
    mvPosition.x += uWindDir.x * lean;
    mvPosition.z += uWindDir.y * lean;
    #ifdef TREE_SWAY_FLUTTER
      float flutter = uWindAmp * swayWeight
                    * ( 0.10 * sin( uWindSwayTime * 5.3 + swayPhase * 3.9 + position.y * 2.0 )
                      + 0.06 * sin( uWindSwayTime * 8.9 + swayPhase * 7.1 + position.x * 3.0 ) );
      mvPosition.x -= uWindDir.y * flutter;
      mvPosition.z += uWindDir.x * flutter;
    #endif
  }
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

/** Inject the wind vertex sway into a tree material's shader. An optional
 *  `rootHeight` roots the bend against a local-space height instead of the pooled
 *  trunk's half-height — the EZ archetype geometries sit base-at-0 with per-archetype
 *  heights, so each material carries its own height define. */
function applyTreeSway(material: THREE.Material, profile: SwayProfile, rootHeight?: number): void {
  let head = TREE_SWAY_HEAD_BASE;
  if (profile === 'rooted') head += '\n  #define TREE_SWAY_ROOTED';
  if (profile === 'flutter') head += '\n  #define TREE_SWAY_FLUTTER';
  if (profile === 'anchored') {
    // Per-instance weight (three transpiles `attribute` -> `in` under WebGL2).
    head += '\n  #define TREE_SWAY_INSTANCE_WEIGHT\n  attribute float aSwayWeight;';
  }
  if (rootHeight !== undefined && rootHeight > 0) {
    head += `\n  #define TREE_SWAY_ROOT_HEIGHT ${rootHeight.toFixed(2)}`;
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindDir = treeWindUniforms.uWindDir;
    shader.uniforms.uWindAmp = treeWindUniforms.uWindAmp;
    shader.uniforms.uWindSwayTime = treeWindUniforms.uWindSwayTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', head)
      .replace('#include <project_vertex>', TREE_SWAY_PROJECT_VERTEX);
  };
  // onBeforeCompile edits are not part of three's default program cache key; a stable key
  // (varied by profile + root height) keeps the swayed program from colliding with an
  // unswayed build or a differently-rooted variant.
  const heightTag = rootHeight !== undefined && rootHeight > 0 ? `-h${rootHeight.toFixed(2)}` : '';
  material.customProgramCacheKey = () => `tree-wind-sway-${profile}${heightTag}-v2`;
}

/** Advance the forest's wind sway one render frame. Reads the shared Wind field (downwind
 *  direction + strength) into the shared uniforms; amplitude collapses to 0 under
 *  prefers-reduced-motion. Deterministic (the flutter clock only ever advances by dt), so
 *  it stays screenshot-reproducible like the rest of the wind stack. Cheap: three uniform
 *  writes, no per-instance work. */
function updateWind(dt: number): void {
  const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  treeSwayClock += d;
  treeWindUniforms.uWindSwayTime.value = treeSwayClock;
  if (prefersReducedTreeMotion()) {
    treeWindUniforms.uWindAmp.value = 0;
    return;
  }
  const dir = Wind.dir();
  treeWindUniforms.uWindDir.value.set(dir.x, dir.z);
  treeWindUniforms.uWindAmp.value = treeSwayAmplitude(Wind.strength());
}

/** Rewind the sway clock (called on each run reset, alongside Wind.reset) so every run
 *  starts from the same deterministic point in the flutter cycle. */
function resetWind(): void {
  treeSwayClock = 0;
  treeWindUniforms.uWindSwayTime.value = 0;
  treeWindUniforms.uWindAmp.value = 0;
  treeWindUniforms.uWindDir.value.set(1, 0);
}

// --- Instanced materials (one per family; white base, tinted per-instance) ---
// Collapsing the 6 bark + 12 foliage palette materials down to ONE material each:
// the base colour is white and the chosen palette colour is supplied per instance via
// `setColorAt` (`instanceColor` multiplies the white base, reproducing the palette
// exactly — ColorManagement is off + output is LinearSRGB, so setHSL maps through
// unchanged). Snow needs no tint, so the instanced snow caps/patches reuse the shared
// white `getSnowMaterial()` directly. Headless-safe: the normal maps are null without
// `document` and three treats a null `normalMap` as no map.

/** White bark material for the instanced trunks (tinted per-instance). */
function getBarkInstancedMaterial(): THREE.MeshStandardMaterial {
  if (!barkInstancedMaterial) {
    barkInstancedMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      map: getBarkAlbedo(),
      normalMap: getBarkNormal(),
      normalScale: new THREE.Vector2(0.8, 0.8)
    });
    applyTreeSway(barkInstancedMaterial, 'rooted');
  }
  return barkInstancedMaterial;
}

/** White foliage material for the instanced cones + branches (tinted per-instance). */
function getFoliageInstancedMaterial(): THREE.MeshStandardMaterial {
  if (!foliageInstancedMaterial) {
    foliageInstancedMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      normalMap: getFoliageNormal(),
      normalScale: new THREE.Vector2(0.6, 0.6)
    });
    applyTreeSway(foliageInstancedMaterial, 'flutter');
  }
  return foliageInstancedMaterial;
}

// Private, self-contained RNG used ONLY while constructing the depth materials below. A
// `new MeshDepthMaterial()` draws Math.random (three's generateUUID, 4×) for its uuid, and these
// are NEW materials that must not perturb a caller's SEEDED Math.random stream — the Node
// forward_stress harness seeds Math.random then places obstacles on one stream, and the browser
// perf/teardown specs seed before the bundle even loads. xorshift32; distinct draws ⇒ distinct uuids.
let depthUuidRngState = 0x1a2b3c4d;
function depthUuidRandom(): number {
  depthUuidRngState ^= depthUuidRngState << 13;
  depthUuidRngState ^= depthUuidRngState >>> 17;
  depthUuidRngState ^= depthUuidRngState << 5;
  return (depthUuidRngState >>> 0) / 0x100000000;
}

/** The shadow-caster material for a swaying instanced family. The forest InstancedMeshes
 *  `castShadow`, and three renders the shadow map with a MeshDepthMaterial that does NOT
 *  inherit the visible material's `onBeforeCompile` sway — so without a matching custom depth
 *  material the trunks/canopies would lean in the wind while their cast shadows stayed put
 *  (detached shadows). This injects the SAME sway (from the SAME shared uniforms, so one
 *  updateWind drives both) with `depthPacking: RGBADepthPacking` for the shadow map, and is
 *  memoized per profile (`rooted` = trunk). Headless-safe (no texture/DOM).
 *
 *  The `new MeshDepthMaterial()` uuid draw is fed from the private `depthUuidRandom` (Math.random
 *  is swapped in a try/finally and restored) so it never touches — and never shifts — a caller's
 *  seeded RNG stream. The pre-existing visible materials deliberately keep drawing from the live
 *  stream; the verification harnesses baseline that, so only these NEW materials are stream-neutral. */
function getSwayDepthMaterial(profile: SwayProfile, opts?: SwayOptions): THREE.MeshDepthMaterial {
  const key = `${profile}|${opts?.rootHeight !== undefined ? opts.rootHeight.toFixed(2) : ''}|` +
    `${opts?.map ? 'map' : ''}${opts?.alphaTest !== undefined ? opts.alphaTest : ''}`;
  const existing = swayDepthMaterials[key];
  if (existing) return existing;
  const savedRandom = Math.random;
  Math.random = depthUuidRandom;
  let material: THREE.MeshDepthMaterial;
  try {
    const params: THREE.MeshDepthMaterialParameters = { depthPacking: THREE.RGBADepthPacking };
    // Needle cards need their alpha silhouette in the shadow map, not the full quad.
    if (opts?.map) params.map = opts.map;
    if (opts?.alphaTest !== undefined) params.alphaTest = opts.alphaTest;
    material = new THREE.MeshDepthMaterial(params);
    applyTreeSway(material, profile, opts?.rootHeight);
  } finally {
    Math.random = savedRandom;
  }
  swayDepthMaterials[key] = material;
  return material;
}

/** Pick a random palette index (forest colour variety); one RNG draw, as before. */
function pickColorIndex(paletteLength: number): number {
  return Math.floor(Math.random() * paletteLength);
}

// --- EZ-Tree evergreen prototype (issue #282, opt-in via ?eztrees) -----------------
// ez-forest.ts generates a few low-poly conifer archetypes (merged branch tubes +
// needle cards); this section renders them with the SAME pipeline as the stylized
// forest: InstancedMesh per archetype part, per-instance palette tint, procedural
// bark maps, wind sway with matching shadow-depth materials, and instanced snow.
// The archetype chunk loads lazily (it is ~4 MB of embedded textures), so the
// visual forest is appended asynchronously a moment after addTrees returns —
// collision (`treePositions`) is computed synchronously either way and never waits.

/** World-space height an archetype is scaled to at treeScale 1 (matches the ~8-13u
 *  stylized conifers so collision radii and sightlines stay comparable). */
const EZ_TREE_TARGET_HEIGHT = 10;

/** Lateral distance from the run's centerline beyond which a tree renders as the
 *  cheap far-LOD build (issue #282, PR 2). The chase camera hugs the corridor, so
 *  every tree past this band is only ever seen at distance — a whole-forest
 *  InstancedMesh never frustum-culls (documented tradeoff, see buildForest), which
 *  makes rasterized triangles the cost that matters; the static near/far split
 *  roughly halves it without any per-frame LOD work. */
const EZ_LOD_FAR_DISTANCE = 32;

/** Which detail build a tree at (x, z) uses. Pure + exported for the headless test. */
function ezDetailForPlacement(x: number, z: number): EzDetail {
  return Math.abs(x - activeLaneX(z)) > EZ_LOD_FAR_DISTANCE ? 'far' : 'near';
}

/** One tree slot for the async EZ build: its placement matrix + palette-driving hash. */
interface EzPlacement {
  matrix: THREE.Matrix4;
  scale: number;
  x: number;
  z: number;
}

/** One EZ snow instance: its world matrix + the host tree's height-rooted sway
 *  weight at the anchor (feeds the 'anchored' profile's aSwayWeight attribute). */
interface EzSnowDesc {
  matrix: THREE.Matrix4;
  weight: number;
}

// Subtle needle tints (the needle sprite already carries the green; these vary
// brightness/frost per instance rather than re-colourising the card).
let ezLeafTints: THREE.Color[] | null = null;
function getEzLeafTints(): THREE.Color[] {
  if (!ezLeafTints) {
    ezLeafTints = ['#ffffff', '#edf5ed', '#e0eee4', '#f2efe2', '#e3ebf3'].map(c => new THREE.Color(c));
  }
  return ezLeafTints;
}

/** Per-archetype visible materials (bark tube + needle cards), memoized. */
interface EzMaterialSet { bark: THREE.MeshStandardMaterial; leaves: THREE.MeshStandardMaterial; }
let ezMaterialSets: EzMaterialSet[] | null = null;
function getEzMaterialSets(archetypes: EzArchetype[]): EzMaterialSet[] {
  if (!ezMaterialSets) {
    ezMaterialSets = archetypes.map((a) => {
      const bark = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.95,
        map: getBarkAlbedo(),
        normalMap: getBarkNormal(),
        normalScale: new THREE.Vector2(0.8, 0.8)
      });
      applyTreeSway(bark, 'rooted', a.height);
      const leavesParams: THREE.MeshStandardMaterialParameters = {
        color: 0xffffff,
        roughness: 0.85,
        side: THREE.DoubleSide,
        alphaTest: 0.35
      };
      if (a.leafMap) leavesParams.map = a.leafMap;
      const leaves = new THREE.MeshStandardMaterial(leavesParams);
      applyTreeSway(leaves, 'flutter', a.height);
      return { bark, leaves };
    });
  }
  return ezMaterialSets;
}

/** The EZ snow material: same cool white as the shared snow material, but swaying
 *  on the 'anchored' profile — each instance leans by its host tree's height-rooted
 *  weight (per-instance aSwayWeight) instead of the uniform canopy lean, so a shelf
 *  low on a trunk stays as still as the needles it sits on. */
let ezSnowMaterial: THREE.MeshStandardMaterial | null = null;
function getEzSnowMaterial(): THREE.MeshStandardMaterial {
  if (!ezSnowMaterial) {
    ezSnowMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.97, 0.98, 1.0),
      roughness: 0.82
    });
    applyTreeSway(ezSnowMaterial, 'anchored');
  }
  return ezSnowMaterial;
}

/** Deterministic per-slot hash (archetype pick, tints, snow variation) — no RNG
 *  draws after the async gap, so the visual build never perturbs seeded streams
 *  and re-builds are reproducible for the same placements. */
function hashPlacement(x: number, z: number, salt: number): number {
  let h = ((Math.round(x * 8) * 73856093) ^ (Math.round(z * 8) * 19349663) ^ (salt * 83492791)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

// Re-init guard: addTrees on the same scene supersedes any EZ build still awaiting
// the archetype chunk (scene-local, mirroring the scene-local forest teardown).
const ezBuildTokens = new WeakMap<THREE.Scene, number>();
// The most recent scheduled build; tests/tools await this to see the full forest.
let ezForestBuildPromise: Promise<void> = Promise.resolve();

/** Resolves when the last scheduled EZ forest build has been appended (or skipped). */
function ezForestReady(): Promise<void> {
  return ezForestBuildPromise;
}

function scheduleEzForest(scene: THREE.Scene, placements: EzPlacement[]): void {
  const token = (ezBuildTokens.get(scene) ?? 0) + 1;
  ezBuildTokens.set(scene, token);
  ezForestBuildPromise = ensureEzArchetypes()
    .then((archetypes) => {
      if (ezBuildTokens.get(scene) !== token) return; // superseded by a re-init
      buildEzForest(scene, placements, archetypes);
    })
    .catch((err) => {
      console.error('EzForest: falling back to no EZ forest for this init', err);
    });
}

/** Append the EZ forest InstancedMeshes for the collected placements. Synchronous
 *  and deterministic given (placements, archetypes); all randomness is hash-based. */
function buildEzForest(scene: THREE.Scene, placements: EzPlacement[], archetypes: EzArchetype[]): void {
  if (archetypes.length === 0 || placements.length === 0) return;
  const sets = getEzMaterialSets(archetypes);
  const trunkPalette = getTrunkColors();
  const leafTints = getEzLeafTints();

  // Bucket placements per archetype: the species comes from a spatial hash (stable
  // stands), the detail level from the corridor-distance LOD split. When the
  // archetype list carries no far builds (defensive: an older/partial provider),
  // everything falls back to the near build of its species.
  const hasFarBuilds = archetypes.length >= EZ_SPECIES_COUNT * 2;
  const perArchetype: EzPlacement[][] = archetypes.map(() => []);
  placements.forEach((p) => {
    const species = hashPlacement(p.x, p.z, 1) % EZ_SPECIES_COUNT;
    const far = hasFarBuilds && ezDetailForPlacement(p.x, p.z) === 'far';
    perArchetype[species + (far ? EZ_SPECIES_COUNT : 0)]!.push(p);
  });

  const snowCapDescs: EzSnowDesc[] = [];
  const snowPatchDescs: EzSnowDesc[] = [];
  const scaleMat = new THREE.Matrix4();
  const fullMat = new THREE.Matrix4();
  const anchorPos = new THREE.Vector3();
  const snowQuat = new THREE.Quaternion();
  const snowEuler = new THREE.Euler();
  const snowScale = new THREE.Vector3();

  archetypes.forEach((a, i) => {
    const list = perArchetype[i]!;
    if (list.length === 0) return;
    const branches = new THREE.InstancedMesh(a.branches, sets[i]!.bark, list.length);
    branches.castShadow = true;
    branches.customDepthMaterial = getSwayDepthMaterial('rooted', { rootHeight: a.height });
    branches.name = 'forestInstanced';
    branches.userData.forestPart = 'ezBranches';
    branches.userData.ezArchetype = i;
    const leaves = new THREE.InstancedMesh(a.leaves, sets[i]!.leaves, list.length);
    leaves.castShadow = true;
    leaves.customDepthMaterial = getSwayDepthMaterial('flutter', {
      rootHeight: a.height, map: a.leafMap, alphaTest: 0.35
    });
    leaves.name = 'forestInstanced';
    leaves.userData.forestPart = 'ezLeaves';
    leaves.userData.ezArchetype = i;

    list.forEach((p, j) => {
      const s = (EZ_TREE_TARGET_HEIGHT * p.scale) / a.height;
      scaleMat.makeScale(s, s, s);
      fullMat.multiplyMatrices(p.matrix, scaleMat);
      branches.setMatrixAt(j, fullMat);
      leaves.setMatrixAt(j, fullMat);
      const h = hashPlacement(p.x, p.z, 2);
      branches.setColorAt(j, trunkPalette[h % TRUNK_WEATHERED_START]!);
      leaves.setColorAt(j, leafTints[(h >>> 4) % leafTints.length]!);

      // Snow: a cap on the crown tip plus, for NEAR trees only, settled shelves
      // draped on needle anchors — far trees keep just the cap (their shelves are
      // sub-pixel at corridor distance, so the instances would be pure cost).
      // Each instance records its height-rooted sway weight (anchor y / tree
      // height) so the snow leans exactly as far as the needles under it.
      anchorPos.set(0, a.height, 0).applyMatrix4(fullMat);
      const capR = 0.45 * p.scale;
      snowCapDescs.push({
        matrix: new THREE.Matrix4().compose(
          anchorPos, snowQuat.identity(), snowScale.set(capR, capR * 0.5, capR)),
        weight: 1 // crown tip: full canopy lean
      });
      if (a.detail === 'near') {
        const shelfCount = 4 + (h % 3);
        const stride = Math.max(1, Math.floor(a.snowAnchors.length / shelfCount));
        for (let k = (h >>> 6) % Math.max(1, stride), c = 0;
          k < a.snowAnchors.length && c < shelfCount; k += stride, c++) {
          const anchor = a.snowAnchors[k]!;
          anchorPos.set(anchor.x, anchor.y, anchor.z).applyMatrix4(fullMat);
          const outward = Math.atan2(anchor.x, anchor.z);
          // Flatter tilt band than the first cut: reads as settled load, not
          // wind-plastered daubs.
          const tilt = 0.24 + ((h >>> (8 + c)) % 16) / 55;
          snowQuat.setFromEuler(snowEuler.set(tilt * Math.sin(outward), 0, -tilt * Math.cos(outward)));
          const shelfR = (0.26 + ((h >>> (4 + c)) % 8) / 36) * p.scale;
          snowPatchDescs.push({
            matrix: new THREE.Matrix4().compose(
              anchorPos, snowQuat, snowScale.set(shelfR, shelfR * 0.35, shelfR)),
            weight: Math.min(1, Math.max(0, anchor.y / a.height))
          });
          snowQuat.identity();
        }
      }
    });
    branches.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (branches.instanceColor) branches.instanceColor.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    scene.add(branches);
    scene.add(leaves);
  });

  // Instanced snow on the EZ trees (like the stylized forest, snow-on-snow never
  // enters the real shadow map). The 'anchored' sway needs a per-instance
  // aSwayWeight attribute, and instanced attributes live on the GEOMETRY — so each
  // build clones the pooled snow geometry rather than mutating the shared buffer
  // the stylized forest also draws from. The clone is owned by its mesh
  // (userData.ownsGeometry) and disposed by the re-init sweep in addTrees.
  const snowDefs: Array<[THREE.BufferGeometry, EzSnowDesc[], string]> = [
    [getSnowCapGeometry(), snowCapDescs, 'ezSnowCap'],
    [getSnowPatchGeometry(), snowPatchDescs, 'ezSnowPatch']
  ];
  for (const [pooledGeometry, descs, part] of snowDefs) {
    if (descs.length === 0) continue;
    const geometry = pooledGeometry.clone();
    const weights = new Float32Array(descs.length);
    descs.forEach((d, j) => { weights[j] = d.weight; });
    geometry.setAttribute('aSwayWeight', new THREE.InstancedBufferAttribute(weights, 1));
    const im = new THREE.InstancedMesh(geometry, getEzSnowMaterial(), descs.length);
    im.castShadow = false;
    im.name = 'forestInstanced';
    im.userData.forestPart = part;
    im.userData.ownsGeometry = true;
    descs.forEach((d, j) => im.setMatrixAt(j, d.matrix));
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
  }
}

// --- Instanced forest: collectors + builder (the draw-call win, issue #...) ---
// Sharing a geometry/material does NOT merge draws — the old code still assembled
// every tree as a Group of ~14-35 individual Meshes, so a few-hundred-tree forest
// issued thousands of draw calls per frame (doubled by the shadow pass). The parts
// span a tiny shared pool of geometries/material families (bark/foliage/snow, varying
// just by base colour), so the whole forest collapses to a handful of InstancedMeshes
// with per-instance colour reproducing the palette. The avalanche
// boulders and ski tracks already use this pattern; the forest was the last holdout.
//
// `createTree` is now a *collector*: it records a transform (+ palette index) per part
// into per-geometry buckets instead of minting a Mesh. `addTrees` collects every tree
// into one shared set of buckets, then `buildForest` allocates the small InstancedMesh
// set. A thin Group-returning `createTree` shim (below) feeds one tree through the
// collector and rebuilds real Meshes from its bucket, preserving the public API for
// headless callers.

type GeomKey = 'trunk' | 'cone' | 'branch' | 'snowCap' | 'snowPatch';
const GEOM_KEYS: GeomKey[] = ['trunk', 'cone', 'branch', 'snowCap', 'snowPatch'];

/** One placed part: its world matrix and (for tinted families) a palette colour index. */
interface InstanceDesc {
  matrix: THREE.Matrix4;
  colorIndex?: number;
}
type Buckets = Record<GeomKey, InstanceDesc[]>;

function createBuckets(): Buckets {
  return { trunk: [], cone: [], branch: [], snowCap: [], snowPatch: [] };
}

// Scratch objects reused across pushPart calls (no per-part allocation churn).
const _identity = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a part's local TRS, premultiply by the tree's world matrix, record it. */
function pushPart(
  buckets: Buckets, key: GeomKey, treeMatrix: THREE.Matrix4,
  pos: { x: number; y: number; z: number },
  rot: { x: number; y: number; z: number },
  scl: { x: number; y: number; z: number },
  colorIndex?: number
): void {
  _q.setFromEuler(_e.set(rot.x, rot.y, rot.z));
  _local.compose(_p.set(pos.x, pos.y, pos.z), _q, _s.set(scl.x, scl.y, scl.z));
  _world.multiplyMatrices(treeMatrix, _local);
  buckets[key].push(colorIndex === undefined ? { matrix: _world.clone() } : { matrix: _world.clone(), colorIndex });
}

type TreeSpecies = 'fir' | 'spruce';

function pickTreeSpecies(): TreeSpecies {
  const r = Math.random();
  return r < 0.62 ? 'fir' : 'spruce';
}

function pickFoliageBaseIndex(species: TreeSpecies): number {
  const count = getFoliageColors().length;
  if (species === 'spruce') return FOLIAGE_DEEP_START + pickColorIndex(count - FOLIAGE_DEEP_START);
  return pickColorIndex(FOLIAGE_FROST_START - 2);
}

// Collect one tree's parts into the buckets. Species variety lives here: classic
// firs with broad lower boughs and narrow spruces with more stacked layers. This is
// visual only; collision uses the unchanged treePositions.
function collectTree(scale: number, treeMatrix: THREE.Matrix4, buckets: Buckets): void {
  const species = pickTreeSpecies();
  const heightScale = (0.8 + Math.random() * 0.4) * scale * (species === 'spruce' ? 1.15 : 1);
  const widthScale = (0.85 + Math.random() * 0.3) * scale * (species === 'spruce' ? 0.68 : 1);

  // Tree trunk — base at y=0 (so its centre is at trunkHeight/2), sized via scale.
  const trunkHeight = 4 * heightScale;
  const trunkWidth = widthScale;
  const trunkColorIndex = pickColorIndex(TRUNK_WEATHERED_START);
  pushPart(buckets, 'trunk', treeMatrix,
    { x: 0, y: trunkHeight / 2, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: trunkWidth, y: trunkHeight / 4, z: trunkWidth }, trunkColorIndex);

  const layerCount = species === 'spruce'
    ? 8 + Math.floor(Math.random() * 3)
    : 6 + Math.floor(Math.random() * 3);
  const foliageBase = trunkHeight * (species === 'spruce'
    ? 0.04 + Math.random() * 0.06
    : 0.16 + Math.random() * 0.08);
  const treeTop = trunkHeight + (species === 'spruce' ? 1.1 : 0.8) * heightScale;
  const taper = species === 'spruce' ? 0.80 : 0.72;
  const baseFoliageIndex = pickFoliageBaseIndex(species);
  const snowLoad = Math.random();

  let topLayerY = foliageBase;
  let topLayerScale = 1;
  for (let i = 0; i < layerCount; i++) {
    const t = layerCount > 1 ? i / (layerCount - 1) : 0;
    const layerScale = 1 - t * taper;
    const layerY = foliageBase + t * (treeTop - foliageBase);
    const coneWidth = widthScale * layerScale * (species === 'fir' ? 1.12 : 1.0);
    const coneScaleY = heightScale * layerScale * (species === 'spruce' ? 1.1 : 1.22);
    const coneRadius = 2.2 * coneWidth;

    const coneColorIndex = baseFoliageIndex;

    // Slight random tilt for natural look
    const xTilt = (Math.random() - 0.5) * 0.12;
    const zTilt = (Math.random() - 0.5) * 0.12;

    pushPart(buckets, 'cone', treeMatrix,
      { x: 0, y: layerY, z: 0 }, { x: xTilt, y: Math.random() * Math.PI * 2, z: zTilt },
      {
        x: coneWidth,
        y: coneScaleY,
        z: coneWidth
      },
      coneColorIndex);

    if (species === 'fir' && t < 0.7) {
      collectBranchesAtLayer(buckets, treeMatrix, layerY, coneRadius, coneColorIndex);
    }

    if (Math.random() < 0.25 + snowLoad * 0.45) {
      collectLayerSnow(buckets, treeMatrix, layerY, coneRadius, coneScaleY, widthScale);
    }

    topLayerY = layerY;
    topLayerScale = layerScale;
  }

  const tipY = topLayerY + 1.25 * heightScale * topLayerScale * (species === 'spruce' ? 1.1 : 1.22);
  const capRadius = widthScale * (species === 'spruce' ? 0.5 : 0.75);
  pushPart(buckets, 'snowCap', treeMatrix,
    { x: 0, y: tipY - capRadius * 0.25, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: capRadius, y: capRadius * 0.5, z: capRadius });
}

function collectLayerSnow(
  buckets: Buckets,
  treeMatrix: THREE.Matrix4,
  layerY: number,
  coneRadius: number,
  coneScaleY: number,
  widthScale: number
): void {
  const shelfCount = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < shelfCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const q = 0.4 + Math.random() * 0.3;
    const shelfRadius = widthScale * (0.3 + Math.random() * 0.25);
    const ySurface = layerY + 1.25 * coneScaleY * (1 - 2 * q);
    const tilt = 0.45 + Math.random() * 0.25;
    pushPart(buckets, 'snowPatch', treeMatrix, {
      x: Math.cos(angle) * coneRadius * q,
      y: ySurface - shelfRadius * 0.1,
      z: Math.sin(angle) * coneRadius * q
    }, { x: tilt * Math.sin(angle), y: 0, z: -tilt * Math.cos(angle) },
      { x: shelfRadius, y: shelfRadius * 0.35, z: shelfRadius });
  }
}

// Collect the branches sticking out of one cone layer. The cone sits at (0, coneY, 0)
// in tree space, so this matches the old addBranchesAtLayer math with conePosition.x/z
// fixed at 0 (the cone only ever had its y set).
function collectBranchesAtLayer(
  buckets: Buckets, treeMatrix: THREE.Matrix4, coneY: number, radius: number, colorIndex: number
): void {
  // Number of branches depends on radius
  const branchCount = Math.floor(3 + Math.random() * 3); // 3-5 visible branches

  for (let i = 0; i < branchCount; i++) {
    // Shared unit cylinder (pre-rotated along +X) sized via scale.
    const branchLength = radius * (0.7 + Math.random() * 0.5);
    const branchThickness = 0.1 + Math.random() * 0.1;

    // Position branch at random angle around cone
    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
    const height = Math.random() * 0.5 - 0.15; // Vertical position variation

    const rotX = (Math.random() - 0.5) * 0.3;
    const rotZ = -(0.08 + Math.random() * 0.3); // snow-laden boughs sag

    pushPart(buckets, 'branch', treeMatrix, {
      x: Math.cos(angle) * (radius * 0.5),
      y: coneY + height,
      z: Math.sin(angle) * (radius * 0.5)
    }, { x: rotX, y: angle, z: rotZ },
      { x: branchLength, y: branchThickness, z: branchThickness }, colorIndex);
  }
}

// Collect snow caps on top of the tree (shared snow geometry, no tint).
function collectSnowCaps(buckets: Buckets, treeMatrix: THREE.Matrix4, treeHeight: number, widthScale: number): void {
  // Add some snow on top
  const capRadius = widthScale * 0.8;
  pushPart(buckets, 'snowCap', treeMatrix,
    { x: 0, y: treeHeight + 0.2, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: capRadius, y: capRadius * 0.5, z: capRadius }); // flattened dome, as before

  // Maybe add snow on some branches
  if (Math.random() > 0.4) {
    const patchRadius = widthScale * 0.4;
    for (let i = 0; i < 2 + Math.random() * 3; i++) {
      // Random position on the tree
      const angle = Math.random() * Math.PI * 2;
      const radius = widthScale * (0.8 + Math.random() * 0.8);
      const height = 2 + Math.random() * (treeHeight - 3);

      pushPart(buckets, 'snowPatch', treeMatrix, {
        x: Math.cos(angle) * radius,
        y: height,
        z: Math.sin(angle) * radius
      }, { x: Math.random() * Math.PI / 4, y: 0, z: Math.random() * Math.PI / 4 },
        { x: patchRadius, y: patchRadius * 0.3, z: patchRadius });
    }
  }
}

/** The shared base geometry for a bucket key. */
function geometryForKey(key: GeomKey): THREE.BufferGeometry {
  switch (key) {
    case 'trunk': return getTrunkGeometry();
    case 'cone': return getConeGeometry();
    case 'branch': return getBranchGeometry();
    case 'snowCap': return getSnowCapGeometry();
    case 'snowPatch': return getSnowPatchGeometry();
  }
}

/** Rebuild a real Mesh from one collected part (for the Group-returning createTree shim). */
function meshFromDesc(key: GeomKey, desc: InstanceDesc): THREE.Mesh {
  let material: THREE.Material;
  if (key === 'trunk') material = getTrunkMaterials()[desc.colorIndex!]!;
  else if (key === 'cone' || key === 'branch') material = getFoliageMaterials()[desc.colorIndex!]!;
  else material = getSnowMaterial();
  const mesh = new THREE.Mesh(geometryForKey(key), material);
  mesh.applyMatrix4(desc.matrix); // decomposes the world TRS into position/quaternion/scale
  mesh.castShadow = true;
  return mesh;
}

// Group-returning shim — kept for API compatibility (contract-surface tests, any
// headless caller) and not used by the instanced `addTrees` path. Runs one tree
// through the collector at identity and rebuilds individual Meshes from its bucket,
// so the visible result matches the old per-mesh tree exactly.
function createTree(scale = 1.0): THREE.Group {
  const buckets = createBuckets();
  collectTree(scale, _identity, buckets);
  const group = new THREE.Group();
  for (const key of GEOM_KEYS) {
    for (const desc of buckets[key]) group.add(meshFromDesc(key, desc));
  }
  return group;
}

// Thin Object3D-emitting shims preserved on the Trees API (contract-surface tests).
// They delegate to the collectors and append the rebuilt Meshes to `parent`, matching
// the old addBranchesAtLayer/addSnowCaps signatures for any external caller.
function addBranchesAtLayer(parent: THREE.Object3D, conePosition: THREE.Vector3, radius: number, _material?: THREE.Material): void {
  const buckets = createBuckets();
  // Reproduce the old world placement: branches sat at conePosition (x/z preserved).
  collectBranchesAtLayer(buckets, new THREE.Matrix4().makeTranslation(conePosition.x, 0, conePosition.z), conePosition.y, radius, 0);
  for (const desc of buckets.branch) parent.add(meshFromDesc('branch', desc));
}

function addSnowCaps(tree: THREE.Object3D, treeHeight: number, widthScale: number): void {
  const buckets = createBuckets();
  collectSnowCaps(buckets, _identity, treeHeight, widthScale);
  for (const desc of buckets.snowCap) tree.add(meshFromDesc('snowCap', desc));
  for (const desc of buckets.snowPatch) tree.add(meshFromDesc('snowPatch', desc));
}

// Allocate the forest InstancedMeshes from the collected buckets and add them to the scene.
function buildForest(scene: THREE.Scene, buckets: Buckets): THREE.InstancedMesh[] {
  // The profile drives both visible sway and (when enabled) the matching depth
  // material; the final boolean controls whether this part participates in the
  // real shadow map.
  const defs: Array<[GeomKey, THREE.Material, THREE.Color[] | null, SwayProfile, boolean]> = [
    ['trunk', getBarkInstancedMaterial(), getTrunkColors(), 'rooted', true],
    ['cone', getFoliageInstancedMaterial(), getFoliageColors(), 'flutter', true],
    ['branch', getFoliageInstancedMaterial(), getFoliageColors(), 'flutter', true],
    // White snow sitting on white snow should not cast dark shadow-map pancakes:
    // trunks/canopy already carry the tree shadow, while these caps/collars remain
    // visible grounding detail and still sway with the canopy shader.
    ['snowCap', getSnowMaterial(), null, 'canopy', false],
    ['snowPatch', getSnowMaterial(), null, 'canopy', false]
  ];
  const built: THREE.InstancedMesh[] = [];
  for (const [key, material, palette, profile, castsShadow] of defs) {
    const list = buckets[key];
    if (list.length === 0) continue; // skip empty families (no zero-count draw)
    const im = new THREE.InstancedMesh(geometryForKey(key), material, list.length);
    im.castShadow = castsShadow;
    if (castsShadow) {
      // Shadow caster sways in lockstep with the visible mesh (shared wind uniforms).
      im.customDepthMaterial = getSwayDepthMaterial(profile);
    }
    im.name = 'forestInstanced';        // scene-cleanup + test handle
    im.userData.forestPart = key;       // lets tests identify the trunk mesh (1 per tree)
    for (let i = 0; i < list.length; i++) {
      im.setMatrixAt(i, list[i]!.matrix);
      if (palette && list[i]!.colorIndex !== undefined) im.setColorAt(i, palette[list[i]!.colorIndex!]!);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im);
    built.push(im);
  }
  return built;
}

// Half-width (world units) of the corridor's clear lane for tree placement — the same strip
// the grid check keeps clear, and wider than the 2.5u tree collision radius so the on-line
// route stays fully passable. Measured PERPENDICULAR to the line (see treeInCorridorLane).
const TREE_CORRIDOR_CLEAR = 3;

/** Is a tree at (x, z) inside the winding corridor's clear lane — i.e. within TREE_CORRIDOR_CLEAR
 *  of the line, measured PERPENDICULAR to the curve? On a steep turn the line runs diagonally, so
 *  a fixed horizontal band is thinner than it looks perpendicular to it: a tree `d` units to the
 *  side of the lane is only `d · |tangent.z|` from the actual path (`tangent.z` = 1/√(1+slope²),
 *  the line's -z component). Culling on that perpendicular distance keeps the on-line route clear
 *  even on sharp turns, where the naive horizontal `|x-lane|<3` left trees ~1.6u from the path —
 *  inside the 2.5u collision radius. Only ever true when a corridor line is active (Black); straight
 *  tiers have no line ⇒ always false ⇒ addTrees culls nothing and their layout + Math.random()
 *  sequence stay byte-identical. Pure + exported for the corridor-obstacles test. */
function treeInCorridorLane(x: number, z: number): boolean {
  const line = getActiveCourseLine();
  if (line === null) return false;
  return Math.abs(x - line.laneX(z)) * Math.abs(line.tangent(z).z) < TREE_CORRIDOR_CLEAR;
}

// Add trees to make the scene more interesting
function addTrees(scene: THREE.Scene): TreePosition[] {
  // Remove + dispose any previously-built instanced forest in THIS scene, to prevent
  // duplicates on re-init (the trees are InstancedMeshes named 'forestInstanced' now,
  // not Groups). The teardown is deliberately scene-LOCAL — scanning the passed scene's
  // own children rather than a module-global handle list — so that calling addTrees on
  // a second THREE.Scene never removes or disposes the forest still live in another
  // scene (each scene owns and clears its own forest, matching the old behaviour). The
  // shared geometries/materials are pooled and app-lifetime, so InstancedMesh.dispose()
  // — which frees only the per-forest instanceMatrix/instanceColor buffers — is the
  // right teardown.
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i]!;
    if (child.name === 'forestInstanced') {
      scene.remove(child);
      const im = child as THREE.InstancedMesh;
      // EZ snow meshes own a per-build geometry clone (it carries their
      // per-instance aSwayWeight attribute); everything else draws the shared
      // pooled geometry, which must NOT be disposed here.
      if (im.userData.ownsGeometry && im.geometry) im.geometry.dispose();
      im.dispose();
    }
  }

  const treePositions: TreePosition[] = [];

  // IMPORTANT: Log the ranges we're using to create trees for debugging
  console.log("Trees.addTrees: Creating trees in X range -100 to 100, Z range -180 to 80");
  
  // Add trees across the mountain - extended for longer run
  for(let z = -180; z < 80; z += 10) {
    // Lateral distance is measured from the run's centerline at this z (the winding
    // corridor for Black), so the clear lane + the density zones follow the line.
    // For straight tiers lane === 0, so every `x - lane` below is exactly `x`.
    const lane = activeLaneX(z);
    for(let x = -100; x < 100; x += 10) {
      // Special handling for center area (former ski path)
      // Keep very center (±3 units) clear for minimal navigation while adding more trees elsewhere
      if(Math.abs(x - lane) < 3) continue;

      // For the area that was previously the ski path (between 3-18 units from center),
      // add trees with increasing density from center
      // - Inner zone (3-8 units): Medium density (50% chance to skip)
      // - Middle zone (8-13 units): Higher density (30% chance to skip)
      // - Outer zone (13-18 units): Full density (10% chance to skip)
      if(Math.abs(x - lane) >= 3 && Math.abs(x - lane) < 8 && Math.random() < 0.5) continue;
      if(Math.abs(x - lane) >= 8 && Math.abs(x - lane) < 13 && Math.random() < 0.3) continue;
      if(Math.abs(x - lane) >= 13 && Math.abs(x - lane) < 18 && Math.random() < 0.1) continue;
      
      // Skip positions that would be too far from the actual terrain plane
      if (Math.abs(x) > 150 || Math.abs(z) > 200) continue;
      
      // Random offset with more natural clustering
      const xPos = x + (Math.random() * 5 - 2.5);
      const zPos = z + (Math.random() * 5 - 2.5);

      // For a winding corridor (Black), drop a tree the ±2.5 jitter pushed onto the on-line
      // route: the grid check at 3 units + jitter can land ~0.5u from the line, well inside the
      // 2.5u tree collision radius, making the intended clear lane randomly crashable. Re-checked
      // at the FINAL (jittered) x/z since the line's lane shifts with z. No-op for straight tiers
      // (no line ⇒ same draw sequence); the cluster branch below already re-checks its own final
      // position.
      if (treeInCorridorLane(xPos, zPos)) continue;

      // Only place trees on suitable slopes (not too steep)
      const y = getTerrainHeight(xPos, zPos);
      const gradient = getTerrainGradient(xPos, zPos);
      const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
      
      // Different tree density based on location and size variation by zone
      // Define zones from the centerline outward
      const innerZone = Math.abs(x - lane) >= 3 && Math.abs(x - lane) < 8;
      const middleZone = Math.abs(x - lane) >= 8 && Math.abs(x - lane) < 13;
      const outerZone = Math.abs(x - lane) >= 13 && Math.abs(x - lane) < 18;
      const centerArea = innerZone || middleZone || outerZone;
      
      // Adjust placement chance based on location, then bias it into the shared
      // forest stands so trees gather where the terrain shows its treeline tint and
      // thin out in the clearings between — instead of a uniform sprinkle. High
      // density lowers the skip chance (more trees); a floor keeps clearings from
      // ever going fully bare (extended terrain still gets trees). The field is the
      // same one the terrain uses for the ground tint, so trees and ground align.
      const forest = forestDensityField(xPos, zPos);
      const standBias = (forest - 0.5) * 0.5; // ±0.25 around the base chance
      const baseChance = centerArea ? 0.65 : 0.7; // higher chance in center area
      const treeChance = Math.min(0.92, Math.max(0.45, baseChance - standBias));

      if(steepness < 0.5 && Math.random() > treeChance) {
        // Size variation by zone - smaller trees closer to the center path
        let sizeVariation = 1.0;
        if (innerZone) sizeVariation = 0.7;  // Very small trees in inner zone
        else if (middleZone) sizeVariation = 0.8; // Smaller trees in middle zone
        else if (outerZone) sizeVariation = 0.9; // Slightly smaller trees in outer zone
        treePositions.push({x: xPos, y: y, z: zPos, scale: sizeVariation});
        
        // 25% chance to add a clustered tree nearby for more natural grouping
        if(Math.random() < 0.25) {
          const clusterX = xPos + (Math.random() * 4 - 2);
          const clusterZ = zPos + (Math.random() * 4 - 2);
          
          // For clustered trees, use the same criteria but add even more trees in center area.
          // Keep the on-line lane clear: the horizontal `>= 3` preserves the straight-tier center
          // strip byte-for-byte (laneC ≡ 0, treeInCorridorLane ≡ false), while the perpendicular
          // treeInCorridorLane drops a cluster that lands within the clear lane on a steep Black
          // turn (where >= 3 horizontal can still be ~1.5u perpendicular — inside the collision
          // radius). For a live line `!treeInCorridorLane` already implies `>= 3` horizontal.
          const laneC = activeLaneX(clusterZ);
          if(Math.abs(clusterX - laneC) >= 3 && !treeInCorridorLane(clusterX, clusterZ)) {
            const clusterY = getTerrainHeight(clusterX, clusterZ);

            // Determine which zone the cluster tree falls in
            const clusterInnerZone = Math.abs(clusterX - laneC) >= 3 && Math.abs(clusterX - laneC) < 8;
            const clusterMiddleZone = Math.abs(clusterX - laneC) >= 8 && Math.abs(clusterX - laneC) < 13;
            const clusterOuterZone = Math.abs(clusterX - laneC) >= 13 && Math.abs(clusterX - laneC) < 18;
            
            // Adjust size based on zone for clustered trees too
            let clusterSizeVariation = sizeVariation; // Default to parent tree size
            
            // Further randomize cluster tree sizes for natural variation
            if (clusterInnerZone) clusterSizeVariation = 0.7 * (0.9 + Math.random() * 0.2);
            else if (clusterMiddleZone) clusterSizeVariation = 0.8 * (0.9 + Math.random() * 0.2);
            else if (clusterOuterZone) clusterSizeVariation = 0.9 * (0.9 + Math.random() * 0.2);
            
            treePositions.push({x: clusterX, y: clusterY, z: clusterZ, scale: clusterSizeVariation});
          }
        }
      }
    }
  }
  
  // Add additional trees specifically in the former ski path area with variable density
  // This creates a more natural backcountry feel with randomly placed trees
  const additionalTrees = 60; // Add 60 more trees in the center area
  
  for (let i = 0; i < additionalTrees; i++) {
    // Position trees in the former ski path area with random placement
    // Each tree has a random position within the ski path width
    const zoneChoice = Math.random();
    let sizeVar;

    if (zoneChoice < 0.2) {
      // 20% in inner zone (3-8 units from center) - smallest trees
      const side = Math.random() < 0.5 ? 1 : -1; // Randomly choose side
      const x = (3 + Math.random() * 5) * side; // 3-8 units from center
      sizeVar = 0.6 + Math.random() * 0.2; // 0.6-0.8 scale (very small)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      // Place relative to the run's centerline at this z (0 for straight tiers ⇒ x unchanged).
      const xPos = x + activeLaneX(z);
      // Drop it if the offset landed inside the on-line clear lane (measured perpendicular to the
      // curve): on steep Black turns the inner band can otherwise sit within the tree collision
      // radius of the path. No-op for straight tiers (no line) ⇒ byte-identical placement.
      if (treeInCorridorLane(xPos, z)) continue;
      const y = getTerrainHeight(xPos, z);

      treePositions.push({x: xPos, y: y, z: z, scale: sizeVar});
    }
    else if (zoneChoice < 0.5) {
      // 30% in middle zone (8-13 units from center) - small trees
      const side = Math.random() < 0.5 ? 1 : -1;
      const x = (8 + Math.random() * 5) * side; // 8-13 units from center
      sizeVar = 0.7 + Math.random() * 0.2; // 0.7-0.9 scale (small)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      // Place relative to the run's centerline at this z (0 for straight tiers ⇒ x unchanged).
      const xPos = x + activeLaneX(z);
      // Drop it if the offset landed inside the on-line clear lane (measured perpendicular to the
      // curve): on steep Black turns the inner band can otherwise sit within the tree collision
      // radius of the path. No-op for straight tiers (no line) ⇒ byte-identical placement.
      if (treeInCorridorLane(xPos, z)) continue;
      const y = getTerrainHeight(xPos, z);

      treePositions.push({x: xPos, y: y, z: z, scale: sizeVar});
    }
    else {
      // 50% in outer zone (13-18 units from center) - medium trees
      const side = Math.random() < 0.5 ? 1 : -1;
      const x = (13 + Math.random() * 5) * side; // 13-18 units from center
      sizeVar = 0.8 + Math.random() * 0.15; // 0.8-0.95 scale (medium)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      // Place relative to the run's centerline at this z (0 for straight tiers ⇒ x unchanged).
      const xPos = x + activeLaneX(z);
      // Drop it if the offset landed inside the on-line clear lane (measured perpendicular to the
      // curve): on steep Black turns the inner band can otherwise sit within the tree collision
      // radius of the path. No-op for straight tiers (no line) ⇒ byte-identical placement.
      if (treeInCorridorLane(xPos, z)) continue;
      const y = getTerrainHeight(xPos, z);

      treePositions.push({x: xPos, y: y, z: z, scale: sizeVar});
    }
  }
  
  // Log the tree positions array size
  console.log(`Trees.addTrees: Created ${treePositions.length} tree positions for collision detection`);
  
  // Check if we have any trees in the extended terrain (z < -80)
  const extendedTrees = treePositions.filter(tree => tree.z < -80).length;
  console.log(`Trees.addTrees: ${extendedTrees} trees in extended terrain area (z < -80)`);
  
  // Collect every tree's parts into shared per-geometry buckets, then allocate the
  // InstancedMeshes once — the whole forest becomes a small set of colour + shadow
  // draws even with species variety.
  // (Tree height comes from the analytic terrain sampler below; the old
  // Raycaster/terrain-mesh lookup here was dead code and has been removed.)
  //
  // Grounding mirrors the improved rocks: each tree sinks deeper into steeper terrain,
  // gets a random yaw + slight lean, and receives a low snow collar tilted to the local
  // slope. This is visual only — collision still uses treePositions.
  const buckets = createBuckets();
  const treeEuler = new THREE.Euler();
  const collarMatrix = new THREE.Matrix4();
  const treeMatrix = new THREE.Matrix4();
  // EZ evergreen prototype (issue #282): when the flag is on, the per-tree placement
  // matrix feeds the async archetype build instead of the stylized collector; snow
  // collars still ground every tree either way. Flag OFF leaves this loop's RNG
  // draw sequence and buckets byte-identical to before.
  const ezOn = isEzForestEnabled();
  const ezPlacements: EzPlacement[] = [];
  treePositions.forEach(pos => {
    const terrainHeight = getTerrainHeight(pos.x, pos.z);
    const gradient = getTerrainGradient(pos.x, pos.z);
    const steepness = Math.hypot(gradient.x, gradient.z);
    const sink = 0.5 + Math.min(0.7, steepness * 0.9);
    const treeScale = pos.scale || 1.0;
    const yaw = Math.random() * Math.PI * 2;
    const leanX = (Math.random() - 0.5) * 0.07;
    const leanZ = (Math.random() - 0.5) * 0.07;

    treeMatrix
      .makeTranslation(pos.x, terrainHeight - sink, pos.z)
      .multiply(new THREE.Matrix4().makeRotationFromEuler(treeEuler.set(leanX, yaw, leanZ)));
    if (ezOn) {
      ezPlacements.push({ matrix: treeMatrix.clone(), scale: treeScale, x: pos.x, z: pos.z });
    } else {
      collectTree(treeScale, treeMatrix, buckets);
    }

    const collarRadius = treeScale * (1.0 + Math.random() * 0.5);
    collarMatrix.makeTranslation(pos.x, terrainHeight - 0.05, pos.z);
    pushPart(buckets, 'snowPatch', collarMatrix,
      { x: 0, y: 0, z: 0 },
      { x: Math.atan(gradient.z) * 0.8, y: 0, z: -Math.atan(gradient.x) * 0.8 },
      { x: collarRadius, y: collarRadius * 0.25, z: collarRadius });
  });
  buildForest(scene, buckets);
  if (ezOn) scheduleEzForest(scene, ezPlacements);

  return treePositions;
}

// Helper function to read the terrain height from the shared sampler.
function getTerrainHeight(x: number, z: number): number {
  return sampleTerrainHeight(x, z);
}

// Helper function to read the terrain gradient from the shared sampler.
function getTerrainGradient(x: number, z: number): TerrainGradient {
  return sampleTerrainGradient(x, z);
}

// --- Pool teardown (dispose / dev-HMR; see src/game/teardown.ts) ---
// The shared geometry/material/normal-map singletons above are built lazily and
// reused for the page's life — fine while the page IS the game. The teardown path
// (`disposeGame`) and Vite dev-HMR need to release them so a later rebuild (a fresh
// `setupScene`, an unmount/remount, the forest re-init) re-creates them cleanly
// instead of dangling as freed-but-still-referenced handles. This disposes every
// pooled GPU resource this module owns and nulls the caches so the `get*()` lazy
// builders re-allocate on the next `addTrees`.
//
// Most of these are ALSO reachable from the scene graph (the instanced geometries +
// instanced bark/foliage materials are attached to the 'forestInstanced' meshes, so
// the scene sweep in teardown.ts disposes them too); THREE's `dispose()` is
// safe to call twice. The legacy per-shade palette materials (`trunkMaterials` /
// `foliageMaterials`, kept only for the Group-returning `createTree` shim) are NOT
// attached to the scene, so disposing them here is the only place they're freed.
export function resetTreePools(): void {
  const free = (r: { dispose?: () => void } | null | undefined): void => {
    if (r && typeof r.dispose === 'function') r.dispose();
  };
  free(trunkGeometry);
  free(coneGeometry);
  free(branchGeometry);
  free(snowCapGeometry);
  free(snowPatchGeometry);
  free(snowMaterial);
  free(barkInstancedMaterial);
  free(foliageInstancedMaterial);
  Object.keys(swayDepthMaterials).forEach(k => {
    free(swayDepthMaterials[k]);
    delete swayDepthMaterials[k];
  });
  (ezMaterialSets || []).forEach(set => { free(set.bark); free(set.leaves); });
  ezMaterialSets = null;
  ezLeafTints = null;
  free(ezSnowMaterial);
  ezSnowMaterial = null;
  resetEzForest();
  (trunkMaterials || []).forEach(free);
  (foliageMaterials || []).forEach(free);
  free(barkNormalTexture);
  free(barkAlbedoTexture);
  free(foliageNormalTexture);

  trunkGeometry = coneGeometry = branchGeometry = snowCapGeometry = snowPatchGeometry = null;
  trunkColors = foliageColors = null;
  trunkMaterials = foliageMaterials = null;
  snowMaterial = barkInstancedMaterial = foliageInstancedMaterial = null;
  barkNormalTexture = barkAlbedoTexture = foliageNormalTexture = null;
}

// Export all tree-related functions
export const Trees = {
  createTree,
  addBranchesAtLayer,
  addSnowCaps,
  addTrees,
  getTerrainHeight,
  getTerrainGradient,
  resetTreePools,
  treeInCorridorLane,
  updateWind,
  resetWind,
  treeSwayAmplitude,
  // EZ evergreen prototype seams (issue #282): flag control + build-completion
  // promise (the archetype chunk loads lazily, so tests/tools await this).
  setEzForestEnabled,
  isEzForestEnabled,
  ezForestReady,
  ezDetailForPlacement
};

// Trees is imported directly by snow.js and mountains.js (issue #84).
