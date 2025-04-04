// controls.js - Keyboard and touch controls for SnowGlider game

// Initialize controls state - used for both keyboard and touch
const gameControls = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false
};

// Touch state tracking
const touchState = {
  touches: {},         // Store active touch points
  controlRegions: {},  // Regions for touch controls on screen
  showVisualControls: false // Flag to enable visual touch controls (optional)
};

// Setup controls (keyboard + touch)
function setupControls() {
  // Set up keyboard controls
  setupKeyboardControls();
  
  // Set up touch controls
  setupTouchControls();

  // Return the shared controls object
  return gameControls;
}

// Setup keyboard control handlers
function setupKeyboardControls() {
  // Handle keyboard down events
  const handleKeyDown = (event) => {
    switch(event.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        gameControls.left = true;
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        gameControls.right = true;
        break;
      case 'ArrowUp':
      case 'w':
      case 'W':
        gameControls.up = true;
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        gameControls.down = true;
        break;
      case ' ':  // Spacebar
        gameControls.jump = true;
        break;
      case 'v':  // Toggle camera view
      case 'V':
        // This will be handled in the main game code
        if (typeof window.toggleCameraView === 'function') {
          window.toggleCameraView();
        }
        break;
    }
  };
  
  // Handle keyboard up events
  const handleKeyUp = (event) => {
    switch(event.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        gameControls.left = false;
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        gameControls.right = false;
        break;
      case 'ArrowUp':
      case 'w':
      case 'W':
        gameControls.up = false;
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        gameControls.down = false;
        break;
      case ' ':  // Spacebar
        gameControls.jump = false;
        break;
    }
  };
  
  // Add keyboard listeners to both window and document for better coverage
  window.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keydown', handleKeyDown);
  
  window.addEventListener('keyup', handleKeyUp);
  document.addEventListener('keyup', handleKeyUp);
}

// Setup touch control handlers
function setupTouchControls() {
  // Detect if we're on a mobile device
  const isMobileDevice = () => {
    return (
      typeof window.orientation !== 'undefined' ||
      navigator.userAgent.indexOf('IEMobile') !== -1 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
  };
  
  // Only create visual indicators if we're on a mobile device
  if (isMobileDevice()) {
    touchState.showVisualControls = true;
    
    // Add touch event handlers for reset and restart buttons
    setupButtonTouchHandlers();
  }
  
  // Calculate and update touch regions based on screen dimensions
  const updateTouchRegions = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Define regions for touch controls
    touchState.controlRegions = {
      // Left side of screen (left third)
      left: {
        x: 0,
        y: height / 3,
        width: width / 3,
        height: height / 3
      },
      // Right side of screen (right third)
      right: {
        x: width * 2 / 3,
        y: height / 3,
        width: width / 3,
        height: height / 3
      },
      // Upper middle of screen
      up: {
        x: width / 3,
        y: 0,
        width: width / 3,
        height: height / 3
      },
      // Lower middle of screen
      down: {
        x: width / 3,
        y: height * 2 / 3,
        width: width / 3,
        height: height / 3
      },
      // Center of screen (for jump)
      jump: {
        x: width / 3,
        y: height / 3,
        width: width / 3,
        height: height / 3
      }
    };
    
    // Create or update visual indicators for touch regions if enabled
    if (touchState.showVisualControls) {
      createOrUpdateVisualControls();
    }
  };
  
  // Update regions initially
  updateTouchRegions();
  
  // Update regions when window is resized
  window.addEventListener('resize', updateTouchRegions);
  
  // Handle touch start
  const handleTouchStart = (event) => {
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }
    
    // Process each touch point
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      processTouchInput(touch, true);
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
    }
  };
  
  // Handle touch move
  const handleTouchMove = (event) => {
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }
    
    // Process each touch point
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      processTouchInput(touch, true);
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
    }
  };
  
  // Handle touch end
  const handleTouchEnd = (event) => {
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }
    
    // Process each touch point being removed
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      processTouchInput(touch, false);
      delete touchState.touches[touch.identifier];
    }
    
    // If no touches remain, reset all controls
    if (Object.keys(touchState.touches).length === 0) {
      gameControls.left = false;
      gameControls.right = false;
      gameControls.up = false;
      gameControls.down = false;
      gameControls.jump = false;
    }
  };
  
  // Process touch input based on screen position
  const processTouchInput = (touch, isActive) => {
    const x = touch.clientX;
    const y = touch.clientY;
    
    // Check which region the touch is in and update controls
    if (isPointInRegion(x, y, touchState.controlRegions.left)) {
      gameControls.left = isActive;
    }
    else if (isPointInRegion(x, y, touchState.controlRegions.right)) {
      gameControls.right = isActive;
    }
    else if (isPointInRegion(x, y, touchState.controlRegions.up)) {
      gameControls.up = isActive;
    }
    else if (isPointInRegion(x, y, touchState.controlRegions.down)) {
      gameControls.down = isActive;
    }
    else if (isPointInRegion(x, y, touchState.controlRegions.jump)) {
      gameControls.jump = isActive;
    }
    
    // Optional: provide visual feedback on touch controls
    if (touchState.showVisualControls && isActive) {
      const touchControls = document.querySelectorAll('.touch-control');
      touchControls.forEach(control => {
        // Highlight the active control
        if ((control.classList.contains('touch-left') && gameControls.left) ||
            (control.classList.contains('touch-right') && gameControls.right) ||
            (control.classList.contains('touch-up') && gameControls.up) ||
            (control.classList.contains('touch-down') && gameControls.down) ||
            (control.classList.contains('touch-jump') && gameControls.jump)) {
          control.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
        } else {
          control.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
        }
      });
    }
  };
  
  // Helper to check if a point is in a region
  const isPointInRegion = (x, y, region) => {
    return (
      x >= region.x && 
      x <= region.x + region.width && 
      y >= region.y && 
      y <= region.y + region.height
    );
  };
  
  // Add touch event listeners
  document.addEventListener('touchstart', handleTouchStart, { passive: false });
  document.addEventListener('touchmove', handleTouchMove, { passive: false });
  document.addEventListener('touchend', handleTouchEnd, { passive: false });
  document.addEventListener('touchcancel', handleTouchEnd, { passive: false });
  
  // Create visual indicators for touch controls
  function createOrUpdateVisualControls() {
    // Remove existing controls if they exist
    const existingControls = document.querySelectorAll('.touch-control');
    existingControls.forEach(control => control.remove());
    
    if (!touchState.showVisualControls) return;
    
    // Helper to create a control element
    const createControlElement = (region, name) => {
      const element = document.createElement('div');
      element.className = `touch-control touch-${name}`;
      element.style.position = 'absolute';
      element.style.left = `${region.x}px`;
      element.style.top = `${region.y}px`;
      element.style.width = `${region.width}px`;
      element.style.height = `${region.height}px`;
      element.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
      element.style.border = '2px solid rgba(255, 255, 255, 0.4)';
      element.style.borderRadius = '8px';
      element.style.pointerEvents = 'none'; // Don't interfere with touch events
      element.style.zIndex = '100';
      
      // Add icon or label based on control type
      const label = document.createElement('div');
      label.style.position = 'absolute';
      label.style.top = '50%';
      label.style.left = '50%';
      label.style.transform = 'translate(-50%, -50%)';
      label.style.color = 'white';
      label.style.fontSize = '24px';
      label.style.textShadow = '1px 1px 2px rgba(0, 0, 0, 0.7)';
      
      switch(name) {
        case 'left':
          label.innerHTML = '←';
          break;
        case 'right':
          label.innerHTML = '→';
          break;
        case 'up':
          label.innerHTML = '↑';
          break;
        case 'down':
          label.innerHTML = '↓';
          break;
        case 'jump':
          label.innerHTML = '⬤'; // Jump button
          break;
      }
      
      element.appendChild(label);
      return element;
    };
    
    // Create all control elements
    Object.entries(touchState.controlRegions).forEach(([name, region]) => {
      const element = createControlElement(region, name);
      document.body.appendChild(element);
    });
  }
}

// Reset all controls to default state
function resetControls() {
  gameControls.left = false;
  gameControls.right = false;
  gameControls.up = false;
  gameControls.down = false;
  gameControls.jump = false;
  
  // Clear all tracked touches
  touchState.touches = {};
  
  return gameControls;
}

// Export controls module
const Controls = {
  setupControls,
  resetControls,
  getControls: () => gameControls,
  isTouchDevice: () => {
    return (
      typeof window.orientation !== 'undefined' ||
      navigator.userAgent.indexOf('IEMobile') !== -1 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
  },
  // Toggle visibility of touch controls
  toggleTouchControls: (show) => {
    if (typeof show === 'boolean') {
      touchState.showVisualControls = show;
      // Refresh controls
      const existingControls = document.querySelectorAll('.touch-control');
      if (show && existingControls.length === 0) {
        // Recalculate regions and create controls
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        if (Object.keys(touchState.controlRegions).length === 0) {
          // Initialize control regions if they don't exist
          setupControls();
        } else {
          // Just create the visuals if regions exist
          const controlElements = document.querySelectorAll('.touch-control');
          if (controlElements.length === 0) {
            // The function is inside setupTouchControls, so we need to call it differently
            const event = new Event('resize');
            window.dispatchEvent(event); // This will trigger updateTouchRegions which calls createOrUpdateVisualControls
          }
        }
      } else if (!show) {
        // Remove controls
        existingControls.forEach(control => control.remove());
      }
    }
    return touchState.showVisualControls;
  }
};

// Function to add explicit touch handlers for game buttons
function setupButtonTouchHandlers() {
  // Add touch handlers to the reset button
  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('touchstart', (event) => {
      event.preventDefault();
      // Call the resetSnowman function directly from the global scope
      if (typeof window.resetSnowman === 'function') {
        window.resetSnowman();
      }
    }, { passive: false });
  }
  
  // Add touch handler to camera toggle button
  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  if (cameraToggleBtn) {
    cameraToggleBtn.addEventListener('touchstart', (event) => {
      event.preventDefault();
      // Call the toggleCameraView function directly from the global scope
      if (typeof window.toggleCameraView === 'function') {
        window.toggleCameraView();
      }
    }, { passive: false });
  }
  
  // For the restart button, we need to set up an observer since it's dynamically created
  // when the game over screen appears
  const gameOverObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && 
          mutation.attributeName === 'style' && 
          mutation.target.id === 'gameOverOverlay' &&
          mutation.target.style.display === 'flex') {
        
        // Game over overlay is now visible, add touch handler to restart button
        const restartButton = document.querySelector('#gameOverOverlay button');
        if (restartButton && !restartButton.getAttribute('touch-handler-added')) {
          restartButton.addEventListener('touchstart', (event) => {
            event.preventDefault();
            // Call the restartGame function directly from the global scope
            if (typeof window.restartGame === 'function') {
              window.restartGame();
            }
          }, { passive: false });
          
          // Mark button as having touch handler to avoid duplicates
          restartButton.setAttribute('touch-handler-added', 'true');
        }
      }
    });
  });
  
  // Start observing the game over overlay
  const gameOverOverlay = document.getElementById('gameOverOverlay');
  if (gameOverOverlay) {
    gameOverObserver.observe(gameOverOverlay, {
      attributes: true,
      attributeFilter: ['style']
    });
  } else {
    // If game over overlay doesn't exist yet, wait a bit and try again
    setTimeout(() => {
      const delayedOverlay = document.getElementById('gameOverOverlay');
      if (delayedOverlay) {
        gameOverObserver.observe(delayedOverlay, {
          attributes: true,
          attributeFilter: ['style']
        });
      }
    }, 1000);
  }
}

// Make Controls available globally
if (typeof window !== 'undefined') {
  window.Controls = Controls;
}