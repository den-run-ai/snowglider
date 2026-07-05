// install-prompt.ts — start-screen "Install" affordance for the offline PWA
// (issue #358, PR 2 of the offline-mode stack).
//
// Adds ONLY the install-prompt half of PWA support — there is deliberately no
// service worker in this PR (that risk is isolated in PR 3). The prompt is a small,
// dismissible chip on the start screen that appears only when the browser has fired
// `beforeinstallprompt` (Chromium desktop/Android). It:
//   - never blocks Start (it lives inside #startGameContainer and is purely additive),
//   - is hidden under automation (`?test=` / webdriver) so the deployed browser suites
//     are unaffected,
//   - is hidden when already installed/standalone,
//   - is hidden on browsers that never fire the event (iOS Safari, Firefox) — the chip
//     simply never appears,
//   - disappears during a run (the whole start container hides on Start), and
//   - remembers a dismissal so it doesn't nag.
//
// The pure decision core (`shouldOfferInstall`) is unit-tested headlessly; the live
// event wiring is exercised by the jsdom install-prompt suite.

import { INSTALL_HINT_TEXT } from '../offline/offline-ui.js';
import { isStandalone } from '../offline/offline-state.js';
import { safeGetItem, safeSetItem, type StorageLike } from '../offline/offline-store.js';

/**
 * The minimal Window surface this module needs. Narrowing (rather than the full
 * `Window`) lets a jsdom `DOMWindow` satisfy `deps.win` structurally in headless
 * tests without stubbing the ~540 `typeof globalThis` members.
 */
type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener' | 'navigator' | 'location'>;

/** localStorage key remembering that the player dismissed the install chip. */
export const INSTALL_DISMISSED_KEY = 'snowgliderInstallDismissed';

/** DOM id of the mounted install chip. */
export const INSTALL_PROMPT_ID = 'installPrompt';

/**
 * The subset of the non-standard `beforeinstallprompt` event we use. Typed locally
 * because it is not in the DOM lib. `prompt()` shows the native install dialog;
 * `userChoice` resolves once the player accepts/dismisses it.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Inputs to the pure show/hide decision. */
export interface InstallOfferState {
  /** Running under automation (`?test=` / webdriver) — never offer install. */
  testMode: boolean;
  /** Already installed / standalone — nothing to install. */
  standalone: boolean;
  /** The browser fired `beforeinstallprompt` and we captured it. */
  promptAvailable: boolean;
  /** The player previously dismissed the chip. */
  dismissed: boolean;
}

/**
 * Should the install chip be shown right now? Pure combinator: offer install only
 * when the browser actually supports it (`promptAvailable`), we're not under
 * automation, we're not already installed, and the player hasn't dismissed it.
 */
export function shouldOfferInstall(state: InstallOfferState): boolean {
  return (
    state.promptAvailable === true &&
    state.testMode !== true &&
    state.standalone !== true &&
    state.dismissed !== true
  );
}

/** Injectable dependencies so the controller is headless-testable. */
export interface InstallPromptDeps {
  doc?: Document;
  win?: WindowLike;
  /** Override automation detection (defaults to a `?test=` / webdriver check). */
  isTestMode?: () => boolean;
  /** Override standalone detection (defaults to offline-state `isStandalone`). */
  standalone?: () => boolean;
  storage?: StorageLike | null;
}

function defaultIsTestMode(win: WindowLike): boolean {
  try {
    if (win.navigator && win.navigator.webdriver) return true;
    const search = win.location && win.location.search ? win.location.search : '';
    return search.includes('test');
  } catch {
    return false;
  }
}

/** A handle to the mounted install prompt, mainly for teardown in tests. */
export interface InstallPromptController {
  /** Re-evaluate visibility against the current state. */
  refresh: () => void;
  /** Remove listeners + the chip (teardown-clean). */
  dispose: () => void;
}

/**
 * Wire the install prompt. Safe to call once at startup. Returns a controller; if the
 * environment has no document (Node without jsdom) it returns an inert controller.
 */
export function initInstallPrompt(deps: InstallPromptDeps = {}): InstallPromptController {
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : null);
  const win = deps.win ?? (typeof window !== 'undefined' ? window : null);
  if (!doc || !win) {
    return { refresh: () => {}, dispose: () => {} };
  }

  const isTestMode = deps.isTestMode ?? (() => defaultIsTestMode(win));
  const standalone = deps.standalone ?? isStandalone;
  const storage = deps.storage;

  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  function isDismissed(): boolean {
    return safeGetItem(INSTALL_DISMISSED_KEY, storage) === '1';
  }

  function currentState(): InstallOfferState {
    return {
      testMode: isTestMode(),
      standalone: standalone(),
      promptAvailable: deferredPrompt !== null,
      dismissed: isDismissed(),
    };
  }

  function findContainer(): HTMLElement | null {
    return doc!.getElementById('startGameContainer');
  }

  function ensureChip(): HTMLElement | null {
    const existing = doc!.getElementById(INSTALL_PROMPT_ID);
    if (existing) return existing;
    const container = findContainer();
    if (!container) return null;

    const chip = doc!.createElement('div');
    chip.id = INSTALL_PROMPT_ID;
    chip.className = 'install-prompt';
    chip.style.display = 'none';

    const label = doc!.createElement('span');
    label.className = 'install-prompt-label';
    label.textContent = INSTALL_HINT_TEXT;

    const installBtn = doc!.createElement('button');
    installBtn.type = 'button';
    installBtn.id = 'installPromptButton';
    installBtn.className = 'install-prompt-install';
    installBtn.textContent = 'Install';
    installBtn.addEventListener('click', () => { void doInstall(); });

    const dismissBtn = doc!.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.id = 'installPromptDismiss';
    dismissBtn.className = 'install-prompt-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss install prompt');
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', () => { dismiss(); });

    chip.appendChild(label);
    chip.appendChild(installBtn);
    chip.appendChild(dismissBtn);
    container.appendChild(chip);
    return chip;
  }

  function refresh() {
    const show = shouldOfferInstall(currentState());
    if (!show) {
      const existing = doc!.getElementById(INSTALL_PROMPT_ID);
      if (existing) existing.style.display = 'none';
      return;
    }
    const chip = ensureChip();
    if (chip) chip.style.display = 'flex';
  }

  async function doInstall() {
    const evt = deferredPrompt;
    if (!evt) return;
    // A prompt event can only be used once.
    deferredPrompt = null;
    try {
      await evt.prompt();
      await evt.userChoice;
    } catch {
      /* user agent rejected the prompt — nothing more to do */
    }
    refresh();
  }

  function dismiss() {
    safeSetItem(INSTALL_DISMISSED_KEY, '1', storage);
    const existing = doc!.getElementById(INSTALL_PROMPT_ID);
    if (existing) existing.style.display = 'none';
  }

  const onBeforeInstallPrompt = (e: Event) => {
    // Suppress the browser's mini-infobar; we surface our own chip instead.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    refresh();
  };
  const onAppInstalled = () => {
    deferredPrompt = null;
    const existing = doc.getElementById(INSTALL_PROMPT_ID);
    if (existing) existing.style.display = 'none';
  };

  win.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  win.addEventListener('appinstalled', onAppInstalled);

  // In case the event already fired before we wired up (rare), reflect current state.
  refresh();

  return {
    refresh,
    dispose() {
      win.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      win.removeEventListener('appinstalled', onAppInstalled);
      const existing = doc.getElementById(INSTALL_PROMPT_ID);
      if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
    },
  };
}
