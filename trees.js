// trees.js - Tree creation and management for snowglider

// Create a more realistic tree with visible branches and variability
function createTree(scale = 1.0) {
  const group = new THREE.Group();
  
  // Add randomization factors for variety
  const heightScale = (0.8 + Math.random() * 0.4) * scale; // 0.8-1.2 height variation with scaling
  const widthScale = (0.85 + Math.random() * 0.3) * scale; // 0.85-1.15 width variation with scaling
  const branchDensity = 3 + Math.floor(Math.random() * 3); // 3-5 branch layers
  
  // Tree trunk with some natural variation
  const trunkHeight = 4 * heightScale;
  const trunkTopRadius = 0.4 * widthScale;
  const trunkBottomRadius = 0.6 * widthScale;
  const trunkGeometry = new THREE.CylinderGeometry(
    trunkTopRadius, trunkBottomRadius, trunkHeight, 8
  );
  
  // Trunk color variation
  const trunkHue = 0.08 + Math.random() * 0.04; // Brown hue variations
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(trunkHue, 0.5, 0.3),
    roughness: 0.9
  });
  
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
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
    
    const coneGeometry = new THREE.ConeGeometry(coneRadius, coneHeight, 8);
    
    // Green color variations for branches
    const greenHue = 0.35 + Math.random() * 0.07; // Green hue variations
    const greenSaturation = 0.6 + Math.random() * 0.3;
    const greenLightness = 0.2 + Math.random() * 0.1;
    
    const coneMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(greenHue, greenSaturation, greenLightness),
      roughness: 0.8
    });
    
    const cone = new THREE.Mesh(coneGeometry, coneMaterial);
    
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
    addBranchesAtLayer(cone, coneRadius, coneMaterial);
  }
  
  // Add some snow on the branches for winter effect
  addSnowCaps(group, layerHeight, widthScale);
  
  return group;
}

// Add visible branches sticking out of the main cone shape
function addBranchesAtLayer(cone, radius, material) {
  // Number of branches depends on radius
  const branchCount = Math.floor(3 + Math.random() * 3); // 3-5 visible branches
  
  for (let i = 0; i < branchCount; i++) {
    // Create branch
    const branchLength = radius * (0.7 + Math.random() * 0.5);
    const branchThickness = 0.1 + Math.random() * 0.1;
    
    const branchGeometry = new THREE.CylinderGeometry(
      branchThickness, branchThickness, branchLength, 4
    );
    branchGeometry.rotateZ(Math.PI / 2); // Rotate to stick out horizontally
    
    const branch = new THREE.Mesh(branchGeometry, material);
    
    // Position branch at random angle around cone
    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
    const height = Math.random() * 0.5; // Vertical position variation
    
    branch.position.set(
      Math.cos(angle) * (radius * 0.5),
      height,
      Math.sin(angle) * (radius * 0.5)
    );
    
    // Random rotation for natural variation
    branch.rotation.y = angle;
    branch.rotation.x = (Math.random() - 0.5) * 0.3;
    branch.rotation.z += (Math.random() - 0.5) * 0.1;
    
    branch.castShadow = true;
    cone.add(branch);
  }
}

// Add snow caps on top of tree
function addSnowCaps(tree, treeHeight, widthScale) {
  // Add some snow on top
  const snowCapGeometry = new THREE.SphereGeometry(widthScale * 0.8, 8, 4, 0, Math.PI * 2, 0, Math.PI / 3);
  const snowMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8
  });
  
  const snowCap = new THREE.Mesh(snowCapGeometry, snowMaterial);
  snowCap.position.y = treeHeight + 0.2;
  snowCap.scale.y = 0.5;
  tree.add(snowCap);
  
  // Maybe add snow on some branches
  if (Math.random() > 0.4) {
    const smallSnowGeometry = new THREE.SphereGeometry(widthScale * 0.4, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    
    for (let i = 0; i < 2 + Math.random() * 3; i++) {
      const snowPatch = new THREE.Mesh(smallSnowGeometry, snowMaterial);
      // Random position on the tree
      const angle = Math.random() * Math.PI * 2;
      const radius = widthScale * (0.8 + Math.random() * 0.8);
      const height = 2 + Math.random() * (treeHeight - 3);
      
      snowPatch.position.set(
        Math.cos(angle) * radius,
        height,
        Math.sin(angle) * radius
      );
      
      snowPatch.scale.y = 0.3;
      snowPatch.rotation.x = Math.random() * Math.PI / 4;
      snowPatch.rotation.z = Math.random() * Math.PI / 4;
      
      tree.add(snowPatch);
    }
  }
}

// Add trees to make the scene more interesting
function addTrees(scene) {
  // Remove any existing trees from the scene to prevent duplicates
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i];
    // Trees are typically groups with many child elements
    if (child.type === 'Group' && child.children.length > 3) {
      scene.remove(child);
    }
  }
  
  const treePositions = [];
  
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
      
      // Adjust placement chance based on location
      const treeChance = centerArea ? 0.65 : 0.7;  // Increased chance in center area
      
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
  
  // Create a raycaster to ensure precise placement
  const raycaster = new THREE.Raycaster();
  const downDirection = new THREE.Vector3(0, -1, 0);
  
  // Get terrain mesh for raycasting - try multiple ways to find it
  let terrainMesh = null;
  
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
    terrainMesh = scene.children.find(child => 
      child.name === 'terrain' || 
      (child.type === 'Mesh' && 
       child.geometry && 
       child.geometry.type === 'PlaneGeometry'));
  }
  
  // Create tree instances - ensure trees are properly anchored to terrain
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

// Helper function to use Mountains utility to get terrain height
function getTerrainHeight(x, z) {
  // First try to use global function
  if (window && window.Mountains && window.Mountains.getTerrainHeight) {
    return window.Mountains.getTerrainHeight(x, z);
  }
  
  // Fallback to accessing via the Mountains global
  if (typeof Mountains !== 'undefined' && Mountains.getTerrainHeight) {
    return Mountains.getTerrainHeight(x, z);
  }
  
  // Last resort - approximate with zero height
  console.warn('Trees: getTerrainHeight function not found');
  return 0;
}

// Helper function to use Mountains utility to get terrain gradient
function getTerrainGradient(x, z) {
  // First try to use global function
  if (window && window.Mountains && window.Mountains.getTerrainGradient) {
    return window.Mountains.getTerrainGradient(x, z);
  }
  
  // Fallback to accessing via the Mountains global
  if (typeof Mountains !== 'undefined' && Mountains.getTerrainGradient) {
    return Mountains.getTerrainGradient(x, z);
  }
  
  // Last resort - approximate with flat gradient
  console.warn('Trees: getTerrainGradient function not found');
  return { x: 0, z: 0 };
}

// Export all tree-related functions
const Trees = {
  createTree,
  addBranchesAtLayer,
  addSnowCaps,
  addTrees,
  getTerrainHeight,
  getTerrainGradient
};

// Make Trees available globally
if (typeof window !== 'undefined') {
  window.Trees = Trees;
}