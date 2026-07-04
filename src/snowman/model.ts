// Snowman geometry/model construction.
import * as THREE from 'three';
import { getSnowmanSnowMaterial } from './snow-material.js';
import { createSkis } from './ski.js';

// The shaped skis (issue #189) — geometry, loft builder, and per-tier top-sheet
// colours — live in ./ski.ts. SKI_TOP_SHEET is re-exported here so existing importers
// of './model.js' (index.ts, the snow-palette tests) keep resolving it unchanged.
export { SKI_TOP_SHEET } from './ski.js';

/** Cosmetic options for createSnowman. Everything defaults to the shipped look. */
export interface SnowmanModelOptions {
  /** Ski top-sheet colour (default: the blue-tier red, SKI_TOP_SHEET.blue). */
  skiTopSheet?: number;
}

// --- Junction-crease shading (completion-plan PR-V4, the last #17 item) -----
// The ring where two snowballs meet is the snowman's "cavity" (cf. the terrain
// cavity/AO vertex term in mountains/snow-surface.ts): real stacked snow reads a
// faint cool shadow in that crease, while a bare white-on-white seam reads plastic.
// Bake the tint into each sphere's vertex colours (the shared snow material has
// `vertexColors` on) — full strength at/beyond the crease latitude (most of that cap
// is hidden inside the neighbouring ball anyway; the visible fringe gets the fade),
// feathering back to plain white over CREASE_FEATHER of latitude.
const CREASE_TINT = { r: 0.86, g: 0.9, b: 0.95 }; // faint cool powder-shadow hue
const CREASE_FEATHER = 0.25;                       // latitude span of the fade

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth01 = (t: number): number => { const c = clamp01(t); return c * c * (3 - 2 * c); };

/** Bake the crease tint into a body sphere's vertex colours. `top`/`bottom` are the
 *  normalized crease latitudes (localY / radius, -1..1) where this ball meets its
 *  neighbour — derived from the sphere-sphere intersection of the shipped layout. */
function bakeJunctionTint(
  geo: THREE.SphereGeometry,
  radius: number,
  creases: { top?: number; bottom?: number }
): void {
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / radius; // -1 (bottom pole) .. 1 (top pole)
    let k = 0;
    if (creases.top !== undefined) {
      k = Math.max(k, smooth01((ny - (creases.top - CREASE_FEATHER)) / CREASE_FEATHER));
    }
    if (creases.bottom !== undefined) {
      k = Math.max(k, smooth01(((creases.bottom + CREASE_FEATHER) - ny) / CREASE_FEATHER));
    }
    colors[i * 3] = 1 - k * (1 - CREASE_TINT.r);
    colors[i * 3 + 1] = 1 - k * (1 - CREASE_TINT.g);
    colors[i * 3 + 2] = 1 - k * (1 - CREASE_TINT.b);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Create Snowman (Three Spheres)
export function createSnowman(scene: THREE.Scene, opts: SnowmanModelOptions = {}): THREE.Group {
  const group = new THREE.Group();
  // Shared snowman/debris snow material (PR-V4): the same albedo/normal generators as
  // the terrain snow, so the player stops reading as plastic against the slope. One
  // module-level instance shared with the crash debris — see snow-material.ts for the
  // ownership/teardown contract.
  const snowMaterial = getSnowmanSnowMaterial();
  const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const carrotMaterial = new THREE.MeshStandardMaterial({ color: 0xFF6600 });
  const stickMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown for sticks
  const hatMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 }); // Dark grey/black for hat

  // Crease latitudes from the shipped layout (centres y=2/4.5/7, radii 2/1.5/1):
  // bottom↔middle intersect at world y=3.6 (bottom ny=0.8, middle ny=-0.6);
  // middle↔head are tangent at world y=6.0 (middle ny=1.0, head ny=-1.0).

  // Bottom sphere
  const bottomGeo = new THREE.SphereGeometry(2, 24, 24);
  bakeJunctionTint(bottomGeo, 2, { top: 0.8 });
  const bottom = new THREE.Mesh(bottomGeo, snowMaterial);
  bottom.position.y = 2;
  bottom.castShadow = true;
  group.add(bottom);

  // Middle sphere
  const middleGeo = new THREE.SphereGeometry(1.5, 24, 24);
  bakeJunctionTint(middleGeo, 1.5, { top: 1.0, bottom: -0.6 });
  const middle = new THREE.Mesh(middleGeo, snowMaterial);
  middle.position.y = 4.5;
  middle.castShadow = true;
  group.add(middle);

  // Head sphere
  const headGeo = new THREE.SphereGeometry(1, 24, 24);
  bakeJunctionTint(headGeo, 1, { bottom: -1.0 });
  const head = new THREE.Mesh(headGeo, snowMaterial);
  head.position.y = 7.0; // Lowered head to sit on middle sphere (4.5 + 1.5 + 1.0)
  head.castShadow = true;
  group.add(head);
  
  // Eyes
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  leftEye.position.set(0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(leftEye);
  
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  rightEye.position.set(-0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(rightEye);
  
  // Carrot nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1, 12), carrotMaterial);
  nose.position.set(0, 7.0, 1); // Adjusted Y based on new head position
  nose.rotation.x = Math.PI / 2;
  group.add(nose);
  
  // Buttons — parented to the BALL they sit on (not the root group) so the flex
  // layer's per-frame squash-and-stretch of that ball carries them along its moving
  // surface. As siblings of the balls they stayed at fixed positions while the belly
  // scaled, so a squashing middle/bottom sphere left the buttons suspended in front of
  // the snowman (issue #337). Positions are BALL-LOCAL (world pos minus the ball's
  // centre) so the shipped rest pose is byte-identical; the buttons now ride (and
  // gently deform with) the snow they're pressed into.
  const buttonGeometry = new THREE.SphereGeometry(0.15, 12, 12);
  const button1 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button1.position.set(0, 5.5 - middle.position.y, 1.4); // middle-local (world y 5.5)
  middle.add(button1);

  const button2 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button2.position.set(0, 4.5 - middle.position.y, 1.45); // middle-local (world y 4.5)
  middle.add(button2);

  const button3 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button3.position.set(0, 3.0 - bottom.position.y, 1.9); // bottom-local (world y 3.0)
  bottom.add(button3);
  
  // --- Stick Arms ---
  // Create a function to build a branched arm
  function createBranchArm(isLeft: boolean): THREE.Group {
    const armGroup = new THREE.Group();
    const mainStickLength = 2.5;
    const mainStickRadius = 0.08; // Slightly thinner radius
    const segments = 8; // Segments for the tube

    // Create a slightly irregular path for the main stick
    const pathPoints = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, mainStickLength * 0.4, isLeft ? 0.1 : -0.1), // Slight bend
      new THREE.Vector3(isLeft ? -0.1 : 0.1, mainStickLength * 0.8, 0), // Another slight bend
      new THREE.Vector3(0, mainStickLength, 0) // End point
    ];
    const curve = new THREE.CatmullRomCurve3(pathPoints);

    // Main stick using TubeGeometry
    const mainStickGeom = new THREE.TubeGeometry(curve, segments * 2, mainStickRadius, 5, false); // Fewer radial segments
    const mainStick = new THREE.Mesh(mainStickGeom, stickMaterial);
    // No need to translate geometry origin with TubeGeometry path starting at 0,0,0
    mainStick.rotation.z = isLeft ? -Math.PI / 10 : Math.PI / 10; // Adjusted angle slightly
    mainStick.castShadow = true;
    armGroup.add(mainStick);

    // Small branch 1 (thinner)
    const branch1Length = 0.8;
    const branch1Radius = 0.05;
    const branch1 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch1Radius, branch1Radius * 0.7, branch1Length, 5), // Fewer segments
      stickMaterial
    );
    branch1.geometry.translate(0, branch1Length / 2, 0); // Move origin to base
    // Attach near the first bend point using curve.getPointAt
    const attachPoint1 = curve.getPointAt(0.5); // Get point halfway along the curve
    branch1.position.copy(attachPoint1);
    branch1.rotation.z = isLeft ? -Math.PI / 5 : Math.PI / 5; // Angle outward more
    branch1.rotation.x = Math.PI / 12; // Angle slightly forward
    branch1.castShadow = true;
    mainStick.add(branch1); // Add as child of main stick

    // Small branch 2 (optional, smaller and thinner)
    const branch2Length = 0.5;
    const branch2Radius = 0.04;
    const branch2 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch2Radius, branch2Radius * 0.7, branch2Length, 5), // Fewer segments
      stickMaterial
    );
    branch2.geometry.translate(0, branch2Length / 2, 0); // Move origin to base
    // Attach near the second bend point
    const attachPoint2 = curve.getPointAt(0.8); // Get point further along the curve
    branch2.position.copy(attachPoint2);
    branch2.rotation.z = isLeft ? Math.PI / 4 : -Math.PI / 4; // Angle more sharply
    branch2.rotation.x = -Math.PI / 10; // Angle slightly backward
    branch2.castShadow = true;
    mainStick.add(branch2); // Add as child of main stick

    // Position the entire arm group
    // Attach to middle sphere, slightly adjusted position
    armGroup.position.set(isLeft ? 1.35 : -1.35, 4.9, 0); // Adjusted position slightly
    // Rotate slightly forward and outward
    armGroup.rotation.x = Math.PI / 16; // Less forward tilt
    armGroup.rotation.y = isLeft ? -Math.PI / 8 : Math.PI / 8; // Rotate arms outward more

    return armGroup;
  }

  // Left Arm
  const leftArmGroup = createBranchArm(true);
  group.add(leftArmGroup);

  // Right Arm
  const rightArmGroup = createBranchArm(false);
  group.add(rightArmGroup);
  // --- End Stick Arms ---
  
  // Hat
  const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.2, 24), hatMaterial);
  hatBase.position.y = 7.9; // Adjusted Y based on new head position: 7.0 (head_y) + 1.0 (head_r) - 0.1
  hatBase.castShadow = true;
  group.add(hatBase);
  
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 24), hatMaterial);
  hatTop.position.y = 8.45; // Adjusted Y: 7.9 (base_y) + 0.1 (base_half_h) + 0.45 (new_top_half_h)
  hatTop.castShadow = true;
  group.add(hatTop);
  
  // --- Shaped skis (issue #189) ---------------------------------------------
  // The lofted ski geometry (sidecut + shovel + tail-kick, steel edges, binding) lives
  // in ./ski.ts. createSkis() parents the two ski root GROUPS under `group`; pose.ts
  // owns each root transform (snowplow wedge / parallel edge+draw) and the flex layer
  // bends the returned tip/tail arms (wired into the part registry below).
  const { left, right } = createSkis(group, opts.skiTopSheet);
  const leftSki = left.root, rightSki = right.root;

  // --- Scarf (issue #53, optional follow-up PR C) ---------------------------
  // A red wool scarf: a torus wrap at the narrow neck seam + a short two-segment tail
  // draped down the front. The tail is its own neck-pivoted group so the flex layer can
  // swing it in the wind (Flex already handles `scarfTail` present-or-absent), and both
  // join the registries below so the crash shatter flings them too. Kept OUT of the head
  // cluster so head bob doesn't drag the scarf.
  const scarfMaterial = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 1.0 });
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.26, 8, 16), scarfMaterial);
  scarf.position.set(0, 6.1, 0);
  scarf.rotation.x = Math.PI / 2; // lie flat around the neck
  scarf.castShadow = true;
  group.add(scarf);

  const scarfTail = new THREE.Group();
  const tailSeg1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.7, 0.16), scarfMaterial);
  tailSeg1.position.y = -0.35;
  tailSeg1.castShadow = true;
  scarfTail.add(tailSeg1);
  const tailSeg2 = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.6, 0.14), scarfMaterial);
  tailSeg2.position.set(0.04, -0.9, 0);
  tailSeg2.rotation.z = -0.18;
  tailSeg2.castShadow = true;
  scarfTail.add(tailSeg2);
  // Anchor at the neck-front and DRAPE FORWARD so the tail hangs in front of the middle
  // snowball instead of being buried inside it: the middle sphere (center y=4.5, r=1.5)
  // bulges out to z≈1.1–1.3 over the tail's vertical range, so a straight tail at z≈0.55
  // would be occluded by the opaque body. Tilting the group forward (rotation.x ≈ -0.6)
  // sends its local -Y axis down-and-out (+z), keeping the tail just outside the chest
  // surface and visible in the front/chase view. Flex preserves this drape (it offsets
  // rotation.x from the base) and only swings rotation.z in the wind.
  scarfTail.position.set(0.3, 6.25, 0.75); // neck-front, just outside the narrow neck
  scarfTail.rotation.x = -0.8;             // drape forward over the chest (clears the snowball)
  group.add(scarfTail);
  // Verified: at the resting base angle and the flex-animated grounded (+0.1) and
  // airborne (-0.3) offsets, both tail segments stay in front of the body spheres.

  // --- Head cluster (issue #53) ---------------------------------------------
  // Parent the head sphere AND its accessories (eyes, nose, hat) into one
  // neck-pivoted group so the flexibility/jiggle layer (src/snowman-flex.ts) can
  // bob/lean the whole face + hat together instead of sliding the accessories off a
  // bare head mesh. Re-basing each child's y by NECK_Y keeps world positions
  // identical at rest, so this is purely structural — no visual or physics change.
  // headGroup is a THREE.Group (no geometry/material), which the PR-B shatter loop
  // handles via its isMesh branch (the whole head breaks off as one piece).
  const NECK_Y = 6.0; // top of the middle sphere / base of the head — a natural pivot
  const headGroup = new THREE.Group();
  headGroup.position.set(0, NECK_Y, 0);
  head.position.y -= NECK_Y;     // head into headGroup-local space (identical world y)
  headGroup.add(head);           // Object3D.add() reparents from `group`
  // Glue the face + hat to the head MESH (not just the cluster). headGroup carries the
  // whole face when the flex layer BOBS/LEANS it, but the layer also SQUASH-STRETCHES
  // the `head` mesh itself every frame (head is one of the three breathing balls). As
  // siblings of `head` the eyes/nose/hat ignored that scale and detached from the
  // moving head surface, the same defect as the buttons (issue #337). Nesting them
  // under `head` makes them ride (and gently deform with) the head. Positions rebase
  // into head-local so world placement is byte-identical at rest.
  for (const part of [leftEye, rightEye, nose, hatBase, hatTop]) {
    part.position.y -= NECK_Y;         // group -> headGroup-local (identical world y)
    part.position.sub(head.position);  // headGroup-local -> head-local
    head.add(part);                    // Object3D.add() reparents onto the head mesh
  }
  group.add(headGroup);

  // Keep references + neutral pose so ski technique (e.g. snowplow wedge) can be shown.
  group.userData = group.userData || {};
  group.userData.leftSki = leftSki;
  group.userData.rightSki = rightSki;
  group.userData.leftSkiBaseX = leftSki.position.x;
  group.userData.rightSkiBaseX = rightSki.position.x;

  // --- Cosmetic part registries (issue #53) ---------------------------------
  // FLEX registry: fine-grained animatable refs read by src/snowman-flex.ts. Every
  // value is a renderable Object3D; headGroup is the neck-pivoted cluster above.
  group.userData.parts = {
    bottom, middle,
    headGroup, head,
    leftEye, rightEye, nose,
    button1, button2, button3,
    leftArmGroup, rightArmGroup,
    hatBase, hatTop,
    scarf, scarfTail,
    // Ski flex arms (issue #189): the only ski transforms the flex layer writes
    // (rotation.x bend). The ski ROOTS (leftSki/rightSki) stay off the registry so
    // pose.ts keeps sole ownership of the wedge/edge/draw transform.
    leftSkiTip: left.tipArm, leftSkiTail: left.tailArm,
    rightSkiTip: right.tipArm, rightSkiTail: right.tailArm
  };
  // SHATTER roots: the flat list of TOP-LEVEL rigid pieces the PR-B debris system
  // flings, so accessories ride with their cluster instead of being double-spawned.
  // headGroup + arms (+ scarfTail) are THREE.Groups; the shatter loop branches on
  // `part.isMesh` (the scarf wrap is a Mesh).
  group.userData.shatterRoots = [
    bottom, middle, headGroup,
    leftArmGroup, rightArmGroup,
    button1, button2, button3,
    scarf, scarfTail
  ];
  // --- Freestyle flip pivot (jump-system completion JP-5, plan §6.1) ----------
  // The group root's origin sits at the SKI BASE (spheres at y = 2 / 4.5 / 7), so a
  // flip applied to the root orbits the feet — visually wrong (a somersault rotates
  // about the body's center of mass). Interpose one child group at the mass-weighted
  // center (radii 2 / 1.5 / 1 ⇒ masses ∝ 8 / 3.375 / 1 ⇒ COM ≈ y 3.1) holding EVERY
  // part (skis included — the whole snowman flips), each child re-based by −COM_Y so
  // world placement is identical at rest. pose.ts applies `trickFlip` to THIS pivot
  // while the root keeps position / yaw / terrain tilt — so the follow camera (which
  // reads the root) stays steady through a flip. Purely structural: the userData
  // part/shatter registries keep their references (debris resolves world transforms
  // via getWorldPosition), and partBaseTransforms below is recorded AFTER the
  // restructure so the flex layer's neutral bases match the new locals.
  const COM_Y = 3.1;
  const flipPivot = new THREE.Group();
  flipPivot.position.y = COM_Y;
  for (const child of [...group.children]) {
    child.position.y -= COM_Y;
    flipPivot.add(child); // Object3D.add() reparents from `group`
  }
  group.add(flipPivot);
  group.userData.flipPivot = flipPivot;

  // Neutral local transforms, kept OFF the registries so a generic loop over .parts
  // / .shatterRoots only ever sees renderable Object3Ds. Keyed by the same names so
  // the flex layer can pair part <-> base and restore exactly on reset.
  group.userData.partBaseTransforms = recordBaseTransforms(group.userData.parts);

  scene.add(group);
  return group;
}

/** A plain-number snapshot of a part's neutral local transform. */
interface BaseTransform {
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

/** Snapshot each part's neutral local position/scale/rotation so the cosmetic flex
 *  layer can animate as offsets from neutral and restore exactly on reset. Stored as
 *  plain numbers (not Vector3/Euler) so the baseline survives independent of the live
 *  object's later mutation. */
function recordBaseTransforms(parts: Record<string, THREE.Object3D>): Record<string, BaseTransform> {
  const out: Record<string, BaseTransform> = {};
  for (const [key, p] of Object.entries(parts)) {
    out[key] = {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      scale: { x: p.scale.x, y: p.scale.y, z: p.scale.z },
      rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z }
    };
  }
  return out;
}
