/**
 * Traffic-source tagging for Firebase Analytics events.
 *
 * Automated clients — Playwright / Puppeteer / Selenium and most headless bots — set
 * `navigator.webdriver = true`. Tagging every analytics event with an `is_bot` param lets
 * that traffic be filtered out in GA4 (register `is_bot` as a custom dimension, then
 * exclude `is_bot = true`) WITHOUT dropping the data. Automated runs against the live site
 * were inflating gameplay event counts (game_reset / game_over / session_health) and
 * driving false "anomaly spikes" that didn't correspond to real players. See
 * docs/ANALYTICS.md and scripts/analytics-report.mjs (the anomaly detector that surfaced
 * this).
 *
 * Tagging rather than suppressing keeps the events visible for debugging and lets the
 * reporter split human vs. bot later; GA4 coerces the boolean to "true"/"false" for the
 * custom dimension, which filters cleanly.
 */

/** True when the page is driven by browser automation (Playwright/Puppeteer/Selenium). */
export function isAutomatedClient(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/**
 * Return a shallow copy of `params` with a stable `is_bot` traffic tag added. Never
 * mutates the input, so callers can pass a literal safely. An explicit `is_bot` already
 * present in `params` is preserved.
 */
export function withTrafficTag(
  params?: Record<string, unknown>,
): Record<string, unknown> {
  return { is_bot: isAutomatedClient(), ...(params ?? {}) };
}
