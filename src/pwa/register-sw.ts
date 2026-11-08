// register-sw.ts — service-worker registration, the ?sw=reset escape hatch, and the
// safe update flow (issue #358, PR 3). Runs in the PAGE (not the worker).
//
// Design constraints (see sw-config.ts for the predicates):
//   - Register only in a secure context and never under ?test= / auth.html / ?no-sw /
//     ?sw=reset — so the deployed browser suites and the standalone auth page keep
//     their real network path.
//   - ?sw=reset is an emergency hatch: a bad SW can prolong a bad deploy even after
//     Pages is fixed, so this unregisters every SW for the origin, deletes our caches,
//     and reloads from the network — recoverable without devtools.
//   - Update safely: a new SW is NOT auto-activated (sw.ts never skipWaiting on
//     install); we surface a "New version available" affordance and only post
//     SKIP_WAITING when the player confirms from a safe screen, so a new bundle can
//     never swap in mid-run.

import { CACHE_PREFIX, shouldRegisterServiceWorker, isSwResetRequest } from './sw-config.js';

/** Called when a new SW is installed and waiting; the app shows an update affordance. */
export type UpdateReadyHandler = (apply: () => void) => void;

export interface RegisterSwOptions {
  /** Path to the built worker (dist/sw.js). */
  swUrl?: string;
  /** Invoked (once) when an update is downloaded and waiting to activate. */
  onUpdateReady?: UpdateReadyHandler;
}

/** Delete every cache we own (prefixed) — used by the reset hatch. Never throws. */
async function deleteOwnCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) || k.startsWith('workbox'))
        .map((k) => caches.delete(k))
    );
  } catch {
    /* cache API unavailable — nothing to clear */
  }
}

/**
 * Emergency hatch (`?sw=reset`): unregister every SW for this origin, delete our
 * caches, then reload from the network at the clean URL (without the reset param).
 * Exported so it can be driven directly and unit-tested. Never throws.
 */
export async function resetServiceWorker(win: Window = window): Promise<void> {
  try {
    if (win.navigator && 'serviceWorker' in win.navigator) {
      const regs = await win.navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* getRegistrations unavailable — continue to cache clear + reload */
  }
  await deleteOwnCaches();
  try {
    // Reload from the network at the URL minus the reset query, so we don't loop.
    const url = new URL(win.location.href);
    url.searchParams.delete('sw');
    win.location.replace(url.pathname + url.search + url.hash);
  } catch {
    try {
      win.location.reload();
    } catch {
      /* location unavailable (headless) */
    }
  }
}

/**
 * Wire the service worker for this page. Safe to call once at startup. No-ops (and
 * runs no reset) in environments without `serviceWorker`. Returns whether registration
 * was attempted (false when gated off / reset / unsupported), which the tests assert.
 */
export function initServiceWorker(options: RegisterSwOptions = {}, win: Window = typeof window !== 'undefined' ? window : (undefined as unknown as Window)): boolean {
  if (!win || !win.navigator || !('serviceWorker' in win.navigator)) {
    return false;
  }
  const loc = win.location;

  // The reset hatch runs BEFORE the register gate (it is itself a non-registering route).
  if (isSwResetRequest(loc.search)) {
    void resetServiceWorker(win);
    return false;
  }

  if (!shouldRegisterServiceWorker(loc)) {
    return false;
  }

  const swUrl = options.swUrl ?? '/sw.js';
  // Register after load so the SW install never competes with first paint / the game
  // boot for bandwidth.
  const register = () => {
    win.navigator.serviceWorker.register(swUrl).then((registration) => {
      wireUpdateFlow(registration, win, options.onUpdateReady);
    }).catch(() => {
      /* registration failed (network / unsupported) — the app just runs online-only */
    });
  };
  if (win.document && win.document.readyState === 'complete') {
    register();
  } else {
    win.addEventListener('load', register, { once: true });
  }
  return true;
}

/**
 * Watch a registration for an update and surface it safely. When a new worker reaches
 * `installed` while one is already controlling the page, it is an UPDATE (not a first
 * install); we invoke `onUpdateReady(apply)` where `apply()` posts SKIP_WAITING and
 * reloads once the new worker takes over. Exported for the update-flow test.
 */
export function wireUpdateFlow(
  registration: ServiceWorkerRegistration,
  win: Window,
  onUpdateReady?: UpdateReadyHandler
): void {
  const notify = (worker: ServiceWorker | null) => {
    if (!worker || !onUpdateReady) return;
    onUpdateReady(() => {
      // Reload once the new worker has taken control (controllerchange fires post-activate).
      let reloaded = false;
      win.navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        try { win.location.reload(); } catch { /* headless */ }
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  // Already waiting when we registered (update downloaded on a prior visit).
  if (registration.waiting && win.navigator.serviceWorker.controller) {
    notify(registration.waiting);
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // `installed` + an existing controller ⇒ this is an update, not the first install.
      if (installing.state === 'installed' && win.navigator.serviceWorker.controller) {
        notify(registration.waiting ?? installing);
      }
    });
  });
}
