// @ts-check
// A rejected renderer/bootstrap promise must show recovery UI, not a dead Start button.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  await new Promise(resolve => setTimeout(resolve, 0));
  const { resetFatalErrorOverlay } = await import('../src/ui/fatal-error-overlay.ts');
  window.__loadSnowGliderOrchestrator = () => Promise.reject(new Error('Error creating WebGL context.'));
  await import('../src/boot/script-loader.ts');
  window.SnowGliderScriptLoader.initializeGameScripts();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(document.querySelector('#fatalErrorMessage').textContent, /WebGL support/);
  assert.ok(document.querySelector('#fatalErrorReloadBtn'));
  assert.notEqual(window.SnowGliderGameScriptsReady, true);
  resetFatalErrorOverlay();
  env.window.close();
  console.log('Startup rejection displays recovery UI without announcing a ready game.');
})().catch(error => { console.error(error); process.exitCode = 1; });
