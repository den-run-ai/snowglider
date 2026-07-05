// sw-config.ts — pure, dependency-free service-worker policy predicates for the
// offline PWA (issue #358, PR 3 of the offline-mode stack).
//
// These decide WHEN the service worker may register and WHICH requests it must NOT
// touch. They live in their own module (no workbox / no `self` / no DOM) so the exact
// same logic is used by the worker (sw.ts), the registrar (register-sw.ts), AND the
// headless tests — the SW's own fetch/nav routing can't be jsdom-tested, but this
// policy core can, which is where the load-bearing "never hijack ?test= / dist tests /
// src / node_modules" guarantees live.
//
// The overriding constraint (see CLAUDE.md): dist/ intentionally ships copied src/,
// tests/, node_modules/three, auth.html and a large MP3 for the DEPLOYED browser test
// suites. The service worker must never precache them and must never navigation-hijack
// their routes, or it would serve a stale app shell in place of a `?test=` suite.

/** localStorage-independent cache-name prefix; used to scope + purge our caches. */
export const CACHE_PREFIX = 'snowglider';

/** URL substrings that must NEVER appear in the generated precache manifest. The
 *  build-artifact test (tests/pwa-build-artifact-tests.js) fails the build if any of
 *  these leak into dist/sw.js, so a glob change can't silently start precaching the
 *  copied source/tests/audio. */
export const FORBIDDEN_PRECACHE_SUBSTRINGS: readonly string[] = [
  '/src/',
  '/tests/',
  '/node_modules/',
  'auth.html',
  '.mp3',
  '.map',
  'README',
  'LICENSE',
];

/** Path prefixes/files the SW must pass straight through to the network (never serve
 *  from cache, never navigation-fallback). These are the deployed test/auth/source
 *  routes that must load their real bytes. */
export function isBypassedPath(pathname: string): boolean {
  if (/(^|\/)auth\.html$/.test(pathname)) return true;
  return (
    pathname.startsWith('/tests/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/')
  );
}

/** Is this an automation / test navigation (`?test=…`)? Mirrors the codebase's
 *  `location.search.includes('test')` automation gate (scene-setup.ts) so the SW and
 *  the game agree on what "a test route" is. */
export function isAutomationSearch(search: string): boolean {
  return (search || '').includes('test');
}

/** Is this the emergency reset request (`?sw=reset`)? */
export function isSwResetRequest(search: string): boolean {
  try {
    return new URLSearchParams(search || '').get('sw') === 'reset';
  } catch {
    return false;
  }
}

/** Is the SW explicitly disabled for this load (`?no-sw=1` / `?no-sw`)? */
export function isSwDisabledRequest(search: string): boolean {
  try {
    return new URLSearchParams(search || '').has('no-sw');
  } catch {
    return false;
  }
}

/** A minimal Location-like shape (so callers/tests need not build a real Location). */
export interface LocationLike {
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
}

/** Is the origin a secure context the SW may run in: https, or http on localhost /
 *  127.0.0.1 (the dev + preview servers). file:// and plain-http hosts are excluded. */
export function isSecureContextForSw(loc: Pick<LocationLike, 'protocol' | 'hostname'>): boolean {
  if (loc.protocol === 'https:') return true;
  if (loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
}

/**
 * Should the registrar register the service worker for this load? Only in a secure
 * context, never on auth.html, and never under the `?test=` / `?no-sw` / `?sw=reset`
 * routes (those either need the real network path or run the reset flow instead).
 */
export function shouldRegisterServiceWorker(loc: LocationLike): boolean {
  if (!isSecureContextForSw(loc)) return false;
  if (/(^|\/)auth\.html$/.test(loc.pathname)) return false;
  if (isSwResetRequest(loc.search)) return false;
  if (isSwDisabledRequest(loc.search)) return false;
  if (isAutomationSearch(loc.search)) return false;
  return true;
}

/**
 * Should the SW serve the cached app shell for this NAVIGATION? False for the
 * bypassed paths and the `?test=` / `?no-sw` / `?sw=reset` routes, so an
 * already-installed SW (from a normal visit) still lets a later `?test=` navigation or
 * an /auth.html load hit the network for their real content. This is the query-aware
 * check workbox's pathname-only NavigationRoute denylist can't do on its own.
 */
export function shouldServeAppShell(url: Pick<LocationLike, 'pathname' | 'search'>): boolean {
  if (isBypassedPath(url.pathname)) return false;
  if (isAutomationSearch(url.search)) return false;
  if (isSwDisabledRequest(url.search)) return false;
  if (isSwResetRequest(url.search)) return false;
  return true;
}
