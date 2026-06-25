// @ts-check
// share-menu-tests.js
// Headless, c8-instrumented coverage for src/ui/share-menu.ts — the finish-screen
// share control. dom_smoke builds the menu and clicks the desktop primary + copy, but
// never clicks the per-platform links, the "Save image" button, or the mobile
// native-share path, so those handlers sit uncovered on Codecov. We build the control
// under jsdom and click every action, stubbing the share/clipboard/canvas/URL seams.
// Run via the register-ts-resolve loader so `../share.js`/`../share-card.js` resolve.

'use strict';

const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  condition ? pass++ : fail++;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://snowglider.ai/' });
const { window } = dom;
const g = /** @type {any} */ (globalThis);
g.window = window;
g.document = window.document;
g.File = window.File || g.File;

// Give jsdom canvases a working (fake) 2D context + toBlob so composeShareCard
// returns a blob (jsdom has no real canvas backend).
window.HTMLCanvasElement.prototype.getContext = /** @type {any} */ (function () {
  return {
    set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set textBaseline(_) {},
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect() {}, fillText() {}, drawImage() {},
  };
});
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(/** @type {any} */ ({ type: 'image/png', size: 1 })); };

// Replace navigator for a scenario. prefersNativeShare()/shareResult()/shareImageFile()
// read the global navigator; jsdom's is read-only, so swap the whole global.
function setNavigator(nav) {
  Object.defineProperty(global, 'navigator', { value: nav, configurable: true, writable: true });
}
// Window.open + URL.createObjectURL stubs (downloadBlob + openIntent).
const opened = [];
window.open = (url) => { opened.push(url); return null; };
global.URL.createObjectURL = () => 'blob:fake';
global.URL.revokeObjectURL = () => {};

async function main() {
  const { buildShareControls } = await import('../src/ui/share-menu.ts');

  function mount(opts) {
    document.body.innerHTML = '';
    const el = buildShareControls(opts);
    document.body.appendChild(el);
    return el;
  }

  // ---- Desktop: primary toggles the menu (no native share available). ----
  console.log('--- desktop menu toggle ---');
  setNavigator({});
  let root = mount({ time: 42.13, isBest: true });
  const primary = /** @type {HTMLButtonElement} */ (root.querySelector('#shareResultBtn'));
  const menu = /** @type {HTMLDivElement} */ (root.querySelector('#shareMenu'));
  check('menu starts hidden', menu.style.display === 'none');
  primary.click();
  check('primary opens the menu on desktop', menu.style.display === 'block');
  check('primary marks itself expanded', primary.getAttribute('aria-expanded') === 'true');
  primary.click();
  check('primary closes the menu again', menu.style.display === 'none');

  // ---- Per-platform links open the right share-intent URL. ----
  console.log('\n--- per-platform links ---');
  opened.length = 0;
  /** @type {HTMLElement} */ (root.querySelector('#share-x-btn')).click();
  /** @type {HTMLElement} */ (root.querySelector('#share-facebook-btn')).click();
  /** @type {HTMLElement} */ (root.querySelector('#share-telegram-btn')).click();
  check('X link opens a twitter intent', opened.some((u) => /twitter\.com\/intent\/tweet/.test(u)));
  check('Facebook link opens the sharer', opened.some((u) => /facebook\.com\/sharer/.test(u)));
  check('Telegram link opens t.me/share', opened.some((u) => /t\.me\/share\/url/.test(u)));
  check('every opened link is the public snowglider url', opened.every((u) => /snowglider\.ai/.test(decodeURIComponent(u))));

  // ---- Copy link ----
  console.log('\n--- copy link ---');
  let copied = null;
  setNavigator({ clipboard: { writeText: async (t) => { copied = t; } } });
  const copyBtn = /** @type {HTMLButtonElement} */ (root.querySelector('#shareCopyBtn'));
  copyBtn.click();
  await tick();
  check('copy writes the message to the clipboard', typeof copied === 'string' && /snowglider\.ai/.test(copied));
  check('copy button reflects the copied state', /copied/i.test(copyBtn.textContent));

  // ---- Save image, desktop: composes a card then downloads it. ----
  console.log('\n--- save image (desktop download) ---');
  setNavigator({}); // no navigator.share -> prefersNativeShare() false -> download
  root = mount({ time: 30, isBest: false, getCapture: () => null });
  const imageBtn = /** @type {HTMLButtonElement} */ (root.querySelector('#shareImageBtn'));
  imageBtn.click();
  await tick();
  check('desktop save-image downloads the card', /image saved/i.test(imageBtn.textContent));

  // ---- Save image, mobile: file-shares the card to the native sheet. ----
  console.log('\n--- save image (mobile file share) ---');
  /** @type {any} */
  let sharedFiles = null;
  setNavigator({
    share: async (d) => { sharedFiles = d.files; },
    canShare: () => true,
    maxTouchPoints: 5,
    userAgent: 'iPhone',
  });
  root = mount({ time: 30, isBest: false, getCapture: () => null });
  const imageBtn2 = /** @type {HTMLButtonElement} */ (root.querySelector('#shareImageBtn'));
  imageBtn2.click();
  await tick();
  check('mobile save-image file-shares the PNG', Array.isArray(sharedFiles) && sharedFiles.length === 1);
  check('mobile save-image reflects the shared state', /shared/i.test(imageBtn2.textContent));

  // ---- Save image, no canvas context -> "unavailable". ----
  console.log('\n--- save image (no card) ---');
  const realGetContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function () { return null; };
  setNavigator({});
  root = mount({ time: 30, isBest: false, getCapture: () => null });
  const imageBtn3 = /** @type {HTMLButtonElement} */ (root.querySelector('#shareImageBtn'));
  imageBtn3.click();
  await tick();
  check('save-image with no card -> unavailable', /unavailable/i.test(imageBtn3.textContent));
  window.HTMLCanvasElement.prototype.getContext = realGetContext;

  // ---- Mobile primary: file-shares the screenshot card to the native sheet. ----
  console.log('\n--- mobile primary native share (image) ---');
  /** @type {any} */
  let nativeShared = null;
  setNavigator({ share: async (d) => { nativeShared = d; }, maxTouchPoints: 5, userAgent: 'iPhone' });
  root = mount({ time: 42.13, isBest: true });
  /** @type {HTMLElement} */ (root.querySelector('#shareResultBtn')).click();
  await tick();
  check('mobile primary file-shares the screenshot card',
    !!nativeShared && Array.isArray(nativeShared.files) && nativeShared.files.length === 1);
  check('mobile primary share text carries the public url',
    !!nativeShared && /snowglider\.ai/.test(nativeShared.text));
  check('mobile primary reflects the shared state', /shared/i.test(root.querySelector('#shareResultBtn').textContent));

  // ---- Mobile primary fallback: no file-share support -> text+link share. ----
  console.log('\n--- mobile primary fallback (no file share) ---');
  /** @type {any} */
  let textShared = null;
  setNavigator({
    share: async (d) => {
      if (d.files) throw Object.assign(new Error('files unsupported'), { name: 'NotAllowedError' });
      textShared = d;
    },
    canShare: () => false, // gates files out -> shareImageFile() returns 'unavailable'
    maxTouchPoints: 5,
    userAgent: 'iPhone',
  });
  root = mount({ time: 12, isBest: false });
  /** @type {HTMLElement} */ (root.querySelector('#shareResultBtn')).click();
  await tick();
  check('mobile primary falls back to a text+link share when files are unsupported',
    !!textShared && /snowglider\.ai/.test(textShared.url));

  console.log(`\nSHARE-MENU TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Share-menu test harness crashed:', err);
  process.exit(1);
});
