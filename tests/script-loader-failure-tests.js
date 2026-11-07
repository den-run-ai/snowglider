// @ts-check
// A rejected background renderer/bootstrap leaves onboarding visible; Start opens recovery.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  await new Promise(resolve => setTimeout(resolve, 0));
  const { resetFatalErrorOverlay } = await import('../src/ui/fatal-error-overlay.ts');
  window.__loadSnowGliderOrchestrator = () => Promise.reject(new Error('Error creating WebGL context.'));
  const { getStartupStatus, setStartupStatus, showStartupError } = await import('../src/boot/startup-status.ts');
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

  // Each case gets a new loader instance, as on a full-page reload. The shared
  // status module deliberately survives so the next boot must clear old errors.
  for (const outcome of ['before-prepare', 'abort', 'complete', 'other-error']) {
    const attempt = setupDom();
    await new Promise(resolve => setTimeout(resolve, 0));
    const contextError = new Error('The WebGL context was lost.');
    const preparationError = new Error('Scene preparation was interrupted.');
    let finishPreparation = () => {};
    const preparation = new Promise((resolve, reject) => {
      finishPreparation = () => outcome === 'complete' ? resolve(undefined) : reject(preparationError);
    });
    window.__loadSnowGliderOrchestrator = () => {
      if (outcome === 'before-prepare') {
        setStartupStatus('error', contextError, 'context-lost');
        return Promise.resolve({});
      }
      return Promise.resolve({ prepareGameForStart: () => preparation });
    };
    await import(`../src/boot/script-loader.ts?failure-case=${outcome}`);
    window.SnowGliderScriptLoader.initializeGameScripts();
    assert.equal(getStartupStatus().stage, 'loading', 'a new boot clears the preceding attempt’s failure');
    await new Promise(resolve => setTimeout(resolve, 0));
    if (outcome !== 'before-prepare') {
      assert.equal(getStartupStatus().stage, 'warming');
      setStartupStatus('error', contextError, outcome === 'other-error' ? undefined : 'context-lost');
      finishPreparation();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const status = getStartupStatus();
    assert.equal(status.stage, 'error');
    assert.notEqual(window.SnowGliderGameScriptsReady, true);
    assert.equal(document.querySelector('#fatalErrorOverlay'), null, 'background loss stays inline');
    if (outcome === 'other-error') {
      assert.equal(status.error, preparationError, 'unrelated status errors do not mask the actual preparation rejection');
      assert.equal(status.reason, undefined);
    } else {
      assert.equal(status.error, contextError, `${outcome}: retain the terminal graphics failure`);
      assert.equal(status.reason, 'context-lost', `${outcome}: preserve the recovery reason through loader catch`);
      showStartupError();
      assert.equal(document.querySelector('#fatalErrorTitle').textContent, 'Graphics interrupted');
    }
    resetFatalErrorOverlay();
    attempt.teardown();
  }
  console.log('Background failure stays inline; context loss keeps its recovery reason through every startup outcome.');
})().catch(error => { console.error(error); process.exitCode = 1; });
