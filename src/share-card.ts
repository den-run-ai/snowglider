// share-card.ts - Build a shareable run image: the final game frame with the
// result (time + branding) composited on top.
//
// This is the "screenshot + card overlay" half of the social-sharing feature
// (see docs/CHANGELOG.md). Instagram has no web share-intent URL, so the
// only way to post a run there is to hand the user an image — on mobile through
// the native file-share sheet, on desktop as a download they upload manually.
//
// Two steps, both defensive (they return null rather than throw, so a missing
// canvas / WebGL context can never break the share menu):
//   - captureGameFrame(ctx): renders one fresh frame and reads it back as a PNG
//     data URL. Needs `preserveDrawingBuffer: true` on the renderer (set in
//     game/scene-setup.ts) so the back buffer is still readable here.
//   - composeShareCard(opts): draws that frame as the background of a portrait
//     1080x1350 card (Instagram-friendly) and overlays the time/branding text.

import * as THREE from 'three';
import { formatRunSeconds } from './share.js';

/** Renderer/scene/camera needed to grab the current game frame. */
export interface CaptureContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
}

/** Inputs for {@link composeShareCard}. */
export interface ShareCardOptions {
  /** PNG data URL of the game frame, or null to fall back to a gradient. */
  frameDataUrl: string | null;
  time: number;
  isBest: boolean;
  /** Public URL printed on the card (host shown, scheme stripped). */
  url: string;
}

// Portrait 4:5 — the largest aspect Instagram shows in-feed without cropping.
const CARD_W = 1080;
const CARD_H = 1350;
const PNG = 'image/png';

/**
 * Render one fresh frame and read the canvas back as a PNG data URL. Returns
 * null if the renderer/canvas is missing or the read fails (e.g. a tainted or
 * lost context), so callers degrade to a textual card.
 */
export function captureGameFrame(ctx: CaptureContext | null): string | null {
  if (!ctx || !ctx.renderer || !ctx.scene || !ctx.camera) return null;
  const canvas = ctx.renderer.domElement as HTMLCanvasElement | undefined;
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  try {
    // Re-render now so the back buffer holds the current frame regardless of
    // whether the run loop is still drawing behind the result overlay.
    ctx.renderer.render(ctx.scene, ctx.camera);
    return canvas.toDataURL(PNG);
  } catch {
    return null;
  }
}

/** Load an <img> from a data URL, resolving null on any failure. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/** Draw `img` so it covers the whole target box, center-cropping the overflow. */
function drawCover(
  g: CanvasRenderingContext2D, img: HTMLImageElement,
  dw: number, dh: number
): void {
  const scale = Math.max(dw / img.width, dh / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  g.drawImage(img, (dw - w) / 2, (dh - h) / 2, w, h);
}

/**
 * Compose the share card. Draws the game frame (or a gradient fallback) as the
 * background, darkens the lower third for legibility, and overlays the time and
 * branding. Returns a PNG Blob, or null if Canvas 2D isn't available. Never
 * rejects.
 */
export async function composeShareCard(opts: ShareCardOptions): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return null;
  }
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const g = canvas.getContext('2d');
  if (!g) return null;

  // --- Background: captured frame (cover) or a sky-blue gradient fallback. ---
  const frame = opts.frameDataUrl ? await loadImage(opts.frameDataUrl) : null;
  if (frame && frame.width > 0 && frame.height > 0) {
    drawCover(g, frame, CARD_W, CARD_H);
  } else {
    const sky = g.createLinearGradient(0, 0, 0, CARD_H);
    sky.addColorStop(0, '#74b9ff');
    sky.addColorStop(1, '#0984e3');
    g.fillStyle = sky;
    g.fillRect(0, 0, CARD_W, CARD_H);
  }

  // --- Scrims so text stays legible over any frame. ---
  const top = g.createLinearGradient(0, 0, 0, 220);
  top.addColorStop(0, 'rgba(8,16,32,0.72)');
  top.addColorStop(1, 'rgba(8,16,32,0)');
  g.fillStyle = top;
  g.fillRect(0, 0, CARD_W, 220);

  const bottom = g.createLinearGradient(0, CARD_H * 0.5, 0, CARD_H);
  bottom.addColorStop(0, 'rgba(8,16,32,0)');
  bottom.addColorStop(1, 'rgba(8,16,32,0.9)');
  g.fillStyle = bottom;
  g.fillRect(0, CARD_H * 0.5, CARD_W, CARD_H * 0.5);

  // --- Text overlay. ---
  const cx = CARD_W / 2;
  const family = 'Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  // Top brand.
  g.fillStyle = '#ffffff';
  g.font = `bold 60px ${family}`;
  g.fillText('⛄ SnowGlider', cx, 110);

  // Headline (best vs finish) + big time.
  g.fillStyle = '#74b9ff';
  g.font = `bold 54px ${family}`;
  g.fillText(opts.isBest ? 'NEW PERSONAL BEST' : 'RUN COMPLETE', cx, CARD_H - 360);

  g.fillStyle = '#ffffff';
  g.font = `bold 200px ${family}`;
  g.fillText(`${formatRunSeconds(opts.time)}s`, cx, CARD_H - 200);

  g.font = `48px ${family}`;
  g.fillStyle = '#dfe6e9';
  g.fillText('Can you beat it?', cx, CARD_H - 130);

  // Footer URL (host only, scheme stripped).
  g.font = `bold 40px ${family}`;
  g.fillStyle = '#74b9ff';
  g.fillText(opts.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), cx, CARD_H - 70);

  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), PNG);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Convenience: capture the current frame and compose it into a share-card Blob.
 * `ctx` may be null (e.g. in tests / before the renderer exists), in which case
 * the card is drawn on the gradient fallback.
 */
export async function buildShareCardBlob(
  ctx: CaptureContext | null,
  time: number,
  isBest: boolean,
  url: string
): Promise<Blob | null> {
  const frameDataUrl = captureGameFrame(ctx);
  return composeShareCard({ frameDataUrl, time, isBest, url });
}

/**
 * Trigger a browser download of `blob`. Returns false when downloading isn't
 * possible (no DOM / object URLs), so callers can surface a different fallback.
 */
export function downloadBlob(blob: Blob, filename = 'snowglider-run.png'): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function') {
    return false;
  }
  try {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after the download has had a chance to start.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    return true;
  } catch {
    return false;
  }
}
