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

/**
 * Format a run clock to a sane 2-decimal seconds string. Exported so the share
 * card ({@link ./share-card}) renders the exact same number as the copy here,
 * with the same NaN/Infinity/negative guard.
 */
export function formatRunSeconds(time: number): string {
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
  const seconds = formatRunSeconds(time);
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

/** How a share was attempted, for the best-effort Analytics event. */
type ShareMethod = ShareOutcome | SharePlatform | 'image';

function logShareEvent(method: ShareMethod): void {
  try {
    const fm = typeof window !== 'undefined' ? window.firebaseModules : undefined;
    if (fm && typeof fm.logEvent === 'function') {
      fm.logEvent('share_result', { method });
    }
  } catch {
    /* Analytics is strictly best-effort; never let it break sharing. */
  }
}

/** Record that the player opened a specific platform's share intent. */
export function logPlatformShare(platform: SharePlatform): void {
  logShareEvent(platform);
}

/**
 * Copy the run's "message + link" to the clipboard (the explicit "Copy link"
 * action in the desktop menu). Resolves true on success; logs a best-effort
 * Analytics event. Never rejects.
 */
export async function copyShareMessage(data: ResultShareData): Promise<boolean> {
  const ok = await copyToClipboard(shareMessage(data));
  if (ok) logShareEvent('copied');
  return ok;
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

// ---------------------------------------------------------------------------
// Per-platform sharing (desktop). The native Web Share sheet is great on mobile
// — it lists installed social apps — but on desktop it only surfaces OS targets
// (AirDrop / Mail / Messages), never social sites. So on desktop we offer an
// explicit menu of web "share intent" links instead. See docs/CHANGELOG.md.
// ---------------------------------------------------------------------------

/** A social platform we can hand off to via a public web share-intent URL. */
export type SharePlatform = 'x' | 'facebook' | 'linkedin' | 'whatsapp' | 'reddit' | 'telegram';

/** Display metadata for the desktop share menu, in presentation order. */
export const SHARE_PLATFORMS: ReadonlyArray<{ key: SharePlatform; label: string; icon: string }> = [
  { key: 'x', label: 'X', icon: '𝕏' },
  { key: 'facebook', label: 'Facebook', icon: 'f' },
  { key: 'linkedin', label: 'LinkedIn', icon: 'in' },
  { key: 'whatsapp', label: 'WhatsApp', icon: '✆' },
  { key: 'reddit', label: 'Reddit', icon: 'r/' },
  { key: 'telegram', label: 'Telegram', icon: '✈' },
];

/**
 * Build a web share-intent URL per platform for the given run. Pure and
 * deterministic — every value is URL-encoded. Facebook and LinkedIn only accept
 * a URL (they ignore any prefilled text per their own policy), so those carry
 * just the link; the rest carry the brag text too.
 */
export function buildShareLinks(data: ResultShareData): Record<SharePlatform, string> {
  const text = encodeURIComponent(data.text);
  const url = encodeURIComponent(data.url);
  const textAndUrl = encodeURIComponent(`${data.text} ${data.url}`);
  return {
    x: `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    whatsapp: `https://wa.me/?text=${textAndUrl}`,
    reddit: `https://www.reddit.com/submit?url=${url}&title=${text}`,
    telegram: `https://t.me/share/url?url=${url}&text=${text}`,
  };
}

/**
 * Whether the native share sheet should be preferred over the explicit desktop
 * menu. True only on touch / mobile devices, where `navigator.share` surfaces
 * installed social apps (and `navigator.share({files})` can reach Instagram).
 * On desktop the OS sheet is a dead end for social, so we return false and the
 * caller shows the per-platform menu instead.
 */
export function prefersNativeShare(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.share !== 'function') return false;
  const coarsePointer = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
  const touch = typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 0;
  // iPadOS Safari reports a "Macintosh" UA, so the touch check above catches it.
  const mobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(nav.userAgent || '');
  return coarsePointer || touch || mobileUA;
}

/**
 * Share a rendered run image via the native file-share sheet (the only way to
 * reach Instagram / Stories, which has no web share-intent URL). Returns
 * 'unavailable' when file sharing isn't supported so the caller can fall back to
 * downloading the PNG. Never rejects.
 */
export async function shareImageFile(
  blob: Blob,
  data: ResultShareData,
  filename = 'snowglider-run.png'
): Promise<ShareOutcome> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.share !== 'function' || typeof File === 'undefined') return 'unavailable';
  let file: File;
  try {
    file = new File([blob], filename, { type: blob.type || 'image/png' });
  } catch {
    return 'unavailable';
  }
  // `canShare` gates files: if it exists and rejects them, native file share is
  // unsupported here — fall back rather than throwing a TypeError on share().
  if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) return 'unavailable';
  try {
    await nav.share({ files: [file], title: data.title, text: `${data.text} ${data.url}` });
    logShareEvent('image');
    return 'shared';
  } catch (err) {
    if (isUserCancel(err)) return 'cancelled';
    return 'unavailable';
  }
}
