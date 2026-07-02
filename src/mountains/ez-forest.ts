// mountains/ez-forest.ts — EZ-Tree conifer archetypes for the instanced forest (issue #282).
//
// This module generates a small set of low-poly evergreen "archetypes" with
// @dgreenheck/ez-tree (MIT) — one merged branch geometry + one needle-card geometry
// per species and LOD — that trees.ts renders through the existing InstancedMesh /
// palette-tint / wind-sway pipeline. It is a geometry PROVIDER only: materials,
// sway shaders, snow and placement all stay in trees.ts, and collision still reads
// the unchanged treePositions. DEFAULT ON for players (PR 3); automation and
// headless runs keep the stylized forest unless they opt in — see the flag section
// below. `?classictrees` restores the stylized look.
//
// Why the loading looks the way it does:
//   - The published ez-tree build eagerly loads its bark/needle textures (base64
//     data URIs) with THREE.TextureLoader AT IMPORT TIME, which both crashes
//     headless Node (`document is not defined`) and weighs ~4 MB. So the package is
//     loaded via a LAZY dynamic import — the chunk is only ever fetched when the
//     flag is on — and headless runs install a tiny document shim around the import
//     (TextureLoader only needs createElementNS to mint <img> stubs; the textures
//     simply never resolve, which geometry generation doesn't care about).
//   - `Tree.generate()` mints THREE meshes/materials whose uuid draws consume
//     Math.random (~16 draws). The verification harnesses baseline seeded
//     Math.random streams, so generation runs with Math.random swapped to a private
//     xorshift (same pattern as trees.ts getSwayDepthMaterial) — archetype
//     generation is RNG-stream-neutral. The swap is held ONLY across the
//     synchronous generate calls, never across the chunk-fetch await (concurrent
//     game code must keep the real Math.random); the package's one-time
//     import-eval uuid draws read the ambient RNG, which no seeded harness ever
//     observes because the flag is off headless. Tree shape itself uses ez-tree's
//     own seeded RNG, so archetypes are deterministic per seed.
import * as THREE from 'three';

/** One generated evergreen archetype, ready for InstancedMesh rendering. */
export interface EzArchetype {
  /** Merged trunk+branch tube geometry (local units, base at y=0). */
  branches: THREE.BufferGeometry;
  /** Needle-card quad geometry (billboard doubles baked at generation time). */
  leaves: THREE.BufferGeometry;
  /** ez-tree's pine needle sprite (alpha card); null when generated headless. */
  leafMap: THREE.Texture | null;
  /** Local-space height of the branch geometry (for scaling + sway rooting). */
  height: number;
  /** Local-space points on the canopy where snow shelves sit (top-biased). */
  snowAnchors: Array<{ x: number; y: number; z: number }>;
  /** Which species recipe (0..EZ_SPECIES_COUNT-1) this build came from. */
  species: number;
  /** Detail level: 'near' full build or the cheaper 'far' off-piste build. */
  detail: EzDetail;
}

// --- Enable flag (issue #282, PR 3: ON by default for players) --------------------
// The EZ evergreens are now the shipped default, but ONLY for a real player:
// automation (`window.isTestMode` / `navigator.webdriver`) and headless Node keep
// the stylized forest, mirroring the debris/intro/sfx gating precedent, so every
// existing test surface — browser suites, e2e specs, seeded physics harnesses whose
// Math.random streams the stylized collectTree draws are part of — stays
// byte-identical unless a test opts in explicitly (setEzForestEnabled / ?eztrees=1).
// Players can opt back to the stylized forest with `?classictrees` (or ?eztrees=0).
let ezForestOverride: boolean | null = null;

/** Force the flag on/off (tests, console experiments). `null` restores URL control. */
export function setEzForestEnabled(on: boolean | null): void {
  ezForestOverride = on;
}

/** Pure precedence resolution (exported for the headless test):
 *  override > URL opt-out > URL opt-in > automation gate > player default ON. */
export function resolveEzForestEnabled(search: string, automated: boolean, override: boolean | null): boolean {
  if (override !== null) return override;
  if (/[?&]eztrees=(?:0|off|false)(?:[&]|$)/.test(search) || /[?&]classictrees(?:[=&]|$)/.test(search)) return false;
  if (/[?&]eztrees(?:[=&]|$)/.test(search)) return true;
  return !automated;
}

/** Is the EZ-Tree evergreen forest enabled for this run? */
export function isEzForestEnabled(): boolean {
  // Headless/stubbed runs stay stylized unless a test opts in via
  // setEzForestEnabled — the seeded verification harnesses' RNG streams must not
  // shift. "Headless" means anything short of a real browser: no window, a
  // window-stub without location or a DOM (the physics harnesses stub `window`
  // but not `document`), a jsdom document (the DOM smoke test), or Node's own
  // built-in navigator (Node 21+ exposes a global `navigator` whose userAgent is
  // "Node.js/..." — a jsdom harness that wires window/document but not navigator
  // would otherwise read as a real browser). Prefer window.navigator so a
  // harness-supplied navigator wins over Node's global.
  const nav: Navigator | undefined =
    (typeof window !== 'undefined' && window.navigator) ||
    (typeof navigator !== 'undefined' ? navigator : undefined) || undefined;
  const headless = typeof window === 'undefined' || !window.location ||
    typeof document === 'undefined' || !nav ||
    !nav.userAgent || /jsdom|node\.js/i.test(nav.userAgent);
  if (headless) return ezForestOverride ?? false;
  // Besides the published flag and webdriver, read the `?test=` marker straight
  // from the URL (the same predicate scene-setup.ts uses to SET window.isTestMode):
  // the first addTrees of a page load runs during setupScene, and this gate must
  // not depend on being called after that assignment.
  const automated = !!window.isTestMode || !!nav.webdriver ||
    window.location.search.includes('test');
  return resolveEzForestEnabled(window.location.search, automated, ezForestOverride);
}

// --- Private RNG (uuid-neutrality during generate; see header) --------------------
let ezUuidRngState = 0x9e3779b9;
function ezUuidRandom(): number {
  ezUuidRngState ^= ezUuidRngState << 13;
  ezUuidRngState ^= ezUuidRngState >>> 17;
  ezUuidRngState ^= ezUuidRngState << 5;
  return (ezUuidRngState >>> 0) / 0x100000000;
}

// --- Archetype recipes -------------------------------------------------------------
// Three pine species tuned WAY down from the ez-tree presets (~19k tris each at
// stock settings) to an instancing-friendly budget: fewer child branches, coarser
// tube segments/sections, fewer-but-larger needle cards. Kept under
// EZ_ARCHETYPE_TRIANGLE_BUDGET (asserted by tests) so a few hundred instances stay
// within the perf envelope of the stylized forest they replace.
//
// Each species is generated at TWO detail levels (issue #282, PR 2): a full "near"
// build for trees around the run corridor and a cheaper "far" build (fewer branches,
// coarser tubes, fewer-but-bigger cards from the SAME seed, so the species keeps its
// silhouette) for the off-piste stands the chase camera only ever sees at distance.
// The far build must stay under EZ_FAR_TRIANGLE_FRACTION of its near counterpart
// (asserted by tests) so the forest-wide raster cost stays near the stylized budget.
export const EZ_ARCHETYPE_TRIANGLE_BUDGET = 4500;
export const EZ_FAR_TRIANGLE_FRACTION = 0.6;
export type EzDetail = 'near' | 'far';

interface EzRecipe {
  preset: string;
  seed: number;
  children0: number;
  leavesCount: number;
  leavesSizeMul: number;
}

const EZ_RECIPES: EzRecipe[] = [
  { preset: 'Pine Small', seed: 11, children0: 30, leavesCount: 17, leavesSizeMul: 1.8 },
  { preset: 'Pine Medium', seed: 23, children0: 34, leavesCount: 17, leavesSizeMul: 1.7 },
  { preset: 'Pine Large', seed: 37, children0: 32, leavesCount: 15, leavesSizeMul: 1.6 }
];

/** Number of species recipes; archetype i+EZ_SPECIES_COUNT is species i's far build. */
export const EZ_SPECIES_COUNT = EZ_RECIPES.length;

/** Derive the cheap far-LOD recipe from a near recipe (same seed ⇒ same silhouette). */
function farRecipe(r: EzRecipe): EzRecipe {
  return {
    preset: r.preset,
    seed: r.seed,
    children0: Math.round(r.children0 * 0.55),
    leavesCount: Math.max(5, Math.round(r.leavesCount * 0.4)),
    leavesSizeMul: r.leavesSizeMul * 1.45
  };
}

/** How many snow shelf anchors each archetype exposes (trees.ts samples from these). */
const SNOW_ANCHORS_PER_ARCHETYPE = 12;

// Memoized module + archetypes. The import promise is shared so concurrent callers
// (re-inits racing the first build) never double-fetch the 4 MB chunk.
let ezModulePromise: Promise<any> | null = null;
let archetypesPromise: Promise<EzArchetype[]> | null = null;
let archetypesCache: EzArchetype[] | null = null;

// Test seam: the dynamic-import thunk, injectable so the Node suite can exercise a
// failed chunk fetch (and the retry after it) without a network. Setting a new
// importer clears the module memo so the next load actually goes through it.
let ezModuleImporter: () => Promise<any> = () => import('@dgreenheck/ez-tree');
export function __setEzModuleImporterForTests(importer: (() => Promise<any>) | null): void {
  ezModuleImporter = importer ?? (() => import('@dgreenheck/ez-tree'));
  ezModulePromise = null;
}

/** Lazy-import ez-tree; headless runs get a throwaway document shim (import-time
 *  TextureLoader — see header). The shim is removed in `finally` so the game's own
 *  `typeof document` guards (procedural canvas textures) keep seeing a bare Node.
 *
 *  Math.random is deliberately NOT swapped around this import: the package's
 *  import-time texture table does mint ~20 THREE Texture uuids from the ambient
 *  Math.random, but holding the private-stream swap across the await would hand
 *  every concurrent caller (snowflake setup, snowman build — anything drawing
 *  randomness while the ~4 MB chunk fetches) the same deterministic xorshift
 *  sequence on every load. The seeded harnesses never reach this import (the flag
 *  is off headless), so the one-time import draws never land on an instrumented
 *  stream; per-archetype GENERATION, which re-runs after resets, stays
 *  stream-neutral via the synchronous swap in ensureEzArchetypes. */
function loadEzTreeModule(): Promise<any> {
  if (!ezModulePromise) {
    const loading = (async () => {
      const g = globalThis as any;
      let shimmed = false;
      if (typeof g.document === 'undefined') {
        const stubEl = (): any => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} });
        g.document = { createElementNS: stubEl, createElement: stubEl };
        shimmed = true;
      }
      try {
        const mod: any = await ezModuleImporter();
        return mod && mod.Tree ? mod : mod.default;
      } finally {
        if (shimmed) delete g.document;
      }
    })();
    ezModulePromise = loading;
    // A failed chunk fetch must not wedge every later attempt behind a rejected
    // memo — clear it so a re-init can retry the import. (ensureEzArchetypes
    // clears its own memo the same way; callers still see this rejection.)
    loading.catch(() => {
      if (ezModulePromise === loading) ezModulePromise = null;
    });
  }
  return ezModulePromise;
}

/** Quad centers of the needle-card geometry, top-N by height, stride-thinned to a
 *  spread set — where trees.ts drapes snow shelves. Billboard-double cards are two
 *  quads per needle cluster; sampling every quad is fine (we only keep a dozen). */
function computeSnowAnchors(leaves: THREE.BufferGeometry): Array<{ x: number; y: number; z: number }> {
  const pos = leaves.getAttribute('position');
  if (!pos) return [];
  const centers: Array<{ x: number; y: number; z: number }> = [];
  for (let q = 0; q + 4 <= pos.count; q += 4) {
    let cx = 0, cy = 0, cz = 0;
    for (let v = q; v < q + 4; v++) {
      cx += pos.getX(v); cy += pos.getY(v); cz += pos.getZ(v);
    }
    centers.push({ x: cx / 4, y: cy / 4, z: cz / 4 });
  }
  if (centers.length === 0) return [];
  centers.sort((a, b) => b.y - a.y);
  const top = centers.slice(0, Math.max(SNOW_ANCHORS_PER_ARCHETYPE, Math.floor(centers.length * 0.4)));
  const stride = Math.max(1, Math.floor(top.length / SNOW_ANCHORS_PER_ARCHETYPE));
  const anchors: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < top.length && anchors.length < SNOW_ANCHORS_PER_ARCHETYPE; i += stride) {
    anchors.push(top[i]!);
  }
  return anchors;
}

function generateArchetype(EZ: any, recipe: EzRecipe, species: number, detail: EzDetail): EzArchetype {
  const tree = new EZ.Tree();
  tree.loadPreset(recipe.preset);
  tree.options.seed = recipe.seed;
  // Low-poly tuning: single branching level, coarser tubes, fewer/larger needle
  // cards. Far builds coarsen the tubes one more notch — at off-piste distance the
  // silhouette is all that survives.
  tree.options.branch.levels = 1;
  tree.options.branch.children[0] = recipe.children0;
  tree.options.branch.children[1] = 0;
  tree.options.branch.segments[0] = detail === 'far' ? 4 : 6;
  tree.options.branch.segments[1] = 3;
  tree.options.branch.sections[0] = detail === 'far' ? 5 : 8;
  tree.options.branch.sections[1] = 3;
  tree.options.leaves.count = recipe.leavesCount;
  tree.options.leaves.size = tree.options.leaves.size * recipe.leavesSizeMul;
  tree.generate();

  const branches = tree.branchesMesh.geometry as THREE.BufferGeometry;
  const leaves = tree.leavesMesh.geometry as THREE.BufferGeometry;
  branches.computeBoundingBox();
  const height = branches.boundingBox ? branches.boundingBox.max.y : 1;

  // Keep ez-tree's needle sprite (module-cached in the package; a stub headless).
  // The package flags it SRGBColorSpace, but this game renders the legacy linear
  // pipeline (ColorManagement off, NoColorSpace canvas textures everywhere) — the
  // sRGB decode would double-darken the needles, so re-flag it to match.
  const leafMaterial = tree.leavesMesh.material as THREE.MeshPhongMaterial;
  const leafMap = (leafMaterial && leafMaterial.map) || null;
  if (leafMap) leafMap.colorSpace = THREE.NoColorSpace;

  // The geometries are ours now; the generated Phong materials are not used
  // (trees.ts builds tinted, swaying materials) — free them. Their maps are the
  // package's shared texture cache, which material.dispose() correctly leaves alone.
  (tree.branchesMesh.material as THREE.Material).dispose();
  leafMaterial.dispose();

  return { branches, leaves, leafMap, height, snowAnchors: computeSnowAnchors(leaves), species, detail };
}

// Bumped by resetEzForest so a generation that was already awaiting the chunk when
// a teardown ran cannot repopulate the cache afterward (its geometries would be
// orphaned — no live scene, nothing left to dispose them until another reset).
let ezGenerationEpoch = 0;

/** Generate (once) and return the evergreen archetypes. RNG-stream-neutral: the
 *  Math.random swap covers every THREE uuid draw generation makes. Resolves to []
 *  (nothing cached) when a reset cancelled this generation mid-load — callers
 *  stale-check against their own teardown guards anyway. */
export function ensureEzArchetypes(): Promise<EzArchetype[]> {
  if (!archetypesPromise) {
    const epoch = ezGenerationEpoch;
    const generating = loadEzTreeModule().then((EZ) => {
      const savedRandom = Math.random;
      Math.random = ezUuidRandom;
      let generated: EzArchetype[];
      try {
        // Near builds first (species i at index i), far builds after (index i +
        // EZ_SPECIES_COUNT) — trees.ts relies on this layout for LOD selection.
        generated = [
          ...EZ_RECIPES.map((r, i) => generateArchetype(EZ, r, i, 'near')),
          ...EZ_RECIPES.map((r, i) => generateArchetype(EZ, farRecipe(r), i, 'far'))
        ];
      } finally {
        Math.random = savedRandom;
      }
      if (epoch !== ezGenerationEpoch) {
        // resetEzForest ran while the chunk was loading: this generation belongs
        // to a torn-down world — free it instead of caching orphaned geometries.
        for (const a of generated) {
          a.branches.dispose();
          a.leaves.dispose();
        }
        return [];
      }
      archetypesCache = generated;
      return generated;
    });
    archetypesPromise = generating;
    // A failed load (offline chunk fetch, package missing) must not wedge every
    // later attempt behind a rejected memo; log + clear so a re-init can retry.
    // (Clear only if a reset hasn't already installed a newer attempt.)
    generating.catch((err) => {
      console.error('EzForest: archetype generation failed', err);
      if (archetypesPromise === generating) archetypesPromise = null;
    });
  }
  return archetypesPromise;
}

/** Already-generated archetypes, or null before the first ensureEzArchetypes resolves. */
export function getEzArchetypesSync(): EzArchetype[] | null {
  return archetypesCache;
}

/** Dispose the cached archetype geometries and clear the memo (teardown / dev-HMR).
 *  The ez-tree module itself stays imported (its texture cache is package-global);
 *  a later ensureEzArchetypes regenerates fresh geometries from the same module. */
export function resetEzForest(): void {
  // Cancel any generation still awaiting its chunk (see ezGenerationEpoch above).
  ezGenerationEpoch++;
  if (archetypesCache) {
    for (const a of archetypesCache) {
      a.branches.dispose();
      a.leaves.dispose();
    }
  }
  archetypesCache = null;
  archetypesPromise = null;
}
