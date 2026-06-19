// mountains.ts - Terrain and mountain features for snowglider
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
import { Trees, type TreePosition } from './trees.js';

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

// --- SimplexNoise implementation ---
class SimplexNoise {
  grad3: number[][];
  p: number[];
  perm: number[];
  gradP: number[][];

  constructor() {
    this.grad3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
                 [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
                 [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
    this.p = [];
    for (let i = 0; i < 256; i++) {
      this.p[i] = Math.floor(Math.random() * 256);
    }

    // To remove the need for index wrapping, double the permutation table length
    this.perm = new Array(512);
    this.gradP = new Array(512);
    
    // Populate permutation table
    for(let i = 0; i < 512; i++) { 
      this.perm[i] = this.p[i & 255]; 
      this.gradP[i] = this.grad3[this.perm[i] % 12]; 
    } 
  }
  
  noise(xin: number, yin: number): number {
    // Simple 2D noise implementation - produces values between -1 and 1
    let n0, n1, n2; // Noise contributions from the three corners
    
    // Skew the input space to determine which simplex cell we're in
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const s = (xin + yin) * F2; // Hairy factor for 2D
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    
    const G2 = (3 - Math.sqrt(3)) / 6;
    const t = (i + j) * G2;
    const X0 = i - t; // Unskew the cell origin back to (x,y) space
    const Y0 = j - t;
    const x0 = xin - X0; // The x,y distances from the cell origin
    const y0 = yin - Y0;
    
    // For the 2D case, the simplex shape is an equilateral triangle.
    // Determine which simplex we are in.
    let i1, j1; // Offsets for second (middle) corner of simplex in (i,j) coords
    if (x0 > y0) {
      i1 = 1; j1 = 0; // lower triangle, XY order: (0,0)->(1,0)->(1,1)
    } else {
      i1 = 0; j1 = 1; // upper triangle, YX order: (0,0)->(0,1)->(1,1)
    }
    
    // A step of (1,0) in (i,j) means a step of (1-c,-c) in (x,y), and
    // a step of (0,1) in (i,j) means a step of (-c,1-c) in (x,y), where
    // c = (3-sqrt(3))/6
    const x1 = x0 - i1 + G2; // Offsets for middle corner in (x,y) unskewed coords
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2; // Offsets for last corner in (x,y) unskewed coords
    const y2 = y0 - 1 + 2 * G2;
    
    // Work out the hashed gradient indices of the three simplex corners
    const ii = i & 255;
    const jj = j & 255;
    
    // Calculate the contribution from the three corners
    let t0 = 0.5 - x0*x0-y0*y0;
    if (t0 < 0) {
      n0 = 0;
    } else {
      t0 *= t0;
      const gi0 = this.perm[ii+this.perm[jj]] % 12;
      n0 = t0 * t0 * this.dot(this.gradP[gi0], x0, y0);
    }
    
    let t1 = 0.5 - x1*x1-y1*y1;
    if (t1 < 0) {
      n1 = 0;
    } else {
      t1 *= t1;
      const gi1 = this.perm[ii+i1+this.perm[jj+j1]] % 12;
      n1 = t1 * t1 * this.dot(this.gradP[gi1], x1, y1);
    }
    
    let t2 = 0.5 - x2*x2-y2*y2;
    if (t2 < 0) {
      n2 = 0;
    } else {
      t2 *= t2;
      const gi2 = this.perm[ii+1+this.perm[jj+1]] % 12;
      n2 = t2 * t2 * this.dot(this.gradP[gi2], x2, y2);
    }
    
    // Add contributions from each corner to get the final noise value.
    // The result is scaled to return values in the interval [-1,1].
    return 70 * (n0 + n1 + n2);
  }
  
  dot(g: number[], x: number, y: number): number {
    return g[0]*x + g[1]*y;
  }
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
  
  // Add additional terrain features and ridges
  y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 0.8;
  
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
 * A subtle near-white snow albedo. Low-amplitude tileable mottling (a sum of
 * periodic waves, so it wraps) breaks up the dead-flat white without ever leaving
 * "snow" range, with a faint cool tint in the dips. Repeated at a low frequency
 * so the broad blotches read as drift/wind variation, not a tiled pattern.
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
      // Tileable low-frequency mottle, normalised to ~[-1, 1].
      let n = Math.sin(2 * Math.PI * (1 * u + 2 * v));
      n += 0.6 * Math.sin(2 * Math.PI * (3 * u - 1 * v) + 1.3);
      n += 0.4 * Math.sin(2 * Math.PI * (2 * u + 3 * v) + 2.1);
      n /= 2.0;
      const base = 244 + n * 9;          // tight bright band (~235..253)
      const cool = Math.max(0, -n) * 6;  // slightly bluer in the dips
      const idx = (y * SIZE + x) * 4;
      data[idx] = base - cool;           // R
      data[idx + 1] = base - cool * 0.4; // G
      data[idx + 2] = Math.min(255, base); // B (kept full -> cool dips)
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 4);
  return tex;
}

/**
 * A tileable tangent-space normal map giving the snow its micro-relief: shallow
 * wind ripples / sastrugi plus a finer granular grain, so the large flat plane
 * catches the directional light instead of reading as a sheet. The height field
 * is a sum of integer-frequency waves (periodic => seamless), biased along one
 * axis so the ripples read as wind-blown drifts; normals are central differences
 * with wraparound.
 */
function createSnowNormalTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      // Wind ripples: low cross-axis freq, higher along-axis freq.
      let h = 0.6 * Math.sin(2 * Math.PI * (3 * u + 1 * v));
      h += 0.35 * Math.sin(2 * Math.PI * (7 * u + 2 * v) + 1.7);
      h += 0.22 * Math.sin(2 * Math.PI * (13 * u + 5 * v) + 0.6);
      // Fine granular grain (product of periodics stays tileable).
      h += 0.12 * Math.sin(2 * Math.PI * 21 * u) * Math.sin(2 * Math.PI * 19 * v);
      height[y * SIZE + x] = h;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  const STRENGTH = 2.0; // height -> slope gain
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
  tex.repeat.set(8, 10);
  // Normal maps are data, not colour: keep them out of any sRGB decode. (The
  // project disables ColorManagement, so this is belt-and-suspenders.)
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Bake per-vertex snow shading into the terrain geometry: flat areas stay bright
 * snow, steeper faces tint toward a cool wind-scoured crust (read from the mesh
 * normal's tilt). Applied via `vertexColors`, so it adds slope-dependent depth
 * without touching the height field — physics is unaffected. Mutates `geometry`
 * in place; call after `computeVertexNormals()`.
 */
function applySnowVertexColors(geometry: THREE.BufferGeometry): void {
  const normals = geometry.attributes.normal.array as Float32Array;
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const snow = { r: 1.0, g: 1.0, b: 1.0 };
  const crust = { r: 0.66, g: 0.72, b: 0.82 }; // cool grey-blue wind crust
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1];
    // normal.y ~1 on flats, lower on pitches; remap the useful band to 0..1.
    const tilt = Math.min(1, Math.max(0, (1 - ny) / 0.35));
    const t = tilt * 0.6; // even the steepest stays mostly snowy
    colors[i * 3] = snow.r + (crust.r - snow.r) * t;
    colors[i * 3 + 1] = snow.g + (crust.g - snow.g) * t;
    colors[i * 3 + 2] = snow.b + (crust.b - snow.b) * t;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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
    
    // Add natural terrain features and ridges
    y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 1.5;
    
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
  
  // Snow surface material (issue #17): a subtly mottled near-white albedo plus a
  // procedural micro-relief normal map (wind ripples / sastrugi) so the slope
  // reads as a real snow surface that catches the light, instead of the old flat
  // grey grid. Slope shading (bright snow -> cool wind crust on pitches) is baked
  // into the geometry's vertex colours and multiplied in via `vertexColors`.
  const albedo = createSnowAlbedoTexture();
  const normalMap = createSnowNormalTexture();
  applySnowVertexColors(geometry);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    map: albedo,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
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
  
  // Update terrain vertices after geometry changes
  geometry.computeVertexNormals();
  
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

  console.log(`Mountains.addRocks: Created ${collisionRockPositions.length} rock positions for collision detection`);
  return collisionRockPositions;
}

// Create a rock with variable size
function createRock(size: number): THREE.Mesh {
  // Use dodecahedron as base shape for rocks
  const geometry = new THREE.DodecahedronGeometry(size, 1);

  // Deform vertices slightly for more natural rock shape
  // (writable Float32Array under the read-only ArrayLike<number> type)
  const positions = geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < positions.length; i += 3) {
    const noise = Math.random() * 0.2;
    positions[i] *= (1 + noise);
    positions[i+1] *= (1 + noise);
    positions[i+2] *= (1 + noise);
  }
  geometry.computeVertexNormals();
  
  // Create rock material with varying colors
  const grayness = 0.4 + Math.random() * 0.3;
  const rockColor = new THREE.Color(grayness, grayness, grayness);
  
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: rockColor,
    roughness: 0.8,
    metalness: 0.2,
    flatShading: true
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
