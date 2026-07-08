// Shared collapse / resize / horizontal-swipe behavior for the in-game HUD panels
// (Game Stats and Game Controls). Extracted from snowglider.ts, which previously
// carried two near-identical copies of this logic in initializeGameStats() and
// initializeControlsToggle(). The two panels differ only in a couple of opt-in
// behaviors (listener reset + small-screen auto-collapse), so those are flags here
// and the rest is unified — behavior is preserved per panel.

export interface CollapsiblePanelOptions {
  /** Human label used in the diagnostic console logs. */
  name: string;
  /** id of the outer container that gets the `collapsed` class toggled. */
  containerId: string;
  /** id of the ▲/▼ toggle button (re-fetched after a header clone). */
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
   * Auto-collapse on small / landscape-mobile screens and keep watching resize
   * (Controls panel and the camera tray).
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

// Wire the collapse toggle, click/touch handlers, optional small-screen
// auto-collapse, and the horizontal swipe gesture onto a resolved header/button.
function wirePanel(
  container: HTMLElement,
  toggleButton: HTMLElement,
  header: HTMLElement,
  name: string,
  autoCollapseOnSmallScreens: boolean,
  signal?: AbortSignal,
): void {
  // Listener options threading the optional teardown signal (matches the
  // listenerOpts/touchOpts pattern in game/lifecycle.ts).
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  const passiveOpts: AddEventListenerOptions = signal ? { passive: true, signal } : { passive: true };
  const activeOpts: AddEventListenerOptions = signal ? { passive: false, signal } : { passive: false };
  const setCollapsed = function(collapsed: boolean) {
    container.classList.toggle('collapsed', collapsed);
    toggleButton.textContent = collapsed ? '▼' : '▲';
  };

  const toggle = function() {
    console.log(`Toggle ${name} called, current state:`, container.classList.contains('collapsed'));
    setCollapsed(!container.classList.contains('collapsed'));
  };

  // Add click and touch event listeners
  toggleButton.addEventListener('click', function(e) {
    console.log(`${name} toggle button clicked`);
    e.stopPropagation(); // Prevent triggering the header click
    toggle();
  }, opts);

  header.addEventListener('click', function() {
    console.log(`${name} header clicked`);
    toggle();
  }, opts);

  // Track whether the active touch became a horizontal swipe. The swipe handler below
  // sets the collapse state directly on touchmove; without this guard the touchend
  // handler would toggle a SECOND time and undo the swipe, so the panels' advertised
  // swipe-to-collapse/expand gesture never actually stuck (Codex review, PR #331).
  let touchStartX = 0;
  let swiped = false;

  header.addEventListener('touchend', function(e) {
    console.log(`${name} header touch end`);
    e.preventDefault();
    if (swiped) { swiped = false; return; } // a swipe already set the state; don't re-toggle
    toggle();
  }, activeOpts);

  // Auto-collapse on small screens and landscape mobile
  if (autoCollapseOnSmallScreens) {
    const handleScreenSizeChange = function() {
      if (window.innerWidth <= 480 ||
          (window.innerWidth <= 768 && window.innerHeight <= 500)) {
        if (!container.classList.contains('collapsed')) {
          console.log(`Auto-collapsing ${name} for small screen`);
          setCollapsed(true);
        }
      }
    };
    window.addEventListener('resize', handleScreenSizeChange, opts);
    handleScreenSizeChange();
  }

  // Add horizontal swipe handler for the panel
  header.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0]!.clientX;
    swiped = false;
  }, passiveOpts);

  header.addEventListener('touchmove', function(e) {
    const diff = e.touches[0]!.clientX - touchStartX;
    if (Math.abs(diff) <= 30) return; // below the swipe threshold: still a tap, let touchend toggle
    // A horizontal swipe owns this gesture — left collapses, right expands (idempotent if
    // already there). `swiped` makes the touchend handler skip its toggle so the gesture sticks.
    console.log(`Swipe ${diff < 0 ? 'left' : 'right'} detected, ${diff < 0 ? 'collapsing' : 'expanding'} ${name}`);
    swiped = true;
    setCollapsed(diff < 0);
    e.preventDefault();
  }, activeOpts);
}

// Fallback used when the header clone/refetch path throws: a bare toggle with no
// touch or swipe support (matches the previous initializeControlsToggle catch path).
function wireFallback(container: HTMLElement, toggleButton: HTMLElement, header: HTMLElement, signal?: AbortSignal): void {
  const opts: AddEventListenerOptions | undefined = signal ? { signal } : undefined;
  const toggle = function() {
    if (container.classList.contains('collapsed')) {
      container.classList.remove('collapsed');
      toggleButton.textContent = '▲';
    } else {
      container.classList.add('collapsed');
      toggleButton.textContent = '▼';
    }
  };

  toggleButton.addEventListener('click', function(e) {
    e.stopPropagation();
    toggle();
  }, opts);

  header.addEventListener('click', toggle, opts);
}

// Set up a collapsible HUD panel. Idempotent for panels that pass
// `resetListeners` (it clones the header to drop stale listeners first).
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

  if (!options.resetListeners) {
    wirePanel(container, toggleButton, header, name, !!options.autoCollapseOnSmallScreens, options.signal);
    return;
  }

  // Ensure previous event listeners are removed (if possible) by replacing the
  // header with a clone, then re-resolving the cloned header/button by id.
  try {
    header.replaceWith(header.cloneNode(true));
    const newHeader = document.getElementById(headerId)!;
    const newToggleButton = document.getElementById(toggleButtonId)!;
    wirePanel(container, newToggleButton, newHeader, name, !!options.autoCollapseOnSmallScreens, options.signal);
  } catch (e) {
    console.error(`Error setting up ${name} toggle:`, e);
    wireFallback(container, toggleButton, header, options.signal);
  }
}
