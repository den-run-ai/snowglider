// ui/share-menu.ts - The finish result screen's share controls.
//
// Hybrid by design (see docs/CHANGELOG.md): the native Web Share sheet is
// the right thing on mobile/touch (it lists installed social apps and can reach
// Instagram via file share), but on desktop it only surfaces OS targets and is a
// dead end for social. So:
//   - prefersNativeShare() (touch/mobile) -> the primary button calls the native
//     sheet directly.
//   - otherwise (desktop) -> the primary button toggles an explicit menu of
//     per-platform web share-intent links, plus "Save image" (Instagram) and
//     "Copy link".
// The Instagram path is always image-based because Instagram has no web
// share-intent URL: on mobile we file-share the PNG (the sheet shows Instagram /
// Stories), on desktop we download it for the player to post manually.

import {
  buildResultShareData, shareResult, copyShareMessage, buildShareLinks,
  SHARE_PLATFORMS, prefersNativeShare, shareImageFile, logPlatformShare,
  type SharePlatform,
} from '../share.js';
import { buildShareCardBlob, downloadBlob, type CaptureContext } from '../share-card.js';

/** Options for {@link buildShareControls}. */
export interface ShareControlsOptions {
  time: number;
  isBest: boolean;
  /**
   * Supplies the renderer/scene/camera at click time so the share image can
   * capture the live frame. Called lazily (the renderer always exists by the
   * time the result screen is shown); may return null, in which case the card
   * falls back to a gradient background.
   */
  getCapture?: () => CaptureContext | null;
}

const PRIMARY_LABEL = '🔗 Share Result';

/** Stop in-overlay button taps from reaching controls.ts's document-level
 *  touchstart handler, which preventDefaults and would kill the synthesized
 *  click on mobile (see fix #173). */
function defuseTouch(el: HTMLElement): void {
  el.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
}

function styleButton(btn: HTMLElement, primary: boolean): void {
  Object.assign(btn.style, {
    display: 'block', width: '100%', padding: primary ? '10px 14px' : '9px 12px',
    fontSize: primary ? '15px' : '14px', fontWeight: '700', color: '#fff',
    cursor: 'pointer', border: 'none', borderRadius: '10px',
    fontFamily: 'Arial, sans-serif', touchAction: 'manipulation', userSelect: 'none',
    background: primary
      ? 'linear-gradient(90deg,#0984e3,#74b9ff)'
      : 'rgba(255,255,255,0.12)',
    marginTop: primary ? '14px' : '8px',
  });
  btn.style.setProperty('-webkit-tap-highlight-color', 'rgba(255,255,255,0.4)');
}

/** Briefly swap a button's label to give feedback, then restore it. */
function flash(btn: HTMLElement, label: string, restore: string, ms = 1800): void {
  btn.textContent = label;
  setTimeout(() => { btn.textContent = restore; }, ms);
}

/** Open a platform share-intent URL in a new tab (a real user-gesture click,
 *  so it isn't popup-blocked). */
function openIntent(url: string, platform: SharePlatform): void {
  logPlatformShare(platform);
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function makeSocialRow(data: ReturnType<typeof buildResultShareData>): HTMLDivElement {
  const links = buildShareLinks(data);
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '10px',
  });
  for (const { key, label, icon } of SHARE_PLATFORMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `share-${key}-btn`;
    btn.setAttribute('data-platform', key);
    btn.title = `Share on ${label}`;
    btn.setAttribute('aria-label', `Share on ${label}`);
    btn.textContent = `${icon} ${label}`;
    Object.assign(btn.style, {
      padding: '8px 6px', fontSize: '13px', fontWeight: '700', color: '#fff',
      cursor: 'pointer', border: 'none', borderRadius: '8px',
      background: 'rgba(255,255,255,0.14)', fontFamily: 'Arial, sans-serif',
      touchAction: 'manipulation', userSelect: 'none', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    });
    btn.style.setProperty('-webkit-tap-highlight-color', 'rgba(255,255,255,0.4)');
    defuseTouch(btn);
    btn.addEventListener('click', () => openIntent(links[key], key));
    row.appendChild(btn);
  }
  return row;
}

/**
 * Build the share controls for the finish result panel: a primary "Share
 * Result" button and (on desktop) a menu of per-platform links + image + copy.
 * Returns a container the caller appends to the result panel.
 */
export function buildShareControls(opts: ShareControlsOptions): HTMLDivElement {
  const container = document.createElement('div');
  const data = buildResultShareData(opts.time, opts.isBest);

  // --- Primary button (always present; id kept for tests/touch wiring). ---
  const primary = document.createElement('button');
  primary.id = 'shareResultBtn';
  primary.type = 'button';
  primary.textContent = PRIMARY_LABEL;
  styleButton(primary, true);
  defuseTouch(primary);

  // --- Desktop menu (hidden until toggled). ---
  const menu = document.createElement('div');
  menu.id = 'shareMenu';
  menu.style.display = 'none';
  menu.appendChild(makeSocialRow(data));

  const imageBtn = document.createElement('button');
  imageBtn.id = 'shareImageBtn';
  imageBtn.type = 'button';
  const imageLabel = '📸 Save image (Instagram)';
  imageBtn.textContent = imageLabel;
  styleButton(imageBtn, false);
  defuseTouch(imageBtn);

  const copyBtn = document.createElement('button');
  copyBtn.id = 'shareCopyBtn';
  copyBtn.type = 'button';
  const copyLabel = '🔗 Copy link';
  copyBtn.textContent = copyLabel;
  styleButton(copyBtn, false);
  defuseTouch(copyBtn);

  // Copy link lives in the (desktop) toggle menu next to the per-platform links.
  menu.appendChild(copyBtn);

  // --- Behaviour ---
  let imageBusy = false;
  async function handleImage(): Promise<void> {
    if (imageBusy) return;
    imageBusy = true;
    imageBtn.textContent = '⏳ Building image…';
    try {
      const ctx = opts.getCapture ? opts.getCapture() : null;
      const blob = await buildShareCardBlob(ctx, opts.time, opts.isBest, data.url);
      if (!blob) { flash(imageBtn, '⚠️ Image unavailable', imageLabel); return; }
      // Mobile: hand the PNG to the native sheet (reaches Instagram / Stories).
      const outcome = prefersNativeShare() ? await shareImageFile(blob, data) : 'unavailable';
      if (outcome === 'shared') { flash(imageBtn, '✅ Shared!', imageLabel); return; }
      if (outcome === 'cancelled') { imageBtn.textContent = imageLabel; return; }
      // Desktop (or no file share): download it to post manually.
      flash(imageBtn, downloadBlob(blob) ? '✅ Image saved' : '⚠️ Image unavailable', imageLabel);
    } finally {
      imageBusy = false;
    }
  }
  imageBtn.addEventListener('click', () => { void handleImage(); });

  copyBtn.addEventListener('click', () => {
    void copyShareMessage(data).then((ok) => {
      flash(copyBtn, ok ? '✅ Copied!' : '⚠️ Copy failed', copyLabel);
    });
  });

  let nativeBusy = false;
  primary.addEventListener('click', () => {
    if (prefersNativeShare()) {
      // Mobile/touch: the OS sheet already lists social apps.
      if (nativeBusy) return;
      nativeBusy = true;
      void shareResult(data).then((outcome) => {
        if (outcome === 'shared') flash(primary, '✅ Shared!', PRIMARY_LABEL);
        else if (outcome === 'copied') flash(primary, '✅ Link copied!', PRIMARY_LABEL);
        else if (outcome === 'unavailable') flash(primary, '⚠️ Sharing unavailable', PRIMARY_LABEL);
      }).finally(() => { nativeBusy = false; });
      return;
    }
    // Desktop: reveal/hide the explicit per-platform menu.
    const open = menu.style.display !== 'none';
    menu.style.display = open ? 'none' : 'block';
    primary.setAttribute('aria-expanded', String(!open));
  });

  container.appendChild(primary);
  // The image/Instagram action stays visible on every device: it's the only way
  // to reach the screenshot card (mobile -> native file share to Instagram /
  // Stories; desktop -> PNG download), independent of the desktop link menu.
  container.appendChild(imageBtn);
  container.appendChild(menu);
  return container;
}
