// Snowman ski geometry (issue #189) — the shaped, lofted skis, extracted from model.ts.
// Owns the ski longitudinal profile (sidecut + camber/shovel/tail-kick), the loft
// builder (buildSkiArm), the per-tier top-sheet colours, and createSkis(), which
// assembles the two pose-owned ski root GROUPS (each = tip arm + tail arm + binding)
// and parents them under the snowman group. Purely cosmetic — no physics. model.ts
// wires the returned tip/tail arms into the flex registry (src/snowman-flex.ts bends
// them, rotation.x only) while pose.ts owns the root transform (snowplow wedge /
// parallel edge+draw).
import * as THREE from 'three';
import type { Difficulty } from '../difficulty.js';

// --- Difficulty-themed ski top sheets (PR 2 of the visual-materials plan) ----
// One accent colour per tier, echoing real trail-marker colours where they exist.
// Blue keeps the shipped red so the default tier's snowman is byte-identical to
// before; black goes near-black (the steel edges + bindings carry the contrast).
export const SKI_TOP_SHEET: Record<Difficulty, number> = {
  bunny: 0x3CA657,  // trail-marker green
  blue: 0xD42B2B,   // the original red — default tier's look is a visual no-op
  black: 0x23232A,  // near-black stealth
  expert: 0xE0A32E, // amber/gold
};

// --- Ski longitudinal profile (issue #189) ----------------------------------
// The ski is a loft along its length (absolute ski-z: -z = tail, +z = tip), driven by
// two control-point curves smoothly interpolated by sampleProfile(). SKI_WIDTH is the
// top-view half-width (the sidecut: wide shovel, narrow waist, medium tail, pinched to
// rounded end caps); SKI_CENTER_Y is the side-profile centerline (a gentle camber bump
// at the waist, a rising shovel toward the tip, and a small tail kick). Both arms sample
// these in absolute z, so their shared waist cross-section matches exactly (no seam).
const SKI_Z_TAIL = -2.9;
const SKI_Z_TIP = 3.3;
const SKI_Z_WAIST = -0.1;       // pivot / binding location
const SKI_SEAM_OVERLAP = 0.28;  // how far each arm runs past the waist to hide the bend seam

type ProfilePt = readonly [number, number]; // [ski-z, value]
const SKI_WIDTH: ReadonlyArray<ProfilePt> = [
  [-2.9, 0.06], [-2.5, 0.21], [-2.0, 0.25], [-0.1, 0.17],
  [1.6, 0.29], [2.2, 0.30], [3.0, 0.19], [3.3, 0.06]
];
const SKI_CENTER_Y: ReadonlyArray<ProfilePt> = [
  [-2.9, 0.17], [-2.4, 0.05], [-1.8, 0.0], [-0.1, 0.04],
  // Shovel/tip rise kept to a gentle, realistic alpine curve: the old peak (0.47 at
  // the tip, climbing 0.13->0.31->0.47) curled up like a water-ski/sled and read
  // physically wrong on the snowman. Halving it to ~0.24 keeps a visible shovel
  // upturn without the "tips flipping up" look (issue: unrealistic ski tips).
  [1.6, 0.0], [2.4, 0.07], [3.0, 0.16], [3.3, 0.24]
];

const smoothstep = (t: number): number => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** Smoothly interpolate a control-point curve at ski-z (clamped, smoothstep between pts). */
function sampleProfile(z: number, pts: ReadonlyArray<ProfilePt>): number {
  if (z <= pts[0]![0]) return pts[0]![1];
  const n = pts.length;
  if (z >= pts[n - 1]![0]) return pts[n - 1]![1];
  for (let i = 0; i < n - 1; i++) {
    const [z0, v0] = pts[i]!, [z1, v1] = pts[i + 1]!;
    if (z >= z0 && z <= z1) return v0 + (v1 - v0) * smoothstep((z - z0) / (z1 - z0));
  }
  return pts[n - 1]![1];
}

/** Thickness taper -> 0 toward both ends so the caps round off instead of ending blunt. */
function skiThicknessScale(z: number): number {
  const fade = 0.55;
  return 0.18 + 0.82 * Math.min(smoothstep((SKI_Z_TIP - z) / fade), smoothstep((z - SKI_Z_TAIL) / fade));
}

// Cross-section ring: 6 vertices (base-L, mid-L, top-L, top-R, mid-R, base-R). The mid
// vertices are the widest line — the steel edge. The 6 ring edges map to materials:
//   0:(0-1) lower-left  -> steel    3:(3-4) upper-right -> top-sheet
//   1:(1-2) upper-left  -> top-sheet 4:(4-5) lower-right -> steel
//   2:(2-3) top         -> top-sheet 5:(5-0) base        -> base
const RING_MAT: ReadonlyArray<number> = [2, 0, 0, 0, 2, 1]; // 0=top-sheet,1=base,2=steel

/** Build one ski arm as a lofted, capped BufferGeometry with three material groups
 *  (top-sheet / base / steel-edge). `z0..z1` is the absolute ski-z span; vertices are
 *  emitted in arm-local space (waist at z=0) so the mesh can pivot at the waist. */
function buildSkiArm(z0: number, z1: number): THREE.BufferGeometry {
  const STATIONS = 22;
  const positions: number[] = [];
  // Per-material triangle index buckets, concatenated into one index buffer + groups.
  const buckets: number[][] = [[], [], []]; // top-sheet, base, steel

  for (let s = 0; s < STATIONS; s++) {
    const z = z0 + (z1 - z0) * (s / (STATIONS - 1));
    const w = sampleProfile(z, SKI_WIDTH);
    const cy = sampleProfile(z, SKI_CENTER_Y);
    const ts = skiThicknessScale(z);
    const topH = 0.05 * ts, baseH = 0.07 * ts;
    const wTop = w * 0.82, wMid = w, wBase = w * 0.9;
    const lz = z - SKI_Z_WAIST; // arm-local z (waist pivot at 0)
    positions.push(
      -wBase, cy - baseH, lz,   // 0 base-left
      -wMid, cy, lz,            // 1 mid-left (steel)
      -wTop, cy + topH, lz,     // 2 top-left
      wTop, cy + topH, lz,      // 3 top-right
      wMid, cy, lz,             // 4 mid-right (steel)
      wBase, cy - baseH, lz     // 5 base-right
    );
  }

  // Side quads between adjacent stations (consistent winding around the tube).
  for (let s = 0; s < STATIONS - 1; s++) {
    const a = s * 6, b = (s + 1) * 6;
    for (let e = 0; e < 6; e++) {
      const r0 = e, r1 = (e + 1) % 6;
      const v00 = a + r0, v01 = a + r1, v10 = b + r0, v11 = b + r1;
      buckets[RING_MAT[e]!]!.push(v00, v10, v11, v00, v11, v01);
    }
  }

  // End caps: a center vertex per end + a fan to its ring, so the arm reads solid and
  // casts a clean shadow. Both caps ride with the top-sheet group.
  const ringCenter = (s: number): number => {
    const base = s * 6, idx = positions.length / 3;
    // average the ring's 6 verts for a centroid cap vertex
    let x = 0, y = 0, zz = 0;
    for (let r = 0; r < 6; r++) { x += positions[(base + r) * 3]!; y += positions[(base + r) * 3 + 1]!; zz += positions[(base + r) * 3 + 2]!; }
    positions.push(x / 6, y / 6, zz / 6);
    return idx;
  };
  const c0 = ringCenter(0);
  for (let e = 0; e < 6; e++) buckets[0]!.push(c0, (e + 1) % 6, e);
  const last = (STATIONS - 1) * 6;
  const cN = ringCenter(STATIONS - 1);
  for (let e = 0; e < 6; e++) buckets[0]!.push(cN, last + e, last + (e + 1) % 6);

  const indices = [...buckets[0]!, ...buckets[1]!, ...buckets[2]!];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.addGroup(0, buckets[0]!.length, 0);
  geom.addGroup(buckets[0]!.length, buckets[1]!.length, 1);
  geom.addGroup(buckets[0]!.length + buckets[1]!.length, buckets[2]!.length, 2);
  geom.computeVertexNormals();
  return geom;
}

/** One assembled ski: the pose-owned root group + the two flex-bent arms. */
export interface ShapedSki {
  root: THREE.Group;
  tipArm: THREE.Mesh;
  tailArm: THREE.Mesh;
}

/** Build both (mirrored) skis and parent their root groups under `parent`. Returns the
 *  left/right roots + tip/tail arms so the caller can wire the arms into the flex
 *  registry. `skiTopSheet` overrides the top-sheet colour (default: the blue-tier red).
 *
 *  Each ski is a pose-owned root GROUP holding two pivot arms (tip + tail) that overlap
 *  at the waist so the surface reads as one continuous ski; the cosmetic flex layer
 *  (src/snowman-flex.ts) bends those arms (rotation.x only) for camber/landing/carve,
 *  while pose.ts owns the root transform (snowplow wedge / parallel edge+draw). DoubleSide
 *  keeps the hand-wound loft solid from every angle (no reliance on a single correct
 *  triangle winding across the lofted tube + caps). */
export function createSkis(parent: THREE.Group, skiTopSheet?: number): { left: ShapedSki; right: ShapedSki } {
  const topSheetMat = new THREE.MeshStandardMaterial({ color: skiTopSheet ?? SKI_TOP_SHEET.blue, roughness: 0.5, side: THREE.DoubleSide }); // per-tier top-sheet (default: the original red)
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1A1A20, roughness: 0.7, side: THREE.DoubleSide });     // dark sintered base
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xB8BCC4, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }); // steel edge
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x202024, roughness: 0.6 });     // binding boot
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x55585F, roughness: 0.4, metalness: 0.5 }); // binding plate
  const skiMats = [topSheetMat, baseMat, steelMat];

  // Build one ski (root group + tip/tail arms + binding). Mirrored by `side`.
  function createShapedSki(side: number): ShapedSki {
    const root = new THREE.Group();
    root.position.set(side, 0.1, 1);

    // Two arms share the SAME longitudinal profile sampled in absolute ski-z, so their
    // cross-sections are identical at the waist seam; each is built in arm-local space
    // (waist at z=0) and overlaps SKI_SEAM_OVERLAP past the waist so a flex bend never
    // opens a visible gap. Pivot lives at the waist (root-local z = SKI_Z_WAIST).
    const tipArm = new THREE.Mesh(buildSkiArm(SKI_Z_WAIST - SKI_SEAM_OVERLAP, SKI_Z_TIP), skiMats);
    const tailArm = new THREE.Mesh(buildSkiArm(SKI_Z_TAIL, SKI_Z_WAIST + SKI_SEAM_OVERLAP), skiMats);
    for (const arm of [tipArm, tailArm]) {
      arm.position.z = SKI_Z_WAIST; // arm-local origin -> waist pivot
      arm.castShadow = true;
      root.add(arm);
    }

    // Binding: a metal plate + boot block, parented to the ROOT (not the arms) so it sits
    // over the waist seam and hides the joint while the arms flex underneath it.
    const binding = new THREE.Group();
    const waistY = sampleProfile(SKI_Z_WAIST, SKI_CENTER_Y);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.9), plateMat);
    plate.position.set(0, waistY + 0.075, 0);
    plate.castShadow = true;
    binding.add(plate);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.52), bootMat);
    boot.position.set(0, waistY + 0.2, 0.02);
    boot.castShadow = true;
    binding.add(boot);
    binding.position.z = SKI_Z_WAIST;
    root.add(binding);

    parent.add(root);
    return { root, tipArm, tailArm };
  }

  const left = createShapedSki(-1);
  const right = createShapedSki(1);
  return { left, right };
}
