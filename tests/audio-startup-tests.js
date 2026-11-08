// @ts-check
// Startup audio must respect saved preferences even before the scene bundle is
// ready. A silent welcome screen must not create or fetch the music element.
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom();
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  /** @type {FakeAudio[]} */
  const instances = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.loop = false;
      this.volume = 1;
      this.paused = true;
      this.playCalls = 0;
      this.pauseCalls = 0;
      instances.push(this);
    }
    addEventListener() {}
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.pauseCalls++;
      this.paused = true;
    }
  }
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    writable: true,
    value: FakeAudio
  });

  const { AudioModule } = await import('../src/audio.ts');
  const { Sfx } = await import('../src/sfx.ts');
  try {
    env.localStorage.setItem('snowgliderMuted', 'true');
    AudioModule.init();
    AudioModule.setupUI();
    await AudioModule.preloadAudio('bad_cat');
    assert.equal(AudioModule.getStatus().muted, true, 'initialization reads the saved preference');
    assert.equal(Sfx.isMuted(), true, 'music and SFX share the initialized preference');
    assert.equal(instances.length, 0, 'initialization, UI, and legacy preload never construct media');

    // Storage can remain readable while writes fail (for example, a full quota).
    // The current welcome-screen choice must win over that stale persisted value
    // when SFX hydrates its preferences during the first Play gesture.
    const saveItem = env.localStorage.setItem;
    try {
      env.localStorage.setItem = () => { throw new Error('Storage quota exceeded'); };
      assert.equal(AudioModule.setMuted(false), false);
      assert.equal(env.localStorage.getItem('snowgliderMuted'), 'true', 'failed write leaves the previous preference');
      Sfx.unlock();
      assert.equal(Sfx.isMuted(), false, 'first SFX unlock retains explicit unmute after a failed write');
      assert.equal(AudioModule.getStatus().muted, false, 'music and SFX keep the same live choice');
      assert.equal(Sfx.getStatus().active, false, 'preference hydration needs no Web Audio context');
    } finally {
      env.localStorage.setItem = saveItem;
    }

    assert.equal(AudioModule.setMuted(false), false);
    assert.equal(env.localStorage.getItem('snowgliderMuted'), 'false');
    assert.equal(Sfx.isMuted(), false);
    assert.equal(document.getElementById('audioControlBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(instances.length, 0, 'enabling sound on the welcome screen stays silent');
    AudioModule.toggleMute();
    AudioModule.toggleMute();
    assert.equal(instances.length, 0, 'a sound toggle before Play does not request music');

    AudioModule.teardown();
    env.localStorage.setItem('snowgliderMuted', 'true');
    assert.equal(AudioModule.getStatus().initialized, false);
    assert.equal(AudioModule.startAudio(), false, 'an early Play obeys mute before scene initialization');
    assert.equal(AudioModule.getStatus().initialized, true);
    assert.equal(AudioModule.getStatus().muted, true);
    assert.equal(instances.length, 0, 'starting muted neither creates nor fetches the track');

    AudioModule.setupUI();
    assert.equal(AudioModule.toggleMute(), false);
    assert.equal(instances.length, 1, 'in-game unmute can create a track absent from a muted start');
    const track = instances[0];
    assert.equal(track.src, 'assets/skullbeatz_bad_cat.mp3');
    assert.equal(track.loop, true);
    assert.equal(track.playCalls, 1);
    assert.equal(AudioModule.getStatus().playing, true);

    assert.equal(AudioModule.setMuted(true), true);
    assert.equal(track.paused, true, 'muting immediately pauses existing music');
    assert.equal(Sfx.isMuted(), true);
    assert.equal(document.getElementById('audioControlBtn').getAttribute('aria-pressed'), 'false');
    AudioModule.setMuted(false);
    assert.equal(track.playCalls, 1, 'preference-only unmute never resumes existing music');
    assert.equal(track.paused, true);
    AudioModule.toggleMute();
    AudioModule.toggleMute();
    assert.equal(track.playCalls, 2, 'in-game unmute resumes the existing track');
    assert.equal(instances.length, 1, 'toggles reuse the media element');
    AudioModule.enableSound(false);
    assert.equal(track.paused, true, 'run end can pause the existing track');
    AudioModule.enableSound(true);
    assert.equal(track.playCalls, 3, 'replay retains the existing resume contract');

    AudioModule.teardown();
    assert.equal(track.paused, true, 'teardown stops playback');
    AudioModule.init();
    AudioModule.toggleMute();
    AudioModule.toggleMute();
    assert.equal(instances.length, 1, 'teardown resets playback intent for the next welcome screen');
    console.log('Audio startup tests passed');
  } finally {
    AudioModule.teardown();
    Sfx.teardown();
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio);
    else Reflect.deleteProperty(globalThis, 'Audio');
    env.teardown();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
