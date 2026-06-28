// controls.ts - Keyboard and touch controls for SnowGlider game
//
// Phase 2.5 (issue #84): converted off the classic global model. `Controls` is
// now `export`ed instead of being a bare script global. This module uses no
// three.js, so there is no `import * as THREE`. It is loaded into the page
// through the bundle entry (src/main.js) and imported directly by snowglider.js
// and the controls browser test.
//
// Phase 3.4 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file), the JSDoc `@typedef`s are now real
// `interface`/`type` declarations, and the JSDoc `/** @type {HTMLElement} */`
// casts are now `as` casts. This is user-input code, so the diff is a behavioural
// no-op — every edit is type-only/erasable, so esbuild (Vite) and Node's native
// type-stripping both run it exactly as before.

/** A rectangular on-screen touch zone (CSS pixels). */
export interface TouchRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The five logical controls, shared by keyboard and touch. */
export type ControlName = 'left' | 'right' | 'up' | 'down' | 'jump';

/** Boolean pressed-state for every control. */
export type ControlState = Record<ControlName, boolean>;

/** A tracked active touch point (CSS pixels). */
interface TouchPoint {
  x: number;
  y: number;
}

/** Touch tracking state: live touches, the screen regions, and the visual flag. */
interface TouchState {
  touches: Record<string, TouchPoint>;
  controlRegions: Partial<Record<ControlName, TouchRegion>>;
  showVisualControls: boolean;
}

// Initialize controls state - used for both keyboard and touch
const gameControls: ControlState = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false
};

// Touch state tracking
const touchState: TouchState = {
  touches: {},         // Store active touch points
  controlRegions: {},  // Regions for touch controls on screen
  showVisualControls: false // Flag to enable visual touch controls (optional)
};

// Setup controls (keyboard + touch).
//
// `signal` (optional): an AbortSignal tying EVERY listener registered here — keyboard,
// touch, the resize handler, the button touch handlers, and the game-over MutationObserver
// — to the game's teardown (disposeGame). Aborting it removes them all, so a dev-HMR
// reload or an unmount/remount doesn't stack duplicate input handlers (e.g. `V` toggling
// the camera once per stale keydown listener). Omitted by the internal re-init call in
// toggleTouchControls and any caller that never tears down.
function setupControls(signal?: AbortSignal): ControlState {
  // Set up keyboard controls
  setupKeyboardControls(signal);

  // Set up touch controls
  setupTouchControls(signal);

  // Return the shared controls object
  return gameControls;
}

// Setup keyboard control handlers
function setupKeyboardControls(signal?: AbortSignal) {
  // Handle keyboard down events
  const handleKeyDown = (event: KeyboardEvent) => {
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
  const handleKeyUp = (event: KeyboardEvent) => {
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
  
  // Add keyboard listeners to both window and document for better coverage. The
  // teardown signal (when supplied) lets disposeGame remove them on HMR/unmount.
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  window.addEventListener('keydown', handleKeyDown, opts);
  document.addEventListener('keydown', handleKeyDown, opts);

  window.addEventListener('keyup', handleKeyUp, opts);
  document.addEventListener('keyup', handleKeyUp, opts);
}

// Setup touch control handlers
function setupTouchControls(signal?: AbortSignal) {
  // Listener options: thread the teardown signal when present (passive:false is required
  // for the touch handlers that preventDefault); else live for the page.
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  const touchOpts: AddEventListenerOptions = signal ? { passive: false, signal } : { passive: false };
  // Detect if we're on a mobile device
  const isMobileDevice = (): boolean => {
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
    setupButtonTouchHandlers(signal);
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
  window.addEventListener('resize', updateTouchRegions, opts);
  
  // Touches that begin inside a scrollable UI panel (the Controls / Ski Techniques
  // guides) must be handed to the browser so the panel can scroll natively. The
  // document-level handlers below otherwise call preventDefault() on every move —
  // killing the scroll — and would also mis-read the drag as ski steering. A
  // TouchEvent's target stays the element the gesture started on, so excluding these
  // targets lets the overflow areas scroll without leaking into gameplay input.
  const isScrollableUiTouch = (event: TouchEvent): boolean => {
    const target = event.target as Element | null;
    return !!(target && typeof target.closest === 'function' &&
      target.closest('#controlsGuide, #controlsContent'));
  };

  // Handle touch start
  const handleTouchStart = (event: TouchEvent) => {
    if (isScrollableUiTouch(event)) return; // let the controls guide scroll natively
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Process each touch point
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
      processTouchInput(touch, true);
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
    }
  };

  // Handle touch move
  const handleTouchMove = (event: TouchEvent) => {
    if (isScrollableUiTouch(event)) return; // let the controls guide scroll natively
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Process each touch point
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
      processTouchInput(touch, true);
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
    }
  };

  // Handle touch end
  const handleTouchEnd = (event: TouchEvent) => {
    if (isScrollableUiTouch(event)) return; // matches the start/move early-out above
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Process each touch point being removed
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
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
  const processTouchInput = (touch: Touch, isActive: boolean) => {
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
        const el = control as HTMLElement;
        // Highlight the active control
        if ((control.classList.contains('touch-left') && gameControls.left) ||
            (control.classList.contains('touch-right') && gameControls.right) ||
            (control.classList.contains('touch-up') && gameControls.up) ||
            (control.classList.contains('touch-down') && gameControls.down) ||
            (control.classList.contains('touch-jump') && gameControls.jump)) {
          el.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
        } else {
          el.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
        }
      });
    }
  };
  
  // Helper to check if a point is in a region
  const isPointInRegion = (x: number, y: number, region: TouchRegion | undefined) => {
    if (!region) return false;
    return (
      x >= region.x &&
      x <= region.x + region.width && 
      y >= region.y && 
      y <= region.y + region.height
    );
  };
  
  // Add touch event listeners
  document.addEventListener('touchstart', handleTouchStart, touchOpts);
  document.addEventListener('touchmove', handleTouchMove, touchOpts);
  document.addEventListener('touchend', handleTouchEnd, touchOpts);
  document.addEventListener('touchcancel', handleTouchEnd, touchOpts);
  
  // Create visual indicators for touch controls
  function createOrUpdateVisualControls() {
    // Remove existing controls if they exist
    const existingControls = document.querySelectorAll('.touch-control');
    existingControls.forEach(control => control.remove());
    
    if (!touchState.showVisualControls) return;
    
    // Helper to create a control element
    const createControlElement = (region: TouchRegion, name: string) => {
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
function resetControls(): ControlState {
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
export const Controls = {
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
  toggleTouchControls: (show?: boolean) => {
    if (typeof show === 'boolean') {
      touchState.showVisualControls = show;
      // Refresh controls
      const existingControls = document.querySelectorAll('.touch-control');
      if (show && existingControls.length === 0) {
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
function setupButtonTouchHandlers(signal?: AbortSignal) {
  const touchOpts: AddEventListenerOptions = signal ? { passive: false, signal } : { passive: false };
  // Add touch handlers to the reset button
  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('touchstart', (event) => {
      event.preventDefault();
      // Call the resetSnowman function directly from the global scope
      if (typeof window.resetSnowman === 'function') {
        window.resetSnowman();
      }
    }, touchOpts);
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
      const target = mutation.target as HTMLElement;
      if (mutation.type === 'attributes' &&
          mutation.attributeName === 'style' &&
          target.id === 'gameOverOverlay' &&
          target.style.display === 'flex') {
        
        // Game over overlay is now visible, add touch handler to restart button.
        // Use the child combinator: the restart button is a direct child of the
        // overlay, whereas the finish result panel's "Share Result" button is a
        // nested descendant — a plain `#gameOverOverlay button` would match that
        // share button first (depth-first) and misbind restart on touch devices.
        const restartButton = document.querySelector('#gameOverOverlay > button');
        if (restartButton && !restartButton.getAttribute('touch-handler-added')) {
          restartButton.addEventListener('touchstart', (event) => {
            event.preventDefault();
            // Call the restartGame function directly from the global scope
            if (typeof window.restartGame === 'function') {
              window.restartGame();
            }
          }, touchOpts);
          
          // Mark button as having touch handler to avoid duplicates
          restartButton.setAttribute('touch-handler-added', 'true');
        }
      }
    });
  });
  
  // Start observing the game over overlay
  let delayedObserveTimer: ReturnType<typeof setTimeout> | null = null;
  const gameOverOverlay = document.getElementById('gameOverOverlay');
  if (gameOverOverlay) {
    gameOverObserver.observe(gameOverOverlay, {
      attributes: true,
      attributeFilter: ['style']
    });
  } else {
    // If game over overlay doesn't exist yet, wait a bit and try again. On mobile this
    // setup runs before setupScene() creates #gameOverOverlay, so this branch is armed.
    delayedObserveTimer = setTimeout(() => {
      delayedObserveTimer = null;
      // Bail if teardown aborted during the 1s wait: without this the stale observer
      // could re-attach to a freshly-remounted overlay (HMR) and bind the OLD restart
      // touch handler to the new game.
      if (signal && signal.aborted) return;
      const delayedOverlay = document.getElementById('gameOverOverlay');
      if (delayedOverlay) {
        gameOverObserver.observe(delayedOverlay, {
          attributes: true,
          attributeFilter: ['style']
        });
      }
    }, 1000);
  }

  // MutationObserver has no AbortSignal option, so disconnect it explicitly on teardown —
  // and cancel any pending delayed-observe so it can't re-arm a stale observer on a
  // remounted overlay (else a dev-HMR remount leaks the old observer / restart handler).
  if (signal) signal.addEventListener('abort', () => {
    if (delayedObserveTimer !== null) { clearTimeout(delayedObserveTimer); delayedObserveTimer = null; }
    gameOverObserver.disconnect();
  }, { once: true });
}

// Controls is imported directly by snowglider.js and the controls browser test
// (issue #84).