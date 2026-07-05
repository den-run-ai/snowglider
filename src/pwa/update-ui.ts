// update-ui.ts — the "New version available" affordance for the offline PWA
// (issue #358, PR 3). Kept tiny and pure-ish so it is headless-testable.
//
// The service worker never activates a new version on its own (sw.ts does not
// skipWaiting on install), so a fresh bundle can't swap in mid-run. register-sw calls
// onUpdateReady exactly ONCE, so if the update arrives while no safe screen is visible
// (mid-run) the callback must NOT be dropped: we stash it and re-surface the banner the
// moment a safe screen appears. The safe screens are the start overlay AND the
// game-over/result overlay — the player returns to one of them after any run — so we
// mount into whichever is currently visible and watch both (Codex #361).

export const UPDATE_BANNER_ID = 'swUpdateBanner';
export const UPDATE_BANNER_TEXT = 'New version available';

// Safe screens the banner may mount into, in priority order. Both are shown/hidden via
// their inline `display` style (#startGameContainer by start-menu.ts, #gameOverOverlay
// by result-overlay.ts / scene-setup.ts).
const SAFE_CONTAINER_IDS = ['startGameContainer', 'gameOverOverlay'];

// The apply() callback stays stashed until the player applies the update (Reload
// navigates the page away), so a single onUpdateReady is never lost. Observers on the
// safe containers re-surface / re-home the banner whenever one becomes visible.
let pendingApply: (() => void) | null = null;
const observers: MutationObserver[] = [];
const observedIds = new Set<string>();

function firstVisibleSafeContainer(doc: Document): HTMLElement | null {
  for (const id of SAFE_CONTAINER_IDS) {
    const el = doc.getElementById(id);
    if (el && el.style.display !== 'none') return el;
  }
  return null;
}

/** Attach a style observer to any safe container that exists and isn't watched yet.
 *  Called on every surface() so a container created later (the game-over overlay is
 *  built on game init) gets picked up once it appears. */
function ensureObservers(doc: Document): void {
  const MO = doc.defaultView?.MutationObserver;
  if (!MO) return;
  for (const id of SAFE_CONTAINER_IDS) {
    if (observedIds.has(id)) continue;
    const el = doc.getElementById(id);
    if (!el) continue;
    const obs = new MO(() => { surface(doc); });
    obs.observe(el, { attributes: true, attributeFilter: ['style'] });
    observers.push(obs);
    observedIds.add(id);
  }
}

/** Build + mount the banner into `container` with `apply` as its Reload handler. */
function mountBanner(apply: () => void, doc: Document, container: HTMLElement): boolean {
  const banner = doc.createElement('div');
  banner.id = UPDATE_BANNER_ID;
  banner.className = 'sw-update-banner';
  banner.setAttribute('role', 'status');

  const label = doc.createElement('span');
  label.textContent = UPDATE_BANNER_TEXT;

  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.id = 'swUpdateReload';
  reload.className = 'sw-update-reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => {
    try {
      apply();
    } catch {
      /* apply failed (headless / no SW) — nothing to do */
    }
  });
  // The banner lives inside a safe container, and start-menu.ts's document-level keydown
  // starts a run on Enter/Space. Stop those keys bubbling so a keyboard user reloading
  // the update doesn't also launch/hide the game screen (Codex #361). The button's native
  // Enter/Space activation still fires (stopPropagation ≠ preventDefault).
  reload.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.stopPropagation();
    }
  });

  banner.appendChild(label);
  banner.appendChild(reload);
  container.appendChild(banner);
  return true;
}

/**
 * Surface the pending banner in whichever safe container is currently visible, re-homing
 * it from a now-hidden container if the screen changed. Returns whether a NEW mount
 * happened (false when nothing was pending, no safe screen is visible, or the banner is
 * already correctly placed — which keeps showUpdatePrompt idempotent).
 */
function surface(doc: Document): boolean {
  if (!pendingApply) return false;
  ensureObservers(doc);
  const container = firstVisibleSafeContainer(doc);
  if (!container) return false;
  const existing = doc.getElementById(UPDATE_BANNER_ID);
  if (existing) {
    if (existing.parentElement === container) return false; // already shown here (no-op)
    existing.remove(); // was in a now-hidden container — re-home it to the visible one
  }
  return mountBanner(pendingApply, doc, container);
}

/**
 * Called by register-sw when an update is ready. Shows the banner now if a safe screen
 * is visible, otherwise stashes the callback and re-surfaces it automatically when one
 * appears (mid-run install, or the game-over screen). Returns whether it mounted now.
 * Idempotent while a banner is already showing.
 */
export function showUpdatePrompt(apply: () => void, doc: Document = document): boolean {
  pendingApply = apply;
  ensureObservers(doc);
  return surface(doc);
}

/**
 * Explicit companion to the observer: re-surface a stashed update prompt if a safe
 * screen is now visible. Returns whether it mounted. No-op when nothing is pending.
 */
export function retryPendingUpdatePrompt(doc: Document = document): boolean {
  return surface(doc);
}
