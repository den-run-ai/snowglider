// --- Import utilities ---
// Note: In a real application, you would use: import * as Snow from './snow.js';
// But for demonstration we assume Snow and Snowman are globally available
// require('./snow.js');
// require('./snowman.js');

// Get keyboard controls from the Controls module
Controls.setupControls();

// --- Scene, Renderer and Camera ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Initialize camera manager
const cameraManager = new Camera(scene);
// Use the camera manager's camera for rendering
const camera = cameraManager.getCamera();

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
restartButton.style.padding = '15px 30px';
restartButton.style.fontSize = '22px';
restartButton.style.backgroundColor = '#ff4136';
restartButton.style.color = 'white';
restartButton.style.border = 'none';
restartButton.style.borderRadius = '8px';
restartButton.style.cursor = 'pointer';
restartButton.style.minWidth = '200px';
restartButton.style.webkitTapHighlightColor = 'rgba(255, 255, 255, 0.5)';
restartButton.style.touchAction = 'manipulation'; // Removes delay on mobile devices
restartButton.style.userSelect = 'none';
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

// --- Lighting ---
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(50, 100, 50);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
scene.add(directionalLight);

// --- Create main game objects ---
// Store terrain in a global for precise object positioning
const terrainResult = Snow.createTerrain(scene);
const terrain = terrainResult.terrain;
// Store terrain reference in global for later object placement
window.terrainMesh = terrain;
// We can't call Snow.addTrees directly, so let's create a global array
let treePositions = [];

// Instead of duplicating the tree placement logic, use Snow.addTrees
// and store its returned positions for collision detection
function addTreesWithPositions(scene) {
  // The addTrees function in Snow now handles all tree placement and rendering
  // It returns an array of all tree positions that we can use for collision detection
  
  // Extended range to match mountains.js implementation
  // Using the same ranges as in mountains.js:
  // - Z range from -180 to 80 (extended run)
  // - X range from -100 to 100 (wider area)
  
  // Let Snow.addTrees handle the actual tree creation and return positions
  return Snow.addTrees(scene);
}

// Call it and store the positions
treePositions = addTreesWithPositions(scene);

// Ensure all tree positions are included in collision detection by logging the range
console.log(`Tree positions array has ${treePositions.length} trees for collision detection`);
if (treePositions.length > 0) {
  // Log the ranges to verify coverage
  const zMin = Math.min(...treePositions.map(t => t.z));
  const zMax = Math.max(...treePositions.map(t => t.z));
  const xMin = Math.min(...treePositions.map(t => t.x));
  const xMax = Math.max(...treePositions.map(t => t.x));
  console.log(`Tree collision ranges - X: ${xMin.toFixed(1)} to ${xMax.toFixed(1)}, Z: ${zMin.toFixed(1)} to ${zMax.toFixed(1)}`);
}

// Set up window.treePositions for test hooks to access
window.treePositions = treePositions;

// Create a global flag to control test behavior
window.isTestMode = window.location.search.includes('test');

const snowman = Snowman.createSnowman(scene);
Snow.createSnowflakes(scene);

// Create snow splash particle system for ski effects using sprites
// like the snowflakes for better visibility
const snowSplash = Snow.createSnowSplash();

// --- Snowman Position & Reset ---
let pos = { x: 0, z: -40, y: Snow.getTerrainHeight(0, -40) };
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

// Add timer and best time tracking
let startTime = 0;
let bestTime = localStorage.getItem('snowgliderBestTime') ? parseFloat(localStorage.getItem('snowgliderBestTime')) : Infinity;
let timerDisplay = document.createElement('div');
timerDisplay.id = 'timerDisplay';
timerDisplay.style.position = 'fixed';
timerDisplay.style.top = '60px'; // Positioned below the auth container
timerDisplay.style.right = '10px';
timerDisplay.style.padding = '8px 12px';
timerDisplay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
timerDisplay.style.color = 'white';
timerDisplay.style.fontFamily = 'Arial, sans-serif';
timerDisplay.style.fontSize = '24px';
timerDisplay.style.borderRadius = '5px';
document.body.appendChild(timerDisplay);

// Add best time to game over overlay
const bestTimeDisplay = document.createElement('p');
bestTimeDisplay.id = 'bestTimeDisplay';
bestTimeDisplay.textContent = bestTime !== Infinity ? `Best Time: ${bestTime.toFixed(2)}s` : 'No best time yet';
bestTimeDisplay.style.color = 'white';
bestTimeDisplay.style.fontFamily = 'Arial, sans-serif';
bestTimeDisplay.style.fontSize = '20px';
bestTimeDisplay.style.marginBottom = '20px';
gameOverOverlay.insertBefore(bestTimeDisplay, restartButton);

// Removed easing function and startup tracking variables - simplifying for debugging

function resetSnowman() {
  // Reset snowman using the Snowman module function
  lastTerrainHeight = Snowman.resetSnowman(snowman, pos, velocity, Snow.getTerrainHeight, cameraManager);
  
  // Reset automatic turning variables to avoid initial random turns
  turnPhase = 0;
  currentTurnDirection = 0;
  turnChangeCooldown = 3.0; // Longer initial cooldown to prevent immediate turns
  
  // Reset air state variables
  isInAir = false;
  verticalVelocity = 0;
  jumpCooldown = 0;
  airTime = 0;
  
  // Reset keyboard controls
  Controls.resetControls();
  
  // Ensure audio is playing if not muted
  if (window.AudioModule) {
    AudioModule.enableSound(true);
  }
  
  // Initialize test hooks immediately after reset
  Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
  
  startTime = performance.now(); // Reset the timer when starting a new run
  updateTimerDisplay();
  
  // Track game reset in Analytics if available
  try {
    // Only try to use analytics when properly initialized with modular SDK
    if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function' && window.location.protocol !== 'file:') {
      // Using the direct logEvent function
      window.firebaseModules.logEvent('game_reset');
    }
  } catch (e) {
    console.log("Analytics tracking skipped:", e.message);
  }
}
// Make resetSnowman accessible globally for touch handler
window.resetSnowman = resetSnowman;

resetSnowman();
document.getElementById('resetBtn').addEventListener('click', resetSnowman);

// Add control information display
const resetBtn = document.getElementById('resetBtn');
const controlsInfo = document.createElement('div');
controlsInfo.id = 'controlsInfo';
controlsInfo.innerHTML = '⌨️ Controls: ←/A, →/D to steer | ↑/W accelerate | ↓/S brake | Space to jump | V to toggle chase view';
controlsInfo.style.display = 'inline-block';
controlsInfo.style.marginLeft = '10px';
controlsInfo.style.fontFamily = 'Arial, sans-serif';
controlsInfo.style.fontSize = '14px';
controlsInfo.style.color = '#333';
resetBtn.parentNode.insertBefore(controlsInfo, resetBtn.nextSibling);

// Add camera toggle button
const cameraToggleBtn = document.createElement('button');
cameraToggleBtn.id = 'cameraToggleBtn';
cameraToggleBtn.textContent = 'Toggle Chase View';
cameraToggleBtn.style.position = 'absolute';
cameraToggleBtn.style.bottom = '20px';
cameraToggleBtn.style.left = '170px'; // Position it next to reset button
cameraToggleBtn.style.padding = '15px 20px';
cameraToggleBtn.style.border = 'none';
cameraToggleBtn.style.borderRadius = '8px';
cameraToggleBtn.style.backgroundColor = '#4a69bd'; // Different color from reset button
cameraToggleBtn.style.color = 'white';
cameraToggleBtn.style.cursor = 'pointer';
cameraToggleBtn.style.fontSize = '16px';
cameraToggleBtn.style.webkitTapHighlightColor = 'rgba(255, 255, 255, 0.5)';
cameraToggleBtn.style.touchAction = 'manipulation'; // Removes delay on mobile devices
cameraToggleBtn.style.userSelect = 'none';

// Add both click and touchend events to ensure cross-platform compatibility
cameraToggleBtn.addEventListener('click', toggleCameraView);
cameraToggleBtn.addEventListener('touchend', function(event) {
  event.preventDefault();
  toggleCameraView();
}, { passive: false });

document.body.appendChild(cameraToggleBtn);

// Keyboard event listeners now managed by the Controls module

// --- Update Snowman: Physics-based Movement ---
function updateSnowman(delta) {
  // We no longer need to add test hooks every frame as they're set up at initialization
  // and after resets. This improves performance.
  
  // Update snowman using the Snowman module function
  const result = Snowman.updateSnowman(
    snowman, delta, pos, velocity, isInAir, verticalVelocity, 
    lastTerrainHeight, airTime, jumpCooldown, Controls.getControls(), 
    turnPhase, currentTurnDirection, turnChangeCooldown, turnAmplitude,
    Snow.getTerrainHeight, Snow.getTerrainGradient, Snow.getDownhillDirection, 
    treePositions, gameActive, showGameOver
  );
  
  // Update state variables from the result
  isInAir = result.isInAir;
  verticalVelocity = result.verticalVelocity;
  lastTerrainHeight = result.lastTerrainHeight;
  airTime = result.airTime;
  jumpCooldown = result.jumpCooldown;
  turnPhase = result.turnPhase;
  currentTurnDirection = result.currentTurnDirection;
  turnChangeCooldown = result.turnChangeCooldown;
  
  // Update info display with jump status
  document.getElementById('info').textContent =
    `Pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} | Speed: ${result.currentSpeed.toFixed(1)} | ${isInAir ? "Jumping!" : "On ground"}`;
}

// --- Update Camera: Follow the Snowman ---
function updateCamera() {
  // Simply delegate to the camera manager
  cameraManager.update(
    snowman.position,
    snowman.rotation,
    velocity,
    Snow.getTerrainHeight
  );
}

// --- Initial Camera Setup ---
// Initialize camera with the snowman's position and rotation
cameraManager.initialize(
  new THREE.Vector3(pos.x, pos.y, pos.z),
  new THREE.Euler(0, Math.PI, 0) // Snowman starts facing down the mountain (π radians)
);

// Initialize audio and connect to camera
AudioModule.init(scene);
// Make sure to attach audio listener to the camera
AudioModule.addAudioListener(camera);
// Set up the audio UI
AudioModule.setupUI();

// --- Animation Loop ---
let lastTime = 0; // Original initialization
function animate(time) {
  if (gameActive) {
    requestAnimationFrame(animate);
    const delta = Math.min((time - lastTime) / 1000, 0.1); // Cap delta to avoid jumps
    lastTime = time;
    
    // Only set up test hooks if they're missing
    if (!window.testHooks) {
      console.log("Test hooks missing in animation loop, reinstalling");
      Snowman.addTestHooks(pos, showGameOver, gameActive, Snow.getTerrainHeight);
    }
    
    updateSnowman(delta);
    Snow.updateSnowflakes(delta, pos, scene);
    
    // Save player position before snow splash effect updates
    const playerPosBefore = { 
      x: snowman.position.x, 
      y: snowman.position.y, 
      z: snowman.position.z 
    };
    
    // Update snow splash particles - pass all required parameters
    Snow.updateSnowSplash(snowSplash, delta, snowman, velocity, isInAir, scene);
    
    // Ensure snowman position wasn't affected by particles
    snowman.position.set(playerPosBefore.x, playerPosBefore.y, playerPosBefore.z);
    
    updateCamera();
    updateTimerDisplay(); // Update the timer display
    renderer.render(scene, camera);
  } else if (animationRunning) {
    animationRunning = false;
  }
}
animate(0);

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
  cameraManager.handleResize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Add these functions for game over handling
function showGameOver(reason) {
  gameActive = false;
  gameOverDetail.textContent = reason;
  
  // Pause audio on game over
  if (window.AudioModule) {
    AudioModule.enableSound(false);
  }
  
  // Only update times if player reached the end successfully
  if (reason === "You reached the end of the slope!") {
    const currentTime = (performance.now() - startTime) / 1000;
    
    // Show appropriate message based on time
    if (currentTime < bestTime) {
      bestTime = currentTime;
      localStorage.setItem('snowgliderBestTime', bestTime);
      bestTimeDisplay.textContent = `New Best Time: ${bestTime.toFixed(2)}s`;
      bestTimeDisplay.style.color = '#ffff00'; // Highlight new record
      
      // Record to Firebase if user is logged in
      if (window.AuthModule && window.AuthModule.getCurrentUser()) {
        window.AuthModule.recordScore(currentTime);
      }
    } else {
      bestTimeDisplay.textContent = `Your Time: ${currentTime.toFixed(2)}s (Best: ${bestTime.toFixed(2)}s)`;
      bestTimeDisplay.style.color = 'white';
      
      // Still record to Firebase even if not a personal best
      if (window.AuthModule && window.AuthModule.getCurrentUser()) {
        window.AuthModule.recordScore(currentTime);
      }
    }
    
    // Show login prompt if not logged in
    if (window.AuthModule && !window.AuthModule.getCurrentUser()) {
      const loginPrompt = document.createElement('p');
      loginPrompt.textContent = 'Log in to save your score and see the leaderboard!';
      loginPrompt.style.color = '#4285F4';
      loginPrompt.style.fontStyle = 'italic';
      loginPrompt.style.margin = '10px 0';
      
      // Insert before restart button
      if (!document.getElementById('loginPrompt')) {
        loginPrompt.id = 'loginPrompt';
        gameOverOverlay.insertBefore(loginPrompt, restartButton);
      }
    }
    
    // Track successful run in Analytics
    try {
      // Only try to use analytics when properly initialized with modular SDK
      if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
        // Using the direct logEvent function
        window.firebaseModules.logEvent('complete_game', {
          time: currentTime
        });
      }
    } catch (e) {
      console.log("Analytics tracking skipped:", e.message);
    }
  } else {
    // For failures (tree collision, falling, etc.), don't record or update best time
    bestTimeDisplay.textContent = bestTime !== Infinity ? `Best Time: ${bestTime.toFixed(2)}s` : 'No best time yet';
    bestTimeDisplay.style.color = 'white';
    
    // Track game over reason in Analytics
    try {
      // Only try to use analytics when properly initialized with modular SDK
      if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
        // Using the direct logEvent function
        window.firebaseModules.logEvent('game_over', {
          reason: reason
        });
      }
    } catch (e) {
      console.log("Analytics tracking skipped:", e.message);
    }
  }
  
  // Get leaderboard if user is logged in
  if (window.AuthModule && window.AuthModule.getCurrentUser()) {
    // Get the leaderboard element
    const leaderboardElement = document.getElementById('leaderboard');
    
    // Add to game over overlay if not already there
    if (leaderboardElement.parentNode !== gameOverOverlay) {
      gameOverOverlay.insertBefore(leaderboardElement, restartButton);
      leaderboardElement.style.display = 'block';
    }
    
    // Display leaderboard
    window.AuthModule.displayLeaderboard();
  }
  
  gameOverOverlay.style.display = 'flex';
}

function restartGame() {
  gameOverOverlay.style.display = 'none';
  gameActive = true;
  resetSnowman();
  
  // Initialize camera with the snowman's position and rotation
  cameraManager.initialize(snowman.position, snowman.rotation);
  
  // Resume audio
  if (window.AudioModule) {
    AudioModule.enableSound(true);
  }
  
  // Reset animation if it was stopped
  if (!animationRunning) {
    animationRunning = true;
    lastTime = performance.now();
    animate(lastTime);
  }
}
// Make restartGame accessible globally for touch handler
window.restartGame = restartGame;

// Toggle between first-person and third-person camera views
function toggleCameraView() {
  // Call the camera manager's toggle method
  const newMode = cameraManager.toggleCameraMode();
  
  // Reset camera initialization with current snowman position and rotation
  cameraManager.initialize(snowman.position, snowman.rotation);
  
  // Update the controls info to show the current camera mode
  const controlsInfo = document.getElementById('controlsInfo');
  if (controlsInfo) {
    controlsInfo.innerHTML = `⌨️ Controls: ←/A, →/D to steer | ↑/W accelerate | ↓/S brake | Space to jump | V to toggle ${newMode === 'thirdPerson' ? 'chase' : 'normal'} view`;
  }
  
  // Update the toggle button text
  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  if (cameraToggleBtn) {
    cameraToggleBtn.textContent = `Toggle ${newMode === 'thirdPerson' ? 'Chase' : 'Normal'} View`;
  }
  
  // Return the new mode (useful for tests)
  return newMode;
}

// Make toggleCameraView accessible globally for the keyboard handler in controls.js
window.toggleCameraView = toggleCameraView;

// Initialize test hooks explicitly to ensure they're available immediately
// This is important for browser tests that run soon after page load
console.log("Initializing test hooks on startup");
Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);

// Add event listener to restart button
restartButton.addEventListener('click', restartGame);

// Animation state tracking
let animationRunning = true;

// Update timer display during gameplay
function updateTimerDisplay() {
  if (gameActive) {
    const currentTime = (performance.now() - startTime) / 1000;
    timerDisplay.textContent = `Time: ${currentTime.toFixed(2)}s`;
  }
}

// Make sure test hooks are always available for tests
// This is crucial for browser tests that need to verify tree collisions
// Run this setup again after a short delay to ensure tests can find them
setTimeout(() => {
  // Always reinitialize test hooks to ensure they have the latest pos and showGameOver references
  console.log("Refreshing test hooks for browser tests (delayed setup)");
  Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
  if (window.testHooks) {
    console.log("Test hooks available:", Object.keys(window.testHooks).join(", "));
  }
}, 300);
