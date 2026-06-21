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

/** Display metadata for one platform in the desktop share menu. `iconPath` is the
 *  official brand logo as a single SVG path on a 24×24 viewBox (Simple Icons,
 *  CC0); `color` is the brand color used to tint it. */
export interface SharePlatformMeta {
  key: SharePlatform;
  label: string;
  iconPath: string;
  color: string;
}

/** Display metadata for the desktop share menu, in presentation order. Real
 *  brand logos (not text glyphs) so the buttons are instantly recognizable. */
export const SHARE_PLATFORMS: ReadonlyArray<SharePlatformMeta> = [
  {
    key: 'x', label: 'X', color: '#ffffff',
    iconPath: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  },
  {
    key: 'facebook', label: 'Facebook', color: '#1877F2',
    iconPath: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  },
  {
    key: 'linkedin', label: 'LinkedIn', color: '#0A66C2',
    iconPath: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  },
  {
    key: 'whatsapp', label: 'WhatsApp', color: '#25D366',
    iconPath: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
  },
  {
    key: 'reddit', label: 'Reddit', color: '#FF4500',
    iconPath: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z',
  },
  {
    key: 'telegram', label: 'Telegram', color: '#26A5E4',
    iconPath: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  },
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
