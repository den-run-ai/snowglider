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
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
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

// --- Seeded convex-hull rock generator ---------------------------------------
// A scrape-a-dodecahedron pass (PR #304) could only press soft dents into a faceted
// sphere — vertex-pull without re-triangulating at the plane can't cleave a crisp
// edge, so ~90–100 of the 144 facet directions survived and rocks still read as
// lumpy spheres. Instead we build each rock as the CONVEX HULL of a small seeded
// point cloud: a hull yields real silhouettes, large planar facets, and crisp edges
// (and far fewer triangles). Shape is driven by a PRIVATE mulberry32 stream seeded
// per rock, so it is deterministic and reproducible without touching the global
// Math.random() sequence that tier determinism and downstream tree/rock placement
// depend on. The legacy per-rock global-draw budget is preserved explicitly (see
// LEGACY_GLOBAL_DRAWS below) so scenery placement stays byte-identical to main.
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
function nextRockSeed(): number {
  return (rockSeedCounter = (rockSeedCounter + 0x9E3779B9) | 0);
}

// Legacy per-rock global-Math.random() budget that createRock MUST keep consuming so
// addRocks leaves the global stream — and thus downstream cliff/rock rotation and ALL
// tree placement (terrain-mesh calls addRocks BEFORE addTrees on the same stream) —
// byte-identical to main. Measured on main's DodecahedronGeometry path and confirmed
// size-independent: boulder 448, cliff 340. (Historically: geometry/material/mesh UUID
// draws 4× each = 12, makeRockColor's 4, plus the old per-vertex deform loop — 432 for
// the detail-1 boulder, 324 for the detail-0 cliff.) Pinned absolutely by the RNG-budget
// test and end-to-end by the downstream-sentinel test in rocks-shape-tests.js.
const LEGACY_GLOBAL_DRAWS = { boulder: 448, cliff: 340 } as const;
// Global draws this path makes on its own before the compatibility burn: the ConvexGeometry
// UUID (4) + makeRockColor (4) + the MeshStandardMaterial UUID (4) + the Mesh UUID (4). The
// hull point cloud draws only from the private seeded stream, so it adds none. If this path's
// THREE construction ever changes (e.g. shared materials in a later PR), the RNG-budget test
// fails and this constant + the burn move together.
const CONSTRUCTION_GLOBAL_DRAWS = 16;

// Hull point-cloud radius envelope (× size). The floor keeps the base broad enough that
// the sink-depth grounding in addRocks (boulders size·0.3, cliffs size·0.28) never leaves
// a rock floating or hollow; the ceiling keeps it inside a sane bound. Re-derived for the
// hull and pinned by the shape test's grounding-envelope case.
const HULL_RADIUS_MIN = 0.72;
const HULL_RADIUS_SPAN = 0.38; // point radius r ∈ [0.72, 1.10]·size

/** Options for createRock. `cliff` builds a larger, taller, sheared, darker outcrop. */
export interface RockOptions {
  cliff?: boolean;
  /** Deterministic shape seed; same seed + size + cliff ⇒ byte-identical hull. */
  seed?: number;
}

/**
 * Seeded point cloud whose convex hull reads as a boulder (isotropic, flattened base)
 * or a crag (tall, one sheared vertical face). Pure function of the private `rng` — it
 * makes ZERO global Math.random() draws (each THREE.Vector3 carries no UUID). Points are
 * sampled on the unit sphere, pushed out to a jittered radius, then squashed/stretched:
 * horizontal anisotropy so no rock is a perfect ball; cliffs are stretched tall and have
 * one side sheared flat so the hull presents a sheer face; boulders get their underside
 * flattened so they sit grounded rather than balancing on a point.
 */
function seededRockPoints(rng: () => number, size: number, cliff: boolean): THREE.Vector3[] {
  const n = cliff ? 16 + Math.floor(rng() * 5) : 13 + Math.floor(rng() * 6);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const z = 2 * rng() - 1;
    const th = 2 * Math.PI * rng();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    let x = r * Math.cos(th), y = z, w = r * Math.sin(th);
    const rad = size * (HULL_RADIUS_MIN + HULL_RADIUS_SPAN * rng());
    x *= rad; y *= rad; w *= rad;
    x *= 0.85 + 0.4 * rng();          // horizontal anisotropy
    w *= 0.85 + 0.4 * rng();
    if (cliff) {
      y *= 1.5 + 0.9 * rng();         // stretch tall -> crag
      if (w > 0) w *= 0.25;           // shear one face flat -> sheer read
    } else if (y < -0.2 * size) {
      y *= 0.5;                       // flatten the base -> sits grounded
    }
    pts.push(new THREE.Vector3(x, y, w));
  }
  return pts;
}

// Create a rock with variable size
export function createRock(size: number, opts: RockOptions = {}): THREE.Mesh {
  const cliff = opts.cliff === true;

  // Build the rock as the convex hull of a private-seeded point cloud (see
  // seededRockPoints). computeVertexNormals gives each hull face flat per-face normals
  // (the geometry is non-indexed), so flatShading renders crisp facets and the snow
  // shelves below key off coherent up-facing normals. Zero global Math.random() draws
  // happen here — the shape rides entirely on the private stream.
  const rng = mulberry32(opts.seed ?? nextRockSeed());
  const geometry = new ConvexGeometry(seededRockPoints(rng, size, cliff));
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
  // Tag every rock so addRocks' re-run de-dup sweep matches by flag, not geometry type.
  // A ConvexGeometry reports `.type === 'BufferGeometry'`, so the old type match would
  // slip the sweep and duplicate rocks on every rebuild; the flag is geometry-agnostic.
  rock.userData.isRock = true;

  // Compatibility burn: consume the remainder of the legacy per-rock global-draw budget
  // so the hull generator leaves the global Math.random() stream exactly where main's
  // dodecahedron path did (see LEGACY_GLOBAL_DRAWS). Everything above already drew
  // CONSTRUCTION_GLOBAL_DRAWS global values; burn the rest so downstream scenery placement
  // stays byte-identical. The burned values are discarded — they only advance the stream.
  const burn = LEGACY_GLOBAL_DRAWS[cliff ? 'cliff' : 'boulder'] - CONSTRUCTION_GLOBAL_DRAWS;
  for (let i = 0; i < burn; i++) Math.random();

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
  // Remove any existing rocks from the scene to prevent duplicates. Rocks are tagged
  // `userData.isRock` in createRock, so the sweep is geometry-agnostic — it keeps
  // working if the rock geometry ever changes away from a dodecahedron.
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i]!;
    if (child.userData && child.userData.isRock === true) {
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
