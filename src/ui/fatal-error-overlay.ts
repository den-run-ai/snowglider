// fatal-error-overlay.ts — last-resort recovery UI for an uncaught error inside the
// per-frame run loop (game/main-loop.ts `animate`).
//
// WHY THIS EXISTS
// ---------------
// `animate()` reschedules its requestAnimationFrame at the TOP of the frame, so an
// uncaught exception in the body doesn't stop the loop — rAF keeps firing and throwing
// on every frame, leaving a HARD-FROZEN last frame with no feedback (the screen looks
// dead). The most plausible real-world trigger is a stale/partially-updated mobile
// cache after a deploy that changed the module graph: old code wired to new code throws
// mid-frame. Rather than freeze silently, the loop catches the error, stops cleanly, and
// shows this overlay so the player can recover with a single tap.
//
// The recovery action is a full RELOAD (not the in-game restart): a fatal loop error is
// almost always a bad module graph or a lost WebGL context, neither of which an in-page
// restart fixes — a fresh page load pulls one consistent, hashed bundle.
//
// Kept tiny and three.js-free (DOM only) so it is headless-testable and can never itself
// throw back into the loop. Idempotent: built once, re-shown on repeat calls.

let overlay: HTMLDivElement | null = null;

/** Default recovery action: a hard page reload to fetch a consistent bundle. Injectable
 *  so the headless test can assert it fires without navigating the test runner. */
function defaultReload(): void {
  if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
    window.location.reload();
  }
}

export interface FatalErrorOverlayOptions {
  /** Override the reload action (tests). Defaults to `window.location.reload()`. */
  onReload?: () => void;
}

/** Build (once) and show the full-screen recovery overlay. Safe to call repeatedly and
 *  safe to call with no DOM (returns null) — it must never throw into the run loop. */
export function showFatalErrorOverlay(err?: unknown, opts: FatalErrorOverlayOptions = {}): HTMLDivElement | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const reload = opts.onReload || defaultReload;

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fatalErrorOverlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '2000', // above the game-over overlay (1000)
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '14px', padding: '24px', boxSizing: 'border-box', textAlign: 'center',
      background: 'rgba(10,14,24,0.92)', color: '#fff',
      fontFamily: 'Arial, sans-serif', pointerEvents: 'auto',
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement('div');
    title.textContent = 'Something went wrong';
    Object.assign(title.style, { fontSize: '24px', fontWeight: '800' } as Partial<CSSStyleDeclaration>);

    const body = document.createElement('div');
    body.id = 'fatalErrorMessage';
    body.textContent = "The game hit an unexpected error. This is usually a stale cache after an update — reloading fixes it.";
    Object.assign(body.style, {
      fontSize: '15px', maxWidth: '420px', lineHeight: '1.4', color: '#cfd8e3',
    } as Partial<CSSStyleDeclaration>);

    const button = document.createElement('button');
    button.id = 'fatalErrorReloadBtn';
    button.textContent = 'Reload';
    Object.assign(button.style, {
      marginTop: '6px', padding: '14px 30px', fontSize: '20px', fontWeight: '700',
      border: 'none', borderRadius: '8px', background: '#ff4136', color: '#fff',
      cursor: 'pointer', touchAction: 'manipulation',
    } as Partial<CSSStyleDeclaration>);
    button.addEventListener('click', () => { try { reload(); } catch { /* ignore */ } });

    overlay.appendChild(title);
    overlay.appendChild(body);
    overlay.appendChild(button);
    document.body.appendChild(overlay);
  }

  // Surface a short, non-sensitive hint of the error for debugging without dumping a
  // full stack at the player. Cosmetic only; the reload is the real recovery.
  const detail = overlay.querySelector<HTMLElement>('#fatalErrorMessage');
  if (detail) {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    detail.textContent = msg
      ? `The game hit an unexpected error (“${msg}”). This is usually a stale cache after an update — reloading fixes it.`
      : "The game hit an unexpected error. This is usually a stale cache after an update — reloading fixes it.";
  }

  overlay.style.display = 'flex';
  return overlay;
}

/** Test seam: drop the cached overlay node so a fresh test starts clean. */
export function resetFatalErrorOverlay(): void {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  overlay = null;
}
