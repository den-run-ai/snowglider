// dom.mjs — shared jsdom environment setup/teardown for headless Node tests.
//
// 13 test files each `new JSDOM(...)` and then wire window/document (and usually a
// localStorage shim, sometimes a navigator.onLine override and window.CustomEvent)
// onto the Node globals the src modules close over. This centralizes that boilerplate
// so a jsdom-shape or global-wiring change is one edit instead of thirteen.
//
// setupDom({ html, url, online }) builds a jsdom, points global.window/document at it,
// installs a fresh in-memory localStorage (createLocalStorageMock), binds
// window.CustomEvent onto globalThis (some src modules dispatch a bare `new
// CustomEvent(...)` that jsdom rejects unless it comes from window's realm), and lets
// navigator.onLine be toggled via the returned setOnline(). Returns the live handles
// plus teardown(). This is a DRY/maintainability seam, not isolation: the `test:*`
// scripts already run each file in its own process, so the globals set here cannot
// leak between files.

import { JSDOM } from 'jsdom';
import { createLocalStorageMock } from './local-storage.mjs';

const DEFAULT_HTML = '<!doctype html><html><body></body></html>';
const DEFAULT_URL = 'https://snowglider.ai/';

/**
 * Stand up a jsdom and wire the Node globals the src modules read.
 * @param {{ html?: string, url?: string, online?: boolean }} [options]
 * @returns {{
 *   dom: import('jsdom').JSDOM,
 *   window: Window,
 *   document: Document,
 *   localStorage: ReturnType<typeof createLocalStorageMock>,
 *   setOnline: (value: boolean) => void,
 *   teardown: () => void
 * }}
 */
export function setupDom({ html = DEFAULT_HTML, url = DEFAULT_URL, online = true } = {}) {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  const localStorage = createLocalStorageMock();

  global.window = window;
  global.document = window.document;
  global.localStorage = localStorage;
  // Some src modules construct a bare `new CustomEvent(...)` (e.g. auth's
  // 'snowglider:auth-changed') and dispatch it on window. Bind jsdom's CustomEvent so
  // the event comes from the SAME realm as window — Node's built-in CustomEvent is
  // rejected by jsdom's dispatchEvent.
  global.CustomEvent = window.CustomEvent;

  // jsdom exposes a read-only window.localStorage on most origins, so redefine it to
  // point at our shim; the bare `localStorage` global (what src actually closes over)
  // and window.localStorage then agree.
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => localStorage });
  } catch {
    // jsdom won't let us redefine it on this origin; the global alias above is the one
    // the modules under test read, so this is non-fatal.
  }

  let onLine = online;
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => onLine
  });

  return {
    dom,
    window,
    document: window.document,
    localStorage,
    /** Control what navigator.onLine reports (drives offline/online code paths). */
    setOnline(value) { onLine = value; },
    /** Close the jsdom window. Globals persist (per-file process isolation handles cleanup). */
    teardown() { dom.window.close(); }
  };
}
