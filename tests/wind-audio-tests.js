// @ts-check
// Airflow perception and graph lifecycle regressions. These run the actual Sfx
// engine against a recording AudioContext; browser audio gets a separate smoke run.
const assert = require('node:assert/strict');

async function main() {
  const { Sfx, windAudioForMotion, windGainForSpeed } = await import('../src/sfx.js');
  const motion = {
    windX: 0, windZ: 0, velocityX: 0, velocityZ: -10,
    cameraRightX: 1, cameraRightZ: 0,
  };
  const calm = windAudioForMotion(motion, 0);
  const headwind = windAudioForMotion({ ...motion, windZ: 5 }, 0.7);
  const tailwind = windAudioForMotion({ ...motion, windZ: -5 }, 0.7);
  const crosswind = windAudioForMotion({ ...motion, windX: 5 }, 0.7);
  assert.equal(calm.apparentSpeed, 10);
  assert.equal(calm.gain, windGainForSpeed(10), 'calm air retains motion-only gain');
  assert.equal(headwind.apparentSpeed, 15);
  assert.equal(tailwind.apparentSpeed, 5);
  assert.ok(headwind.gain > crosswind.gain && crosswind.gain > tailwind.gain,
    'headwind and tailwind must not sound identical at the same skier speed');
  assert.ok(headwind.frequency > tailwind.frequency, 'air rush brightens with relative airspeed');
  assert.ok(crosswind.environmentalPan < 0, 'wind flowing right arrives from the left');
  const reverseView = windAudioForMotion({ ...motion, windX: 5, cameraRightX: -1 }, 0.7);
  assert.equal(reverseView.environmentalPan, -crosswind.environmentalPan,
    'an opposite camera view swaps the environmental source side');
  const overheadView = windAudioForMotion({ ...motion, windX: 5, cameraRightX: 0 }, 0.7);
  assert.equal(overheadView.environmentalPan, 0, 'a degenerate listener basis stays centered');
  const sameAir = windAudioForMotion({ ...motion, windZ: -10 }, 0.7);
  assert.equal(sameAir.apparentSpeed, 0);
  assert.equal(sameAir.pan, 0);
  for (const bad of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const output = windAudioForMotion({
      windX: bad, windZ: bad, velocityX: bad, velocityZ: bad,
      cameraRightX: bad, cameraRightZ: bad,
    }, bad);
    assert.ok(Object.values(output).every(Number.isFinite), 'invalid inputs must not poison AudioParams');
    assert.ok(output.gain >= 0 && output.gain <= 0.61);
    assert.ok(output.frequency >= 300 && output.frequency <= 1180);
    assert.ok(Math.abs(output.pan) <= 0.16 && Math.abs(output.environmentalPan) <= 0.45);
  }

  const globals = /** @type {any} */ (globalThis);
  const originalWindow = globals.window;
  const originalStorage = globals.localStorage;
  const originalRandom = Math.random;
  const originalWarn = console.warn;
  /** @type {FakeContext[]} */
  const contexts = [];
  let allowStereo = true;
  let failBuild = false;
  class Param {
    constructor() { this.value = 0; this.targets = []; }
    setTargetAtTime(value, time, tau) {
      assert.ok(Number.isFinite(value));
      this.value = value;
      this.targets.push({ value, time, tau });
    }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.value = value; }
  }
  class Node {
    constructor() { this.connections = []; this.disconnected = false; }
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; }
  }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Filter extends Node {
    constructor() { super(); this.frequency = new Param(); this.Q = new Param(); this.type = ''; }
  }
  class Panner extends Node { constructor() { super(); this.pan = new Param(); } }
  class Source extends Node {
    constructor() { super(); this.offset = -1; this.stopped = false; this.loop = false; this.buffer = null; }
    start(_time, offset = 0) { this.offset = offset; }
    stop() { this.stopped = true; }
  }
  class Oscillator extends Source {
    constructor() { super(); this.frequency = new Param(); this.type = 'sine'; }
  }
  class FakeContext {
    constructor() {
      this.currentTime = 0; this.sampleRate = 8000; this.state = 'suspended';
      this.destination = new Node(); this.gains = []; this.filters = [];
      this.sources = []; this.panners = []; this.closed = false; this.resumes = 0;
      this.noise = new Float32Array(0);
      this.createStereoPanner = allowStereo ? () => {
        const p = new Panner(); this.panners.push(p); return p;
      } : undefined;
      contexts.push(this);
    }
    createBuffer(_channels, length) {
      this.noise = new Float32Array(length);
      return { getChannelData: () => this.noise };
    }
    createBufferSource() { const n = new Source(); this.sources.push(n); return n; }
    createGain() { const n = new Gain(); this.gains.push(n); return n; }
    createBiquadFilter() {
      if (failBuild) throw new Error('test graph failure');
      const n = new Filter(); this.filters.push(n); return n;
    }
    createOscillator() { return new Oscillator(); }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  }
  try {
    globals.window = { isTestMode: true, testHooks: { sfxEnabled: true }, AudioContext: FakeContext };
    globals.localStorage = { getItem: () => null };
    Math.random = () => { throw new Error('audio consumed the gameplay random stream'); };
    Sfx.setMuted(false);
    Sfx.unlock();
    const context = contexts[0];
    assert.equal(Sfx.getStatus().active, true, 'unlock must build without global random draws');
    assert.equal(context.resumes, 1, 'gesture resumes a suspended audio context');
    assert.equal(context.sources.length, 5, 'five shared loops, no per-frame voices');
    assert.equal(new Set(context.sources.map(s => s.offset)).size, 5, 'beds use decorrelated noise phases');
    assert.equal(context.noise.length, 6 * context.sampleRate);
    assert.ok(context.noise.some(s => s > 0) && context.noise.some(s => s < 0));
    assert.ok(context.filters[3].Q.value < 1, 'gust layer must be a broad wash, not a tonal whistle');
    assert.equal(context.panners.length, 3);
    Sfx.updateSkiing(10, 'carve', false, 0.7, { ...motion, windX: 5 });
    Sfx.updateWindHowl(0.7, 0.8, crosswind.environmentalPan);
    Sfx.updateForest(0.7, 0.8, 1, crosswind.environmentalPan);
    assert.equal(context.gains[1].gain.value, crosswind.gain);
    assert.equal(context.filters[0].frequency.value, crosswind.frequency);
    assert.equal(context.panners[0].pan.value, crosswind.pan);
    assert.equal(context.panners[1].pan.value, crosswind.environmentalPan);
    assert.equal(context.panners[2].pan.value, crosswind.environmentalPan);
    assert.ok(context.panners[1].pan.targets.every(t => t.tau >= 0.2), 'camera pan is smoothed');
    assert.ok(context.gains[2].gain.value > 0, 'ground carve is audible');
    Sfx.updateSkiing(10, 'carve', true, 0.7, motion);
    assert.equal(context.gains[2].gain.value, 0, 'airborne skier has no edge scrape');
    Sfx.setMuted(true);
    assert.equal(context.gains[0].gain.value, 0, 'one master mutes every bed');
    Sfx.updateSkiing(10, 'glide', false, 0.7, { ...motion, windZ: -5 });
    assert.equal(context.gains[1].gain.value, tailwind.gain, 'muted beds keep tracking for clean unmute');
    Sfx.updateWindHowl(0, 0, NaN);
    Sfx.updateForest(0, 0, 0, Infinity);
    assert.equal(context.gains[4].gain.value, 0);
    assert.equal(context.gains[5].gain.value, 0);
    Sfx.setMuted(false);
    Sfx.endRun('finish');
    assert.ok(context.gains.slice(1, 6).every(g => g.gain.value === 0), 'finish silences all five beds');
    const count = contexts.length;
    Sfx.unlock();
    assert.equal(contexts.length, count, 'replay reuses the existing graph');
    assert.ok(context.panners.every(p => p.pan.value === 0), 'replay clears the previous camera pan');
    Sfx.teardown(); Sfx.teardown();
    assert.equal(context.closed, true);
    assert.ok(context.sources.every(s => s.stopped && s.disconnected));
    assert.ok(context.panners.every(p => p.disconnected));
    assert.equal(Sfx.getStatus().running, false);

    allowStereo = false;
    Sfx.unlock();
    const mono = contexts[1];
    assert.equal(Sfx.getStatus().active, true, 'no StereoPanner support retains mono audio');
    assert.equal(mono.panners.length, 0);
    Sfx.updateSkiing(NaN, 'glide', false, NaN);
    Sfx.updateWindHowl(NaN, Infinity, Infinity);
    Sfx.updateForest(Infinity, NaN, NaN, Infinity);
    assert.ok(mono.filters.every(f => Number.isFinite(f.frequency.value)));
    Sfx.teardown();

    failBuild = true;
    console.warn = () => {};
    Sfx.unlock();
    assert.equal(contexts[2].closed, true, 'a partial graph failure closes the context');
    assert.equal(Sfx.getStatus().active, false);
    assert.equal(Sfx.getStatus().running, false);
    failBuild = false;
    Sfx.unlock();
    assert.equal(Sfx.getStatus().active, true, 'a subsequent gesture can recover');
  } finally {
    Sfx.teardown();
    Math.random = originalRandom;
    console.warn = originalWarn;
    if (originalWindow === undefined) delete globals.window; else globals.window = originalWindow;
    if (originalStorage === undefined) delete globals.localStorage; else globals.localStorage = originalStorage;
  }
  console.log('Wind audio: apparent airspeed, camera stereo, RNG isolation, mixer and lifecycle passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
