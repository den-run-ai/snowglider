# UI patterns and release checks

The start screen, result screen, account controls and in-game HUD use the same
dark translucent surfaces, rounded borders, readable labels and 44px minimum
interactive targets. Color supplements text and symbols; it never identifies a
difficulty or action on its own.

## Start and replay

- Keep the difficulty choices, Start and Offline play visible in the initial
  viewport. Use two columns for difficulty. Short landscape screens place play
  and help side by side; small portrait screens keep the same reading order.
- Put optional instructions behind native `details`/`summary` disclosures. Their
  chevrons match Camera, Controls, Stats and the guest account chip. Enter and
  Space toggle the focused disclosure without starting a run.
- The start card owns vertical scrolling. Expanded instructions must remain
  reachable without horizontal clipping or trapping the primary action.
- Reserve space for the account controls above the start card. Keep game HUD
  controls hidden while onboarding is active. Sign-in is optional for play.
- `styles/hud.css` owns HUD geometry; `styles/menu.css` owns onboarding geometry.
  Use the shared difficulty-picker factory for start and results. Do not restore
  inline `display:flex` when a layout is CSS-controlled.
- Start intent survives slow script loading and a required mountain rebuild.
  Only one run starts per gesture. Same-tier replay reuses the scene; changing
  tiers rebuilds geometry and resumes the requested run without a second menu.
  A one-shot tier parameter is validated and removed from the URL after boot.
- Audio unlock is attempted in the user gesture. Audio/network initialization
  must not hold up local play. Browser autoplay restrictions still apply after
  navigation.

## Offline, account and sharing

- Offline play is always discoverable. Explain that the game must finish loading
  online first in the same browser; sign-in/global scores require connectivity.
  Keep the install prompt inside the offline disclosure and update notifications
  inside the visible safe screen. Never imply that installing is required.
- Provider buttons show a busy state while auth initializes or a popup is open.
  Google, GitHub and Guest share one visual pattern. Apple remains hidden until
  configured. Guest bests stay local; guest upgrades retain their existing guards.
- Native sharing must start from the click/tap itself. Prepare optional images
  ahead of time; share text/link if the image is not ready. Cancellation is quiet,
  unsupported/failed sharing opens the explicit alternatives, and closing the
  alternatives restores focus. Never post automatically.
- Social options wrap within the viewport, with readable labels and at least
  44px targets. Do not truncate platform names or attach duplicate handlers on
  repeated results.

## Evidence required for UI changes

Run lint, all type-check projects, Node/physics invariants and the production
build. The CI browser matrix covers desktop Chromium/WebKit and iPhone/Android
portrait and landscape. `onboarding.spec.ts` checks viewport bounds and actual
hit targets, including 320×568 and 568×320; `panels.spec.ts` checks the HUD.
Startup/replay tests must exercise the real tier-rebuild path rather than a
webdriver-only shortcut. Auth/share tests mock provider boundaries without
signing into real accounts or posting to social networks.

The production PWA suite separately verifies cached offline reloads, local
results and update behavior. Logic tests alone cannot prove responsive layout.
Keep before/after screenshots with the PR using `scripts/capture-hud-review.mjs`;
the script uses the player scene with EZ trees, not the automation fallback.

An announcement check also needs real provider popup completion, platform link
previews and real-device audio/native-share testing. Automated mocked providers
and emulated phones do not establish those external/device behaviors.
