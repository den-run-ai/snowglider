// @ts-check
// A rejected background renderer/bootstrap leaves onboarding visible; Start opens recovery.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  await new Promise(resolve => setTimeout(resolve, 0));
  const { resetFatalErrorOverlay } = await import('../src/ui/fatal-error-overlay.ts');
  window.__loadSnowGliderOrchestrator = () => Promise.reject(new Error('Error creating WebGL context.'));
  const { getStartupStatus, showStartupError } = await import('../src/boot/startup-status.ts');
  await import('../src/boot/script-loader.ts');
  window.SnowGliderScriptLoader.initializeGameScripts();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(getStartupStatus().stage, 'error');
  assert.equal(document.querySelector('#fatalErrorOverlay'), null, 'background failure keeps the onboarding artwork visible');
  assert.equal(showStartupError(), true, 'Start can open actionable recovery');
  assert.match(document.querySelector('#fatalErrorMessage').textContent, /WebGL support/);
  assert.ok(document.querySelector('#fatalErrorReloadBtn'));
  assert.notEqual(window.SnowGliderGameScriptsReady, true);
  resetFatalErrorOverlay();
  env.window.close();
  console.log('Background startup failure stays inline; an explicit Start opens recovery.');
})().catch(error => { console.error(error); process.exitCode = 1; });
