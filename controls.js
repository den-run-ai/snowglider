// controls.js - Keyboard controls for SnowGlider game

// Initialize controls state
const keyboardControls = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false
};

// Setup keyboard controls
function setupControls() {
  // Add keyboard event listeners to both window and document to ensure coverage
  const handleKeyDown = (event) => {
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
  };
  
  const handleKeyUp = (event) => {
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
  };
  
  // Add listeners to both window and document for better coverage
  window.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keydown', handleKeyDown);
  
  window.addEventListener('keyup', handleKeyUp);
  document.addEventListener('keyup', handleKeyUp);

  // Return the controls object
  return keyboardControls;
}

// Reset all controls to default state
function resetControls() {
  keyboardControls.left = false;
  keyboardControls.right = false;
  keyboardControls.up = false;
  keyboardControls.down = false;
  keyboardControls.jump = false;
  return keyboardControls;
}

// Export controls module
const Controls = {
  setupControls,
  resetControls,
  getControls: () => keyboardControls
};

// Make Controls available globally
if (typeof window !== 'undefined') {
  window.Controls = Controls;
}