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

/** Touch tracking state: live touches, per-touch control ownership, the screen
 *  regions, and the visual flags. */
interface TouchState {
  touches: Record<string, TouchPoint>;
  /** identifier -> the control this live touch currently owns (null: in no region).
   *  Multitouch correctness (#399) hangs off this map: the control state is
   *  recomputed from ALL live owners on every touch event, so a finger sliding
   *  between regions releases its old control, and lifting one finger cannot
   *  clear a control another finger still holds. */
  owners: Record<string, ControlName | null>;
  /** Which controls the ownership pass is currently asserting. Lets the recompute
   *  release exactly the controls TOUCH was holding, without clobbering a control
   *  a keyboard key is holding at the same time. */
  touchHeld: Record<ControlName, boolean>;
  controlRegions: Partial<Record<ControlName, TouchRegion>>;
  showVisualControls: boolean;   // production affordances (small faint pads, default ON on mobile)
  showDebugTouchZones: boolean;  // full-region debug rectangles (?debugTouchZones=1 only)
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
  owners: {},          // identifier -> owned control (see TouchState.owners)
  touchHeld: { left: false, right: false, up: false, down: false, jump: false },
  controlRegions: {},  // Regions for touch controls on screen
  showVisualControls: false,  // Production affordances; set from shouldShowTouchAffordances() on mobile
  showDebugTouchZones: false  // Debug hit-area rectangles; set from shouldShowTouchZones() on mobile
};

// Helper to check if a point is in a region (module-scope: the ownership resolver
// below and the region handlers both use it).
function isPointInRegion(x: number, y: number, region: TouchRegion | undefined): boolean {
  if (!region) return false;
  return (
    x >= region.x &&
    x <= region.x + region.width &&
    y >= region.y &&
    y <= region.y + region.height
  );
}

/** Which control (if any) a touch at (x, y) owns right now. The center jump
 *  region is excluded while the tier has no jump verb (setJumpEnabled). */
function controlAtPoint(x: number, y: number): ControlName | null {
  if (isPointInRegion(x, y, touchState.controlRegions.left)) return 'left';
  if (isPointInRegion(x, y, touchState.controlRegions.right)) return 'right';
  if (isPointInRegion(x, y, touchState.controlRegions.up)) return 'up';
  if (isPointInRegion(x, y, touchState.controlRegions.down)) return 'down';
  if (jumpEnabled && isPointInRegion(x, y, touchState.controlRegions.jump)) return 'jump';
  return null;
}

const CONTROL_NAMES: readonly ControlName[] = ['left', 'right', 'up', 'down', 'jump'];

/** Recompute the touch contribution to the shared control state from ALL live
 *  touches (#399): a control is touch-held iff at least one live touch owns it.
 *  Releases only controls the previous pass was asserting, so a keyboard-held
 *  control is never clobbered by a touch ending elsewhere. */
function applyTouchOwnership(): void {
  for (const name of CONTROL_NAMES) {
    let held = false;
    for (const id in touchState.owners) {
      if (touchState.owners[id] === name) { held = true; break; }
    }
    if (held) {
      gameControls[name] = true;
      touchState.touchHeld[name] = true;
    } else if (touchState.touchHeld[name]) {
      gameControls[name] = false;
      touchState.touchHeld[name] = false;
    }
  }
}

// Per-tier jump availability (jump-system completion, workstream A). When false —
// set at run start from the tier's `ski.manualJump` via setJumpEnabled — the CENTER
// touch region is excluded from hit-testing and the `touch-jump` indicator is hidden,
// so a Bunny run's touch surface doesn't advertise a dead verb. Keyboard deliberately
// keeps writing `controls.jump`: the physics kernel's `tuning.manualJump` gate is the
// single source of truth, and a held Space on a no-jump tier is provably ≡ no-input
// (invariant harness), so no keyboard suppression is needed here.
let jumpEnabled = true;

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
      case 'v':  // Toggle camera view (edge-triggered: once per physical press)
      case 'V':
        // Ignore OS/browser key auto-repeat while V is held. Unlike the movement keys
        // (which just set an idempotent boolean), this flips a mode, so a long press
        // must toggle exactly once — without the `event.repeat` guard the repeated
        // keydowns would flicker the camera and leave it in an arbitrary mode.
        if (!event.repeat && typeof window.toggleCameraView === 'function') {
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
  
  // Register on `window` ONLY. A keydown dispatched at the focused element bubbles
  // up to `window`, so a single window-level listener catches every key. Registering
  // the SAME handler on both `window` and `document` (as this used to) fires it twice
  // per keypress: harmless for the movement keys, which only set a boolean, but it
  // broke the edge-triggered `V` toggle — `toggleCameraView()` ran twice and the
  // camera flipped to the new mode and immediately back, so `V` looked dead.
  // The teardown signal (when supplied) lets disposeGame remove them on HMR/unmount.
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  window.addEventListener('keydown', handleKeyDown, opts);
  window.addEventListener('keyup', handleKeyUp, opts);
}

// Two SEPARATE visual concepts share the touch-region math (both pointer-events:none,
// neither affects touch INPUT, which is always active):
//
// 1. Production touch AFFORDANCES — small, faint, centered pads (one per region) that
//    tell a phone player where left/right/up/down/jump live. Gameplay UI, ON by default
//    on mobile: when they were removed outright, players reported the touch controls as
//    having disappeared (the mobile regression this guards against).
// 2. DEBUG touch zones — the original edge-to-edge screen-third rectangles, useful for
//    inspecting the real hit-areas. Drawn every run they read as "big floating white
//    plates" over the scene (the snow-plates complaint), so they stay behind the
//    explicit `?debugTouchZones=1` opt-in and are never the production UI.

// Production affordance styling: faint enough to never read as scene geometry.
const AFFORDANCE_IDLE_BG = 'rgba(255, 255, 255, 0.07)';
const AFFORDANCE_ACTIVE_BG = 'rgba(255, 255, 255, 0.3)';
const AFFORDANCE_BORDER = '1px solid rgba(255, 255, 255, 0.14)';
// Debug hit-zone styling: dimmer than the pre-gate 0.2/0.4 originals but full-region.
const DEBUG_ZONE_IDLE_BG = 'rgba(255, 255, 255, 0.16)';
const DEBUG_ZONE_ACTIVE_BG = 'rgba(255, 255, 255, 0.4)';
const DEBUG_ZONE_BORDER = '2px solid rgba(255, 255, 255, 0.28)';

// Whether to draw the production touch affordances on mobile. ON by default — they are
// gameplay UI, not debug chrome. Opt out with `?hideTouchControls` or persist the choice
// via localStorage['snowglider.showTouchControls'] = '0' (set '1' to force back on).
// Wrapped in try/catch because URLSearchParams/localStorage can throw on some mobile/
// private contexts; the fallback keeps the controls visible (hiding them is the
// regression, not the safe side). Exported as a small testable seam so the node suite
// can cover every branch without re-running setupControls (which would double-bind the
// button touch handlers).
export function shouldShowTouchAffordances(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('hideTouchControls')) return false;
    const stored = window.localStorage.getItem('snowglider.showTouchControls');
    if (stored === '0') return false;
    return true; // '1' or unset: default ON for mobile
  } catch {
    // Keep the controls visible if storage/search access is blocked.
    return true;
  }
}

// Single source of truth for "is this a touch-driven device?" — used both by
// setupTouchControls (to wire the mobile button handlers + draw the affordances) and
// exported as Controls.isTouchDevice (the two used to carry duplicate copies).
//
// Legacy signals first (window.orientation, mobile UA sniff), then the modern ones:
// a real touch digitizer (navigator.maxTouchPoints > 0) AND a coarse PRIMARY pointer
// (matchMedia('(pointer: coarse)')). Requiring BOTH keeps touchscreen laptops (fine
// mouse primary) on the desktop path while catching the UA-less cases the sniff
// misses — most notably iPadOS Safari's "desktop mode", which reports a Macintosh UA
// but maxTouchPoints=5 and a coarse pointer. try/catch because matchMedia/navigator
// access can throw in exotic embeds; the fallback is the desktop path (no overlay UI).
function isTouchCapableDevice(): boolean {
  try {
    if (typeof window.orientation !== 'undefined') return true;
    if (navigator.userAgent.indexOf('IEMobile') !== -1) return true;
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) return true;
    if (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0 &&
        typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
    return false;
  } catch {
    return false; // desktop path
  }
}

// Whether to draw the full-region DEBUG hit-zone rectangles. OFF by default — opt in for
// debugging touch hit-areas with `?debugTouchZones=1` or by setting
// localStorage['snowglider.debugTouchZones'] = '1'. Touch INPUT is unaffected either way.
export function shouldShowTouchZones(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('debugTouchZones')) return true;
    return window.localStorage.getItem('snowglider.debugTouchZones') === '1';
  } catch {
    return false;
  }
}

// Setup touch control handlers
function setupTouchControls(signal?: AbortSignal) {
  // Listener options: thread the teardown signal when present (passive:false is required
  // for the touch handlers that preventDefault); else live for the page.
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  const touchOpts: AddEventListenerOptions = signal ? { passive: false, signal } : { passive: false };

  // On a touch device, wire the mobile-only button touch handlers and decide which
  // visuals to draw: the production affordances (ON by default) and/or the full-region
  // debug zones (opt-in). The touch INPUT regions computed in updateTouchRegions()
  // below are always active regardless of either flag.
  if (isTouchCapableDevice()) {
    touchState.showVisualControls = shouldShowTouchAffordances();
    touchState.showDebugTouchZones = shouldShowTouchZones();

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
    if (touchState.showVisualControls || touchState.showDebugTouchZones) {
      createOrUpdateVisualControls();
    }
  };
  
  // Update regions initially
  updateTouchRegions();
  
  // Update regions when window is resized
  window.addEventListener('resize', updateTouchRegions, opts);
  
  // Touches that begin inside a scrollable UI panel (the Controls / Ski Techniques
  // guides, or the finish/game-over result overlay) must be handed to the browser so
  // the panel can scroll natively. The document-level handlers below otherwise call
  // preventDefault() on every move — killing the scroll — and would also mis-read the
  // drag as ski steering. A TouchEvent's target stays the element the gesture started
  // on, so excluding these targets lets the overflow areas scroll without leaking into
  // gameplay input. `#gameOverOverlay` is included because on a tall finish screen
  // (result panel + expanded share menu) it scrolls to keep RESTART reachable, and the
  // run is already over there, so a drag is never gameplay steering.
  const isScrollableUiTouch = (event: TouchEvent): boolean => {
    const target = event.target as Element | null;
    return !!(target && typeof target.closest === 'function' &&
      target.closest('#controlsGuide, #controlsContent, #gameOverOverlay'));
  };

  // Touches that land on an interactive control (any button/link/form field, or an
  // element explicitly marked interactive) must NOT be treated as gameplay steering.
  // The handlers below preventDefault() every steering touch, and on mobile a
  // preventDefault() on touchstart/touchmove/touchend suppresses the browser's
  // synthesized click — which silently kills every click-bound UI button drawn over
  // the canvas (Start/About/Close, the finish-screen share controls, the account
  // chip/logout, …). Historically each such button was rescued one at a time (the
  // restart-button defuse in #173, the auth touchend, the audio-button touchstart,
  // the share defuseTouch); keying off the element role fixes the whole class at the
  // source and covers buttons added later. Steering touches land on the canvas /
  // background, which matches none of these. Buttons that run their OWN touch handler
  // (audio/reset/camera/restart) keep working unchanged — they call their own
  // preventDefault, so bailing here only drops the now-redundant document-level
  // suppression and never double-fires.
  //
  // `#cameraControls` covers the bottom-left camera tray as a whole: its buttons match
  // the role list above, but its collapsible header/title and the gaps between widgets
  // are plain divs. On landscape phones the tray sits inside a steering region, so a
  // fold tap/swipe on that chrome would otherwise ALSO be read as ski steering. This
  // mirrors the mouse-drag/wheel exclusion lifecycle.ts already applies to the tray
  // (Codex review, PR #331).
  const isInteractiveUiTouch = (event: TouchEvent): boolean => {
    const target = event.target as Element | null;
    return !!(target && typeof target.closest === 'function' &&
      target.closest('button, a, input, select, textarea, label, [role="button"], #cameraControls'));
  };

  // A touch the gameplay layer must leave entirely alone: a scroll inside a guide
  // panel or a tap on an interactive control. Both skip preventDefault() and steering
  // so the browser delivers the native scroll / click.
  const isNonGameplayTouch = (event: TouchEvent): boolean =>
    isScrollableUiTouch(event) || isInteractiveUiTouch(event);

  // Touch handlers (#399): every event re-registers the changed touches' ownership
  // (identifier -> control) and then recomputes the whole touch contribution from ALL
  // live touches via applyTouchOwnership(). The old per-event `processTouchInput`
  // wrote only the region the changed touch was in NOW, which broke multitouch two
  // ways: a finger sliding from `left` into `right` set `right` but never released
  // `left` (both steered until every finger lifted), and lifting one finger cleared a
  // region that a SECOND finger was still holding. The recompute also subsumes the
  // old zero-touches full reset (Codex review, PR #383): a press that drifts out of
  // its region before lifting releases its control because its owner entry is gone,
  // not because a blanket reset clobbered every control (including keyboard-held ones).

  // Handle touch start
  const handleTouchStart = (event: TouchEvent) => {
    if (isNonGameplayTouch(event)) return; // let UI controls + scrollable guides own their touch
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Register each new touch point and the control it lands on
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
      touchState.owners[touch.identifier] = controlAtPoint(touch.clientX, touch.clientY);
    }
    applyTouchOwnership();
    // Repaint on every press/move/release so pads track the recomputed state (a pad
    // gated on the raw event used to sit stuck highlighted after a drift-out lift).
    repaintVisualControls();
  };

  // Handle touch move
  const handleTouchMove = (event: TouchEvent) => {
    if (isNonGameplayTouch(event)) return; // let UI controls + scrollable guides own their touch
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Re-resolve ownership for each moved touch: entering a new region hands the
    // touch to that control, and applyTouchOwnership releases the one it left.
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
      touchState.touches[touch.identifier] = {
        x: touch.clientX,
        y: touch.clientY
      };
      touchState.owners[touch.identifier] = controlAtPoint(touch.clientX, touch.clientY);
    }
    applyTouchOwnership();
    repaintVisualControls();
  };

  // Handle touch end
  const handleTouchEnd = (event: TouchEvent) => {
    if (isNonGameplayTouch(event)) return; // matches the start/move early-out above
    // Skip preventDefault during tests to avoid interfering with test automation
    if (!window.location.search.includes('test=')) {
      event.preventDefault();
    }

    // Drop each lifted touch and its ownership; the recompute below releases only
    // controls no remaining touch holds (a second finger still in the region keeps
    // its control pressed).
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (!touch) continue;
      delete touchState.touches[touch.identifier];
      delete touchState.owners[touch.identifier];
    }
    applyTouchOwnership();
    repaintVisualControls();
  };

  // Sync every pad/zone's fill to the CURRENT control state: active controls get the
  // highlight, everything else returns to idle. Called on every press/release and after
  // the zero-touches full reset in handleTouchEnd.
  const repaintVisualControls = () => {
    if (!touchState.showVisualControls && !touchState.showDebugTouchZones) return;
    const debug = touchState.showDebugTouchZones;
    const activeBg = debug ? DEBUG_ZONE_ACTIVE_BG : AFFORDANCE_ACTIVE_BG;
    const idleBg = debug ? DEBUG_ZONE_IDLE_BG : AFFORDANCE_IDLE_BG;
    const touchControls = document.querySelectorAll('.touch-control');
    touchControls.forEach(control => {
      const el = control as HTMLElement;
      // Highlight the active control
      if ((control.classList.contains('touch-left') && gameControls.left) ||
          (control.classList.contains('touch-right') && gameControls.right) ||
          (control.classList.contains('touch-up') && gameControls.up) ||
          (control.classList.contains('touch-down') && gameControls.down) ||
          (control.classList.contains('touch-jump') && gameControls.jump)) {
        el.style.backgroundColor = activeBg;
      } else {
        el.style.backgroundColor = idleBg;
      }
    });
  };

  // Add touch event listeners
  document.addEventListener('touchstart', handleTouchStart, touchOpts);
  document.addEventListener('touchmove', handleTouchMove, touchOpts);
  document.addEventListener('touchend', handleTouchEnd, touchOpts);
  document.addEventListener('touchcancel', handleTouchEnd, touchOpts);
  
  // Shrink a full hit-region down to the small centered pad the production
  // affordance draws: large enough to notice and tap-target sized (44px floor per
  // mobile HIG), capped so it never approaches the full region on a big screen.
  function shrinkRegionForAffordance(region: TouchRegion): TouchRegion {
    const minSide = Math.min(region.width, region.height);
    const size = Math.max(44, Math.min(72, minSide * 0.42));
    return {
      x: region.x + region.width / 2 - size / 2,
      y: region.y + region.height / 2 - size / 2,
      width: size,
      height: size,
    };
  }

  // Create visual indicators for touch controls: small centered affordance pads in
  // production, or the full-region rectangles when the debug flag is on (debug wins —
  // it exists precisely to see the real hit-areas).
  function createOrUpdateVisualControls() {
    // Remove existing controls if they exist
    const existingControls = document.querySelectorAll('.touch-control');
    existingControls.forEach(control => control.remove());

    if (!touchState.showVisualControls && !touchState.showDebugTouchZones) return;
    const debug = touchState.showDebugTouchZones;

    // Helper to create a control element
    const createControlElement = (region: TouchRegion, name: string) => {
      const visualRegion = debug ? region : shrinkRegionForAffordance(region);
      const element = document.createElement('div');
      element.className = `touch-control touch-${name} ${debug ? 'touch-debug-zone' : 'touch-affordance'}`;
      element.style.position = 'fixed';
      element.style.left = `${visualRegion.x}px`;
      element.style.top = `${visualRegion.y}px`;
      element.style.width = `${visualRegion.width}px`;
      element.style.height = `${visualRegion.height}px`;
      element.style.backgroundColor = debug ? DEBUG_ZONE_IDLE_BG : AFFORDANCE_IDLE_BG;
      element.style.border = debug ? DEBUG_ZONE_BORDER : AFFORDANCE_BORDER;
      element.style.borderRadius = debug ? '8px' : '50%';
      element.style.pointerEvents = 'none'; // Don't interfere with touch events
      element.style.zIndex = debug ? '100' : '90';
      element.setAttribute('aria-hidden', 'true'); // decorative; the regions are the real input

      // Add icon or label based on control type
      const label = document.createElement('div');
      label.style.position = 'absolute';
      label.style.top = '50%';
      label.style.left = '50%';
      label.style.transform = 'translate(-50%, -50%)';
      label.style.color = debug ? 'white' : 'rgba(255, 255, 255, 0.75)';
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
      // The jump indicator respects the per-tier availability seam: created either
      // way (so a later setJumpEnabled(true) can just un-hide it) but hidden while
      // the tier has no jump verb.
      if (name === 'jump' && !jumpEnabled) element.style.display = 'none';
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

  // Clear all tracked touches, their control ownership, and the touch-held ledger
  // (#399) — a stale owner would re-assert its control on the next touch event.
  touchState.touches = {};
  touchState.owners = {};
  touchState.touchHeld = { left: false, right: false, up: false, down: false, jump: false };

  return gameControls;
}

// Export controls module
export const Controls = {
  setupControls,
  resetControls,
  getControls: () => gameControls,
  // Per-tier jump availability seam (workstream A): called at run start with the
  // tier's `ski.manualJump`. Gates the CENTER touch region out of hit-testing and
  // hides/shows the visual jump indicator; clears any latched jump state when
  // disabling so a held press can't carry across the toggle.
  setJumpEnabled: (enabled: boolean): void => {
    jumpEnabled = enabled;
    if (!enabled) {
      gameControls.jump = false;
      // Drop jump ownership from any live touch (#399): controlAtPoint stops
      // resolving the center region while disabled, but a touch that grabbed jump
      // BEFORE the toggle would otherwise re-assert it on its next recompute.
      touchState.touchHeld.jump = false;
      for (const id in touchState.owners) {
        if (touchState.owners[id] === 'jump') touchState.owners[id] = null;
      }
    }
    // Typed query rather than `instanceof HTMLElement`: the headless (jsdom) harness
    // only exposes window/document globals, and '.touch-jump' can only match the
    // HTMLElement the visual-controls builder created.
    const indicator = document.querySelector<HTMLElement>('.touch-jump');
    if (indicator) {
      indicator.style.display = enabled ? '' : 'none';
    }
  },
  isTouchDevice: () => isTouchCapableDevice(),
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