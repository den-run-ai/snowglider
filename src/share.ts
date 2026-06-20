// share.ts - Lightweight social sharing for the finish result screen.
//
// Lets a player share a completed run without sign-in, a backend endpoint, or a
// per-platform SDK. The course result panel wires a single "Share Result" button
// to shareResult(); see the "Social sharing" entry in docs/CHANGELOG.md.
//
// Two pieces, kept deliberately small and side-effect-light:
//   - buildResultShareData(time, isNewBest): deterministic share copy (no DOM /
//     network), with the public URL cleaned of local-only query params so a
//     shared link is always a stable public page.
//   - shareResult(data): native Web Share API when available, otherwise a
//     clipboard fallback; best-effort Analytics, and it never rejects.

/** Canonical public page, used when the current URL is local/dev/unparseable. */
const PUBLIC_URL = 'https://snowglider.ai/';

/** Title handed to the Web Share API (platforms may or may not surface it). */
const SHARE_TITLE = 'SnowGlider';

/** Query params that only make sense on a dev/test page; never leak them. */
const LOCAL_ONLY_PARAMS = ['test'];

/** Deterministic share payload produced by {@link buildResultShareData}. */
export interface ResultShareData {
  title: string;
  text: string;
  url: string;
}

/** What {@link shareResult} ended up doing, for callers that want feedback. */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unavailable';

function isLocalHost(hostname: string): boolean {
  return hostname === '' || hostname === 'localhost' ||
    hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
    hostname === '[::1]' || hostname.endsWith('.local');
}

/**
 * Return a stable, shareable absolute URL for `href`, stripping local-only query
 * params (e.g. `?test=...`) and the hash. Local/dev/file or unparseable inputs
 * collapse to the canonical public page so a shared link is never useless to a
 * recipient.
 */
export function cleanShareUrl(href?: string | null): string {
  if (!href) return PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return PUBLIC_URL;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || isLocalHost(url.hostname)) {
    return PUBLIC_URL;
  }
  for (const param of LOCAL_ONLY_PARAMS) url.searchParams.delete(param);
  url.hash = '';
  return url.toString();
}

function currentHref(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  return window.location.href;
}

function formatSeconds(time: number): string {
  // Guard against NaN/Infinity/negative clocks so the copy is always sane.
  const safe = Number.isFinite(time) && time > 0 ? time : 0;
  return safe.toFixed(2);
}

/**
 * Build deterministic share copy for a finished run. Pure aside from reading
 * `window.location` for the default URL; pass `href` explicitly to keep it fully
 * testable.
 */
export function buildResultShareData(
  time: number,
  isNewBest: boolean,
  href?: string | null
): ResultShareData {
  const seconds = formatSeconds(time);
  const text = isNewBest
    ? `New SnowGlider personal best: ${seconds}s. Can you beat it?`
    : `I finished SnowGlider in ${seconds}s. Can you beat my run?`;
  const url = cleanShareUrl(href === undefined ? currentHref() : href);
  return { title: SHARE_TITLE, text, url };
}

/** Single-string form used for the clipboard fallback (message + link). */
export function shareMessage(data: ResultShareData): string {
  return `${data.text}\n${data.url}`;
}

function isUserCancel(err: unknown): boolean {
  // The native share sheet rejects with AbortError when the user dismisses it;
  // that is an explicit "no", so we must not fall back to the clipboard.
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

async function copyToClipboard(text: string): Promise<boolean> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return false;
  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function logShareEvent(method: ShareOutcome): void {
  try {
    const fm = typeof window !== 'undefined' ? window.firebaseModules : undefined;
    if (fm && typeof fm.logEvent === 'function') {
      fm.logEvent('share_result', { method });
    }
  } catch {
    /* Analytics is strictly best-effort; never let it break sharing. */
  }
}

/**
 * Share a finished run. Prefers the native Web Share API (which must be triggered
 * by a user gesture); on its absence — or a non-cancel failure — copies the
 * message to the clipboard. Resolves with what happened and never rejects.
 */
export async function shareResult(data: ResultShareData): Promise<ShareOutcome> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;

  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title: data.title, text: data.text, url: data.url });
      logShareEvent('shared');
      return 'shared';
    } catch (err) {
      if (isUserCancel(err)) return 'cancelled';
      // Any other failure (e.g. NotAllowedError) → try the clipboard fallback.
    }
  }

  if (await copyToClipboard(shareMessage(data))) {
    logShareEvent('copied');
    return 'copied';
  }
  return 'unavailable';
}
