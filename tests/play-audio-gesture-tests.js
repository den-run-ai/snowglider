// @ts-check
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ html: '<div id="slope" tabindex="-1"><canvas></canvas></div><button id="account">Account</button>' });
  const { resumeAudioOnPlayGesture } = await import('../src/ui/play-audio-gesture.ts');
  const surface = document.getElementById('slope');
  const controller = new env.window.AbortController();
  let playing = false;
  let resumed = 0;
  resumeAudioOnPlayGesture(surface, { signal: controller.signal,
    isPlaying: () => playing, resume: () => { resumed++; } });
  surface.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
  assert.equal(resumed, 0, 'loading taps cannot consume the retry');
  playing = true;
  document.getElementById('account').dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(resumed, 0, 'account/menu input cannot consume the retry');
  const gesture = new env.window.Event('pointerup', { bubbles: true, cancelable: true });
  surface.querySelector('canvas').dispatchEvent(gesture);
  assert.equal(resumed, 1);
  assert.equal(gesture.defaultPrevented, false, 'audio retry must not capture gameplay');
  surface.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(resumed, 1, 'pointer/key compatibility input only retries once');
  const removed = new env.window.AbortController();
  resumeAudioOnPlayGesture(surface, { signal: removed.signal,
    isPlaying: () => true, resume: () => { resumed++; } });
  removed.abort();
  surface.dispatchEvent(new env.window.Event('pointerup', { bubbles: true }));
  assert.equal(resumed, 1, 'teardown removes the pending gesture retry');
  env.teardown();
  console.log('Audio retry: next gameplay gesture only, once, non-consuming and teardown-safe.');
})().catch(error => { console.error(error); process.exitCode = 1; });
