# Offline / Installable PWA

SnowGlider ships as an installable, offline-capable Progressive Web App (issue #358).
The guiding rule: **offline gameplay is core; online identity / global ranking is
opportunistic.** This doc covers the contract, the automated coverage, and the manual
real-device checklist that the CI can't run.

## What "offline mode" means

1. A player visits `snowglider.ai` once while online.
2. The app becomes installable on mobile and desktop (manifest + icons + install chip).
3. After install / first successful load, the game launches in airplane mode.
4. Core gameplay works offline: terrain, physics, trees/rocks, snowman, touch + keyboard
   controls, camera, timer, local best time, splits, ghost racing.
5. Online-only features degrade clearly: Firebase login, the global leaderboard, GitHub
   feedback, and analytics are unavailable and say so.
6. Local results sync later, only when the player is back online **and** signed in with a
   real (non-anonymous) account.

We do **not** promise: an offline global leaderboard, offline login, or direct
`file://` play.

## How it's built (the PR stack)

| Layer | Where |
|---|---|
| Offline state + hardened local storage + pending-sync marker | `src/offline/offline-state.ts`, `offline-store.ts`, `offline-ui.ts` |
| Manifest + icons + install prompt | `public/manifest.webmanifest`, `public/icons/icon.svg`, `src/pwa/install-prompt.ts` |
| Service worker (injectManifest) + registration + `?sw=reset` + update banner | `src/pwa/sw.ts`, `sw-config.ts`, `register-sw.ts`, `update-ui.ts` |
| Local-first score sync + honest result copy | `src/offline/sync-manager.ts`, wired into `src/scores.ts` + `src/ui/result-overlay.ts` |

### Cache policy (the load-bearing invariant)

`dist/` intentionally ships copied `src/`, `tests/`, `node_modules/three`, `auth.html`
and a large MP3 for the **deployed browser test suites**. The service worker must never
precache or navigation-hijack them. The precache is the app shell only (index.html + the
hashed core chunk + css + manifest + icon). `scripts/verify-pages-dist.sh` fails the
build if any forbidden path (`src/`, `tests/`, `node_modules/`, `auth.html`, `.mp3`,
`.map`) leaks into the generated precache manifest.

### Escape hatch

`https://snowglider.ai/?sw=reset` unregisters every service worker for the origin, deletes
SnowGlider's caches, and reloads from the network — recovery from a bad deploy without
devtools. `?no-sw=1` loads once without registering the worker.

## Automated coverage

- **Headless (Node):** `offline-state`, `offline-store`, `offline-ui`, `install-prompt`,
  `pwa-sw-config`, `pwa-register-sw`, `pwa-update-ui`, `pwa-build-artifact`, `pwa-manifest`,
  `sync-manager` suites (run by `npm test`).
- **Production-build E2E:** `npm run test:pwa` builds `dist/` and drives the **real**
  service worker under `vite preview` with Playwright (`tests/e2e/pwa-offline.spec.ts`):
  offline launch after one online load, `?test=` never registers the SW, and the
  `?sw=reset` hatch clears caches. Runs in CI as the non-deploy-gating `pwa` job.

The service worker registers under real browsers but **self-gates off `?test=`**, so the
deployed Puppeteer/`?test=` suites keep their network path. The dev-server Playwright e2e
runs against `vite` (no `sw.js` emitted), so it is unaffected.

## Manual real-device checklist

CI can't cover install funnels, the iOS hardware silent switch, or real airplane mode.
Run this before relying on offline in production.

### iOS Safari
- [ ] Open `snowglider.ai`; **Share → Add to Home Screen**.
- [ ] Launch the installed app (standalone, no Safari chrome).
- [ ] Start a run; enable audio after the start gesture.
- [ ] Airplane mode → relaunch the installed app → start a game again.
- [ ] Confirm local best / splits / ghost persist; leaderboard shows the offline copy.
- [ ] Note: iOS routes Web Audio through the hardware silent switch — verify with the
      switch off.

### Android Chrome
- [ ] Install the app (the install chip appears, or the browser menu → Install).
- [ ] Airplane mode → relaunch → touch controls work, gameplay runs.
- [ ] Audio degrades acceptably (silent if never cached); procedural SFX still play.
- [ ] Local best persists; result screen shows the offline sync copy.

### Desktop Chrome / Edge
- [ ] Install the app (install chip / address-bar install button).
- [ ] Disconnect the network → relaunch → keyboard controls work, local best persists.
- [ ] The "New version available" banner appears only on a safe screen (start / after a
      run), never mid-run, and Reload applies the update.

### Sync honesty (any platform)
- [ ] Signed in (real provider), go offline, finish a ranked run → result says it saved
      locally and will sync. Reconnect → the best syncs to the global leaderboard.
- [ ] As an anonymous guest, a run stays local-only (never hits the global board) until
      upgrading to a real provider.
