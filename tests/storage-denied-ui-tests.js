// @ts-check
// Disabled storage used to abort scene setup at AudioModule.init and, after that
// was fixed, at the initial best-time read. Exercise the real boot consumers plus
// mute and finish/replay affordances with the storage object itself unavailable.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ html: '<div id="gameOverOverlay" style="display:none"><p id="gameOverDetail"></p><p id="bestTimeDisplay"></p><button id="restartButton">Play again</button></div>' });
  const denyStorage = () => { throw new env.window.DOMException('Storage blocked', 'SecurityError'); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denyStorage });
  Object.defineProperty(env.window, 'localStorage', { configurable: true, get: denyStorage });
  window.isTestMode = true;
  const { AudioModule } = await import('../src/audio.ts');
  const { readStoredBestTime, createShowGameOver } = await import('../src/ui/result-overlay.ts');
  assert.equal(AudioModule.init().initialized, true, 'audio preferences cannot abort scene setup');
  assert.equal(readStoredBestTime(), Infinity, 'best-time lookup cannot abort orchestrator boot');
  AudioModule.setupUI();
  assert.equal(AudioModule.toggleMute(), true, 'mute remains usable without preference persistence');
  assert.equal(document.getElementById('audioControlBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(AudioModule.toggleMute(), false);

  const state = { gameActive: true, bestTime: Infinity, startTime: performance.now(), simElapsed: 40 };
  const overlay = document.getElementById('gameOverOverlay');
  const best = document.getElementById('bestTimeDisplay');
  createShowGameOver({
    state, gameOverOverlay: overlay, gameOverDetail: document.getElementById('gameOverDetail'),
    restartButton: document.getElementById('restartButton'), bestTimeDisplay: best,
    getDifficulty: () => 'bunny',
  })('You reached the end of the slope!');
  assert.equal(state.gameActive, false);
  assert.equal(state.bestTime, 40, 'a session best still updates in memory');
  assert.equal(overlay.style.display, 'flex', 'denied score persistence cannot block the result');
  assert.match(best.textContent, /New Best Time: 40.00s/);
  assert.equal(document.getElementById('restartButton').isConnected, true);

  // The real classic local-auth fallback also has synchronous storage access.
  // Its failure must not stop a ranked finish from reaching the replay controls.
  require('../src/boot/local-auth.js');
  window.SnowGliderLocalAuth.installScoresModule();
  window.SnowGliderLocalAuth.installAuthModule();
  state.gameActive = true;
  state.bestTime = Infinity;
  createShowGameOver({
    state, gameOverOverlay: overlay, gameOverDetail: document.getElementById('gameOverDetail'),
    restartButton: document.getElementById('restartButton'), bestTimeDisplay: best,
    getDifficulty: () => 'blue',
  })('You reached the end of the slope!');
  assert.equal(state.gameActive, false);
  assert.equal(state.bestTime, 40);
  assert.match(best.textContent, /New Best Time: 40.00s/);
  assert.equal(document.getElementById('restartButton').isConnected, true);
  AudioModule.teardown();
  env.teardown();
  console.log('Storage denial: audio init, best-time read, mute, finish and replay controls remain usable.');
})().catch(error => { console.error(error); process.exitCode = 1; });
