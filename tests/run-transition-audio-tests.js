// @ts-check
// A rebuilt tier is a new document: the previous Restart activation cannot
// authorize audio here. Readiness must wait for this document's Start gesture.
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({
    url: 'https://snowglider.ai/?seed=123&play=expert',
    html: `<!doctype html><body>
      <div id="startGameContainer">
        <div id="startLoadingStatus"><span id="startLoadingText"></span></div>
        <button id="startSoundButton"></button><div id="difficultyPicker"></div>
        <button id="startGameButton">Start Game</button>
      </div><canvas id="gameCanvas" style="display:none"></canvas>
    </body>`,
  });
  const g = /** @type {any} */ (globalThis);
  g.HTMLButtonElement = env.window.HTMLButtonElement;
  g.HTMLMetaElement = env.window.HTMLMetaElement;
  let inGesture = false;
  const calls = [];
  g.Audio = class {
    constructor() { this.paused = true; }
    addEventListener() {}
    play() {
      calls.push('music');
      assert.equal(inGesture, true, 'media playback must start in the Start gesture');
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  };
  const { AudioModule } = await import('../src/audio.ts');
  const { Sfx } = await import('../src/sfx.ts');
  const { setStartupStatus } = await import('../src/boot/startup-status.ts');
  const originalUnlock = Sfx.unlock;
  Sfx.unlock = () => {
    calls.push('sfx');
    assert.equal(inGesture, true, 'SFX unlock must occur in the same Start gesture');
  };
  let active = false;
  let starts = 0;
  env.window.initializeGameWithAudio = () => {
    assert.equal(inGesture, true, 'a prepared transition starts synchronously');
    calls.push('run');
    active = true;
    starts++;
    return true;
  };
  try {
    await import('../src/ui/start-menu.ts');
    const menu = env.window.SnowGliderStartMenu;
    menu.initializeStartMenu();
    const button = /** @type {HTMLButtonElement} */ (document.getElementById('startGameButton'));
    const container = document.getElementById('startGameContainer');
    assert.equal(menu.getSelectedDifficulty(), 'expert');
    assert.equal(new URL(env.window.location.href).searchParams.has('play'), false);
    assert.equal(button.disabled, true, 'preparation disables Start');
    assert.equal(active, false);
    assert.deepEqual(calls, [], 'navigation must not attempt playback');
    setStartupStatus('ready');
    env.window.dispatchEvent(new env.window.Event('snowglider:game-scripts-ready'));
    assert.equal(active, false, 'readiness must not auto-start a silent run');
    assert.deepEqual(calls, [], 'readiness must not attempt playback without activation');
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Start run');
    assert.equal(container.classList.contains('run-preparing'), false);
    assert.match(document.getElementById('startLoadingText').textContent, /Ready to ride/);
    assert.notEqual(container.style.display, 'none');

    inGesture = true;
    button.click();
    inGesture = false;
    assert.deepEqual(calls, ['music', 'sfx', 'run'], 'audio starts before gameplay in one gesture');
    assert.equal(active, true);
    assert.equal(container.style.display, 'none');
    button.click();
    assert.equal(starts, 1, 'compatibility clicks cannot start twice');

    AudioModule.setMuted(true);
    container.style.display = 'flex';
    menu.initializeStartMenu();
    assert.equal(AudioModule.getStatus().muted, true, 'transition keeps the saved mute choice');
    calls.length = 0;
    inGesture = true;
    button.click();
    inGesture = false;
    assert.deepEqual(calls, ['sfx', 'run'], 'muted Start never plays music');
    assert.equal(Sfx.isMuted(), true, 'effects obey the same mute choice');
    console.log('Tier-transition audio: waits for Start, unlocks before gameplay, preserves mute.');
  } finally {
    Sfx.unlock = originalUnlock;
    AudioModule.teardown();
    env.teardown();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
