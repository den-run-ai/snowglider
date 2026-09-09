// Shared collapse / resize / horizontal-swipe behavior for the in-game HUD panels
// (Camera, Game Stats and Game Controls). State, accessible disclosure semantics,
// gesture ownership, responsive folding and listener teardown live in one place.

const panelControllers = new WeakMap<HTMLElement, AbortController>();

/** Compact phones and short landscape windows share the same HUD layout. */
export function isCompactPanelViewport(): boolean {
  return window.innerWidth <= 600 || window.innerHeight <= 500;
}

export interface CollapsiblePanelOptions {
  /** Human label used in the diagnostic console logs. */
  name: string;
  /** id of the outer container that gets the `collapsed` class toggled. */
  containerId: string;
  /** id of the disclosure button (re-fetched after a header clone). */
  toggleButtonId: string;
  /** id of the clickable / swipeable header. */
  headerId: string;
  /**
   * Replace the header node with a clone first so any listeners attached by a
   * previous call are dropped (the Controls panel is initialized more than once).
   * When false the existing nodes are wired directly (the Stats panel behavior).
   */
  resetListeners?: boolean;
  /**
   * Auto-collapse initially on compact screens, then only when entering that
   * breakpoint. Browser toolbar resizes preserve a player's expanded panel.
   */
  autoCollapseOnSmallScreens?: boolean;
  /**
   * Teardown signal: aborting it removes every listener this call registered —
   * including the WINDOW-level resize listener the auto-collapse option adds, which
   * would otherwise outlive a torn-down panel (the camera tray is recreated each
   * game, so without this each run would stack another resize listener).
   * `| undefined` so callers under exactOptionalPropertyTypes can pass their own
   * optional teardown signal straight through.
   */
  signal?: AbortSignal | undefined;
}

// Also used by result/restart transitions, so the visual and accessible state
// cannot drift when a panel is collapsed without clicking its disclosure.
export function setPanelCollapsed(container: HTMLElement, toggleButton: HTMLElement, collapsed: boolean): void {
  const content = Array.from(container.children).find((el) => el.id.endsWith('Content')) as HTMLElement | undefined;
  if (collapsed && content?.contains(container.ownerDocument.activeElement)) toggleButton.focus();
  container.classList.toggle('collapsed', collapsed);
  container.classList.add('hud-panel');
  toggleButton.classList.add('panel-disclosure');
  if (!toggleButton.querySelector('.panel-chevron')) {
    const chevron = container.ownerDocument.createElement('span');
    chevron.className = 'panel-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    toggleButton.replaceChildren(chevron);
  }
  toggleButton.setAttribute('aria-expanded', String(!collapsed));
  if (content) {
    toggleButton.setAttribute('aria-controls', content.id);
    content.inert = collapsed;
    content.setAttribute('aria-hidden', String(collapsed));
  }
}

// Wire the collapse toggle, click/touch handlers, optional small-screen
// auto-collapse, and the horizontal swipe gesture onto a resolved header/button.
function wirePanel(
  container: HTMLElement,
  toggleButton: HTMLElement,
  header: HTMLElement,
  name: string,
  autoCollapseOnSmallScreens: boolean,
  signal: AbortSignal,
): void {
  const opts: AddEventListenerOptions = { signal };
  const passiveOpts: AddEventListenerOptions = { passive: true, signal };
  const activeOpts: AddEventListenerOptions = { passive: false, signal };
  const setCollapsed = function(collapsed: boolean, userInitiated = false) {
    // Compact layouts have room for one expanded information/control panel.
    // Direct state updates (startup/result transitions) do not operate the accordion.
    if (!collapsed && userInitiated && isCompactPanelViewport()) {
      // Closing a peer containing keyboard focus must not steal focus back from
      // the disclosure the player just opened by tapping its header/title.
      toggleButton.focus({ preventScroll: true });
      for (const other of container.ownerDocument.querySelectorAll<HTMLElement>('.hud-panel')) {
        if (other === container || !panelControllers.has(other)) continue;
        const otherToggle = other.querySelector<HTMLElement>('.panel-disclosure');
        if (otherToggle) setPanelCollapsed(other, otherToggle, true);
      }
    }
    setPanelCollapsed(container, toggleButton, collapsed);
  };
  toggleButton.setAttribute('aria-label', `Toggle ${name} options`);
  setCollapsed(container.classList.contains('collapsed'));

  const toggle = function() {
    console.log(`Toggle ${name} called, current state:`, container.classList.contains('collapsed'));
    setCollapsed(!container.classList.contains('collapsed'), true);
  };

  // Add click and touch event listeners
  toggleButton.addEventListener('click', function(e) {
    console.log(`${name} toggle button clicked`);
    e.stopPropagation(); // Prevent triggering the header click
    toggle();
  }, opts);

  header.addEventListener('click', function(e) {
    e.stopPropagation();
    console.log(`${name} header clicked`);
    toggle();
  }, opts);

  // Lock a gesture to its first intentional axis. A vertical scroll, cancelled
  // gesture, or second finger must never be interpreted as a tap or horizontal swipe.
  let touchStart: { x: number; y: number; id: number } | null = null;
  let gesture: 'pending' | 'horizontal' | 'vertical' = 'pending';

  header.addEventListener('touchend', function(e) {
    console.log(`${name} header touch end`);
    e.stopPropagation();
    if (!touchStart) return;
    touchStart = null;
    if (e.touches.length || gesture === 'vertical') return;
    // Cancel the browser's synthesized click: this touch already owns the action.
    e.preventDefault();
    if (gesture === 'pending') toggle();
  }, activeOpts);

  // Auto-collapse on small screens and landscape mobile
  if (autoCollapseOnSmallScreens) {
    let wasCompact = false;
    const handleScreenSizeChange = function() {
      const compact = isCompactPanelViewport();
      if (compact && !wasCompact) {
        if (!container.classList.contains('collapsed')) {
          console.log(`Auto-collapsing ${name} for small screen`);
          setCollapsed(true);
        }
      }
      wasCompact = compact;
    };
    window.addEventListener('resize', handleScreenSizeChange, opts);
    handleScreenSizeChange();
  }

  // Add horizontal swipe handler for the panel
  header.addEventListener('touchstart', function(e) {
    e.stopPropagation();
    const touch = e.touches[0];
    touchStart = e.touches.length === 1 && touch
      ? { x: touch.clientX, y: touch.clientY, id: touch.identifier } : null;
    gesture = 'pending';
  }, passiveOpts);

  header.addEventListener('touchmove', function(e) {
    e.stopPropagation();
    const touch = e.touches[0];
    if (!touchStart) return;
    if (e.touches.length !== 1 || !touch || touch.identifier !== touchStart.id) {
      touchStart = null;
      return;
    }
    const diff = touch.clientX - touchStart.x;
    const verticalDiff = touch.clientY - touchStart.y;
    if (gesture === 'pending' && Math.abs(verticalDiff) > 10 && Math.abs(verticalDiff) >= Math.abs(diff)) {
      gesture = 'vertical';
    }
    if (gesture === 'vertical') return;
    if (gesture === 'horizontal') e.preventDefault();
    if (Math.abs(diff) <= 30) return;
    // A horizontal swipe owns this gesture — left collapses, right expands (idempotent if
    // already there). The trailing touchend skips its toggle so the gesture sticks.
    console.log(`Swipe ${diff < 0 ? 'left' : 'right'} detected, ${diff < 0 ? 'collapsing' : 'expanding'} ${name}`);
    gesture = 'horizontal';
    setCollapsed(diff < 0, true);
    e.preventDefault();
  }, activeOpts);

  header.addEventListener('touchcancel', function(e) {
    e.stopPropagation();
    touchStart = null;
  }, passiveOpts);
}

// Every setup replaces its previous listeners, including window resize handlers.
// Header cloning additionally drops legacy listeners for resetListeners callers.
export function setupCollapsiblePanel(options: CollapsiblePanelOptions): void {
  const { name, containerId, toggleButtonId, headerId } = options;
  console.log(`Initializing ${name} toggle`);

  const container = document.getElementById(containerId);
  const toggleButton = document.getElementById(toggleButtonId);
  const header = document.getElementById(headerId);

  if (!(container && toggleButton && header)) {
    console.warn(`${name} elements not found:`, {
      container: !!container,
      toggleButton: !!toggleButton,
      header: !!header,
    });
    return;
  }

  console.log(`Setting up ${name} toggle`);
  panelControllers.get(container)?.abort();
  if (options.signal?.aborted) return;
  const controller = new (container.ownerDocument.defaultView?.AbortController ?? AbortController)();
  panelControllers.set(container, controller);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener('abort', () => {
    options.signal?.removeEventListener('abort', abort);
    if (panelControllers.get(container) === controller) panelControllers.delete(container);
  }, { once: true });
  header.classList.add('hud-panel-header');
  toggleButton.setAttribute('aria-label', `Toggle ${name} options`);

  if (!options.resetListeners) {
    wirePanel(container, toggleButton, header, name, !!options.autoCollapseOnSmallScreens, controller.signal);
    return;
  }

  // Remove any legacy listeners by replacing the header with a clone when possible.
  // If cloning fails, the original nodes still receive the same shared behavior.
  let resolvedHeader = header;
  let resolvedToggle = toggleButton;
  try {
    header.replaceWith(header.cloneNode(true));
    resolvedHeader = document.getElementById(headerId)!;
    resolvedToggle = document.getElementById(toggleButtonId)!;
  } catch (e) {
    console.error(`Error setting up ${name} toggle:`, e);
  }
  wirePanel(container, resolvedToggle, resolvedHeader, name, !!options.autoCollapseOnSmallScreens, controller.signal);
}
