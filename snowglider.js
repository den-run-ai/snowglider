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
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], z = vertices[i + 2];
    const distance = Math.sqrt(x * x + z * z);
    let y = 40 * Math.exp(-distance / 40);
    
    // Create a smoother ski path along x=0
    if (Math.abs(x) < 8) {
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
  
  // Add trees to make the slope more visible
  addTrees();
  
  return terrain;
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

// Create a simple tree
function createTree() {
  const group = new THREE.Group();
  
  // Tree trunk
  const trunkGeometry = new THREE.CylinderGeometry(0.5, 0.7, 4, 8);
  const trunkMaterial = new THREE.MeshStandardMaterial({color: 0x8B4513});
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunk.position.y = 2;
  trunk.castShadow = true;
  group.add(trunk);
  
  // Tree top (cone)
  const coneGeometry = new THREE.ConeGeometry(2, 6, 8);
  const coneMaterial = new THREE.MeshStandardMaterial({color: 0x2E8B57});
  const cone = new THREE.Mesh(coneGeometry, coneMaterial);
  cone.position.y = 6;
  cone.castShadow = true;
  group.add(cone);
  
  return group;
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
  if (Math.abs(x) < 8) {
    y = y * 0.9 + (z + 100) * 0.1 + Math.sin(z / 3) * 0.3;
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

// --- Animation Loop ---
let lastTime = 0;
function animate(time) {
  requestAnimationFrame(animate);
  const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
  lastTime = time;
  
  updateSnowman(delta);
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
