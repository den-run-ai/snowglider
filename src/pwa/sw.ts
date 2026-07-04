// sw.ts — SnowGlider's service worker (issue #358, PR 3). Built by vite-plugin-pwa's
// `injectManifest` strategy: it bundles this file to dist/sw.js and replaces
// `self.__WB_MANIFEST` with the precache list of the app shell (index.html + the
// hashed JS/CSS chunks + manifest + icons). We hand-author the routing (rather than
// `generateSW`) precisely because this repo's dist/ also contains copied src/, tests/,
// node_modules/three, auth.html and a large MP3 that must NOT be cached or
// navigation-hijacked — see sw-config.ts for that policy.
//
// This file is bundled for the ServiceWorkerGlobalScope, not type-checked by the app
// tsconfig (it is excluded there); vite-plugin-pwa compiles it standalone.
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { CACHE_PREFIX, shouldServeAppShell } from './sw-config.js';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Precache the injected app shell and serve those exact URLs from cache. The manifest
// is content-hashed by Vite, so revisions are null (the URL is the version).
precacheAndRoute(self.__WB_MANIFEST);
// Drop precaches from older SW versions so an update can't leave stale shells around.
cleanupOutdatedCaches();

// --- Navigation fallback: serve the cached index.html for in-app navigations, but
// NOT for the deployed test/auth/source routes or the ?test= / ?no-sw / ?sw=reset
// query routes (shouldServeAppShell is the query-aware gate workbox's pathname-only
// NavigationRoute can't express). This lets an already-installed SW still let a later
// /?test=… navigation or /auth.html hit the network for its real content.
const appShellHandler = createHandlerBoundToURL('/index.html');
registerRoute(
  ({ request, url }) =>
    request.mode === 'navigate' &&
    url.origin === self.location.origin &&
    shouldServeAppShell({ pathname: url.pathname, search: url.search }),
  appShellHandler
);

// --- Background music (MP3): NOT precached (large, optional). Runtime CacheFirst so it
// works offline only after it has been loaded online once; otherwise gameplay + the
// procedural SFX continue silently. Scoped to same-origin /assets/*.mp3.
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    request.destination === 'audio' &&
    url.pathname.endsWith('.mp3'),
  new CacheFirst({ cacheName: `${CACHE_PREFIX}-audio` })
);

// --- EZ-Tree evergreen chunk (~4 MB, lazy, players only): NOT precached (would bloat
// the install and exceed workbox's per-file ceiling). Runtime CacheFirst so it works
// offline after one online load; without it the forest falls back to the stylized cone
// trees, so gameplay is unaffected. Scoped to the same-origin hashed chunk.
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith('/assets/ez-tree') &&
    url.pathname.endsWith('.js'),
  new CacheFirst({ cacheName: `${CACHE_PREFIX}-ez-tree` })
);

// --- Online identity / ranking / analytics: NEVER cache. Fail fast so offline never
// pretends these worked (Firebase auth + Firestore, Google APIs, GitHub feedback).
registerRoute(
  ({ url }) =>
    /(^|\.)(firebase|firebaseio|firebaseapp|firestore|googleapis|identitytoolkit|securetoken|google-analytics|analytics\.google)\.com$/.test(
      url.hostname
    ) || url.hostname === 'github.com',
  new NetworkOnly()
);

// Take control promptly on first install; the update flow (register-sw.ts) gates the
// actual reload so we never swap the running bundle mid-run.
self.addEventListener('install', () => {
  // Do NOT skipWaiting() here — the page decides when to activate a new SW (register-sw
  // posts SKIP_WAITING from a safe screen), so a new version can't reload an active run.
});
self.addEventListener('activate', (event: ExtendableEvent) => {
  // waitUntil keeps the activation alive until the claim resolves — otherwise the
  // browser may terminate the event before clients.claim() completes, and an
  // apply-update (SKIP_WAITING) would never fire controllerchange, so register-sw's
  // reload wouldn't run until the user manually navigated (Codex #361).
  event.waitUntil(self.clients.claim());
});
// The page posts this from a safe screen (start / result / game-over) to apply an update.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
