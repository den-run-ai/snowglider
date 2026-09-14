// @ts-check
// Optional auth must not block the real game boot while its network promise is
// pending. Then a late auth success still initializes the provider exactly once.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  await new Promise(resolve => setTimeout(resolve, 0));
  let finishAuth = () => {};
  let authInitialized = 0;
  let gameLoaded = 0;
  window.SnowGliderFirebase = /** @type {any} */ ({
    waitForAuthModule: () => new Promise(resolve => { finishAuth = () => resolve(undefined); }),
    initializeAuthModule: () => { authInitialized++; },
  });
  window.__loadSnowGliderOrchestrator = () => { gameLoaded++; return Promise.resolve({}); };
  await import('../src/boot/script-loader.ts');
  window.SnowGliderScriptLoader.initializeGameScripts();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gameLoaded, 1, 'game loads before optional auth settles');
  assert.equal(window.SnowGliderGameScriptsReady, true);
  assert.equal(authInitialized, 0);
  finishAuth();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(authInitialized, 1, 'late provider still initializes');
  env.teardown();
  console.log('Game is ready while auth is pending; late auth initializes once.');
})().catch(error => { console.error(error); process.exitCode = 1; });
