// mountains/index.ts - Terrain and mountain features for snowglider
//
// Stage R-mountains (issue #34): `src/mountains.ts` is now a thin ROOT FACADE
// (`export * from './mountains/index.js'`) and the implementation lives here, so
// every existing importer keeps resolving the sibling `./mountains.js` specifier.
// This hub is being carved into focused submodules (noise / terrain / snow-surface
// / terrain-mesh / rocks) the same way `src/snowman/*` was split; the terrain math
// stays byte-identical at every step (the terrain/regression suites + the physics
// invariant harness pin it).
//
// Phase 2.7 (issue #84): converted off the classic global model. `THREE` and the
// `Trees` module now come from real ES-module imports, and `Mountains` is
// `export`ed. mountains.js and trees.js import each other (the cross-references
// run only at call time, so the circular import resolves cleanly). The terrain
// samplers (`getTerrainHeight`/`getTerrainGradient`/`getDownhillDirection`) are
// reached via the `Mountains` import or as injected parameters — the old window
// bridges are gone.
//
// Phase 3.6 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file), the `SimplexNoise` fields and the terrain
// sampler/geometry helper signatures are now real type declarations, and the
// JSDoc `/** @type {Float32Array} */` buffer casts are now `as` casts. The terrain
// math is byte-identical — every edit is type-only/erasable, so esbuild (Vite) and
// Node's native type-stripping both run it exactly as before, preserving terrain
// height consistency (the seam camera/trees/snow/physics all depend on).
// The `./trees.js` specifier stays `.js` (Vite/tsc resolve it to `trees.ts`; the
// Node terrain/regression tests use the `.js`->`.ts` resolve hook added in PR 3.3).
import * as THREE from 'three';
import { Trees, type TreePosition } from '../trees.js';
import {
  SimplexNoise,
  terrainRidgeField,
  forestDensityField,
} from './noise.js';

// Re-export the deterministic noise fields so the public `./mountains.js` named
// exports (`terrainRidgeField`, `forestDensityField`) and the terrain tests that
// import `terrainRidgeField` directly keep resolving them through this hub.
export { terrainRidgeField, forestDensityField };

/** A 2D vector in the terrain x/z plane: a gradient or a unit downhill direction. */
export interface TerrainVec2 {
  x: number;
  z: number;
}

/** A placed rock's world position and size. */
export interface RockPosition {
  x: number;
  y: number;
  z: number;
  size: number;
}

const ROCK_COLLISION_MIN_SIZE = 1.25;

// Keep the central ski line and the spawn pocket clear of *collidable* rocks: the
// run must always stay navigable (mirrors the tree clear-corridor in trees.ts) and
// the player must never spawn on, or right next to, a hazard. Decorative rocks are
// still rendered everywhere — only their hazard status is suppressed here. Both
// exclusions are widened by the rock's own collision radius below, so a rock whose
// *center* sits just outside the corridor/pocket can't still reach into it.
const ROCK_COLLISION_PATH_HALF_WIDTH = 5;     // central ski-line corridor half-width, before the rock radius is added
const ROCK_COLLISION_START_CLEAR_RADIUS = 10; // clear pocket around the snowman start, before the rock radius is added
// Snowman spawn, mirroring resetSnowman() in snowman.ts (pos.x = 0, pos.z = -15).
const SNOWMAN_START_X = 0;
const SNOWMAN_START_Z = -15;

/**
 * Collision radius (world units) of a collidable rock of the given size (max 3u).
 * The placement-time safe-zone below uses this to exclude rocks whose hazard radius
 * would reach the ski lane or spawn pocket. snowman.ts's in-game rock collision uses
 * the identical formula inline (it must stay free of relative imports so the
 * no-resolve-hook Node test harnesses can load it) — keep the two in sync.
 */
export function rockCollisionRadius(size: number): number {
  return Math.max(1.25, Math.min(3.0, size * 0.75 + 0.75));
}

/**
 * Whether a placed rock should act as a collision hazard. A rock qualifies only
 * when it is large enough to read as an obstacle AND clear of both the central ski
 * line and the spawn pocket — each exclusion expanded by the rock's own collision
 * radius so the unseeded random placement can never reach into the ski lane, wall
 * off the run, or crash the player on spawn.
 */
function rockIsCollisionHazard(x: number, z: number, size: number): boolean {
  if (size < ROCK_COLLISION_MIN_SIZE) return false;
  const radius = rockCollisionRadius(size);
  if (Math.abs(x) < ROCK_COLLISION_PATH_HALF_WIDTH + radius) return false;
  const dx = x - SNOWMAN_START_X;
  const dz = z - SNOWMAN_START_Z;
  if (Math.sqrt(dx * dx + dz * dz) < ROCK_COLLISION_START_CLEAR_RADIUS + radius) return false;
  return true;
}

// --- Terrain utilities ---

// Global height map for efficient lookup - will be populated when terrain is created
const heightMap: Record<string, number> = {};

// Calculate terrain height at (x, z)
function getTerrainHeight(x: number, z: number): number {
  // First check if we have this position in our cached height map
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  if (heightMap[key] !== undefined) {
    return heightMap[key];
  }
  
  const distance = Math.sqrt(x * x + z * z);
  
  // Use EXACTLY the same formula as in terrain mesh creation
  // Base mountain shape
  let y = 40 * Math.exp(-distance / 40);
  
  // Add noise for natural backcountry terrain
  y += 1.5 * Math.sin(x * 0.05) * Math.cos(z * 0.05) * (1 - Math.exp(-distance / 60));
  
  // Add additional terrain features and ridges (aperiodic — see terrainRidgeField).
  // Damped toward the peak (like the low-freq term + mesh perlin) so the summit stays
  // smooth and the relief grows down the slope where it reads as backcountry terrain.
  y += terrainRidgeField(x, z) * 0.8 * (1 - Math.exp(-distance / 60));
  
  // Ensure downhill gradient in extended sections - create a consistent downhill slope
  // This factor increases the further (more negative) z gets, creating a gradual slope
  // Use a stronger gradient (0.12) to ensure consistent downhill even with terrain noise
  if (z < -30) {
    y += (z + 30) * 0.12; // This creates a consistent downhill gradient
  }
  
  // Store in height map for future lookups
  heightMap[key] = y;
  return y;
}

// Calculate terrain gradient for physics and tree placement
function getTerrainGradient(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  return { x: (hX - h) / eps, z: (hZ - h) / eps };
}

// Compute Downhill Direction (Approximate Gradient)
function getDownhillDirection(x: number, z: number): TerrainVec2 {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  const gradient = { x: (hX - h) / eps, z: (hZ - h) / eps };
  // Downhill is opposite to the gradient
  const dir = { x: -gradient.x, z: -gradient.z };
  const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  return len ? { x: dir.x / len, z: dir.z / len } : { x: 0, z: 1 };
}

// --- Procedural snow surface textures (issue #17) ---
// Authored for the project's legacy colour pipeline (`ColorManagement.enabled =
// false`, linear output, no tone mapping — see game/scene-setup.ts): the canvases
// are sampled as-authored with no sRGB decode, so the near-white albedo and the
// tangent-space normal map are written directly in the values the shader uses.
// Both are generated procedurally (no committed binary assets — matching the
// existing snowflake/splash canvases) and tile seamlessly so they can repeat
// across the 300x400 terrain plane without visible seams.

/**
 * A bright near-white snow albedo for deep powder. Very low-amplitude *isotropic*
 * mottling (a sum of periodic waves pointing in many directions, so no single
 * orientation dominates and it never reads as a stripe) breaks up the dead-flat
 * white without leaving "snow" range, plus a faint cold-blue cast in the dips and
 * a sparse high-frequency sparkle. Repeated at a low frequency so the broad
 * blotches read as wind-drifted powder, not a tiled pattern.
 */
function createSnowAlbedoTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      // Tileable low-frequency mottle from mixed directions (no dominant axis),
      // normalised to ~[-1, 1].
      let n = Math.sin(2 * Math.PI * (1 * u + 2 * v));
      n += 0.7 * Math.sin(2 * Math.PI * (2 * u - 3 * v) + 1.3);
      n += 0.5 * Math.sin(2 * Math.PI * (-3 * u + 1 * v) + 2.1);
      n += 0.4 * Math.sin(2 * Math.PI * (3 * u + 3 * v) + 0.7);
      n /= 2.6;
      // Sparse crystalline sparkle (product of high-freq periodics stays tileable).
      const sparkle = Math.max(0, Math.sin(2 * Math.PI * 24 * u) * Math.sin(2 * Math.PI * 22 * v));
      const base = 250 + n * 5 + sparkle * sparkle * 4; // very bright band (~245..255)
      const cool = Math.max(0, -n) * 5;  // slightly bluer in the dips
      const idx = (y * SIZE + x) * 4;
      data[idx] = Math.min(255, base - cool);            // R
      data[idx + 1] = Math.min(255, base - cool * 0.35); // G
      data[idx + 2] = Math.min(255, base);               // B (kept full -> cool dips)
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  return tex;
}

/**
 * A tileable tangent-space normal map giving the snow its micro-relief: soft,
 * *isotropic* powder granulation so the large flat plane catches the directional
 * light as a gently broken surface instead of reading as a sheet. The previous
 * version summed ripples that were all biased toward one diagonal, which tiled
 * into visible "grey grid" stripes under the directional light (issue #17 follow-up);
 * this version spreads the wave directions (mixed signs, no dominant axis) and
 * leans on fine grain, so the relief reads as snow grain rather than corrugation.
 * The height field is a sum of integer-frequency waves (periodic => seamless);
 * normals are central differences with wraparound.
 */
function createSnowNormalTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const height = new Float32Array(SIZE * SIZE);
  // Many *high-frequency* waves pointing in many directions. Keeping every term
  // high-frequency means the relief is sub-metre "snow tooth" that mip-maps away
  // with distance (sparkle up close, smooth far) instead of the metre-scale
  // ripples that tiled into visible diagonal bands. Mixed directions/signs keep it
  // isotropic so no orientation reads as a stripe. Integer frequencies => seamless.
  const waves: [number, number, number, number][] = [
    [13, 17, 0.22, 0.4],
    [19, -11, 0.20, 1.9],
    [-7, 23, 0.18, 2.7],
    [21, 9, 0.16, 0.9],
    [11, -19, 0.15, 1.3],
    [25, 5, 0.13, 2.1],
    [-15, 13, 0.12, 0.6],
    [9, 27, 0.11, 1.5],
  ];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      let h = 0;
      for (let k = 0; k < waves.length; k++) {
        const [fx, fz, a, p] = waves[k];
        h += a * Math.sin(2 * Math.PI * (fx * u + fz * v) + p);
      }
      height[y * SIZE + x] = h;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  const STRENGTH = 1.5; // height -> slope gain
  const wrap = (i: number) => (i + SIZE) % SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const hl = height[y * SIZE + wrap(x - 1)];
      const hr = height[y * SIZE + wrap(x + 1)];
      const hd = height[wrap(y - 1) * SIZE + x];
      const hu = height[wrap(y + 1) * SIZE + x];
      let nx = -(hr - hl) * STRENGTH;
      let ny = -(hu - hd) * STRENGTH;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const idx = (y * SIZE + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 20); // fine: sub-metre grain that mip-maps to smooth at distance
  // Normal maps are data, not colour: keep them out of any sRGB decode. (The
  // project disables ColorManagement, so this is belt-and-suspenders.)
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Bake per-vertex snow shading into the terrain geometry: flat areas stay bright
 * snow, steeper faces take only a faint, cool *shadow* tint (read from the mesh
 * normal's tilt). The previous crust was a strong grey-blue (0.66, 0.72, 0.82)
 * applied at up to 0.6, which — combined with the bumpy terrain — read as grey
 * patches all over the snow; this keeps pitches bright and snowy with just a soft
 * blue cast for depth, the way real powder shadows do. Applied via `vertexColors`,
 * so it adds slope-dependent depth without touching the height field — physics is
 * unaffected. Mutates `geometry` in place; call after `computeVertexNormals()`.
 */
function applySnowVertexColors(geometry: THREE.BufferGeometry): void {
  const normals = geometry.attributes.normal.array as Float32Array;
  const positions = geometry.attributes.position.array as Float32Array;
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const snow = { r: 1.0, g: 1.0, b: 1.0 };
  const shade = { r: 0.93, g: 0.95, b: 0.99 }; // barely-cool powder shadow (almost white)
  // Where conifer stands grow — gentle slopes inside the forest-density bands — the
  // snow picks up a faint warm/green treeline cast from the canopy and needle litter
  // showing through. It is deliberately low-amplitude (a tint, never dirt) and gated
  // to gentle, forested ground, so the open snowfields in the clearings stay bright
  // white. Driven by the SHARED forest field, so the ground visually ties to the
  // trees that Trees.addTrees clusters into the very same stands.
  const forestTint = { r: 0.83, g: 0.87, b: 0.75 };
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1];
    // normal.y ~1 on flats, lower on pitches; remap the useful band to 0..1.
    const tilt = Math.min(1, Math.max(0, (1 - ny) / 0.4));
    const t = tilt * 0.5; // gentle, near-white slope shading (lighting does the rest)
    let r = snow.r + (shade.r - snow.r) * t;
    let g = snow.g + (shade.g - snow.g) * t;
    let b = snow.b + (shade.b - snow.b) * t;
    // Forest treeline tint: strongest on gentle, densely-forested ground; fades out
    // on steep pitches and in the open clearings.
    const gentle = Math.max(0, 1 - tilt * 1.4);
    const stand = Math.max(0, (forestDensityField(positions[i * 3], positions[i * 3 + 2]) - 0.45) / 0.55);
    const amt = gentle * stand * 0.26;
    r += (forestTint.r - r) * amt;
    g += (forestTint.g - g) * amt;
    b += (forestTint.b - b) * amt;
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Give the snow surface *smoothed shading normals* without moving any vertex
 * (issue #17 follow-up, per maintainer review on PR #181). The grey "grid lines"
 * that survived the texture fix are the bumpy terrain's own facet normals being
 * raked by the directional light — every little mogul/ridge gets a lit and a
 * shaded face. We can't move the positions (physics rides the exact mesh via
 * `heightMap`, and the two-formula terrain contract + invariant harness depend on
 * it), but the *shading* normals are render-only. So we low-pass a throwaway clone
 * of the height field and copy its normals onto the real geometry: the silhouette
 * stays the skiable terrain, but the light sees a soft surface and the snow reads
 * as deep powder instead of corduroy. Physics is untouched (it never reads mesh
 * normals — slope forces use the analytic `getTerrainGradient`).
 *
 * `cols`/`rows` are the vertex counts (segments + 1) of the PlaneGeometry grid.
 */
function applySmoothShadingNormals(
  geometry: THREE.BufferGeometry, cols: number, rows: number, passes: number
): void {
  const clone = geometry.clone();
  const pos = clone.attributes.position.array as Float32Array;
  // Pull the height (world y) of each grid vertex into a 2D buffer.
  const h = new Float32Array(cols * rows);
  for (let k = 0; k < cols * rows; k++) h[k] = pos[k * 3 + 1];
  // Separable 3-tap box blur, edge-clamped, repeated for a gentle low-pass.
  const tmp = new Float32Array(cols * rows);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const l = h[base + Math.max(0, c - 1)];
        const m = h[base + c];
        const rr = h[base + Math.min(cols - 1, c + 1)];
        tmp[base + c] = (l + m + rr) / 3;
      }
    }
    // vertical
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const u = tmp[Math.max(0, r - 1) * cols + c];
        const m = tmp[r * cols + c];
        const d = tmp[Math.min(rows - 1, r + 1) * cols + c];
        h[r * cols + c] = (u + m + d) / 3;
      }
    }
  }
  // Write the smoothed heights back into the clone and let three compute robust,
  // correctly-oriented normals from it; copy those onto the real geometry.
  for (let k = 0; k < cols * rows; k++) pos[k * 3 + 1] = h[k];
  clone.computeVertexNormals();
  const smooth = clone.attributes.normal.array as Float32Array;
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(smooth), 3));
  clone.dispose();
}

// --- Terrain creation functions ---

// Create Terrain (Natural Mountain)
function createTerrain(scene: THREE.Scene) {
  // Create a large natural mountain terrain
  const geometry = new THREE.PlaneGeometry(300, 400, 150, 200);
  geometry.rotateX(-Math.PI / 2);
  
  // Store the original terrain geometry for raycasting
  scene.userData = scene.userData || {}; 
  scene.userData.terrainGeometry = geometry;
  
  // BufferAttribute.array is typed ArrayLike<number> (read-only); the concrete
  // buffer is a writable Float32Array, which we mutate in place below.
  const vertices = geometry.attributes.position.array as Float32Array;

  // Create Perlin noise for natural terrain variation
  const perlin = new SimplexNoise();
  
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], z = vertices[i + 2];
    const distance = Math.sqrt(x * x + z * z);
    
    // Base mountain shape - MUST MATCH getTerrainHeight function exactly!
    let y = 40 * Math.exp(-distance / 40);
    
    // Add perlin noise for natural terrain roughness
    // Less noise near the peak, more at the sides
    const noiseScale = 0.05;
    const noiseStrength = 2.0 * (1 - Math.exp(-distance / 60));
    y += perlin.noise(x * noiseScale, z * noiseScale) * noiseStrength;
    
    // Store this vertex position in our heightmap for precise object placement
    const key = `${Math.round(x*10)},${Math.round(z*10)}`;
    heightMap[key] = y;
    
    // Add natural terrain features and ridges (aperiodic — see terrainRidgeField).
    // Damped toward the peak like the perlin roughness above (same distance falloff).
    y += terrainRidgeField(x, z) * 1.5 * (1 - Math.exp(-distance / 60));
    
    // Ensure downhill gradient in extended sections - create a consistent downhill slope
    // Must match getTerrainHeight implementation exactly!
    // Use a stronger gradient (0.12) to ensure consistent downhill even with terrain noise
    if (z < -30) {
      y += (z + 30) * 0.12;
    }
    
    // Add some random smaller bumps for natural backcountry terrain
    if (Math.random() > 0.6) {
      y += perlin.noise(x * 0.1 + 100, z * 0.1 + 100) * 2.0;
    }
    
    vertices[i + 1] = y;
    
    // IMPORTANT: Update the heightmap with the FINAL height after all modifications
    heightMap[`${Math.round(x*10)},${Math.round(z*10)}`] = y;
  }
  geometry.computeVertexNormals();
  // Smooth the *shading* normals (positions/physics untouched) so the directional
  // light stops raking every terrain bump into a grey band (PR #181 review). Must
  // run before applySnowVertexColors (which derives the slope tint from these
  // normals) and must NOT be followed by another computeVertexNormals (it would
  // overwrite them). PlaneGeometry(150,200 segments) => 151x201 grid vertices.
  applySmoothShadingNormals(geometry, 151, 201, 7);

  // Snow surface material (issue #17): a bright, isotropically mottled near-white
  // albedo plus a soft *isotropic* micro-relief normal map (powder granulation, no
  // directional ripples) so the slope reads as deep snow that catches the light,
  // instead of the old flat grey grid / diagonal striping. Slope shading (bright
  // snow -> faint cool powder shadow on pitches) is baked into the geometry's
  // vertex colours and multiplied in via `vertexColors`. A high roughness keeps it
  // matte like real powder; the gentle normalScale avoids harsh corrugation.
  const albedo = createSnowAlbedoTexture();
  const normalMap = createSnowNormalTexture();
  applySnowVertexColors(geometry);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    map: albedo,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.12, 0.12),
    vertexColors: true
  });
  
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  terrain.name = 'terrain'; // Add a name for easy identification
  scene.add(terrain);
  
  // Store terrain mesh in scene userData and global window for precise object placement
  scene.userData.terrainMesh = terrain;
  if (typeof window !== 'undefined') {
    window.terrainMesh = terrain;
  }
  
  // NOTE: do not recompute vertex normals here — applySmoothShadingNormals() above
  // installed the smoothed snow-shading normals and a plain computeVertexNormals
  // would overwrite them with the raw faceted ones (reintroducing the grey banding).

  // Debug log to verify our height map is working
  console.log(`Height map contains ${Object.keys(heightMap).length} terrain points`);
  
  // Add rocks to make the mountain more realistic. The returned subset is the
  // collision source of truth for rocks large enough to read as hazards.
  const rockPositions = addRocks(scene);
  
  // Add trees to make the slope more visible using the separate Trees module
  let treePositions: TreePosition[] = [];
  if (Trees && typeof Trees.addTrees === 'function') {
    treePositions = Trees.addTrees(scene);
  } else {
    console.warn("Trees module not found, skipping tree creation");
  }
  
  return { terrain, treePositions, rockPositions };
}

// Add rocks to create a more realistic mountain environment
function addRocks(scene: THREE.Scene): RockPosition[] {
  // Remove any existing rocks from the scene to prevent duplicates
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i];
    // Rocks are typically meshes with dodecahedron geometry
    const mesh = child as THREE.Mesh;
    if (child.type === 'Mesh' && mesh.geometry &&
        mesh.geometry.type && mesh.geometry.type.includes('Dodecahedron')) {
      scene.remove(child);
    }
  }

  // Create rock positions with higher density on steeper parts of mountain
  const rockPositions: RockPosition[] = [];
  
  // Add rocks scattered across the entire mountain
  for(let z = -180; z < 90; z += 10) {
    for(let x = -140; x < 140; x += 10) {
      // Skip positions that would be too far from the actual terrain plane
      if (Math.abs(x) > 150 || Math.abs(z) > 200) continue;
      
      // Random offset for natural placement
      const xPos = x + (Math.random() * 8 - 4);
      const zPos = z + (Math.random() * 8 - 4);
      
      // Get terrain information at this position
      const y = getTerrainHeight(xPos, zPos);
      const gradient = getTerrainGradient(xPos, zPos);
      const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
      
      // Higher probability of rocks on steeper slopes, but still some randomness
      if(Math.random() < 0.1 + steepness * 0.5) {
        rockPositions.push({x: xPos, y: y, z: zPos, size: 0.5 + Math.random() * 2.5});
      }
    }
  }
  
  // Create a raycaster to ensure precise placement
  const raycaster = new THREE.Raycaster();
  const downDirection = new THREE.Vector3(0, -1, 0);
  
  // Get terrain mesh for raycasting - try multiple ways to find it
  let terrainMesh: THREE.Object3D | null = null;

  // Check global reference first (set in snowglider.js)
  if (window && window.terrainMesh) {
    terrainMesh = window.terrainMesh;
  }
  // Then check userData
  else if (scene.userData && scene.userData.terrainMesh) {
    terrainMesh = scene.userData.terrainMesh;
  }
  // Last resort - find by name or type
  else {
    terrainMesh = scene.children.find(child => {
      const mesh = child as THREE.Mesh;
      return child.name === 'terrain' ||
        (child.type === 'Mesh' &&
         !!mesh.geometry &&
         mesh.geometry.type === 'PlaneGeometry');
    }) ?? null;
  }
  
  const collisionRockPositions: RockPosition[] = [];

  // Create rock instances
  rockPositions.forEach(pos => {
    // Get the exact terrain height from our height map or calculation
    const terrainHeight = getTerrainHeight(pos.x, pos.z);
    
    const rock = createRock(pos.size);
    
    // Sink the rock deeper into the terrain for better anchoring
    rock.position.set(pos.x, terrainHeight - pos.size * 0.3, pos.z);
    
    // Random rotation for natural look
    rock.rotation.y = Math.random() * Math.PI * 2;
    rock.rotation.z = Math.random() * 0.3;
    
    // Align rock to terrain slope for better anchoring
    const gradient = getTerrainGradient(pos.x, pos.z);
    rock.rotation.x = Math.atan(gradient.z) * 0.8;
    rock.rotation.z = -Math.atan(gradient.x) * 0.8;
    
    scene.add(rock);

    if (rockIsCollisionHazard(pos.x, pos.z, pos.size)) {
      collisionRockPositions.push({ x: pos.x, y: terrainHeight, z: pos.z, size: pos.size });
    }
  });

  // Cliff outcrops: a sparse scatter of larger, craggy rock formations on the
  // steepest flanks, kept well clear of the central ski corridor so they add drama
  // and terrain diversity without walling off the run. Each outcrop is a tight
  // cluster of 2-3 cliff blocks so it reads as a rocky band/buttress rather than one
  // lone boulder. Like every rock these are decorative, but any block big enough and
  // clear of the ski line/spawn pocket also registers as a collision hazard (radius
  // capped at 3u, in sync with snowman collision) — you can't ski through a cliff.
  for (let z = -180; z < 80; z += 30) {
    for (let x = -130; x <= 130; x += 30) {
      // Keep the whole formation off the centre line (the ski corridor is |x| < 5).
      if (Math.abs(x) < 18) continue;
      const cx = x + (Math.random() * 14 - 7);
      const cz = z + (Math.random() * 14 - 7);
      if (Math.abs(cx) < 16) continue;
      if (Math.abs(cx) > 145 || Math.abs(cz) > 195) continue;

      // Only on genuinely steep pitches, and not on every one even then.
      const gradient = getTerrainGradient(cx, cz);
      const steepness = Math.sqrt(gradient.x * gradient.x + gradient.z * gradient.z);
      if (steepness < 0.22) continue;
      if (Math.random() > 0.28 + steepness * 0.35) continue;

      const baseSize = 3.0 + Math.random() * 2.0; // 3-5u cliff blocks
      const blocks = 2 + Math.floor(Math.random() * 2); // 2-3 blocks per outcrop
      for (let b = 0; b < blocks; b++) {
        const bx = b === 0 ? cx : cx + (Math.random() * 6 - 3);
        const bz = b === 0 ? cz : cz + (Math.random() * 6 - 3);
        if (Math.abs(bx) < 14) continue; // never let a satellite block drift onto the line
        const bSize = b === 0 ? baseSize : baseSize * (0.55 + Math.random() * 0.4);
        const bHeight = getTerrainHeight(bx, bz);

        const rock = createRock(bSize, { cliff: true });
        rock.position.set(bx, bHeight - bSize * 0.28, bz);
        rock.rotation.y = Math.random() * Math.PI * 2;
        const g = getTerrainGradient(bx, bz);
        rock.rotation.x = Math.atan(g.z) * 0.8;
        rock.rotation.z = -Math.atan(g.x) * 0.8;
        scene.add(rock);

        if (rockIsCollisionHazard(bx, bz, bSize)) {
          collisionRockPositions.push({ x: bx, y: bHeight, z: bz, size: bSize });
        }
      }
    }
  }

  console.log(`Mountains.addRocks: Created ${collisionRockPositions.length} rock positions for collision detection`);
  return collisionRockPositions;
}

// Shared craggy normal map for all rocks (issue #17, Stage 2). Built once and
// reused across the few hundred rock meshes — cheap, and avoids per-rock canvas
// work. Lazily created so it's only touched in a DOM/browser context (createRock
// is browser-only via createTerrain/addRocks); returns null elsewhere so the
// material simply renders without it. Same legacy-pipeline / NoColorSpace
// handling as the snow normal map above.
let rockNormalTexture: THREE.CanvasTexture | null = null;
function getRockNormalTexture(): THREE.CanvasTexture | null {
  if (rockNormalTexture) return rockNormalTexture;
  if (typeof document === 'undefined') return null;
  const SIZE = 128;
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      // Chaotic high-frequency relief for a rough rock face (tileable).
      let h = 0.5 * Math.sin(2 * Math.PI * (5 * u + 3 * v) + 0.4);
      h += 0.4 * Math.sin(2 * Math.PI * (9 * u - 7 * v) + 1.1);
      h += 0.3 * Math.sin(2 * Math.PI * (17 * u + 11 * v) + 2.3);
      h += 0.2 * Math.sin(2 * Math.PI * 23 * u) * Math.sin(2 * Math.PI * 29 * v);
      height[y * SIZE + x] = h;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  const STRENGTH = 2.5;
  const wrap = (i: number) => (i + SIZE) % SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const hl = height[y * SIZE + wrap(x - 1)];
      const hr = height[y * SIZE + wrap(x + 1)];
      const hd = height[wrap(y - 1) * SIZE + x];
      const hu = height[wrap(y + 1) * SIZE + x];
      let nx = -(hr - hl) * STRENGTH;
      let ny = -(hu - hd) * STRENGTH;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const idx = (y * SIZE + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz / len * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  rockNormalTexture = tex;
  return tex;
}

/**
 * Bake snow accumulation into a rock's vertex colours: upward-facing faces gather
 * snow (toward white), the rest keep the rock's base grey. The deformed
 * dodecahedron is non-indexed, so each vertex carries its own face normal — the
 * snow settles cleanly per-face on top. Multiplied in via `vertexColors`; rocks
 * are scenery (not in any physics/determinism path), so the look is the only
 * contract. Mutates `geometry` in place; call after `computeVertexNormals()`.
 */
function applyRockSnowColors(geometry: THREE.BufferGeometry, rockColor: THREE.Color): void {
  const normals = geometry.attributes.normal.array as Float32Array;
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  // Snow blanket toward a faintly cool white so the cap reads as snow, not blown
  // highlight. The band starts lower and saturates sooner than before so up-facing
  // faces are convincingly *covered* (the previous 0.25..0.70 band left rocks
  // reading as bare grey crystals with only a faint dusting).
  const snowCol = { r: 0.97, g: 0.98, b: 1.0 };
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1];
    const t = Math.min(1, Math.max(0, (ny - 0.05) / (0.55 - 0.05)));
    const snow = t * t * (3 - 2 * t); // smoothstep up-facing band -> snow amount
    colors[i * 3] = rockColor.r + (snowCol.r - rockColor.r) * snow;
    colors[i * 3 + 1] = rockColor.g + (snowCol.g - rockColor.g) * snow;
    colors[i * 3 + 2] = rockColor.b + (snowCol.b - rockColor.b) * snow;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// A small palette of realistic mountain-stone base tones (HSL). Snow accumulates on
// top via applyRockSnowColors, so these are the bare-rock hues seen on the faces and
// undersides: cool granite grey, dark slate/charcoal, warm brown/tan, an iron-stained
// reddish, and a faint olive lichen. All kept low-saturation — real stone is mostly
// desaturated — and weighted toward the greys/browns so the slope reads as natural
// rock, not a gem field. Authored as setHSL values for the project's legacy linear
// pipeline (ColorManagement disabled), matching the existing tree trunk/foliage
// colours. Replaces the old uniform grey so the scattered rocks read as varied stone.
interface RockStone { h: number; s: number; l: number; weight: number; }
const ROCK_STONES: RockStone[] = [
  { h: 0.60, s: 0.05, l: 0.46, weight: 4 }, // cool granite grey
  { h: 0.62, s: 0.09, l: 0.30, weight: 3 }, // dark slate / charcoal
  { h: 0.08, s: 0.20, l: 0.40, weight: 3 }, // warm brown / tan
  { h: 0.04, s: 0.30, l: 0.34, weight: 2 }, // iron-stained reddish
  { h: 0.22, s: 0.12, l: 0.42, weight: 1 }, // faint olive lichen
];
const ROCK_STONE_WEIGHT = ROCK_STONES.reduce((s, e) => s + e.weight, 0);

/**
 * Pick a per-rock base colour: a weighted-random stone tone jittered in hue,
 * saturation, and lightness so no two rocks read identical. `darken` (0..1) pushes a
 * cliff/outcrop toward a deeper, more dramatic stone.
 */
function makeRockColor(darken = 0): THREE.Color {
  let r = Math.random() * ROCK_STONE_WEIGHT;
  let stone = ROCK_STONES[0];
  for (const e of ROCK_STONES) { stone = e; r -= e.weight; if (r <= 0) break; }
  const h = stone.h + (Math.random() - 0.5) * 0.03;
  const s = Math.min(0.45, Math.max(0, stone.s + (Math.random() - 0.5) * 0.06));
  const l = Math.min(0.7, Math.max(0.14, stone.l + (Math.random() - 0.5) * 0.12 - darken * 0.13));
  return new THREE.Color().setHSL(h, s, l);
}

/** Options for createRock. `cliff` builds a larger, more angular, darker outcrop. */
interface RockOptions { cliff?: boolean; }

// Create a rock with variable size
function createRock(size: number, opts: RockOptions = {}): THREE.Mesh {
  const cliff = opts.cliff === true;
  // Cliffs use detail 0 (sharper, blockier facets) and a stronger, vertically biased
  // deformation so they read as craggy outcrops; ordinary rocks stay rounded boulders.
  const geometry = new THREE.DodecahedronGeometry(size, cliff ? 0 : 1);

  // Deform vertices for a more natural shape
  // (writable Float32Array under the read-only ArrayLike<number> type)
  const positions = geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < positions.length; i += 3) {
    if (cliff) {
      positions[i]     *= 1 + (Math.random() - 0.25) * 0.5;
      positions[i + 1] *= 1 + Math.random() * 0.7;        // stretch upward -> taller crag
      positions[i + 2] *= 1 + (Math.random() - 0.25) * 0.5;
    } else {
      const noise = Math.random() * 0.2;
      positions[i]     *= (1 + noise);
      positions[i + 1] *= (1 + noise);
      positions[i + 2] *= (1 + noise);
    }
  }
  geometry.computeVertexNormals();

  // Snow gathers on the rock's up-facing faces (baked into vertex colours); the base
  // stone colour rides in the same attribute, so the material colour stays white and
  // is modulated per-vertex. A shared craggy normal map adds surface roughness without
  // extra geometry. (issue #17, Stage 2)
  const rockColor = makeRockColor(cliff ? 1 : 0);
  applyRockSnowColors(geometry, rockColor);

  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: cliff ? 0.95 : 0.9,
    metalness: 0.0, // matte rock/snow, not the shiny grey crystal it read as before
    flatShading: true,
    vertexColors: true,
    normalMap: getRockNormalTexture(),
    normalScale: new THREE.Vector2(cliff ? 0.6 : 0.4, cliff ? 0.6 : 0.4)
  });

  const rock = new THREE.Mesh(geometry, rockMaterial);
  rock.castShadow = true;
  rock.receiveShadow = true;

  return rock;
}

// Debug utility to verify the height map is working
function debugHeightMap(x: number, z: number): number {
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  console.log(`Height Map Debug at (${x}, ${z}):`);
  console.log(`- Height Map Entry: ${heightMap[key]}`);
  console.log(`- Calculated Height: ${getTerrainHeight(x, z)}`);
  return heightMap[key];
}

// Export all mountain-related functions and classes
export const Mountains = {
  SimplexNoise,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  terrainRidgeField,
  forestDensityField,
  createTerrain,
  createRock,
  addRocks,
  ROCK_COLLISION_MIN_SIZE,
  rockCollisionRadius,
  rockIsCollisionHazard,
  debugHeightMap,
  heightMap // Expose the heightmap for debugging
};

// All window.* bridges from mountains.js are gone (issue #84). Consumers get the
// terrain samplers via imports (camera.js, trees.js, snow.js import Mountains) or
// as injected parameters (snowman.js, course.js receive them from snowglider.js).
