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
// Update to assign renderer to a specific div with an ID
const rendererContainer = document.createElement('div');
rendererContainer.id = 'gameCanvas';
document.body.appendChild(rendererContainer);
rendererContainer.appendChild(renderer.domElement);

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

// --- Initialize audio early, but don't start playing until user interaction ---
// Initialize audio and connect to camera
AudioModule.init(scene);
// Make sure to attach audio listener to the camera
AudioModule.addAudioListener(camera);
// Set up the audio UI
AudioModule.setupUI();

// --- Game state ---
let gameActive = false; // Start inactive until user clicks start button
let animationRunning = false; // Track if animation loop is running
let gameInitialized = false; // Track if game has been initialized

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

// Initialize game stats functionality
function initializeGameStats() {
  console.log("Initializing game stats");
  const bestTimeElement = document.getElementById('bestTimeValue');
  if (bestTimeElement) {
    bestTimeElement.textContent = bestTime !== Infinity ? `${bestTime.toFixed(2)}s` : '--';
  }
  
  // Add game stats toggle functionality
  const statsContainer = document.getElementById('gameStatsContainer');
  const toggleStatsBtn = document.getElementById('toggleStats');
  const statsHeader = document.getElementById('gameStatsHeader');
  
  if (statsContainer && toggleStatsBtn && statsHeader) {
    console.log("Setting up game stats toggle");
    // Function to toggle stats visibility
    const toggleStats = function() {
      console.log("Toggle stats called, current state:", statsContainer.classList.contains('collapsed'));
      statsContainer.classList.toggle('collapsed');
      toggleStatsBtn.textContent = statsContainer.classList.contains('collapsed') ? '▼' : '▲';
    };
    
    // Add click and touch event listeners
    toggleStatsBtn.addEventListener('click', function(e) {
      console.log("Toggle button clicked");
      e.stopPropagation();
      toggleStats();
    });
    
    statsHeader.addEventListener('click', function(e) {
      console.log("Stats header clicked");
      toggleStats();
    });
    
    statsHeader.addEventListener('touchend', function(e) {
      console.log("Stats header touch end");
      e.preventDefault();
      toggleStats();
    }, { passive: false });
    
    // Add horizontal swipe handler for the stats window
    let touchStartX = 0;
    
    statsHeader.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    
    statsHeader.addEventListener('touchmove', function(e) {
      const touchX = e.touches[0].clientX;
      const diff = touchX - touchStartX;
      
      // If swiping left and stats expanded, collapse them
      if (diff < -30 && !statsContainer.classList.contains('collapsed')) {
        console.log("Swipe left detected, collapsing");
        statsContainer.classList.add('collapsed');
        toggleStatsBtn.textContent = '▼';
        e.preventDefault();
      }
      
      // If swiping right and stats collapsed, expand them
      if (diff > 30 && statsContainer.classList.contains('collapsed')) {
        console.log("Swipe right detected, expanding");
        statsContainer.classList.remove('collapsed');
        toggleStatsBtn.textContent = '▲';
        e.preventDefault();
      }
    }, { passive: false });
  } else {
    console.warn("Game stats elements not found:", {
      statsContainer: !!statsContainer,
      toggleStatsBtn: !!toggleStatsBtn,
      statsHeader: !!statsHeader
    });
  }
}

// Initialize the stats display when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log("DOM content loaded, initializing game stats");
  initializeGameStats();
});

// Add best time to game over overlay
const bestTimeDisplay = document.createElement('p');
bestTimeDisplay.id = 'bestTimeDisplay';
bestTimeDisplay.textContent = bestTime !== Infinity ? `Best Time: ${bestTime.toFixed(2)}s` : 'No best time yet';
bestTimeDisplay.style.color = 'white';
bestTimeDisplay.style.fontFamily = 'Arial, sans-serif';
bestTimeDisplay.style.fontSize = '20px';
bestTimeDisplay.style.marginBottom = '20px';
gameOverOverlay.insertBefore(bestTimeDisplay, restartButton);

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

// Initialize controls but don't reset the snowman yet
document.getElementById('resetBtn').addEventListener('click', resetSnowman);

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
  
  // Update game stats display
  // Format speed with color based on value
  const speed = result.currentSpeed.toFixed(1);
  let speedColor = '#FFFFFF'; // Default white
  
  // Color code speed (green for slow, yellow for medium, red for fast)
  if (result.currentSpeed > 20) {
    speedColor = '#FF5252'; // Red for fast
  } else if (result.currentSpeed > 12) {
    speedColor = '#FFD700'; // Yellow for medium
  } else if (result.currentSpeed > 5) {
    speedColor = '#4CAF50'; // Green for good speed
  }
  
  // Update individual stat elements
  const speedElement = document.getElementById('speedValue');
  if (speedElement) {
    speedElement.textContent = speed;
    speedElement.style.color = speedColor;
  }
  
  const positionElement = document.getElementById('positionValue');
  if (positionElement) {
    positionElement.textContent = `${pos.x.toFixed(0)},${pos.z.toFixed(0)}`;
  }
  
  const groundElement = document.getElementById('groundStatus');
  if (groundElement) {
    if (isInAir) {
      groundElement.innerHTML = '🚀 JUMP!';
      groundElement.style.color = '#00FFFF';
    } else {
      groundElement.innerHTML = '⛷️ Ground';
      groundElement.style.color = '#AAFFAA';
    }
  }
  
  // Update timer in the updateTimerDisplay function which is called separately
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

// --- Animation Loop ---
let lastTime = 0;
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

// --- Handle Window Resize ---
window.addEventListener('resize', () => {
  cameraManager.handleResize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Add these functions for game over handling
function showGameOver(reason) {
  gameActive = false;
  
  // Remove game-active class from body for styling
  document.body.classList.remove('game-active');
  
  gameOverDetail.textContent = reason;
  
  // Pause audio on game over
  if (window.AudioModule) {
    AudioModule.enableSound(false);
  }
  
  // Hide or collapse game stats container on game over
  const gameStatsContainer = document.getElementById('gameStatsContainer');
  if (gameStatsContainer) {
    // Option 1: Collapse the stats
    gameStatsContainer.classList.add('collapsed');
    const toggleBtn = document.getElementById('toggleStats');
    if (toggleBtn) {
      toggleBtn.textContent = '▼';
    }
    
    // Option 2 (alternative): Hide the stats completely
    // gameStatsContainer.style.display = 'none';
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
      
      // Update the best time in the game stats window too
      const bestTimeElement = document.getElementById('bestTimeValue');
      if (bestTimeElement) {
        bestTimeElement.textContent = `${bestTime.toFixed(2)}s`;
        bestTimeElement.style.color = '#ffff00'; // Highlight new record
      }
      
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
  
  // Add game-active class to body for styling
  document.body.classList.add('game-active');
  
  // Show and reset game stats
  const gameStatsContainer = document.getElementById('gameStatsContainer');
  if (gameStatsContainer) {
    gameStatsContainer.classList.remove('collapsed');
    const toggleBtn = document.getElementById('toggleStats');
    if (toggleBtn) {
      toggleBtn.textContent = '▲';
    }
    
    // Reset colors for best time display
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.style.color = ''; // Reset to default color
    }
  }
  
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
  
  // Update the camera mode text in the controls info
  const viewControlItem = document.querySelector('#controlsContent .control-item:last-child');
  if (viewControlItem) {
    const keyBadge = viewControlItem.querySelector('.key-badge');
    const textSpan = viewControlItem.querySelector('span:last-child');
    
    if (keyBadge && textSpan) {
      keyBadge.textContent = 'V';
      textSpan.textContent = `Toggle ${newMode === 'thirdPerson' ? 'Normal' : 'Chase'} View`;
    }
  }
  
  // Update the toggle button text
  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  if (cameraToggleBtn) {
    cameraToggleBtn.textContent = `Toggle ${newMode === 'thirdPerson' ? 'Normal' : 'Chase'} View`;
  }
  
  // Return the new mode (useful for tests)
  return newMode;
}

// Make toggleCameraView accessible globally for the keyboard handler in controls.js
window.toggleCameraView = toggleCameraView;

// Add test hook functions for tree collision testing
function addTestHooks(pos, showGameOver, getTerrainHeight) {
  console.log("Snowman.addTestHooks called - setting up test hooks");
  
  if (!window.testHooks) {
    window.testHooks = {};
  }
  
  // Add a force collision function that can be called by tests
  window.testHooks.forceTreeCollision = function() {
    console.log("TEST: forceTreeCollision hook called");
    
    // Create a direct function reference to ensure it works
    const directShowGameOver = window.showGameOver || showGameOver;
    
    // Call the function directly to ensure it works
    console.log("TEST: Forcing tree collision (direct call)");
    try {
      directShowGameOver("BANG!!! You hit a tree!");
      console.log("TEST: Successfully called showGameOver");
    } catch (error) {
      console.error("TEST ERROR: Failed to call showGameOver:", error);
      // As a fallback, just simulate the collision for the test
      window.testCollisionDetected = true;
    }
    
    return true;
  };
  
  // Other test hooks and functionality...
}

// Initialize test hooks explicitly to ensure they're available immediately
// This is important for browser tests that run soon after page load
console.log("Initializing test hooks on startup");
Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);

// Add event listener to restart button
restartButton.addEventListener('click', restartGame);

// Function to initialize controls toggle
function initializeControlsToggle() {
  console.log("Initializing controls toggle");
  const controlsInfo = document.getElementById('controlsInfo');
  const toggleButton = document.getElementById('toggleControls');
  const controlsHeader = document.getElementById('controlsHeader');
  const controlsContent = document.getElementById('controlsContent');
  
  if (controlsInfo && toggleButton && controlsHeader) {
    console.log("Setting up controls toggle");
    
    // Ensure previous event listeners are removed (if possible)
    try {
      controlsHeader.replaceWith(controlsHeader.cloneNode(true));
      const newControlsHeader = document.getElementById('controlsHeader');
      const newToggleButton = document.getElementById('toggleControls');
      
      // Setup the toggle functionality
      const toggleControls = function() {
        console.log("Toggle controls called, current state:", controlsInfo.classList.contains('collapsed'));
        if (controlsInfo.classList.contains('collapsed')) {
          controlsInfo.classList.remove('collapsed');
          newToggleButton.textContent = '▲';
        } else {
          controlsInfo.classList.add('collapsed');
          newToggleButton.textContent = '▼';
        }
      };
      
      // Add click listener to both the button and header
      newToggleButton.addEventListener('click', function(e) {
        console.log("Controls toggle button clicked");
        e.stopPropagation(); // Prevent triggering the header click
        toggleControls();
      });
      
      newControlsHeader.addEventListener('click', function(e) {
        console.log("Controls header clicked");
        toggleControls();
      });
      
      // Add touch events for better mobile experience
      newControlsHeader.addEventListener('touchend', function(e) {
        console.log("Controls header touch end");
        e.preventDefault(); // Prevent default touch behavior
        toggleControls();
      }, { passive: false });
      
      // Auto-collapse on small screens
      const handleScreenSizeChange = () => {
        if (window.innerWidth <= 480 || 
            (window.innerWidth <= 768 && window.innerHeight <= 500)) {
          // Auto-collapse on small screens and landscape mobile
          if (!controlsInfo.classList.contains('collapsed')) {
            console.log("Auto-collapsing controls for small screen");
            controlsInfo.classList.add('collapsed');
            newToggleButton.textContent = '▼';
          }
        }
      };
      
      // Check on resize
      window.addEventListener('resize', handleScreenSizeChange);
      
      // Check on initial load
      handleScreenSizeChange();
      
      // Add horizontal swipe handler for the controls (like Game Stats)
      let touchStartX = 0;
      
      newControlsHeader.addEventListener('touchstart', function(e) {
        touchStartX = e.touches[0].clientX;
      }, { passive: true });
      
      newControlsHeader.addEventListener('touchmove', function(e) {
        const touchX = e.touches[0].clientX;
        const diff = touchX - touchStartX;
        
        // If swiping left and controls expanded, collapse them
        if (diff < -30 && !controlsInfo.classList.contains('collapsed')) {
          console.log("Swipe left detected, collapsing controls");
          controlsInfo.classList.add('collapsed');
          newToggleButton.textContent = '▼';
          e.preventDefault();
        }
        
        // If swiping right and controls collapsed, expand them
        if (diff > 30 && controlsInfo.classList.contains('collapsed')) {
          console.log("Swipe right detected, expanding controls");
          controlsInfo.classList.remove('collapsed');
          newToggleButton.textContent = '▲';
          e.preventDefault();
        }
      }, { passive: false });
    } catch (e) {
      console.error("Error setting up controls toggle:", e);
      
      // Fall back to simple toggle without cloning
      const toggleControls = function() {
        if (controlsInfo.classList.contains('collapsed')) {
          controlsInfo.classList.remove('collapsed');
          toggleButton.textContent = '▲';
        } else {
          controlsInfo.classList.add('collapsed');
          toggleButton.textContent = '▼';
        }
      };
      
      toggleButton.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleControls();
      });
      
      controlsHeader.addEventListener('click', toggleControls);
    }
  } else {
    console.warn("Controls elements not found:", {
      controlsInfo: !!controlsInfo,
      toggleButton: !!toggleButton,
      controlsHeader: !!controlsHeader
    });
  }
}

// Initialize controls toggle when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log("DOM content loaded, initializing controls toggle");
  initializeControlsToggle();
});

// Update timer display during gameplay
function updateTimerDisplay() {
  if (gameActive) {
    const currentTime = (performance.now() - startTime) / 1000;
    
    // Update the current time element in game stats
    const currentTimeElement = document.getElementById('currentTime');
    if (currentTimeElement) {
      currentTimeElement.textContent = `${currentTime.toFixed(2)}s`;
    }
    
    // Keep best time updated
    const bestTimeElement = document.getElementById('bestTimeValue');
    if (bestTimeElement) {
      bestTimeElement.textContent = bestTime !== Infinity ? `${bestTime.toFixed(2)}s` : '--';
    }
  }
}

// Function to initialize the game with audio - called from the start button
window.initializeGameWithAudio = function() {
  console.log("Initializing game with audio...");
  
  // Explicitly try to resume audio context first to address mobile audio issues
  AudioModule.resumeAudioContext().then(() => {
    console.log("Audio context resumed successfully");
  }).catch(err => {
    console.warn("Audio context resume attempt failed:", err);
  });
  
  // Monitor audio status on mobile and show retry if needed
  const checkAudioStatus = () => {
    const status = AudioModule.getStatus();
    
    // If audio buffer is loaded and context is ready, but not playing 2 seconds after game start
    if (!status.playing && status.bufferLoaded && status.contextReady) {
      console.warn('[AUDIO] Ready but not playing — showing retry UI');
      AudioModule.showAudioRetryPrompt();
    } else if (status.contextState === 'interrupted' || status.contextState === 'suspended') {
      console.warn('[AUDIO] Context in unusual state:', status.contextState, '— showing retry UI');
      AudioModule.showAudioRetryPrompt();
    }
  };
  
  // Check audio status 2 seconds after game starts
  setTimeout(checkAudioStatus, 2000);
  
  // Start the audio (will work better on mobile now that we've attempted to resume)
  AudioModule.startAudio();
  
  // Reset the snowman to starting position
  resetSnowman();
  
  // Make sure test hooks are available
  Snowman.addTestHooks(pos, showGameOver, Snow.getTerrainHeight);
  
  // Make sure game stats and controls are properly initialized and visible
  initializeGameStats();
  initializeControlsToggle();
  
  // Initialize Game Stats
  const gameStatsContainer = document.getElementById('gameStatsContainer');
  if (gameStatsContainer) {
    console.log("Game start: ensuring stats are expanded");
    // Make sure stats are visible when game starts
    gameStatsContainer.classList.remove('collapsed');
    const toggleBtn = document.getElementById('toggleStats');
    if (toggleBtn) {
      toggleBtn.textContent = '▲';
    }
    
    // Update initial values
    updateTimerDisplay();
  }
  
  // Initialize Controls
  const controlsInfo = document.getElementById('controlsInfo');
  if (controlsInfo) {
    console.log("Game start: ensuring controls are in right state");
    // Auto-collapse controls on smaller screens, expand on larger screens
    const shouldCollapse = window.innerWidth <= 480 || 
                           (window.innerWidth <= 768 && window.innerHeight <= 500);
    
    if (shouldCollapse) {
      controlsInfo.classList.add('collapsed');
      const toggleBtn = document.getElementById('toggleControls');
      if (toggleBtn) {
        toggleBtn.textContent = '▼';
      }
    } else {
      controlsInfo.classList.remove('collapsed');
      const toggleBtn = document.getElementById('toggleControls');
      if (toggleBtn) {
        toggleBtn.textContent = '▲';
      }
    }
  }
  
  // Display a short loading message if this is the first initialization
  if (!gameInitialized) {
    // Show a loading indicator while THREE.js initializes
    AudioModule.showMessage("Loading game...", 1500);
    gameInitialized = true;
    
    // Short delay to allow for visual transition
    setTimeout(() => {
      // Activate the game after a short delay for visual feedback
      gameActive = true;
      animationRunning = true;
      
      // Add game-active class to body for styling
      document.body.classList.add('game-active');
      
      // Start animation loop
      lastTime = performance.now();
      animate(lastTime);
      
      // Show a "Get Ready" message
      setTimeout(() => {
        AudioModule.showMessage("Get Ready!", 1000);
      }, 1500);
    }, 1800);
  } else {
    // If already initialized once, just restart immediately
    gameActive = true;
    animationRunning = true;
    
    // Add game-active class to body for styling
    document.body.classList.add('game-active');
    
    // Start animation loop
    lastTime = performance.now();
    animate(lastTime);
  }
  
  console.log("Game started successfully!");
  
  // Track game start in analytics if available
  try {
    if (window.firebaseModules && typeof window.firebaseModules.logEvent === 'function') {
      window.firebaseModules.logEvent('game_start');
    }
  } catch (e) {
    console.log("Analytics tracking skipped:", e.message);
  }
  
  return true;
};

// If this is a test environment, auto-start the game
if (window.isTestMode) {
  console.log("Test mode detected, auto-starting game...");
  setTimeout(() => {
    // Hide the start button container
    const startContainer = document.getElementById('startGameContainer');
    if (startContainer) startContainer.style.display = 'none';
    
    // Show the game canvas
    document.getElementById('gameCanvas').style.display = 'block';
    
    // Initialize the game
    window.initializeGameWithAudio();
  }, 100);
}
