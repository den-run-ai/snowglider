// mountains/contact-shadows.ts - Baked contact-AO decals under obstacles (issue #17).
//
// THE READABILITY GAP. Trees and rocks sit ON the bright snow with no grounding cue,
// so on an all-white slope a tree can read as floating / pasted-on. The slope tint and
// cavity/AO shade the terrain itself, but nothing darkens the snow right where an
// obstacle meets it. This adds a soft, baked **contact shadow** (ambient-occlusion blob)
// under each tree and large rock so hazards visually "sit in" the snow and pop against it.
//
// Why a single InstancedMesh (perf). The forest is a few hundred obstacles; a per-object
// decal mesh would blow the draw-call / geometry budget the perf-budget e2e guards
// (tests/e2e/perf-budget.spec.ts), exactly the trap the instanced forest itself avoids.
// So every blob is one instance of ONE shared horizontal quad with ONE shared material
// and ONE shared radial-alpha texture — a single extra draw call, one geometry, one
// texture. The blobs never cast or receive shadows (they ARE the shadow), so they add no
// shadow-pass cost either.
//
// Contract & safety. Purely cosmetic scenery, like rocks/trees/snowtracks: it only READS
// the injected terrain height + the obstacle positions the placement code already
// computed (no duplicated placement logic), and never touches pos/velocity, the physics
// kernel, or the height field — the determinism/physics-invariant harness is unaffected.
// Headless-safe: the radial texture is guarded on `document` (null in Node), and the rest
// is geometry + a colour material, so the Node tests build it exactly like the avalanche /
// snowtrails systems. Disposed by the generic scene sweep in game/teardown.ts (the mesh,
// its material, and the texture hung off `material.map` are all collected there).
import * as THREE from 'three';
import type { TreePosition } from './trees.js';
import type { RockPosition } from './rocks.js';

/** Terrain height sampler injected by the caller (same shape the other scenery uses). */
export type TerrainHeightFn = (x: number, z: number) => number;

// --- Tunables ---
// Contact shadows should read as cool powder AO, not black/brown stains on the snow.
// Keep the tree blobs tight: the real tree/canopy shadow already does the long-form
// grounding, this decal only darkens the immediate base.
const BLOB_OPACITY = 0.16;
const BLOB_COLOR = 0x6f7f91;   // cool blue-grey, blended lightly over white snow
const TREE_RADIUS_K = 1.15;    // blob radius = tree.scale * this
const ROCK_RADIUS_K = 0.95;    // blob radius = rock.size * this
const MIN_RADIUS = 0.65;       // floor so the smallest obstacles still read as grounded
const SURFACE_LIFT = 0.05;     // sit just above the snow to avoid z-fighting

/**
 * A radial alpha disc with a soft, non-opaque centre fading quickly to transparent at
 * the rim, so the instanced quad reads as subtle powder contact AO rather than a
 * visible circular stain. Guarded on `document` (returns null in Node) like the
 * snow/rock/tree normal maps.
 */
function createContactShadowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const data = image.data;
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - r, 2.2) * 0.75;
      const idx = (y * SIZE + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // alpha/AO data, not authored colour
  return tex;
}

/** Per-obstacle blob descriptor (world centre + radius). */
interface Blob { x: number; z: number; radius: number; }

/**
 * Build the contact-shadow blobs for the given trees + rocks and add them to the scene
 * as one InstancedMesh. Each blob is a horizontal quad centred on the obstacle, sized to
 * its footprint, and lifted just above the terrain. Returns the mesh (named
 * `contactShadows` for the scene-cleanup sweep + tests), or null when there is nothing
 * to place. Reuses the positions the placement code already produced — no duplicated
 * tree/rock placement logic.
 */
export function addContactShadows(
  scene: THREE.Scene,
  trees: TreePosition[],
  rocks: RockPosition[],
  getTerrainHeight: TerrainHeightFn
): THREE.InstancedMesh | null {
  const blobs: Blob[] = [];
  for (const t of trees) {
    blobs.push({ x: t.x, z: t.z, radius: Math.max(MIN_RADIUS, (t.scale || 1) * TREE_RADIUS_K) });
  }
  for (const r of rocks) {
    blobs.push({ x: r.x, z: r.z, radius: Math.max(MIN_RADIUS, (r.size || 1) * ROCK_RADIUS_K) });
  }
  if (blobs.length === 0) return null;

  // One shared horizontal unit quad; per-instance matrix scales it to the blob radius.
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const texture = createContactShadowTexture();
  const material = new THREE.MeshBasicMaterial({
    color: BLOB_COLOR,
    map: texture,            // null in headless -> a plain soft disc isn't drawn anyway
    transparent: true,
    opacity: BLOB_OPACITY,
    depthWrite: false,       // overlay: don't occlude / z-fight with itself or the snow
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, blobs.length);
  mesh.name = 'contactShadows';
  mesh.castShadow = false;     // it IS the (fake) shadow — never casts
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;  // one batch spanning the whole slope; don't cull as a unit
  mesh.renderOrder = 1;        // draw over the terrain surface

  const dummy = new THREE.Object3D();
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i]!;
    dummy.position.set(b.x, getTerrainHeight(b.x, b.z) + SURFACE_LIFT, b.z);
    dummy.scale.set(b.radius * 2, 1, b.radius * 2); // quad spans diameter
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}
