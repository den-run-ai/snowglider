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

/** Vertical bark ridges (relief varies around the trunk, runs up it). */
function getBarkNormal(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (!barkNormalTexture) {
    barkNormalTexture = buildNormalTexture(128, 2.5, (u) => {
      let s = 0.5 * Math.sin(2 * Math.PI * 8 * u);
      s += 0.3 * Math.sin(2 * Math.PI * 17 * u + 1.3);
      s += 0.2 * Math.sin(2 * Math.PI * 31 * u + 0.7);
      return s;
    });
    barkNormalTexture.repeat.set(1, 3); // wrap once around, repeat up the trunk
  }
  return barkNormalTexture;
}

/** Isotropic dapple = needle clumps on the foliage cones. */
function getFoliageNormal(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (!foliageNormalTexture) {
    foliageNormalTexture = buildNormalTexture(128, 2.0, (u, v) => {
      let h = 0.5 * Math.sin(2 * Math.PI * (6 * u + 4 * v) + 0.5);
      h += 0.35 * Math.sin(2 * Math.PI * (11 * u - 9 * v) + 1.9);
      h += 0.25 * Math.sin(2 * Math.PI * 19 * u) * Math.sin(2 * Math.PI * 17 * v);
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

/** Canonical trunk: top/bottom radius + height match the old defaults at scale 1. */
function getTrunkGeometry(): THREE.CylinderGeometry {
  if (!trunkGeometry) trunkGeometry = new THREE.CylinderGeometry(0.4, 0.6, 4, 8);
  return trunkGeometry;
}

/** Canonical foliage cone (radius 2.2, height 2.5); resized per layer via scale. */
function getConeGeometry(): THREE.ConeGeometry {
  if (!coneGeometry) coneGeometry = new THREE.ConeGeometry(2.2, 2.5, 8);
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

/** Small palette of brown bark shades (the old per-trunk HSL range, quantised). */
function getTrunkColors(): THREE.Color[] {
  if (!trunkColors) {
    const count = 6;
    trunkColors = [];
    for (let i = 0; i < count; i++) {
      const hue = 0.08 + (i / (count - 1)) * 0.04; // 0.08-0.12, as before
      trunkColors.push(new THREE.Color().setHSL(hue, 0.5, 0.3));
    }
  }
  return trunkColors;
}

/** Small palette of green foliage shades spanning the old per-cone HSL ranges. */
function getFoliageColors(): THREE.Color[] {
  if (!foliageColors) {
    const count = 12;
    foliageColors = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const hue = 0.35 + t * 0.07;                 // 0.35-0.42, as before
      const saturation = 0.6 + ((i * 7) % count) / count * 0.3; // spread across 0.6-0.9
      const lightness = 0.2 + ((i * 5) % count) / count * 0.1;  // spread across 0.2-0.3
      foliageColors.push(new THREE.Color().setHSL(hue, saturation, lightness));
    }
  }
  return foliageColors;
}

/** Legacy per-shade bark materials (Group shim / API compat); built from the palette. */
function getTrunkMaterials(): THREE.MeshStandardMaterial[] {
  if (!trunkMaterials) {
    const normalMap = getBarkNormal();
    trunkMaterials = getTrunkColors().map(color => new THREE.MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.9,
      normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7)
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
      normalScale: new THREE.Vector2(0.5, 0.5)
    }));
  }
  return foliageMaterials;
}

/** The single shared white snow material (every cap/patch is identical, no instanceColor). */
function getSnowMaterial(): THREE.MeshStandardMaterial {
  if (!snowMaterial) {
    snowMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    applyTreeSway(snowMaterial, false); // snow caps ride the canopy sway (USE_INSTANCING-gated)
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
// Two sway profiles keep trees looking rooted without needing any per-instance data
// (which would have to live on the *shared* pooled geometry and break its one-forest
// assumption): the TRUNK material is "rooted" — the bend is weighted 0 at the trunk base
// and 1 at its top, so the tree pivots at the ground — while the FOLIAGE/SNOW canopy
// above it sways as a unit at the same top-of-trunk amplitude, so the join stays
// continuous. A spatial phase from each vertex's world x/z desyncs neighbouring trees so
// the stand doesn't wave in lockstep. One shared uniform set drives every material.
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
// world x/z. Rooted (trunk) vs. uniform (canopy) is selected by `TREE_SWAY_ROOTED`, which
// only the bark material defines. Pinned to the stock chunk; if a three upgrade rewrites
// `<project_vertex>` this replace must be revisited (docs/THREEJS_UPGRADE.md).
const TREE_SWAY_PROJECT_VERTEX = `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  {
    #ifdef TREE_SWAY_ROOTED
      float swayWeight = clamp( ( position.y + TREE_TRUNK_HALF ) / ( 2.0 * TREE_TRUNK_HALF ), 0.0, 1.0 );
    #else
      float swayWeight = 1.0;
    #endif
    float swayPhase = dot( mvPosition.xz, vec2( 0.35, 0.27 ) );
    float swayOsc = sin( uWindSwayTime * TREE_SWAY_RATE + swayPhase )
                  + 0.3 * sin( uWindSwayTime * TREE_SWAY_RATE * 2.1 + swayPhase * 1.7 );
    float lean = uWindAmp * swayWeight * ( 0.75 + 0.25 * swayOsc );
    mvPosition.x += uWindDir.x * lean;
    mvPosition.z += uWindDir.y * lean;
  }
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

/** Inject the wind vertex sway into a tree material's shader. `rooted` selects the trunk
 *  profile (bend planted at the base). Guarded by USE_INSTANCING so the non-instanced
 *  Group-shim path (createTree) is untouched, and it wires the SHARED uniform objects so a
 *  single updateTreeWind() drives every tree material at once. */
function applyTreeSway(material: THREE.Material, rooted: boolean): void {
  const head = rooted ? `${TREE_SWAY_HEAD_BASE}\n  #define TREE_SWAY_ROOTED` : TREE_SWAY_HEAD_BASE;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindDir = treeWindUniforms.uWindDir;
    shader.uniforms.uWindAmp = treeWindUniforms.uWindAmp;
    shader.uniforms.uWindSwayTime = treeWindUniforms.uWindSwayTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', head)
      .replace('#include <project_vertex>', TREE_SWAY_PROJECT_VERTEX);
  };
  // onBeforeCompile edits are not part of three's default program cache key; a stable key
  // (varied by profile) keeps the swayed program from colliding with an unswayed build.
  material.customProgramCacheKey = () => (rooted ? 'tree-wind-sway-rooted-v1' : 'tree-wind-sway-v1');
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
  treeWindUniforms.uWindAmp.value =
    TREE_SWAY_MIN_AMP + (TREE_SWAY_MAX_AMP - TREE_SWAY_MIN_AMP) * Wind.strength();
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
      normalMap: getBarkNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7)
    });
    applyTreeSway(barkInstancedMaterial, true); // rooted: bend planted at the trunk base
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
      normalScale: new THREE.Vector2(0.5, 0.5)
    });
    applyTreeSway(foliageInstancedMaterial, false); // canopy sways as a unit
  }
  return foliageInstancedMaterial;
}

/** Pick a random palette index (forest colour variety); one RNG draw, as before. */
function pickColorIndex(paletteLength: number): number {
  return Math.floor(Math.random() * paletteLength);
}

// --- Instanced forest: collectors + builder (the draw-call win, issue #...) ---
// Sharing a geometry/material does NOT merge draws — the old code still assembled
// every tree as a Group of ~14-35 individual Meshes, so a few-hundred-tree forest
// issued thousands of draw calls per frame (doubled by the shadow pass). The parts
// only span 5 geometries and 3 material families (bark/foliage/snow, varying just by
// base colour), so the whole forest collapses to 5 InstancedMeshes — ~5 colour + ~5
// shadow draws total — with per-instance colour reproducing the palette. The avalanche
// boulders and ski tracks already use this pattern; the forest was the last holdout.
//
// `createTree` is now a *collector*: it runs the SAME randomisation in the SAME order
// (byte-identical RNG draws) but records a transform (+ palette index) per part into
// per-geometry buckets instead of minting a Mesh. `addTrees` collects every tree into
// one shared set of buckets, then `buildForest` allocates the 5 InstancedMeshes. A thin
// Group-returning `createTree` shim (below) feeds one tree through the collector and
// rebuilds real Meshes from its bucket, preserving the public API for headless callers.

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

// Collect one tree's parts into the buckets, translated by `treeMatrix`. This is the
// original createTree body verbatim — same heightScale/widthScale/branchDensity draws,
// same per-cone tilt — with each `new THREE.Mesh(...)` replaced by a pushPart(...).
function collectTree(scale: number, treeMatrix: THREE.Matrix4, buckets: Buckets): void {
  // Add randomization factors for variety
  const heightScale = (0.8 + Math.random() * 0.4) * scale; // 0.8-1.2 height variation with scaling
  const widthScale = (0.85 + Math.random() * 0.3) * scale; // 0.85-1.15 width variation with scaling
  const branchDensity = 3 + Math.floor(Math.random() * 3); // 3-5 branch layers

  // Tree trunk — base at y=0 (so its centre is at trunkHeight/2), sized via scale.
  const trunkHeight = 4 * heightScale;
  const trunkColorIndex = pickColorIndex(getTrunkColors().length);
  pushPart(buckets, 'trunk', treeMatrix,
    { x: 0, y: trunkHeight / 2, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: widthScale, y: heightScale, z: widthScale }, trunkColorIndex);

  // Create multiple branch layers
  const baseHeight = trunkHeight;
  let layerHeight = baseHeight;

  for (let i = 0; i < branchDensity; i++) {
    // Larger at bottom, smaller at top
    const layerScale = 1 - (i / branchDensity) * 0.7;
    const coneHeight = 2.5 * heightScale * layerScale;
    const coneRadius = 2.2 * widthScale * layerScale;

    // One foliage shade from the palette (branches inherit the same index).
    const coneColorIndex = pickColorIndex(getFoliageColors().length);

    // Slight random tilt for natural look
    const xTilt = (Math.random() - 0.5) * 0.1;
    const zTilt = (Math.random() - 0.5) * 0.1;

    // Position branches with overlap
    layerHeight += coneHeight * 0.6;
    pushPart(buckets, 'cone', treeMatrix,
      { x: 0, y: layerHeight, z: 0 }, { x: xTilt, y: 0, z: zTilt },
      { x: widthScale * layerScale, y: heightScale * layerScale, z: widthScale * layerScale },
      coneColorIndex);

    // Add visible branches coming out of each cone layer
    collectBranchesAtLayer(buckets, treeMatrix, layerHeight, coneRadius, coneColorIndex);
  }

  // Add some snow on the branches for winter effect
  collectSnowCaps(buckets, treeMatrix, layerHeight, widthScale);
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
    const height = Math.random() * 0.5; // Vertical position variation

    const rotX = (Math.random() - 0.5) * 0.3;
    const rotZ = (Math.random() - 0.5) * 0.1;

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

// Allocate the 5 InstancedMeshes from the collected buckets and add them to the scene.
function buildForest(scene: THREE.Scene, buckets: Buckets): THREE.InstancedMesh[] {
  const defs: Array<[GeomKey, THREE.Material, THREE.Color[] | null]> = [
    ['trunk', getBarkInstancedMaterial(), getTrunkColors()],
    ['cone', getFoliageInstancedMaterial(), getFoliageColors()],
    ['branch', getFoliageInstancedMaterial(), getFoliageColors()],
    ['snowCap', getSnowMaterial(), null],
    ['snowPatch', getSnowMaterial(), null]
  ];
  const built: THREE.InstancedMesh[] = [];
  for (const [key, material, palette] of defs) {
    const list = buckets[key];
    if (list.length === 0) continue; // skip empty families (no zero-count draw)
    const im = new THREE.InstancedMesh(geometryForKey(key), material, list.length);
    im.castShadow = true;
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
      (child as THREE.InstancedMesh).dispose();
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
  // InstancedMeshes once — the whole forest becomes ~5 colour + ~5 shadow draws.
  // (Tree height comes from the analytic terrain sampler below; the old
  // Raycaster/terrain-mesh lookup here was dead code and has been removed.) Each tree's
  // world matrix is a pure translation: the group only ever got .position.set(...), and
  // trees are sunk 0.5 units into the terrain to anchor them.
  const buckets = createBuckets();
  treePositions.forEach(pos => {
    const terrainHeight = getTerrainHeight(pos.x, pos.z);
    const treeScale = pos.scale || 1.0;
    collectTree(treeScale, new THREE.Matrix4().makeTranslation(pos.x, terrainHeight - 0.5, pos.z), buckets);
  });
  buildForest(scene, buckets);

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
  (trunkMaterials || []).forEach(free);
  (foliageMaterials || []).forEach(free);
  free(barkNormalTexture);
  free(foliageNormalTexture);

  trunkGeometry = coneGeometry = branchGeometry = snowCapGeometry = snowPatchGeometry = null;
  trunkColors = foliageColors = null;
  trunkMaterials = foliageMaterials = null;
  snowMaterial = barkInstancedMaterial = foliageInstancedMaterial = null;
  barkNormalTexture = foliageNormalTexture = null;
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
  resetWind
};

// Trees is imported directly by snow.js and mountains.js (issue #84).