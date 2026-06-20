// share-card-tests.js
// Headless, c8-instrumented coverage for src/share-card.ts — frame capture +
// Instagram share-card compositing + download.
//
// The browser suites render the game but never click "Save image", so the capture /
// Canvas2D / download paths sit uncovered on Codecov. jsdom has no 2D canvas context
// (the native `canvas` pkg isn't installed), so we install small global stubs for
// document / Image / URL and a fake CanvasRenderingContext2D, then drive every branch
// and assert the control flow + the canvas calls it makes. Run via the
// register-ts-resolve loader so the module's `./share.js` import resolves to `.ts`.

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  condition ? pass++ : fail++;
}
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function clearGlobal(name) {
  if (Object.prototype.hasOwnProperty.call(globalThis, name)) delete globalThis[name];
}

// A fake 2D context that records what the card drew.
function makeCtx2d(calls) {
  return {
    set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set textBaseline(_) {},
    createLinearGradient() { calls.gradients++; return { addColorStop() {} }; },
    fillRect() { calls.fillRect++; },
    fillText(t) { calls.texts.push(t); },
    drawImage() { calls.drawImage++; },
  };
}

// Install document/Image/URL stubs. opts toggles the failure branches.
function installDom(opts = {}) {
  const calls = { gradients: 0, fillRect: 0, drawImage: 0, texts: [], clicked: 0, revoked: 0, removed: 0 };
  const anchor = { click() { calls.clicked++; } };
  const canvas = {
    width: 0, height: 0,
    getContext: () => (opts.noCtx ? null : makeCtx2d(calls)),
    toBlob: (cb) => {
      if (opts.toBlobThrows) throw new Error('toBlob boom');
      cb(opts.nullBlob ? null : { type: 'image/png', size: 1 });
    },
  };
  setGlobal('document', {
    createElement: (tag) => (tag === 'canvas' ? canvas : tag === 'a' ? anchor : {}),
    body: { appendChild() {}, removeChild() { calls.removed++; } },
  });
  // Image: onload fires asynchronously with a non-zero size (or onerror).
  setGlobal('Image', class {
    set src(_v) {
      setTimeout(() => {
        if (opts.imgError) { if (this.onerror) this.onerror(); }
        else { this.width = opts.imgW ?? 1200; this.height = opts.imgH ?? 800; if (this.onload) this.onload(); }
      }, 0);
    }
  });
  setGlobal('URL', opts.noObjectUrl ? {} : {
    createObjectURL: () => 'blob:fake', revokeObjectURL: () => { calls.revoked++; },
  });
  return { calls, anchor, canvas };
}

async function main() {
  const {
    captureGameFrame, composeShareCard, buildShareCardBlob, downloadBlob
  } = await import('../src/share-card.ts');

  // ---- captureGameFrame ----
  console.log('--- captureGameFrame ---');
  check('null ctx -> null', captureGameFrame(null) === null);
  check('missing renderer fields -> null', captureGameFrame({ renderer: {}, scene: {}, camera: {} }) === null);
  let rendered = 0;
  const okCtx = {
    renderer: { render() { rendered++; }, domElement: { toDataURL: () => 'data:image/png;base64,AAAA' } },
    scene: {}, camera: {},
  };
  check('happy path renders a fresh frame + returns the PNG data URL',
    captureGameFrame(okCtx) === 'data:image/png;base64,AAAA' && rendered === 1);
  const throwCtx = {
    renderer: { render() {}, domElement: { toDataURL: () => { throw new Error('context lost'); } } },
    scene: {}, camera: {},
  };
  check('toDataURL throwing -> null (never throws)', captureGameFrame(throwCtx) === null);

  // ---- composeShareCard ----
  console.log('\n--- composeShareCard ---');
  clearGlobal('document');
  check('no document -> null', (await composeShareCard({ frameDataUrl: null, time: 1, isBest: false, url: 'https://x/' })) === null);

  installDom({ noCtx: true });
  check('no 2d context -> null', (await composeShareCard({ frameDataUrl: null, time: 1, isBest: false, url: 'https://x/' })) === null);

  let dom = installDom();
  const best = await composeShareCard({ frameDataUrl: null, time: 42.13, isBest: true, url: 'https://snowglider.ai/' });
  check('no-frame (gradient) card -> blob', !!best);
  check('gradient fallback is drawn (no captured image)', dom.calls.drawImage === 0 && dom.calls.gradients >= 1);
  check('best card shows the NEW PERSONAL BEST headline', dom.calls.texts.some((t) => /NEW PERSONAL BEST/.test(t)));
  check('card shows the formatted time + brand + host',
    dom.calls.texts.includes('42.13s') &&
    dom.calls.texts.some((t) => /SnowGlider/.test(t)) &&
    dom.calls.texts.includes('snowglider.ai'));

  dom = installDom();
  const fromFrame = await composeShareCard({ frameDataUrl: 'data:image/png;base64,AAAA', time: 10, isBest: false, url: 'https://snowglider.ai/' });
  check('captured-frame card -> blob', !!fromFrame);
  check('captured frame is drawn as the cover background', dom.calls.drawImage === 1);
  check('non-best card shows the RUN COMPLETE headline', dom.calls.texts.some((t) => /RUN COMPLETE/.test(t)));
  check('time guard renders 10.00s', dom.calls.texts.includes('10.00s'));

  // A frame that fails to load falls back to the gradient.
  dom = installDom({ imgError: true });
  const frameFailed = await composeShareCard({ frameDataUrl: 'data:bad', time: 5, isBest: false, url: 'https://snowglider.ai/' });
  check('un-loadable frame falls back to gradient -> still a blob', !!frameFailed && dom.calls.drawImage === 0);

  installDom({ nullBlob: true });
  check('toBlob yielding null -> null', (await composeShareCard({ frameDataUrl: null, time: 1, isBest: false, url: 'https://x/' })) === null);

  installDom({ toBlobThrows: true });
  check('toBlob throwing -> null (never throws)', (await composeShareCard({ frameDataUrl: null, time: 1, isBest: false, url: 'https://x/' })) === null);

  // ---- buildShareCardBlob ----
  console.log('\n--- buildShareCardBlob ---');
  installDom();
  check('null ctx -> composes a gradient card blob', !!(await buildShareCardBlob(null, 5, false, 'https://snowglider.ai/')));
  check('live ctx -> captures the frame then composes', !!(await buildShareCardBlob(okCtx, 5, true, 'https://snowglider.ai/')));

  // ---- downloadBlob ----
  console.log('\n--- downloadBlob ---');
  dom = installDom();
  check('downloadBlob -> true and clicks an anchor', downloadBlob({ type: 'image/png' }, 'run.png') === true && dom.calls.clicked === 1);
  check('downloadBlob removes the temp anchor', dom.calls.removed === 1);
  installDom({ noObjectUrl: true });
  check('no URL.createObjectURL -> false', downloadBlob({ type: 'image/png' }) === false);
  clearGlobal('document');
  check('no document -> false', downloadBlob({ type: 'image/png' }) === false);

  clearGlobal('document'); clearGlobal('Image'); clearGlobal('URL');
  console.log(`\nSHARE-CARD TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Share-card test harness crashed:', err);
  process.exit(1);
});
