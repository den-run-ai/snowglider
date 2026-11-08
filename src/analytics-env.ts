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
 * reporter split human vs. bot later. Use explicit "true"/"false" strings so the
 * custom dimension has the same representation across SDK transports.
 */

/** True when the page is driven by browser automation (Playwright/Puppeteer/Selenium). */
export function isAutomatedClient(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  if (typeof window === 'undefined') return false;
  return window.isTestMode === true || new URLSearchParams(window.location?.search || '').has('test');
}

/** A bounded deployment label lets reports distinguish stale clients after a
 * deploy. Only the build plugin's fixed timestamp format (or dev) is accepted. */
export function analyticsBuildId(): string {
  const value = typeof document !== 'undefined'
    ? document.querySelector('meta[name="build-id"]')?.getAttribute('content') || '' : '';
  return value === 'dev' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(value) ? value : 'unknown';
}

/**
 * Return a shallow copy of `params` with a stable `is_bot` traffic tag added. Never
 * mutates the input. The environment owns this tag: callers cannot disguise an
 * automated run by overriding it. Explicit strings match GA4 custom-dimension filters.
 */
export function withTrafficTag(
  params?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(params ?? {}), is_bot: isAutomatedClient() ? 'true' : 'false', app_build: analyticsBuildId() };
}
