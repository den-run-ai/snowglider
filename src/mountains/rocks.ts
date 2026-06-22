// mountains/rocks.ts - Rock scenery: meshes, snow-capped colouring, placement,
// and the collision-hazard subset.
//
// THREE-heavy (browser-only) plus the placement-time collision rules. Rocks are
// scenery — not on any physics/determinism path — but a placed rock large enough
// and clear of the ski corridor/spawn pocket is reported as a collision hazard
// (radius capped at 3u, in sync with snowman.ts's inline rock collision). Reads the
// analytic terrain samplers from terrain.js. Extracted from the mountains hub
// (Stage R-mountains, issue #34).
import * as THREE from 'three';
import { getTerrainHeight, getTerrainGradient } from './terrain.js';

/** A placed rock's world position and size. */
export interface RockPosition {
  x: number;
  y: number;
  z: number;
  size: number;
}

export const ROCK_COLLISION_MIN_SIZE = 1.25;

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
export function rockIsCollisionHazard(x: number, z: number, size: number): boolean {
  if (size < ROCK_COLLISION_MIN_SIZE) return false;
  const radius = rockCollisionRadius(size);
  if (Math.abs(x) < ROCK_COLLISION_PATH_HALF_WIDTH + radius) return false;
  const dx = x - SNOWMAN_START_X;
  const dz = z - SNOWMAN_START_Z;
  if (Math.sqrt(dx * dx + dz * dz) < ROCK_COLLISION_START_CLEAR_RADIUS + radius) return false;
  return true;
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
export function createRock(size: number, opts: RockOptions = {}): THREE.Mesh {
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

// Add rocks to create a more realistic mountain environment
export function addRocks(scene: THREE.Scene): RockPosition[] {
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
