// --- Scene, Camera, Renderer ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// --- Lighting ---
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(50, 100, 50);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
scene.add(directionalLight);

// --- Create Terrain (Mountain with Ski Slope) ---
function createTerrain() {
  const geometry = new THREE.PlaneGeometry(200, 200, 100, 100);
  geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position.array;
  
  // Create Perlin noise for natural terrain variation
  const perlin = new SimplexNoise();
  
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], z = vertices[i + 2];
    const distance = Math.sqrt(x * x + z * z);
    
    // Base mountain shape
    let y = 40 * Math.exp(-distance / 40);
    
    // Add perlin noise for natural terrain roughness
    // Less noise near the peak, more at the sides
    const noiseScale = 0.05;
    const noiseStrength = 2.0 * (1 - Math.exp(-distance / 60));
    y += perlin.noise(x * noiseScale, z * noiseScale) * noiseStrength;
    
    // Create a smoother ski path along x=0
    if (Math.abs(x) < 8) {
      // Make the ski path smoother but still with some texture
      y = y * 0.9 + (z + 100) * 0.1 + Math.sin(z / 3) * 0.3;
      
      // Add fewer, smaller moguls along the path
      if (Math.abs(x) < 5) {
        // Less frequent moguls (using higher frequency in the sine)
        if (Math.abs(Math.sin(z * 0.2)) > 0.7) { // Only create bumps at certain intervals
          y += Math.sin(z * 0.8) * Math.cos(x * 0.3) * 0.8; // Reduced height (0.8 instead of 1.5)
        }
        
        // Add just a few well-defined jump ramps at specific positions
        const jumpPositions = [-80, -40, 0]; // Fewer, more spread out jumps
        for (const jumpZ of jumpPositions) {
          // Create a ramp near this z position
          const distToJump = Math.abs(z - jumpZ);
          if (distToJump < 5) {
            // Shape of the jump: rise up and then drop
            if (z > jumpZ) {
              y += (5 - distToJump) * 0.8; // Steeper ramp up (0.8 instead of 0.6)
            } else if (z > jumpZ - 1) {
              y += (5 - distToJump) * 0.3; // Shorter plateau
            }
          }
        }
      }
    } else {
      // Add more extreme variation away from the ski path
      // Add some small ridges and folds to simulate mountain texture
      y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 1.5;
      
      // Add some random smaller bumps
      if (Math.random() > 0.7) {
        y += perlin.noise(x * 0.1 + 100, z * 0.1 + 100) * 2.0;
      }
    }
    
    vertices[i + 1] = y;
  }
  geometry.computeVertexNormals();
  
  // Create a texture with grid pattern for better visibility
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;
  
  // Draw grid
  for(let i = 0; i < 512; i += 20) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  
  const material = new THREE.MeshStandardMaterial({ 
    color: 0xffffff, 
    roughness: 0.8,
    map: texture
  });
  
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  scene.add(terrain);
  
  // Add rocks to make the mountain more realistic
  addRocks();
  
  // Add trees to make the slope more visible
  addTrees();
  
  return terrain;
}

// Add rocks to create a more realistic mountain environment
function addRocks() {
  // Create rock positions with higher density on steeper parts of mountain
  const rockPositions = [];
  
  // Add rocks scattered across the mountain
  for(let z = -90; z < 90; z += 10) {
    for(let x = -80; x < 80; x += 10) {
      // Avoid placing rocks on or very near the ski path
      if(Math.abs(x) < 15) continue;
      
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
  
  // Create rock instances
  rockPositions.forEach(pos => {
    const rock = createRock(pos.size);
    rock.position.set(pos.x, pos.y, pos.z);
    
    // Random rotation for natural look
    rock.rotation.y = Math.random() * Math.PI * 2;
    rock.rotation.z = Math.random() * 0.3;
    
    // Align rock to terrain slope
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

// SimplexNoise implementation (or you could use an existing library)
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

// Add trees to make the scene more interesting and provide depth cues
function addTrees() {
  const treePositions = [];
  // Add trees on both sides of the ski path
  for(let z = -80; z < 80; z += 10) {
    for(let x = -60; x < 60; x += 10) {
      // Skip the ski path
      if(Math.abs(x) < 10) continue;
      
      // Random offset
      const xPos = x + (Math.random() * 5 - 2.5);
      const zPos = z + (Math.random() * 5 - 2.5);
      
      // Only place trees on suitable slopes (not too steep)
      const y = getTerrainHeight(xPos, zPos);
      const gradient = getTerrainGradient(xPos, zPos);
      const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
      
      if(steepness < 0.5 && Math.random() > 0.7) {
        treePositions.push({x: xPos, y: y, z: zPos});
      }
    }
  }
  
  // Create tree instances
  treePositions.forEach(pos => {
    const tree = createTree();
    tree.position.set(pos.x, pos.y, pos.z);
    scene.add(tree);
  });
}

// Create a more realistic tree with visible branches and variability
function createTree() {
  const group = new THREE.Group();
  
  // Add randomization factors for variety
  const heightScale = 0.8 + Math.random() * 0.4; // 0.8-1.2 height variation
  const widthScale = 0.85 + Math.random() * 0.3; // 0.85-1.15 width variation
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

// Calculate terrain gradient for physics and tree placement
function getTerrainGradient(x, z) {
  const eps = 0.1;
  const h = getTerrainHeight(x, z);
  const hX = getTerrainHeight(x + eps, z);
  const hZ = getTerrainHeight(x, z + eps);
  return { x: (hX - h) / eps, z: (hZ - h) / eps };
}

const terrain = createTerrain();

// --- Create Snowman (Simplified as Three Spheres) ---
function createSnowman() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  
  // Bottom sphere
  const bottom = new THREE.Mesh(new THREE.SphereGeometry(2, 24, 24), material);
  bottom.position.y = 2;
  bottom.castShadow = true;
  group.add(bottom);
  
  // Middle sphere
  const middle = new THREE.Mesh(new THREE.SphereGeometry(1.5, 24, 24), material);
  middle.position.y = 5;
  middle.castShadow = true;
  group.add(middle);
  
  // Head sphere
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 24), material);
  head.position.y = 7.5;
  head.castShadow = true;
  group.add(head);
  
  // Eyes
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), eyeMaterial);
  leftEye.position.set(0.4, 7.7, 0.8);
  group.add(leftEye);
  
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), eyeMaterial);
  rightEye.position.set(-0.4, 7.7, 0.8);
  group.add(rightEye);
  
  // Carrot nose
  const noseMaterial = new THREE.MeshStandardMaterial({ color: 0xFF6600 });
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1, 12), noseMaterial);
  nose.position.set(0, 7.5, 1);
  nose.rotation.x = Math.PI / 2;
  group.add(nose);
  
  // Add skis
  const skiMaterial = new THREE.MeshStandardMaterial({ color: 0xFF0000 }); // Bright red
  
  // Left ski
  const leftSki = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.2, 6), 
    skiMaterial
  );
  leftSki.position.set(-1, 0.1, 1);
  leftSki.castShadow = true;
  // Add ski tip (angled front)
  const leftSkiTip = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.4, 1),
    skiMaterial
  );
  leftSkiTip.position.set(0, 0.2, 3);
  leftSkiTip.rotation.x = Math.PI / 8; // Angle up slightly
  leftSki.add(leftSkiTip);
  group.add(leftSki);
  
  // Right ski
  const rightSki = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.2, 6),
    skiMaterial
  );
  rightSki.position.set(1, 0.1, 1);
  rightSki.castShadow = true;
  // Add ski tip (angled front)
  const rightSkiTip = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.4, 1),
    skiMaterial
  );
  rightSkiTip.position.set(0, 0.2, 3);
  rightSkiTip.rotation.x = Math.PI / 8; // Angle up slightly
  rightSki.add(rightSkiTip);
  group.add(rightSki);
  
  scene.add(group);
  return group;
}
const snowman = createSnowman();

// --- Helper: Get Terrain Height at (x, z) ---
function getTerrainHeight(x, z) {
  const distance = Math.sqrt(x * x + z * z);
  let y = 40 * Math.exp(-distance / 40);
  
  // Add simplified version of the noise and terrain details
  // Need to keep this in sync with the full version for physics to work properly
  const perlin = 1.5 * Math.sin(x * 0.05) * Math.cos(z * 0.05); // Simplified noise approximation
  y += perlin * (1 - Math.exp(-distance / 60));
  
  if (Math.abs(x) < 8) {
    y = y * 0.9 + (z + 100) * 0.1 + Math.sin(z / 3) * 0.3;
  } else {
    // Add simplified version of the ridges outside the ski path
    y += Math.sin(x * 0.2) * Math.cos(z * 0.3) * 0.8;
  }
  
  return y;
}

// --- Helper: Compute Downhill Direction (Approximate Gradient) ---
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

// --- Snowman Position & Reset ---
let pos = { x: 0, z: -40, y: getTerrainHeight(0, -40) };
let velocity = { x: 0, z: 0 }; // Define velocity object

function resetSnowman() {
  pos = { x: 0, z: -40, y: getTerrainHeight(0, -40) };
  // Give the snowman a small initial push for smooth start - doubled for speed
  velocity = { x: 0, z: -6.0 }; 
  snowman.position.set(pos.x, pos.y, pos.z);
  snowman.rotation.set(0, Math.PI, 0);
}
resetSnowman();
document.getElementById('resetBtn').addEventListener('click', resetSnowman);

// Add control information display next to reset button
const resetBtn = document.getElementById('resetBtn');
const controlsInfo = document.createElement('div');
controlsInfo.id = 'controlsInfo';
controlsInfo.innerHTML = '⌨️ Controls: ←/A, →/D to steer | ↑/W accelerate | ↓/S brake | Space to jump';
controlsInfo.style.display = 'inline-block';
controlsInfo.style.marginLeft = '10px';
controlsInfo.style.fontFamily = 'Arial, sans-serif';
controlsInfo.style.fontSize = '14px';
controlsInfo.style.color = '#333';
resetBtn.parentNode.insertBefore(controlsInfo, resetBtn.nextSibling);

// --- Variables for automatic turning ---
let turnPhase = 0;
let currentTurnDirection = 0;
let turnChangeCooldown = 0;
let turnAmplitude = 3.0; // Increased amplitude for more visible turns

// Add keyboard control variables
let keyboardControls = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false  // New jump control
};

// Add keyboard event listeners
window.addEventListener('keydown', (event) => {
  switch(event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      keyboardControls.left = true;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      keyboardControls.right = true;
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      keyboardControls.up = true;
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      keyboardControls.down = true;
      break;
    case ' ':  // Spacebar
      keyboardControls.jump = true;
      break;
  }
});

window.addEventListener('keyup', (event) => {
  switch(event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      keyboardControls.left = false;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      keyboardControls.right = false;
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      keyboardControls.up = false;
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      keyboardControls.down = false;
      break;
    case ' ':  // Spacebar
      keyboardControls.jump = false;
      break;
  }
});

// Add jump-related variables
let isInAir = false;
let verticalVelocity = 0;
let jumpCooldown = 0;
let lastTerrainHeight = 0;
let airTime = 0;

// --- Update Snowman: Physics-based Movement ---
function updateSnowman(delta) {
  // Update jump cooldown
  if (jumpCooldown > 0) {
    jumpCooldown -= delta;
  }
  
  // Get current terrain height at position
  const terrainHeightAtPosition = getTerrainHeight(pos.x, pos.z);
  
  // Check for landing
  if (isInAir && pos.y <= terrainHeightAtPosition) {
    isInAir = false;
    pos.y = terrainHeightAtPosition;
    
    // More dramatic landing impact based on air time and height
    const landingImpact = Math.min(0.5, airTime * 0.15);
    const currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
    
    // Reduce speed on landing, more reduction for longer jumps
    velocity.x *= (1 - landingImpact);
    velocity.z *= (1 - landingImpact);
    
    // Reset jump-related variables
    verticalVelocity = 0;
    airTime = 0;
    jumpCooldown = 0.3; // Short cooldown after landing
  }
  
  // Calculate the downhill direction
  const dir = getDownhillDirection(pos.x, pos.z);
  
  // Get gradient for physics calculations
  const gradient = getTerrainGradient(pos.x, pos.z);
  const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
  
  // Detect natural jumps from terrain (like going over moguls)
  const heightDifference = terrainHeightAtPosition - lastTerrainHeight;
  const currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
  const movingFast = currentSpeed > 12; // Higher threshold for auto-jumps
  
  // Auto-jump when going downhill after a steep uphill section
  if (!isInAir && heightDifference < -0.8 && movingFast && jumpCooldown <= 0) {
    // Natural jump from terrain - more powerful
    verticalVelocity = 6 + (currentSpeed * 0.3);
    isInAir = true;
  }
  
  // Manual jump with spacebar - much higher jumps
  if (keyboardControls.jump && !isInAir && jumpCooldown <= 0) {
    // Jump strength increases with current speed, more dramatically
    verticalVelocity = 10 + (currentSpeed * 0.5);
    isInAir = true;
    jumpCooldown = 0.5; // Prevent jump spam
  }
  
  // Update vertical position and velocity when in air
  if (isInAir) {
    // Track time in air
    airTime += delta;
    
    // Apply gravity to vertical velocity (slightly reduced for more "hang time")
    verticalVelocity -= 16 * delta; // Reduced gravity for more air time
    
    // Update vertical position
    pos.y += verticalVelocity * delta;
    
    // Better air control
    if (keyboardControls.left) {
      velocity.x -= 5.0 * delta; // Improved air control
    }
    if (keyboardControls.right) {
      velocity.x += 5.0 * delta; // Improved air control
    }
    
    // Less friction in air
    velocity.x *= (1 - 0.01);
    velocity.z *= (1 - 0.01);
  } else {
    // Update velocity based on gravity, gradient, and a simple friction model
    const gravity = 9.8;
    const friction = 0.04; // Slightly reduced friction for higher speeds
    
    // Apply forces to velocity (gravity pulls along slope direction)
    velocity.x += dir.x * steepness * gravity * delta;
    velocity.z += dir.z * steepness * gravity * delta;
    
    // Handle keyboard input for steering - doubled turn force
    const keyboardTurnForce = 16.0; // How strong keyboard turning is
    
    if (keyboardControls.left) {
      velocity.x -= keyboardTurnForce * delta;
    }
    if (keyboardControls.right) {
      velocity.x += keyboardTurnForce * delta;
    }
    
    // Handle forward/backward input - doubled acceleration
    const accelerationForce = 10.0;
    if (keyboardControls.up) {
      velocity.z -= accelerationForce * delta;
    }
    if (keyboardControls.down) {
      velocity.z += accelerationForce * delta * 0.5; // Braking is less powerful
    }
    
    // Only use automatic turning if no keyboard input
    if (!keyboardControls.left && !keyboardControls.right) {
      // Update turn phase and apply automatic turning
      turnPhase += delta;
      turnChangeCooldown -= delta;
      
      // Make more dramatic turn direction changes
      if (turnChangeCooldown <= 0) {
        // Use more extreme values (-1 or 1) for sharper turns
        currentTurnDirection = Math.random() > 0.5 ? 1 : -1;
        // Shorter intervals between direction changes
        turnChangeCooldown = 2 + Math.random() * 3; // Random cooldown between 2-5 seconds
      }
      
      // Apply much stronger turning force (pronounced carving effect)
      const turnIntensity = 2.5 * Math.min(currentSpeed, 10) / 10; // Adjusted for higher speeds
      
      // Apply sine wave turning + random direction change for more dramatic movement
      velocity.x += Math.sin(turnPhase * 0.5) * turnAmplitude * delta * turnIntensity * currentTurnDirection;
    }
    
    // Apply simple friction to slow down
    velocity.x *= (1 - friction);
    velocity.z *= (1 - friction);
    
    // Update y position to terrain height when not in air
    pos.y = terrainHeightAtPosition;
  }
  
  // Apply velocity to position
  pos.x += velocity.x * delta;
  pos.z += velocity.z * delta;
  
  // Store current terrain height for next frame
  lastTerrainHeight = terrainHeightAtPosition;
  
  // Update snowman position and rotation
  snowman.position.set(pos.x, pos.y, pos.z);
  
  // Rotate the snowman to face the movement direction
  const movementDir = { x: velocity.x, z: velocity.z };
  
  if (currentSpeed > 0.1) { // Only rotate if moving with significant speed
    snowman.rotation.y = Math.atan2(movementDir.x, movementDir.z);
  }
  
  // Calculate a tilt based on the slope and turning with improved smoothing
  const gradX = (getTerrainHeight(pos.x + 0.1, pos.z) - getTerrainHeight(pos.x - 0.1, pos.z)) / 0.2;
  const gradZ = (getTerrainHeight(pos.x, pos.z + 0.1) - getTerrainHeight(pos.x, pos.z - 0.1)) / 0.2;
  
  // Add more dramatic jump rotation - lean forward during jumps
  let jumpTilt = 0;
  if (isInAir) {
    // More dramatic tilt during jumps, especially on takeoff
    if (verticalVelocity > 0) {
      // Lean back on ascent
      jumpTilt = -Math.min(0.5, verticalVelocity * 0.04);
    } else {
      // Lean forward on descent, more as you fall faster
      jumpTilt = Math.min(0.6, -verticalVelocity * 0.03);
    }
  }
  
  // Add more controlled turning tilt with speed-based scaling
  const turnTiltFactor = Math.min(0.5, currentSpeed / 20); // Less tilt at lower speeds
  const turnTilt = velocity.x * turnTiltFactor;
  
  // Limit maximum tilt angles to prevent unrealistic leaning
  const maxTiltAngle = 0.3; // About 17 degrees maximum tilt
  
  // Apply smoothing and clamping to rotation values
  const targetRotX = gradZ * 0.4 + jumpTilt; // Add jump tilt to X rotation
  const targetRotZ = -gradX * 0.4 - turnTilt;
  
  // Smooth transition to target rotation (lerp)
  const rotationSmoothing = isInAir ? 3.0 * delta : 6.0 * delta; // Slower transitions in air
  snowman.rotation.x += (Math.max(-maxTiltAngle, Math.min(maxTiltAngle, targetRotX)) - snowman.rotation.x) * rotationSmoothing;
  snowman.rotation.z += (Math.max(-maxTiltAngle, Math.min(maxTiltAngle, targetRotZ)) - snowman.rotation.z) * rotationSmoothing;
  
  // Check if snowman is off the terrain or falling
  const fallThreshold = 0.5; // How far below terrain to allow before reset
  
  // Reset if: reaches end of slope, goes off sides, or falls off terrain
  if (pos.z < -100 || Math.abs(pos.x) > 70 || (!isInAir && pos.y < terrainHeightAtPosition - fallThreshold)) {
    resetSnowman();
  }
  
  // Update info display with jump status
  document.getElementById('info').textContent =
    `Pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} | Speed: ${currentSpeed.toFixed(1)} | ${isInAir ? "Jumping!" : "On ground"}`;
}

// --- Update Camera: Follow the Snowman ---
function updateCamera() {
  // Position camera above and behind the snowman
  const offset = new THREE.Vector3(0, 8, 15);
  const angle = snowman.rotation.y;
  
  const camOffset = new THREE.Vector3(
    Math.sin(angle) * offset.z,
    offset.y,
    Math.cos(angle) * offset.z
  );
  
  camera.position.copy(snowman.position).add(camOffset);
  camera.lookAt(snowman.position);
}

// --- Initial Camera Setup ---
// Set the camera to a position where we can actually see the terrain and snowman
camera.position.set(0, 20, 0);
camera.lookAt(0, 0, -40);

// --- Snow Particle System ---
const snowflakes = [];
const snowflakeCount = 1000;
const snowflakeSpread = 100; // Spread area around player
const snowflakeHeight = 50; // Height above player
const snowflakeFallSpeed = 5;

function createSnowflakes() {
  // Create a simple white circle texture for snowflakes
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  
  // Draw a soft, white circle
  const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ 
    map: texture,
    transparent: true
  });
  
  // Create individual snowflakes
  for (let i = 0; i < snowflakeCount; i++) {
    const snowflake = new THREE.Sprite(material);
    
    // Random size (smaller snowflakes to look more realistic)
    const size = 0.2 + Math.random() * 0.4;
    snowflake.scale.set(size, size, size);
    
    // Random positions in a box above the player
    resetSnowflakePosition(snowflake);
    
    // Random speeds for natural variation
    snowflake.userData.speed = (0.7 + Math.random() * 0.6) * snowflakeFallSpeed;
    snowflake.userData.wobble = Math.random() * 0.1;
    snowflake.userData.wobbleSpeed = 0.5 + Math.random() * 1.5;
    snowflake.userData.wobblePos = Math.random() * Math.PI * 2;
    
    scene.add(snowflake);
    snowflakes.push(snowflake);
  }
}

function resetSnowflakePosition(snowflake) {
  // Position snowflakes randomly in a box above the player
  snowflake.position.x = pos.x + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.z = pos.z + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.y = pos.y + Math.random() * snowflakeHeight;
}

function updateSnowflakes(delta) {
  snowflakes.forEach(snowflake => {
    // Apply falling movement
    snowflake.position.y -= snowflake.userData.speed * delta;
    
    // Add some gentle sideways wobble for realism
    snowflake.userData.wobblePos += snowflake.userData.wobbleSpeed * delta;
    snowflake.position.x += Math.sin(snowflake.userData.wobblePos) * snowflake.userData.wobble;
    
    // Check if snowflake has fallen below the terrain or is too far from player
    const terrainHeight = getTerrainHeight(snowflake.position.x, snowflake.position.z);
    const distanceToPlayer = Math.sqrt(
      Math.pow(snowflake.position.x - pos.x, 2) + 
      Math.pow(snowflake.position.z - pos.z, 2)
    );
    
    if (snowflake.position.y < terrainHeight || distanceToPlayer > snowflakeSpread) {
      resetSnowflakePosition(snowflake);
    }
  });
}

// Create snowflakes when the game starts
createSnowflakes();

// --- Animation Loop ---
let lastTime = 0;
function animate(time) {
  requestAnimationFrame(animate);
  const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
  lastTime = time;
  
  updateSnowman(delta);
  updateSnowflakes(delta);
  updateCamera();
  renderer.render(scene, camera);
}
animate(0);

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
