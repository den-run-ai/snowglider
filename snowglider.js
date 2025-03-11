// --- Import utilities ---
// Note: In a real application, you would use: import * as Utils from './utils.js';
// But for demonstration we assume Utils is globally available

// --- Scene, Camera, Renderer ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Create game over overlay
const gameOverOverlay = document.createElement('div');
gameOverOverlay.id = 'gameOverOverlay';
gameOverOverlay.style.position = 'fixed';
gameOverOverlay.style.top = '0';
gameOverOverlay.style.left = '0';
gameOverOverlay.style.width = '100%';
gameOverOverlay.style.height = '100%';
gameOverOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
gameOverOverlay.style.display = 'flex';
gameOverOverlay.style.flexDirection = 'column';
gameOverOverlay.style.alignItems = 'center';
gameOverOverlay.style.justifyContent = 'center';
gameOverOverlay.style.zIndex = '1000';
gameOverOverlay.style.display = 'none'; // Initially hidden

// Game over message
const gameOverMessage = document.createElement('h1');
gameOverMessage.id = 'gameOverMessage';
gameOverMessage.textContent = 'GAME OVER';
gameOverMessage.style.color = 'white';
gameOverMessage.style.fontFamily = 'Arial, sans-serif';
gameOverMessage.style.fontSize = '48px';
gameOverMessage.style.marginBottom = '20px';
gameOverOverlay.appendChild(gameOverMessage);

// Game over stats container
const gameOverStats = document.createElement('div');
gameOverStats.id = 'gameOverStats';
gameOverStats.style.color = 'white';
gameOverStats.style.fontFamily = 'Arial, sans-serif';
gameOverStats.style.fontSize = '20px';
gameOverStats.style.marginBottom = '20px';
gameOverStats.style.textAlign = 'center';
gameOverOverlay.appendChild(gameOverStats);

// Detailed message (shows reason for game over)
const gameOverDetail = document.createElement('p');
gameOverDetail.id = 'gameOverDetail';
gameOverDetail.textContent = '';
gameOverDetail.style.color = 'white';
gameOverDetail.style.fontFamily = 'Arial, sans-serif';
gameOverDetail.style.fontSize = '24px';
gameOverDetail.style.marginBottom = '30px';
gameOverOverlay.appendChild(gameOverDetail);

// Restart button
const restartButton = document.createElement('button');
restartButton.textContent = 'RESTART';
restartButton.style.padding = '10px 20px';
restartButton.style.fontSize = '20px';
restartButton.style.backgroundColor = '#ff4136';
restartButton.style.color = 'white';
restartButton.style.border = 'none';
restartButton.style.borderRadius = '5px';
restartButton.style.cursor = 'pointer';
restartButton.addEventListener('mouseenter', () => {
  restartButton.style.backgroundColor = '#ff725c';
});
restartButton.addEventListener('mouseleave', () => {
  restartButton.style.backgroundColor = '#ff4136';
});
gameOverOverlay.appendChild(restartButton);

// Add to document
document.body.appendChild(gameOverOverlay);

// Game state
let gameActive = true;
let gameStartTime = 0;
let currentTime = 0;
let bestTime = localStorage.getItem('bestTime') ? parseFloat(localStorage.getItem('bestTime')) : null;
let maxSpeed = 0;

// Add score display
const scoreDisplay = document.createElement('div');
scoreDisplay.id = 'scoreDisplay';
scoreDisplay.style.position = 'fixed';
scoreDisplay.style.top = '10px';
scoreDisplay.style.right = '10px';
scoreDisplay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
scoreDisplay.style.color = 'white';
scoreDisplay.style.padding = '10px';
scoreDisplay.style.borderRadius = '5px';
scoreDisplay.style.fontFamily = 'Arial, sans-serif';
scoreDisplay.style.fontSize = '16px';
scoreDisplay.style.zIndex = '100';
document.body.appendChild(scoreDisplay);

// Function to update the score display
function updateScoreDisplay() {
  if (!gameActive) return;
  
  const timeString = currentTime.toFixed(2) + 's';
  const bestTimeString = bestTime ? bestTime.toFixed(2) + 's' : 'None';
  const maxSpeedString = maxSpeed.toFixed(1);
  
  scoreDisplay.innerHTML = `
    Time: ${timeString}<br>
    Best: ${bestTimeString}<br>
    Max Speed: ${maxSpeedString}
  `;
}

// --- Lighting ---
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(50, 100, 50);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
scene.add(directionalLight);

// --- Create main game objects ---
const terrain = Utils.createTerrain(scene);
// We can't call Utils.addTrees directly, so let's create a global array
let treePositions = [];

// Manually add trees and store their positions
function addTreesWithPositions(scene) {
  // Copy the addTrees function implementation here
  const positions = [];
  // Add trees on both sides of the ski path
  for(let z = -80; z < 80; z += 10) {
    for(let x = -60; x < 60; x += 10) {
      // Skip the ski path
      if(Math.abs(x) < 10) continue;
      
      // Random offset
      const xPos = x + (Math.random() * 5 - 2.5);
      const zPos = z + (Math.random() * 5 - 2.5);
      
      // Only place trees on suitable slopes (not too steep)
      const y = Utils.getTerrainHeight(xPos, zPos);
      const gradient = Utils.getTerrainGradient(xPos, zPos);
      const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
      
      if(steepness < 0.5 && Math.random() > 0.7) {
        positions.push({x: xPos, y: y, z: zPos});
      }
    }
  }
  
  // Create tree instances using the createTree function from utils
  positions.forEach(pos => {
    const tree = createTree(); // This would need the createTree function
    tree.position.set(pos.x, pos.y, pos.z);
    scene.add(tree);
  });
  
  return positions;
}

// Call it and store the positions
treePositions = addTreesWithPositions(scene);

const snowman = Utils.createSnowman(scene);
Utils.createSnowflakes(scene);

// --- Snowman Position & Reset ---
let pos = { x: 0, z: -40, y: Utils.getTerrainHeight(0, -40) };
let velocity = { x: 0, z: 0 }; 
let isInAir = false;
let verticalVelocity = 0;
let jumpCooldown = 0;
let lastTerrainHeight = 0;
let airTime = 0;

// Variables for automatic turning
let turnPhase = 0;
let currentTurnDirection = 0;
let turnChangeCooldown = 0;
let turnAmplitude = 3.0;

function resetSnowman() {
  pos = { x: 0, z: -40, y: Utils.getTerrainHeight(0, -40) };
  velocity = { x: 0, z: -6.0 }; 
  snowman.position.set(pos.x, pos.y, pos.z);
  snowman.rotation.set(0, Math.PI, 0);
  
  // Reset timer and max speed
  gameStartTime = performance.now();
  currentTime = 0;
  maxSpeed = 0;
}
resetSnowman();
document.getElementById('resetBtn').addEventListener('click', resetSnowman);

// Add control information display
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

// Keyboard control state
let keyboardControls = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false
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

// --- Update Snowman: Physics-based Movement ---
function updateSnowman(delta) {
  // Update time
  if (gameActive) {
    currentTime = (performance.now() - gameStartTime) / 1000;
    updateScoreDisplay();
  }
  
  // Update jump cooldown
  if (jumpCooldown > 0) {
    jumpCooldown -= delta;
  }
  
  // Get current terrain height at position
  const terrainHeightAtPosition = Utils.getTerrainHeight(pos.x, pos.z);
  
  // Check for landing
  if (isInAir && pos.y <= terrainHeightAtPosition) {
    isInAir = false;
    pos.y = terrainHeightAtPosition;
    
    // Landing impact based on air time and height
    const landingImpact = Math.min(0.5, airTime * 0.15);
    let currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
    
    // Reduce speed on landing
    velocity.x *= (1 - landingImpact);
    velocity.z *= (1 - landingImpact);
    
    // Reset jump-related variables
    verticalVelocity = 0;
    airTime = 0;
    jumpCooldown = 0.3; // Short cooldown after landing
  }
  
  // Calculate the downhill direction
  const dir = Utils.getDownhillDirection(pos.x, pos.z);
  
  // Get gradient for physics calculations
  const gradient = Utils.getTerrainGradient(pos.x, pos.z);
  const steepness = Math.sqrt(gradient.x*gradient.x + gradient.z*gradient.z);
  
  // Detect natural jumps from terrain (like going over moguls)
  const heightDifference = terrainHeightAtPosition - lastTerrainHeight;
  let currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
  const movingFast = currentSpeed > 12;
  
  // Auto-jump when going downhill after a steep uphill section
  if (!isInAir && heightDifference < -0.8 && movingFast && jumpCooldown <= 0) {
    verticalVelocity = 6 + (currentSpeed * 0.3);
    isInAir = true;
  }
  
  // Manual jump with spacebar
  if (keyboardControls.jump && !isInAir && jumpCooldown <= 0) {
    verticalVelocity = 10 + (currentSpeed * 0.5);
    isInAir = true;
    jumpCooldown = 0.5; // Prevent jump spam
  }
  
  // Update vertical position and velocity when in air
  if (isInAir) {
    // Track time in air
    airTime += delta;
    
    // Apply gravity to vertical velocity
    verticalVelocity -= 16 * delta;
    
    // Update vertical position
    pos.y += verticalVelocity * delta;
    
    // Air control
    if (keyboardControls.left) {
      velocity.x -= 5.0 * delta;
    }
    if (keyboardControls.right) {
      velocity.x += 5.0 * delta;
    }
    
    // Less friction in air
    velocity.x *= (1 - 0.01);
    velocity.z *= (1 - 0.01);
  } else {
    // Update velocity based on gravity, gradient, and a simple friction model
    const gravity = 9.8;
    const friction = 0.04;
    
    // Apply forces to velocity (gravity pulls along slope direction)
    velocity.x += dir.x * steepness * gravity * delta;
    velocity.z += dir.z * steepness * gravity * delta;
    
    // Handle keyboard input for steering
    const keyboardTurnForce = 16.0;
    
    if (keyboardControls.left) {
      velocity.x -= keyboardTurnForce * delta;
    }
    if (keyboardControls.right) {
      velocity.x += keyboardTurnForce * delta;
    }
    
    // Handle forward/backward input
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
        currentTurnDirection = Math.random() > 0.5 ? 1 : -1;
        turnChangeCooldown = 2 + Math.random() * 3;
      }
      
      // Apply turning force
      const turnIntensity = 2.5 * Math.min(currentSpeed, 10) / 10;
      
      // Apply sine wave turning + random direction change
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
  const gradX = (Utils.getTerrainHeight(pos.x + 0.1, pos.z) - Utils.getTerrainHeight(pos.x - 0.1, pos.z)) / 0.2;
  const gradZ = (Utils.getTerrainHeight(pos.x, pos.z + 0.1) - Utils.getTerrainHeight(pos.x, pos.z - 0.1)) / 0.2;
  
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
  
  // Calculate current speed and update max speed if needed
  currentSpeed = Math.sqrt(velocity.x*velocity.x + velocity.z*velocity.z);
  if (currentSpeed > maxSpeed) {
    maxSpeed = currentSpeed;
  }
  
  // Check if snowman is off the terrain or falling
  const fallThreshold = 0.5; // How far below terrain to allow before reset
  
  // Check for tree collisions
  const treeCollisionRadius = 2.5; // Collision distance for trees
  const collision = treePositions.some(treePos => {
    const dx = pos.x - treePos.x;
    const dz = pos.z - treePos.z;
    const distance = Math.sqrt(dx*dx + dz*dz);
    return distance < treeCollisionRadius;
  });
  
  // Reset if: reaches end of slope, goes off sides, falls off terrain, or hits a tree
  if (pos.z < -100 || 
      Math.abs(pos.x) > 70 || 
      (!isInAir && pos.y < terrainHeightAtPosition - fallThreshold) ||
      collision) {
    
    if (gameActive) {
      // Determine the reason for game over
      let reason = "You crashed!";
      let victory = false;
      
      if (collision) {
        reason = "BANG!!! You hit a tree!";
      } else if (pos.z < -100) {
        reason = "You reached the bottom of the mountain!";
        victory = true;
        
        // Check if this is a new best time
        if (victory && (bestTime === null || currentTime < bestTime)) {
          bestTime = currentTime;
          localStorage.setItem('bestTime', bestTime.toString());
        }
      } else if (Math.abs(pos.x) > 70) {
        reason = "You went off the mountain!";
      } else if (!isInAir && pos.y < terrainHeightAtPosition - fallThreshold) {
        reason = "You fell off the terrain!";
      }
      
      showGameOver(reason, victory);
    }
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
camera.position.set(0, 20, 0);
camera.lookAt(0, 0, -40);

// --- Animation Loop ---
let lastTime = 0;
function animate(time) {
  if (gameActive) {
    requestAnimationFrame(animate);
    const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
    lastTime = time;
    
    updateSnowman(delta);
    Utils.updateSnowflakes(delta, pos, scene);
    updateCamera();
    renderer.render(scene, camera);
  } else if (animationRunning) {
    animationRunning = false;
  }
}
// Initialize the first time
gameStartTime = performance.now();
animate(0);

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Add these functions for game over handling
function showGameOver(reason, victory = false) {
  gameActive = false;
  
  // Update stats on game over screen
  gameOverStats.innerHTML = `
    Time: ${currentTime.toFixed(2)}s<br>
    Best Time: ${bestTime ? bestTime.toFixed(2) + 's' : 'None'}<br>
    Max Speed: ${maxSpeed.toFixed(1)}
  `;
  
  // Set message based on victory or defeat
  if (victory) {
    gameOverMessage.textContent = 'FINISH!';
    gameOverMessage.style.color = '#4CAF50';
    
    if (bestTime === currentTime) {
      gameOverStats.innerHTML += '<br><span style="color:#FFD700;font-weight:bold">NEW RECORD!</span>';
    }
  } else {
    gameOverMessage.textContent = 'GAME OVER';
    gameOverMessage.style.color = 'white';
  }
  
  gameOverDetail.textContent = reason;
  gameOverOverlay.style.display = 'flex';
}

function restartGame() {
  gameOverOverlay.style.display = 'none';
  gameActive = true;
  resetSnowman();
  
  // Reset animation if it was stopped
  if (!animationRunning) {
    animationRunning = true;
    lastTime = performance.now();
    animate(lastTime);
  }
}

// Add event listener to restart button
restartButton.addEventListener('click', restartGame);

// Animation state tracking
let animationRunning = true;
