// share-tests.js
// Focused, headless coverage for src/share.ts — the social-sharing helper behind
// the finish result screen's "Share Result" button (see CHANGELOG #157).
//
// share.ts imports nothing (no three.js / Firebase / DOM module), so we import the
// REAL `.ts` directly — Node 23 type-strips it and c8 instruments it with correct
// source-mapped lines. The Web Share / clipboard / Analytics seams are reached via
// the `navigator` and `window` globals, so each case installs a small stub and
// restores it afterwards. Run via the `test:share` npm script (`node tests/share-tests.js`).

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  if (condition) pass++; else fail++;
}

// Override a configurable global (Node 23 exposes a getter-only `navigator`).
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function clearGlobal(name) {
  if (Object.prototype.hasOwnProperty.call(globalThis, name)) delete globalThis[name];
}

async function main() {
  const {
    buildResultShareData, cleanShareUrl, shareMessage, shareResult,
    buildShareLinks, prefersNativeShare, shareImageFile, copyShareMessage,
    formatRunSeconds, SHARE_PLATFORMS
  } = await import('../src/share.ts');

  // ---- buildResultShareData: deterministic copy ----
  console.log('--- buildResultShareData ---');
  const normal = buildResultShareData(42.13, false, 'https://snowglider.ai/');
  check('normal finish copy matches the plan', normal.text === 'I finished SnowGlider in 42.13s. Can you beat my run?');
  check('normal finish carries the cleaned url', normal.url === 'https://snowglider.ai/');
  check('share title is SnowGlider', normal.title === 'SnowGlider');

  const best = buildResultShareData(42.13, true, 'https://snowglider.ai/');
  check('new personal best copy matches the plan', best.text === 'New SnowGlider personal best: 42.13s. Can you beat it?');

  check('time is rounded to 2 decimals (42.129 -> 42.13)', buildResultShareData(42.129, false, 'https://snowglider.ai/').text.includes('42.13s'));
  check('NaN/garbage time collapses to 0.00s', buildResultShareData(NaN, false, 'https://snowglider.ai/').text.includes('0.00s'));
  check('negative time collapses to 0.00s', buildResultShareData(-5, false, 'https://snowglider.ai/').text.includes('0.00s'));

  // ---- cleanShareUrl: stable public links ----
  console.log('\n--- cleanShareUrl ---');
  check('strips the local-only ?test= param', cleanShareUrl('https://snowglider.ai/?test=unified') === 'https://snowglider.ai/');
  check('strips ?test= but keeps other params', cleanShareUrl('https://snowglider.ai/?test=unified&ref=tw') === 'https://snowglider.ai/?ref=tw');
  check('strips the hash fragment', cleanShareUrl('https://snowglider.ai/#section') === 'https://snowglider.ai/');
  check('keeps a clean public url unchanged', cleanShareUrl('https://snowglider.ai/') === 'https://snowglider.ai/');
  check('keeps another public origin (e.g. GitHub Pages)', cleanShareUrl('https://den-run-ai.github.io/snowglider/') === 'https://den-run-ai.github.io/snowglider/');
  check('localhost falls back to the public url', cleanShareUrl('http://localhost:8080/?test=true') === 'https://snowglider.ai/');
  check('127.0.0.1 falls back to the public url', cleanShareUrl('http://127.0.0.1:8080/') === 'https://snowglider.ai/');
  check('file:// falls back to the public url', cleanShareUrl('file:///Users/x/snowglider/index.html') === 'https://snowglider.ai/');
  check('empty/missing href falls back to the public url', cleanShareUrl('') === 'https://snowglider.ai/' && cleanShareUrl(null) === 'https://snowglider.ai/');
  check('unparseable href falls back to the public url', cleanShareUrl('not a url') === 'https://snowglider.ai/');

  // buildResultShareData should default its url from window.location when href omitted.
  setGlobal('window', { location: { href: 'http://localhost:8080/?test=true' } });
  check('default url reads window.location and cleans it', buildResultShareData(10, false).url === 'https://snowglider.ai/');
  clearGlobal('window');

  // ---- shareMessage ----
  console.log('\n--- shareMessage ---');
  check('clipboard message joins text + url with a newline',
    shareMessage(normal) === 'I finished SnowGlider in 42.13s. Can you beat my run?\nhttps://snowglider.ai/');

  // ---- shareResult: native share, cancel, and clipboard fallback ----
  console.log('\n--- shareResult ---');
  const data = buildResultShareData(42.13, false, 'https://snowglider.ai/');

  // (a) Native Web Share API present and succeeds.
  let shared = null;
  setGlobal('navigator', { share: async (d) => { shared = d; } });
  check('uses navigator.share when available -> "shared"', (await shareResult(data)) === 'shared');
  check('native share receives title/text/url', !!shared && shared.text === data.text && shared.url === data.url);

  // (b) User dismisses the native sheet (AbortError) -> "cancelled", no clipboard write.
  let clipboardCalls = 0;
  setGlobal('navigator', {
    share: async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; },
    clipboard: { writeText: async () => { clipboardCalls++; } }
  });
  check('AbortError from native share -> "cancelled"', (await shareResult(data)) === 'cancelled');
  check('cancelled share does NOT touch the clipboard', clipboardCalls === 0);

  // (c) Non-cancel share failure falls back to the clipboard -> "copied".
  let copied = null;
  setGlobal('navigator', {
    share: async () => { const e = new Error('nope'); e.name = 'NotAllowedError'; throw e; },
    clipboard: { writeText: async (t) => { copied = t; } }
  });
  check('non-cancel share failure falls back to clipboard -> "copied"', (await shareResult(data)) === 'copied');
  check('clipboard fallback writes the joined message', copied === shareMessage(data));

  // (d) No native share, clipboard available -> "copied".
  copied = null;
  setGlobal('navigator', { clipboard: { writeText: async (t) => { copied = t; } } });
  check('no native share but clipboard present -> "copied"', (await shareResult(data)) === 'copied');
  check('clipboard receives the joined message', copied === shareMessage(data));

  // (e) Neither share nor clipboard -> "unavailable".
  setGlobal('navigator', {});
  check('no share and no clipboard -> "unavailable"', (await shareResult(data)) === 'unavailable');

  // (f) Clipboard write rejects -> "unavailable" (and never throws).
  setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
  check('clipboard rejection -> "unavailable"', (await shareResult(data)) === 'unavailable');

  // ---- Analytics seam: best-effort logEvent, never required ----
  console.log('\n--- analytics seam ---');
  const events = [];
  setGlobal('window', { firebaseModules: { logEvent: (name, params) => events.push({ name, params }) } });
  setGlobal('navigator', { share: async () => {} });
  await shareResult(data);
  check('logs a share_result event with method on success',
    events.length === 1 && events[0].name === 'share_result' && events[0].params.method === 'shared');

  // A throwing analytics seam must not break sharing.
  events.length = 0;
  setGlobal('window', { firebaseModules: { logEvent: () => { throw new Error('analytics down'); } } });
  setGlobal('navigator', { clipboard: { writeText: async () => {} } });
  check('analytics failure does not break sharing', (await shareResult(data)) === 'copied');
  clearGlobal('window');

  // ---- formatRunSeconds: shared 2-decimal clock (also used by the share card) ----
  console.log('\n--- formatRunSeconds ---');
  check('formats to 2 decimals', formatRunSeconds(42.129) === '42.13');
  check('guards NaN -> 0.00', formatRunSeconds(NaN) === '0.00');
  check('guards negative -> 0.00', formatRunSeconds(-3) === '0.00');

  // ---- buildShareLinks: per-platform web share-intent URLs ----
  console.log('\n--- buildShareLinks ---');
  // Pass a dirty href so the cleaned (?test stripped) url flows through the links.
  const linkData = buildResultShareData(42.13, true, 'https://snowglider.ai/?test=unified&ref=tw');
  const links = buildShareLinks(linkData);
  const encUrl = encodeURIComponent('https://snowglider.ai/?ref=tw');
  const encText = encodeURIComponent('New SnowGlider personal best: 42.13s. Can you beat it?');
  const encTextUrl = encodeURIComponent('New SnowGlider personal best: 42.13s. Can you beat it? https://snowglider.ai/?ref=tw');
  check('all six platforms present', Object.keys(links).length === 6 && SHARE_PLATFORMS.length === 6);
  check('x/twitter intent carries cleaned url + text', links.x === `https://twitter.com/intent/tweet?text=${encText}&url=${encUrl}`);
  check('facebook sharer carries only the url', links.facebook === `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`);
  check('linkedin carries only the url', links.linkedin === `https://www.linkedin.com/sharing/share-offsite/?url=${encUrl}`);
  check('whatsapp carries text + url combined', links.whatsapp === `https://wa.me/?text=${encTextUrl}`);
  check('reddit carries url + title', links.reddit === `https://www.reddit.com/submit?url=${encUrl}&title=${encText}`);
  check('telegram carries url + text', links.telegram === `https://t.me/share/url?url=${encUrl}&text=${encText}`);
  check('every intent is a valid https URL', Object.values(links).every((u) => {
    try { return new URL(u).protocol === 'https:'; } catch { return false; }
  }));

  // ---- prefersNativeShare: native sheet only on touch/mobile ----
  console.log('\n--- prefersNativeShare ---');
  setGlobal('window', {});
  setGlobal('navigator', {});
  check('no navigator.share -> desktop menu (false)', prefersNativeShare() === false);
  setGlobal('navigator', { share: async () => {}, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 0 });
  check('desktop Safari (share, no touch) -> menu (false)', prefersNativeShare() === false);
  setGlobal('navigator', { share: async () => {}, userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 });
  check('touch device (maxTouchPoints>0) -> native (true)', prefersNativeShare() === true);
  setGlobal('navigator', { share: async () => {}, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', maxTouchPoints: 0 });
  check('mobile UA -> native (true)', prefersNativeShare() === true);
  setGlobal('navigator', { share: async () => {}, userAgent: 'X', maxTouchPoints: 0 });
  setGlobal('window', { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) });
  check('coarse pointer (matchMedia) -> native (true)', prefersNativeShare() === true);
  clearGlobal('window');

  // ---- copyShareMessage: explicit "Copy link" action ----
  console.log('\n--- copyShareMessage ---');
  let cm = null;
  setGlobal('navigator', { clipboard: { writeText: async (t) => { cm = t; } } });
  check('copyShareMessage writes the joined message + returns true',
    (await copyShareMessage(data)) === true && cm === shareMessage(data));
  setGlobal('navigator', {});
  check('copyShareMessage with no clipboard returns false', (await copyShareMessage(data)) === false);

  // ---- shareImageFile: native file share (the only path to Instagram) ----
  console.log('\n--- shareImageFile ---');
  const blob = new Blob(['fake-png'], { type: 'image/png' });
  setGlobal('navigator', {});
  check('no navigator.share -> image share unavailable', (await shareImageFile(blob, data)) === 'unavailable');
  setGlobal('navigator', { share: async () => {}, canShare: () => false });
  check('canShare rejects files -> unavailable', (await shareImageFile(blob, data)) === 'unavailable');
  let sharedFiles = null;
  setGlobal('navigator', { share: async (d) => { sharedFiles = d.files; }, canShare: () => true });
  check('native file share succeeds -> shared', (await shareImageFile(blob, data)) === 'shared');
  check('native file share receives a single File payload',
    Array.isArray(sharedFiles) && sharedFiles.length === 1 && sharedFiles[0] instanceof File);
  setGlobal('navigator', {
    share: async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; },
    canShare: () => true
  });
  check('user cancels file share -> cancelled', (await shareImageFile(blob, data)) === 'cancelled');

  clearGlobal('navigator');
  clearGlobal('window');

  console.log(`\nSHARE TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Share test harness crashed:', err);
  process.exit(1);
});
