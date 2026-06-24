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
      const hl = h[y * size + wrap(x - 1)], hr = h[y * size + wrap(x + 1)];
      const hd = h[wrap(y - 1) * size + x], hu = h[wrap(y + 1) * size + x];
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
let trunkMaterials: THREE.MeshStandardMaterial[] | null = null;
let foliageMaterials: THREE.MeshStandardMaterial[] | null = null;
let snowMaterial: THREE.MeshStandardMaterial | null = null;

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

/** Small palette of brown bark shades (the old per-trunk HSL range, quantised). */
function getTrunkMaterials(): THREE.MeshStandardMaterial[] {
  if (!trunkMaterials) {
    const normalMap = getBarkNormal();
    const count = 6;
    trunkMaterials = [];
    for (let i = 0; i < count; i++) {
      const hue = 0.08 + (i / (count - 1)) * 0.04; // 0.08-0.12, as before
      trunkMaterials.push(new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, 0.5, 0.3),
        roughness: 0.9,
        normalMap,
        normalScale: new THREE.Vector2(0.7, 0.7)
      }));
    }
  }
  return trunkMaterials;
}

/** Small palette of green foliage shades spanning the old per-cone HSL ranges. */
function getFoliageMaterials(): THREE.MeshStandardMaterial[] {
  if (!foliageMaterials) {
    const normalMap = getFoliageNormal();
    const count = 12;
    foliageMaterials = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const hue = 0.35 + t * 0.07;                 // 0.35-0.42, as before
      const saturation = 0.6 + ((i * 7) % count) / count * 0.3; // spread across 0.6-0.9
      const lightness = 0.2 + ((i * 5) % count) / count * 0.1;  // spread across 0.2-0.3
      foliageMaterials.push(new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, saturation, lightness),
        roughness: 0.8,
        normalMap,
        normalScale: new THREE.Vector2(0.5, 0.5)
      }));
    }
  }
  return foliageMaterials;
}

/** The single shared white snow material (every cap/patch was identical anyway). */
function getSnowMaterial(): THREE.MeshStandardMaterial {
  if (!snowMaterial) {
    snowMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  }
  return snowMaterial;
}

/** Pick a random material from a palette (forest colour variety, shared GPU state). */
function pickMaterial(pool: THREE.MeshStandardMaterial[]): THREE.MeshStandardMaterial {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Create a more realistic tree with visible branches and variability.
// Each part draws from the shared geometry/material pools above and is sized via
// `mesh.scale`, so the forest reuses a handful of GPU buffers/materials instead of
// minting thousands. The mesh layout (one Group of individual meshes) is unchanged.
function createTree(scale = 1.0): THREE.Group {
  const group = new THREE.Group();

  // Add randomization factors for variety
  const heightScale = (0.8 + Math.random() * 0.4) * scale; // 0.8-1.2 height variation with scaling
  const widthScale = (0.85 + Math.random() * 0.3) * scale; // 0.85-1.15 width variation with scaling
  const branchDensity = 3 + Math.floor(Math.random() * 3); // 3-5 branch layers

  // Tree trunk — shared canonical cylinder, sized via scale, palette material.
  const trunkHeight = 4 * heightScale;
  const trunk = new THREE.Mesh(getTrunkGeometry(), pickMaterial(getTrunkMaterials()));
  trunk.scale.set(widthScale, heightScale, widthScale);
  // Position the trunk so its base is at y=0 instead of its center
  trunk.position.y = trunkHeight / 2;
  trunk.castShadow = true;
  group.add(trunk);

  // Create multiple branch layers
  const baseHeight = trunkHeight;
  let layerHeight = baseHeight;

  for (let i = 0; i < branchDensity; i++) {
    // Larger at bottom, smaller at top
    const layerScale = 1 - (i / branchDensity) * 0.7;
    const coneHeight = 2.5 * heightScale * layerScale;
    const coneRadius = 2.2 * widthScale * layerScale;

    // Shared cone geometry resized to this layer; one foliage shade from the palette.
    const coneMaterial = pickMaterial(getFoliageMaterials());
    const cone = new THREE.Mesh(getConeGeometry(), coneMaterial);
    cone.scale.set(widthScale * layerScale, heightScale * layerScale, widthScale * layerScale);

    // Position with slight random offset for natural look
    const xTilt = (Math.random() - 0.5) * 0.1; // Slight random tilt
    const zTilt = (Math.random() - 0.5) * 0.1;
    cone.rotation.x = xTilt;
    cone.rotation.z = zTilt;

    // Position branches with overlap
    layerHeight += coneHeight * 0.6;
    cone.position.y = layerHeight;
    cone.castShadow = true;
    group.add(cone);

    // Add visible branches coming out of each cone layer
    addBranchesAtLayer(group, cone.position, coneRadius, coneMaterial);
  }

  // Add some snow on the branches for winter effect
  addSnowCaps(group, layerHeight, widthScale);

  return group;
}

// Add visible branches sticking out of the main cone shape. They are added to the
// tree group (not the cone) so the shared unit branch geometry can be sized in
// world units via scale without inheriting the cone's own size — the cone's tiny
// tilt is the only thing the branches no longer inherit (visually imperceptible).
function addBranchesAtLayer(parent: THREE.Object3D, conePosition: THREE.Vector3, radius: number, material: THREE.Material) {
  // Number of branches depends on radius
  const branchCount = Math.floor(3 + Math.random() * 3); // 3-5 visible branches

  for (let i = 0; i < branchCount; i++) {
    // Create branch — shared unit cylinder (pre-rotated along +X) sized via scale.
    const branchLength = radius * (0.7 + Math.random() * 0.5);
    const branchThickness = 0.1 + Math.random() * 0.1;

    const branch = new THREE.Mesh(getBranchGeometry(), material);
    branch.scale.set(branchLength, branchThickness, branchThickness);

    // Position branch at random angle around cone
    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
    const height = Math.random() * 0.5; // Vertical position variation

    branch.position.set(
      conePosition.x + Math.cos(angle) * (radius * 0.5),
      conePosition.y + height,
      conePosition.z + Math.sin(angle) * (radius * 0.5)
    );

    // Random rotation for natural variation
    branch.rotation.y = angle;
    branch.rotation.x = (Math.random() - 0.5) * 0.3;
    branch.rotation.z = (Math.random() - 0.5) * 0.1;

    branch.castShadow = true;
    parent.add(branch);
  }
}

// Add snow caps on top of tree (shared snow geometry/material, sized via scale).
function addSnowCaps(tree: THREE.Object3D, treeHeight: number, widthScale: number) {
  const snowMat = getSnowMaterial();

  // Add some snow on top
  const capRadius = widthScale * 0.8;
  const snowCap = new THREE.Mesh(getSnowCapGeometry(), snowMat);
  snowCap.scale.set(capRadius, capRadius * 0.5, capRadius); // flattened dome, as before
  snowCap.position.y = treeHeight + 0.2;
  tree.add(snowCap);

  // Maybe add snow on some branches
  if (Math.random() > 0.4) {
    const patchRadius = widthScale * 0.4;
    for (let i = 0; i < 2 + Math.random() * 3; i++) {
      const snowPatch = new THREE.Mesh(getSnowPatchGeometry(), snowMat);
      // Random position on the tree
      const angle = Math.random() * Math.PI * 2;
      const radius = widthScale * (0.8 + Math.random() * 0.8);
      const height = 2 + Math.random() * (treeHeight - 3);

      snowPatch.position.set(
        Math.cos(angle) * radius,
        height,
        Math.sin(angle) * radius
      );

      snowPatch.scale.set(patchRadius, patchRadius * 0.3, patchRadius);
      snowPatch.rotation.x = Math.random() * Math.PI / 4;
      snowPatch.rotation.z = Math.random() * Math.PI / 4;

      tree.add(snowPatch);
    }
  }
}

// Add trees to make the scene more interesting
function addTrees(scene: THREE.Scene): TreePosition[] {
  // Remove any existing trees from the scene to prevent duplicates
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i];
    // Trees are typically groups with many child elements
    if (child.type === 'Group' && child.children.length > 3) {
      scene.remove(child);
    }
  }
  
  const treePositions: TreePosition[] = [];

  // IMPORTANT: Log the ranges we're using to create trees for debugging
  console.log("Trees.addTrees: Creating trees in X range -100 to 100, Z range -180 to 80");
  
  // Add trees across the mountain - extended for longer run
  for(let z = -180; z < 80; z += 10) {
    for(let x = -100; x < 100; x += 10) {
      // Special handling for center area (former ski path)
      // Keep very center (±3 units) clear for minimal navigation while adding more trees elsewhere
      if(Math.abs(x) < 3) continue;
      
      // For the area that was previously the ski path (between 3-18 units from center),
      // add trees with increasing density from center
      // - Inner zone (3-8 units): Medium density (50% chance to skip)
      // - Middle zone (8-13 units): Higher density (30% chance to skip)
      // - Outer zone (13-18 units): Full density (10% chance to skip)
      if(Math.abs(x) >= 3 && Math.abs(x) < 8 && Math.random() < 0.5) continue;
      if(Math.abs(x) >= 8 && Math.abs(x) < 13 && Math.random() < 0.3) continue;
      if(Math.abs(x) >= 13 && Math.abs(x) < 18 && Math.random() < 0.1) continue;
      
      // Skip positions that would be too far from the actual terrain plane
      if (Math.abs(x) > 150 || Math.abs(z) > 200) continue;
      
      // Random offset with more natural clustering
      const xPos = x + (Math.random() * 5 - 2.5);
      const zPos = z + (Math.random() * 5 - 2.5);
      
      // Only place trees on suitable slopes (not too steep)
      const y = getTerrainHeight(xPos, zPos);
      const gradient = getTerrainGradient(xPos, zPos);
      const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
      
      // Different tree density based on location and size variation by zone
      // Define zones from center outward
      const innerZone = Math.abs(x) >= 3 && Math.abs(x) < 8;
      const middleZone = Math.abs(x) >= 8 && Math.abs(x) < 13;
      const outerZone = Math.abs(x) >= 13 && Math.abs(x) < 18;
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
          
          // For clustered trees, use the same criteria but add even more trees in center area
          // Keep only the very center (±3 units) clear for minimal navigation
          if(Math.abs(clusterX) >= 3) {
            const clusterY = getTerrainHeight(clusterX, clusterZ);
            
            // Determine which zone the cluster tree falls in
            const clusterInnerZone = Math.abs(clusterX) >= 3 && Math.abs(clusterX) < 8;
            const clusterMiddleZone = Math.abs(clusterX) >= 8 && Math.abs(clusterX) < 13;
            const clusterOuterZone = Math.abs(clusterX) >= 13 && Math.abs(clusterX) < 18;
            
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
    let xRange;
    let sizeVar;
    
    if (zoneChoice < 0.2) {
      // 20% in inner zone (3-8 units from center) - smallest trees
      xRange = 5;
      const side = Math.random() < 0.5 ? 1 : -1; // Randomly choose side
      const x = (3 + Math.random() * 5) * side; // 3-8 units from center
      sizeVar = 0.6 + Math.random() * 0.2; // 0.6-0.8 scale (very small)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      const y = getTerrainHeight(x, z);
      
      treePositions.push({x: x, y: y, z: z, scale: sizeVar});
    }
    else if (zoneChoice < 0.5) {
      // 30% in middle zone (8-13 units from center) - small trees
      const side = Math.random() < 0.5 ? 1 : -1;
      const x = (8 + Math.random() * 5) * side; // 8-13 units from center
      sizeVar = 0.7 + Math.random() * 0.2; // 0.7-0.9 scale (small)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      const y = getTerrainHeight(x, z);
      
      treePositions.push({x: x, y: y, z: z, scale: sizeVar});
    }
    else {
      // 50% in outer zone (13-18 units from center) - medium trees
      const side = Math.random() < 0.5 ? 1 : -1;
      const x = (13 + Math.random() * 5) * side; // 13-18 units from center
      sizeVar = 0.8 + Math.random() * 0.15; // 0.8-0.95 scale (medium)
      
      // Range between -180 and 80 for z
      const z = -180 + Math.random() * 260;
      const y = getTerrainHeight(x, z);
      
      treePositions.push({x: x, y: y, z: z, scale: sizeVar});
    }
  }
  
  // Log the tree positions array size
  console.log(`Trees.addTrees: Created ${treePositions.length} tree positions for collision detection`);
  
  // Check if we have any trees in the extended terrain (z < -80)
  const extendedTrees = treePositions.filter(tree => tree.z < -80).length;
  console.log(`Trees.addTrees: ${extendedTrees} trees in extended terrain area (z < -80)`);
  
  // Create tree instances - ensure trees are properly anchored to terrain.
  // (Tree height comes from the analytic terrain sampler below; the old
  // Raycaster/terrain-mesh lookup here was dead code and has been removed.)
  treePositions.forEach(pos => {
    // Get the exact terrain height from our height map or via calculation
    const terrainHeight = getTerrainHeight(pos.x, pos.z);
    
    // Create tree with optional scale and position it precisely on the terrain
    // Use the scale from the position data or default to 1.0
    const treeScale = pos.scale || 1.0;
    const tree = createTree(treeScale);
    
    // Make sure trees are properly anchored by sinking them 0.5 units into the terrain
    tree.position.set(pos.x, terrainHeight - 0.5, pos.z);
    scene.add(tree);
  });
  
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

// Export all tree-related functions
export const Trees = {
  createTree,
  addBranchesAtLayer,
  addSnowCaps,
  addTrees,
  getTerrainHeight,
  getTerrainGradient
};

// Trees is imported directly by snow.js and mountains.js (issue #84).