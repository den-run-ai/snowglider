// mountains.js - Terrain and mountain features for snowglider

// --- SimplexNoise implementation ---
class SimplexNoise {
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
  
  noise(xin, yin) {
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
  
  dot(g, x, y) {
    return g[0]*x + g[1]*y;
  }
}

// --- Terrain utilities ---

// Global height map for efficient lookup - will be populated when terrain is created
const heightMap = {}; 

// Calculate terrain height at (x, z)
function getTerrainHeight(x, z) {
  // First check if we have this position in our cached height map
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  if (heightMap[key] !== undefined) {
    return heightMap[key];
  }
  
  const distance = Math.sqrt(x * x + z * z);
  
  // Use EXACTLY the same formula as in terrain mesh creation
  // Base mountain shape
  let y = 40 * Math.exp(-distance / 40);
  
  // Add noise (simplified without perlin for testing)
  y += 1.5 * Math.sin(x * 0.05) * Math.cos(z * 0.05) * (1 - Math.exp(-distance / 60));
  
  // Create a wider, smoother, and more clearly groomed ski path
  if (Math.abs(x) < 15) {
    // Calculate a smooth transition factor at path edges using quadratic curve
    const pathFactor = (15 - Math.abs(x)) / 15;
    const smoothPathFactor = pathFactor * pathFactor;
    
    // Create a longer, smoother, curvier ski run
    y = y * 0.9 + (z + 200) * 0.05 + Math.sin(z / 6) * 0.3 * smoothPathFactor;
  } else {
    // Add simplified version of the ridges outside the ski path
    const distFromPath = Math.abs(x) - 15;
    const transitionFactor = Math.min(1, distFromPath / 10);
    y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 0.8 * transitionFactor;
  }
  
  // Store in height map for future lookups
  heightMap[key] = y;
  return y;
}

// Calculate terrain gradient for physics and tree placement
function getTerrainGradient(x, z) {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  return { x: (hX - h) / eps, z: (hZ - h) / eps };
}

// Compute Downhill Direction (Approximate Gradient)
function getDownhillDirection(x, z) {
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

// --- Terrain creation functions ---

// Create Terrain (Mountain with Ski Slope)
function createTerrain(scene) {
  // Increase terrain size from 200x200 to 300x400 for a longer ski run
  const geometry = new THREE.PlaneGeometry(300, 400, 150, 200);
  geometry.rotateX(-Math.PI / 2);
  
  // Store the original terrain geometry for raycasting
  scene.userData = scene.userData || {}; 
  scene.userData.terrainGeometry = geometry;
  
  const vertices = geometry.attributes.position.array;
  
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
    // Round to one decimal place for reasonable map size
    const key = `${Math.round(x*10)},${Math.round(z*10)}`;
    heightMap[key] = y;
    
    // Create a wider, longer, smoother, and more visibly groomed ski path along x=0
    if (Math.abs(x) < 15) {
      // Calculate a smooth transition factor at path edges using quadratic curve
      const pathFactor = (15 - Math.abs(x)) / 15;
      const smoothPathFactor = pathFactor * pathFactor;
      
      // Make the ski path smoother with longer, more graceful curves
      y = y * 0.9 + (z + 100) * 0.1 + Math.sin(z / 4) * 0.25 * smoothPathFactor;
      
      // Core of the path is extra smooth and groomed
      if (Math.abs(x) < 10) {
        // Create well-defined parallel grooves in the snow for a groomed look
        // Only in the center part of the path
        if (Math.abs(x) > 1) { // Avoid center line
          // Subtle grooves running along the path (parallel to z-axis)
          y += Math.sin(x * 3) * 0.06; // Very subtle height variation for grooved appearance
        }
        
        // Add just a few well-defined jump ramps at specific positions, with smoother transitions
        const jumpPositions = [-80, -40, 0]; // Spread out jumps for a longer run
        for (const jumpZ of jumpPositions) {
          // Create a ramp near this z position with smooth transitions
          const distToJump = Math.abs(z - jumpZ);
          if (distToJump < 6) { // Wider jumps for a smoother experience
            // Shape of the jump: smoother rise and drop
            if (z > jumpZ) {
              // Use quadratic curve for smoother ramp
              const rampFactor = (6 - distToJump) / 6;
              y += rampFactor * rampFactor * 0.7;
            } else if (z > jumpZ - 2) {
              // Longer, smoother plateau
              y += (6 - distToJump) * 0.2;
            }
          }
        }
      }
      
      // Create a subtle blue-tinted white color for the groomed path
      // (This will be applied in the material section below)
    } else {
      // Add more extreme variation away from the ski path
      // Create a smoother transition at the edges of the path
      const distFromPath = Math.abs(x) - 15;
      const transitionFactor = Math.min(1, distFromPath / 10);
      
      // Add terrain features outside the path with a smooth transition
      y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 1.5 * transitionFactor;
      
      // Add some random smaller bumps
      if (Math.random() > 0.7) {
        y += perlin.noise(x * 0.1 + 100, z * 0.1 + 100) * 2.0 * transitionFactor;
      }
    }
    
    vertices[i + 1] = y;
    
    // IMPORTANT: Update the heightmap with the FINAL height after all modifications
    // Note: this key is also defined above (reusing the same key)
    heightMap[`${Math.round(x*10)},${Math.round(z*10)}`] = y;
  }
  geometry.computeVertexNormals();
  
  // Create a texture with grid pattern for better visibility
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);
  
  // Create a faint blue-ish tint in the center for the groomed ski path
  const grd = ctx.createLinearGradient(156, 0, 356, 0);
  grd.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grd.addColorStop(0.5, 'rgba(220, 240, 255, 1)'); // Subtle blue tint
  grd.addColorStop(1, 'rgba(255, 255, 255, 1)');
  ctx.fillStyle = grd;
  ctx.fillRect(156, 0, 200, 512);
  
  // Add subtle grooming lines along the ski path (vertical)
  ctx.strokeStyle = 'rgba(230, 240, 255, 0.7)';
  ctx.lineWidth = 2;
  for (let i = 176; i < 336; i += 10) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
  }
  
  // Draw regular grid outside the path
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;
  
  // Draw grid
  for(let i = 0; i < 512; i += 20) {
    // Horizontal lines
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
    
    // Vertical lines - skip over the ski path to avoid cluttering the groomed path
    if (i < 156 || i > 356) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 512);
      ctx.stroke();
    }
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Increase texture repeats for larger terrain (4x4 to 6x6)
  texture.repeat.set(6, 6);
  
  const material = new THREE.MeshStandardMaterial({ 
    color: 0xffffff, 
    roughness: 0.8,
    map: texture
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
  
  // Add rocks to make the mountain more realistic
  addRocks(scene);
  
  // Add trees to make the slope more visible using the separate Trees module
  let treePositions = [];
  if (typeof window !== 'undefined' && window.Trees && window.Trees.addTrees) {
    treePositions = window.Trees.addTrees(scene);
  } else {
    console.warn("Trees module not found, skipping tree creation");
  }
  
  return { terrain, treePositions };
}

// Add rocks to create a more realistic mountain environment
function addRocks(scene) {
  // Remove any existing rocks from the scene to prevent duplicates
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const child = scene.children[i];
    // Rocks are typically meshes with dodecahedron geometry
    if (child.type === 'Mesh' && child.geometry && 
        child.geometry.type && child.geometry.type.includes('Dodecahedron')) {
      scene.remove(child);
    }
  }
  
  // Create rock positions with higher density on steeper parts of mountain
  const rockPositions = [];
  
  // Add rocks scattered across the mountain - adjusted for extended terrain
  for(let z = -180; z < 90; z += 10) {
    for(let x = -100; x < 100; x += 10) {
      // Avoid placing rocks on or very near the wider ski path
      // With the path width increased to 15, keep a buffer of 5 units
      if(Math.abs(x) < 20) continue;
      
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
        
        // Occasionally add rocks at the edge of the ski path for visual interest
        if(Math.random() < 0.15 && Math.abs(x) >= 20 && Math.abs(x) <= 25) {
          // Place smaller rocks near the path edges
          const pathEdgeX = (x > 0) ? 18 + Math.random() * 3 : -18 - Math.random() * 3;
          const pathEdgeZ = zPos + Math.random() * 4 - 2;
          const pathEdgeY = getTerrainHeight(pathEdgeX, pathEdgeZ);
          
          // Smaller rocks along the path edge
          rockPositions.push({x: pathEdgeX, y: pathEdgeY, z: pathEdgeZ, size: 0.3 + Math.random() * 1.0});
        }
      }
    }
  }
  
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
  });
}

// Create a rock with variable size
function createRock(size) {
  // Use dodecahedron as base shape for rocks
  const geometry = new THREE.DodecahedronGeometry(size, 1);
  
  // Deform vertices slightly for more natural rock shape
  const positions = geometry.attributes.position.array;
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
function debugHeightMap(x, z) {
  const key = `${Math.round(x*10)},${Math.round(z*10)}`;
  console.log(`Height Map Debug at (${x}, ${z}):`);
  console.log(`- Height Map Entry: ${heightMap[key]}`);
  console.log(`- Calculated Height: ${getTerrainHeight(x, z)}`);
  return heightMap[key];
}

// Export all mountain-related functions and classes
const Mountains = {
  SimplexNoise,
  getTerrainHeight,
  getTerrainGradient,
  getDownhillDirection,
  createTerrain,
  createRock,
  addRocks,
  debugHeightMap,
  heightMap // Expose the heightmap for debugging
};

// Make Mountains available globally
if (typeof window !== 'undefined') {
  window.Mountains = Mountains;
}