// DOM-only accessibility helpers. No game state, timers, or per-frame observers.
const sessions = new Map<HTMLElement, { close: (restore: boolean) => void; refresh: () => void }>();
const stack: HTMLElement[] = [];

export function announceGameStatus(message: string): void {
  if (typeof document === 'undefined') return;
  const region = document.getElementById('gameAnnouncements');
  if (region) region.textContent = message;
}

export function closeOverlayFocus(root: HTMLElement, restore = true): void {
  sessions.get(root)?.close(restore);
}

/** Trap focus inside a blocking surface, including explicitly allowed account UI.
 * Snapshots preserve nested dialog/disclosure inert state; closing restores it.
 * Only direct body additions are observed, so HUD/frame updates incur no work. */
export function openOverlayFocus(root: HTMLElement, options: {
  initialFocus?: HTMLElement | null;
  allowed?: HTMLElement[];
  onEscape?: () => void;
  onClose?: () => void;
  modal?: boolean;
} = {}): void {
  closeOverlayFocus(root, false);
  const doc = root.ownerDocument;
  const previous = doc.activeElement as HTMLElement | null;
  const allowed = [root, ...(options.allowed ?? [])];
  const allowedInert = allowed.map((scope) => scope.inert);
  for (const scope of allowed) scope.inert = false;
  const changed = new Map<HTMLElement, boolean>();
  if (options.modal !== false) root.setAttribute('aria-modal', 'true');
  root.tabIndex = -1;
  stack.push(root);

  function isolate(parent: Element): void {
    for (const node of Array.from(parent.children)) {
      const el = node as HTMLElement;
      if (allowed.includes(el) || el.id === 'gameAnnouncements' || el.tagName === 'SCRIPT') continue;
      if (allowed.some((scope) => el.contains(scope))) isolate(el);
      else {
        if (!changed.has(el)) changed.set(el, el.inert);
        el.inert = true;
      }
    }
  }
  isolate(doc.body);
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (stack.at(-1) !== root) return;
    if (!root.isConnected) closeOverlayFocus(root, false);
    else isolate(doc.body);
  }) : null;
  observer?.observe(doc.body, { childList: true });

  const selector = 'button, a[href], input, select, textarea, [tabindex]';
  function focusable(): HTMLElement[] {
    return allowed.flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>(selector)))
      .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]')
        && el.getClientRects().length > 0);
  }
  function focusFirst(): void {
    (options.initialFocus ?? focusable()[0] ?? root).focus({ preventScroll: true });
  }
  function onKey(event: KeyboardEvent): void {
    if (stack.at(-1) !== root) return;
    if (event.key === 'Escape' && (options.onEscape || options.modal !== false)) {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape?.();
    } else if (event.key === 'Tab') {
      const candidates = focusable();
      const first = candidates[0];
      const last = candidates.at(-1);
      if (!first || (event.shiftKey && (doc.activeElement === first || doc.activeElement === root))) {
        event.preventDefault();
        (last ?? root).focus();
      } else if (!event.shiftKey && (doc.activeElement === last || doc.activeElement === root)) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  function onFocus(event: FocusEvent): void {
    if (stack.at(-1) !== root) return;
    if (!allowed.some((scope) => scope.contains(event.target as Node))) focusFirst();
  }
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusin', onFocus);
  sessions.set(root, { refresh: () => isolate(doc.body), close(restore) {
    observer?.disconnect();
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusin', onFocus);
    options.onClose?.();
    for (const [el, wasInert] of changed) el.inert = wasInert;
    allowed.forEach((scope, index) => { scope.inert = allowedInert[index] ?? false; });
    stack.splice(stack.indexOf(root), 1);
    sessions.delete(root);
    const active = stack.at(-1);
    if (active) sessions.get(active)?.refresh();
    if (restore && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
  } });
  focusFirst();
}

export function focusGameCanvas(): void {
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) return;
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-label', 'Ski slope. Arrow keys or WASD to ski. V changes camera. Open Game Controls for more options.');
  canvas.focus({ preventScroll: true });
}
