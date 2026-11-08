// Exact URL-query policy for SnowGlider's browser automation modes.
//
// A real player URL must enter automation only when it has a `test` QUERY KEY.
// Substring checks such as `location.search.includes('test')` also matched ordinary
// campaign URLs (`?utm_campaign=beta-test`, `?latest=1`, `?contest=...`). That could
// auto-start the game, disable PWA behavior and even activate collision test hooks.

/** Return every value supplied for the exact `test` query key. */
export function getTestModeValues(search: string): string[] {
  try {
    return new URLSearchParams(search || '').getAll('test');
  } catch {
    return [];
  }
}

/** Whether the query contains the exact `test` key, including bare `?test`. */
export function isTestModeSearch(search: string): boolean {
  return getTestModeValues(search).length > 0;
}
