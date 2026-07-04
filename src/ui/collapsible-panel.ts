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
   * (Controls panel only).
   */
  autoCollapseOnSmallScreens?: boolean;
}

// Wire the collapse toggle, click/touch handlers, optional small-screen
// auto-collapse, and the horizontal swipe gesture onto a resolved header/button.
function wirePanel(
  container: HTMLElement,
  toggleButton: HTMLElement,
  header: HTMLElement,
  name: string,
  autoCollapseOnSmallScreens: boolean,
): void {
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
  });

  header.addEventListener('click', function() {
    console.log(`${name} header clicked`);
    toggle();
  });

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
  }, { passive: false });

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
    window.addEventListener('resize', handleScreenSizeChange);
    handleScreenSizeChange();
  }

  // Add horizontal swipe handler for the panel
  header.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0]!.clientX;
    swiped = false;
  }, { passive: true });

  header.addEventListener('touchmove', function(e) {
    const diff = e.touches[0]!.clientX - touchStartX;
    if (Math.abs(diff) <= 30) return; // below the swipe threshold: still a tap, let touchend toggle
    // A horizontal swipe owns this gesture — left collapses, right expands (idempotent if
    // already there). `swiped` makes the touchend handler skip its toggle so the gesture sticks.
    console.log(`Swipe ${diff < 0 ? 'left' : 'right'} detected, ${diff < 0 ? 'collapsing' : 'expanding'} ${name}`);
    swiped = true;
    setCollapsed(diff < 0);
    e.preventDefault();
  }, { passive: false });
}

// Fallback used when the header clone/refetch path throws: a bare toggle with no
// touch or swipe support (matches the previous initializeControlsToggle catch path).
function wireFallback(container: HTMLElement, toggleButton: HTMLElement, header: HTMLElement): void {
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
  });

  header.addEventListener('click', toggle);
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
    wirePanel(container, toggleButton, header, name, !!options.autoCollapseOnSmallScreens);
    return;
  }

  // Ensure previous event listeners are removed (if possible) by replacing the
  // header with a clone, then re-resolving the cloned header/button by id.
  try {
    header.replaceWith(header.cloneNode(true));
    const newHeader = document.getElementById(headerId)!;
    const newToggleButton = document.getElementById(toggleButtonId)!;
    wirePanel(container, newToggleButton, newHeader, name, !!options.autoCollapseOnSmallScreens);
  } catch (e) {
    console.error(`Error setting up ${name} toggle:`, e);
    wireFallback(container, toggleButton, header);
  }
}
