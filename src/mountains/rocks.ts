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
// The run's centerline: the clear collidable corridor + cliff exclusion follow it, and
// a Black run adds deterministic rock-gate pinches along it. activeLaneX is exactly 0
// for straight tiers, so `x - lane` collapses to `x` and Bunny/Blue stay byte-identical.
import { activeLaneX, getActiveCourseLine } from '../course-line.js';
import { SNOW_WHITE } from './snow-palette.js';

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
  // Clearance is measured from the run's centerline at this z (the winding corridor for
  // Black); lane === 0 for straight tiers, so this stays `Math.abs(x)` for Bunny/Blue.
  if (Math.abs(x - activeLaneX(z)) < ROCK_COLLISION_PATH_HALF_WIDTH + radius) return false;
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
      const hl = height[y * SIZE + wrap(x - 1)]!;
      const hr = height[y * SIZE + wrap(x + 1)]!;
      const hd = height[wrap(y - 1) * SIZE + x]!;
      const hu = height[wrap(y + 1) * SIZE + x]!;
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
  const normals = geometry.attributes.normal!.array as Float32Array;
  const count = geometry.attributes.position!.count;
  const colors = new Float32Array(count * 3);
  // Snow blanket toward the shared snow-cap white (snow-palette.ts) so the cap reads
  // as snow, not blown highlight — and matches the tree caps/shelves exactly. The
  // band starts lower and saturates sooner than before so up-facing faces are
  // convincingly *covered* (the previous 0.25..0.70 band left rocks reading as bare
  // grey crystals with only a faint dusting).
  const snowCol = SNOW_WHITE;
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1]!;
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
  let stone = ROCK_STONES[0]!;
  for (const e of ROCK_STONES) { stone = e; r -= e.weight; if (r <= 0) break; }
  const h = stone.h + (Math.random() - 0.5) * 0.03;
  const s = Math.min(0.45, Math.max(0, stone.s + (Math.random() - 0.5) * 0.06));
  const l = Math.min(0.7, Math.max(0.14, stone.l + (Math.random() - 0.5) * 0.12 - darken * 0.13));
  return new THREE.Color().setHSL(h, s, l);
}

// --- Seeded scrape pass ------------------------------------------------------
// gl-rock-style plane scrapes give the dodecahedron flat facets and shear faces.
// RNG-stream-neutral: a private mulberry32 stream (seeded per rock) does every
// draw, so the global Math.random() sequence — which tier determinism and the
// downstream tree/rock placement order depend on — is completely untouched.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fallback seed when the caller doesn't pass one: a stepped counter, not
// Math.random(), so createRock stays stream-neutral even seedless (mirrors
// ez-forest's private xorshift precedent for THREE uuid draws).
let rockSeedCounter = 0x2F6E2B1;

// Scrape geometry bounds. Vertices are never pulled inside KEEP_HULL_RADIUS of the
// rock's core: placement sinks boulders by size*0.3 and cliffs by size*0.28, so a
// hull floor at 0.45*size keeps every rock grounded with no floating or open base.
const SCRAPE_KEEP_HULL_RADIUS = 0.45;
const SCRAPE_OFFSET_MIN = 0.55; // plane offset r ∈ [0.55, 0.9]·size
const SCRAPE_OFFSET_SPAN = 0.35;

/** Options for createRock. `cliff` builds a larger, more angular, darker outcrop. */
export interface RockOptions {
  cliff?: boolean;
  /** Deterministic scrape-shape seed; same seed + size + cliff ⇒ identical scrape
   *  planes (the pre-existing radial jitter still rides the global Math.random()). */
  seed?: number;
  /** Disable the plane-scrape pass (default on). */
  scrape?: boolean;
  /** Override the number of scrape planes (default: boulders 3–5, cliffs 6–9). */
  scrapeCount?: number;
  /** 0..1 plane hardness — how fully vertices flatten onto each plane (default 1). */
  scrapeStrength?: number;
}

/**
 * Flatten `count` random planes into the (already jittered) rock hull. Each pass
 * picks a direction d and an offset r ∈ [0.55, 0.9]·size, then pulls every vertex
 * with dot(v,d) > r back toward the plane. Cliffs bias d toward the horizon so the
 * cuts read as sheer faces (plus an occasional top shelf); boulders stay isotropic.
 * The 0.45·size hull floor keeps the shape convex enough that the existing
 * sink-depth grounding in addRocks still works.
 */
function scrapeRock(
  positions: Float32Array, size: number, rng: () => number,
  count: number, strength: number, cliff: boolean
): void {
  const d = new THREE.Vector3();
  const keepSq = (SCRAPE_KEEP_HULL_RADIUS * size) ** 2;
  for (let s = 0; s < count; s++) {
    const az = rng() * Math.PI * 2;
    // Cliffs: mostly horizontal cut normals (sheer faces) + occasional top shelf.
    const el = cliff
      ? (rng() < 0.25 ? 0.9 + rng() * 0.5 : (rng() - 0.5) * 0.6)
      : Math.acos(2 * rng() - 1) - Math.PI / 2; // uniform over the sphere
    d.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const r = size * (SCRAPE_OFFSET_MIN + rng() * SCRAPE_OFFSET_SPAN);
    for (let i = 0; i < positions.length; i += 3) {
      const p = positions[i]! * d.x + positions[i + 1]! * d.y + positions[i + 2]! * d.z;
      if (p <= r) continue;
      const pull = (p - r) * strength;
      const nx = positions[i]! - d.x * pull;
      const ny = positions[i + 1]! - d.y * pull;
      const nz = positions[i + 2]! - d.z * pull;
      if (nx * nx + ny * ny + nz * nz < keepSq) continue; // keep the core hull
      positions[i] = nx; positions[i + 1] = ny; positions[i + 2] = nz;
    }
  }
}

// Create a rock with variable size
export function createRock(size: number, opts: RockOptions = {}): THREE.Mesh {
  const cliff = opts.cliff === true;
  // Cliffs use detail 0 (sharper, blockier facets) and a stronger, vertically biased
  // deformation so they read as craggy outcrops; ordinary rocks stay rounded boulders.
  const geometry = new THREE.DodecahedronGeometry(size, cliff ? 0 : 1);

  // Deform vertices for a more natural shape
  // (writable Float32Array under the read-only ArrayLike<number> type)
  const positions = geometry.attributes.position!.array as Float32Array;
  for (let i = 0; i < positions.length; i += 3) {
    if (cliff) {
      positions[i]!     *= 1 + (Math.random() - 0.25) * 0.5;
      positions[i + 1]! *= 1 + Math.random() * 0.7;        // stretch upward -> taller crag
      positions[i + 2]! *= 1 + (Math.random() - 0.25) * 0.5;
    } else {
      const noise = Math.random() * 0.2;
      positions[i]!     *= (1 + noise);
      positions[i + 1]! *= (1 + noise);
      positions[i + 2]! *= (1 + noise);
    }
  }

  // Seeded scrape pass: flatten a few random planes into the jittered hull so
  // boulders read as faceted rock and cliffs as sheared crag faces instead of
  // inflated dodecahedra. Runs BEFORE computeVertexNormals/applyRockSnowColors,
  // so up-facing scrape planes pick up coherent snow shelves for free.
  if (opts.scrape !== false) {
    const rng = mulberry32(opts.seed ?? (rockSeedCounter = (rockSeedCounter + 0x9E3779B9) | 0));
    const count = opts.scrapeCount ?? (cliff ? 6 + Math.floor(rng() * 4) : 3 + Math.floor(rng() * 3));
    scrapeRock(positions, size, rng, count, opts.scrapeStrength ?? 1, cliff);
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

// Add rocks to create a more realistic mountain environment.
//
// `outAllRendered`, when supplied, is filled with EVERY rendered rock (scatter boulders
// + cliff blocks), not just the collision-hazard subset that's returned. Contact shadows
// (mountains/contact-shadows.ts) need the full rendered set so decorative rocks — and
// large rocks filtered out of the hazard list by the ski-lane/spawn safety checks — still
// get a grounding blob (Codex review #243). Optional, so existing callers are unchanged.
export function addRocks(scene: THREE.Scene, outAllRendered?: RockPosition[]): RockPosition[] {
  // Remove any existing rocks from the scene to prevent duplicates
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i]!;
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

  const collisionRockPositions: RockPosition[] = [];

  // Deterministic per-placement scrape seed: derived from the (already
  // stream-stable) placement coordinates, so a given run re-creates identical
  // rock shapes without consuming any global Math.random() draws.
  const shapeSeed = (x: number, z: number): number =>
    (Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(z * 100), 19349663)) >>> 0;

  // Create rock instances
  rockPositions.forEach(pos => {
    // Get the exact terrain height from our height map or calculation
    const terrainHeight = getTerrainHeight(pos.x, pos.z);

    const rock = createRock(pos.size, { seed: shapeSeed(pos.x, pos.z) });

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
    outAllRendered?.push({ x: pos.x, y: terrainHeight, z: pos.z, size: pos.size });

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
    const lane = activeLaneX(z);
    for (let x = -130; x <= 130; x += 30) {
      // Keep the whole formation off the centerline (the ski corridor follows the line).
      if (Math.abs(x - lane) < 18) continue;
      const cx = x + (Math.random() * 14 - 7);
      const cz = z + (Math.random() * 14 - 7);
      if (Math.abs(cx - activeLaneX(cz)) < 16) continue;
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
        if (Math.abs(bx - activeLaneX(bz)) < 14) continue; // never let a satellite block drift onto the line
        const bSize = b === 0 ? baseSize : baseSize * (0.55 + Math.random() * 0.4);
        const bHeight = getTerrainHeight(bx, bz);

        const rock = createRock(bSize, { cliff: true, seed: shapeSeed(bx, bz) });
        rock.position.set(bx, bHeight - bSize * 0.28, bz);
        rock.rotation.y = Math.random() * Math.PI * 2;
        const g = getTerrainGradient(bx, bz);
        rock.rotation.x = Math.atan(g.z) * 0.8;
        rock.rotation.z = -Math.atan(g.x) * 0.8;
        scene.add(rock);
        outAllRendered?.push({ x: bx, y: bHeight, z: bz, size: bSize });

        if (rockIsCollisionHazard(bx, bz, bSize)) {
          collisionRockPositions.push({ x: bx, y: bHeight, z: bz, size: bSize });
        }
      }
    }
  }

  // Rock-gate pinches (Black). A few collidable rocks framing the corridor at intervals,
  // so the winding line threads a series of rock "gates": drift wide off the line and you
  // clip one. Placed DETERMINISTICALLY at the channel edge (just outside the collidable
  // clear corridor) so the on-line path stays clear and winnable — they punish leaving the
  // line, not following it. Only runs when a corridor line is active; straight tiers add
  // nothing here, so Bunny/Blue consume no extra Math.random() and stay byte-identical.
  // (Provisional placement; tightened/validated against the winnability harness in D3.2d.)
  const courseLine = getActiveCourseLine();
  if (courseLine) {
    const PINCH_Z = [-42, -78, -126, -168];   // between/around the checkpoints (-60,-105,-150)
    const PINCH_EDGE = 8;                       // > ROCK_COLLISION_PATH_HALF_WIDTH + radius ⇒ line stays clear
    const PINCH_SIZE = 2.2;                     // collidable (>= ROCK_COLLISION_MIN_SIZE)
    for (const pz of PINCH_Z) {
      const lx = courseLine.laneX(pz);
      for (const sideSign of [-1, 1]) {
        const rx = lx + sideSign * PINCH_EDGE;
        const ry = getTerrainHeight(rx, pz);
        const rock = createRock(PINCH_SIZE, { cliff: true, seed: shapeSeed(rx, pz) });
        rock.position.set(rx, ry - PINCH_SIZE * 0.28, pz);
        rock.rotation.y = Math.random() * Math.PI * 2;
        const g = getTerrainGradient(rx, pz);
        rock.rotation.x = Math.atan(g.z) * 0.8;
        rock.rotation.z = -Math.atan(g.x) * 0.8;
        scene.add(rock);
        collisionRockPositions.push({ x: rx, y: ry, z: pz, size: PINCH_SIZE });
        // Register with the rendered-rock list too (like the scatter + cliff rocks above), so
        // these collidable pinch hazards get the grounding contact-AO blob addContactShadows draws.
        outAllRendered?.push({ x: rx, y: ry, z: pz, size: PINCH_SIZE });
      }
    }
  }

  console.log(`Mountains.addRocks: Created ${collisionRockPositions.length} rock positions for collision detection`);
  return collisionRockPositions;
}
