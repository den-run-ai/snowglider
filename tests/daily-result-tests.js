// @ts-check
// Exercise the actual finish overlay and CourseModule together: a valid daily
// invitation may be shared even when its device record cannot be persisted.
const assert = require('node:assert/strict');

(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/' });
  // Course gates need a tiny text-canvas surface. Share-card preparation gets
  // the same stub and no PNG, so this suite never captures or renders images.
  env.window.HTMLCanvasElement.prototype.getContext = /** @type {any} */ (() => ({
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    fillRect() {}, fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  }));
  env.window.HTMLCanvasElement.prototype.toBlob = callback => callback(null);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  /** @type {string[]} */
  const clipboard = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { clipboard.push(text); } } },
  });

  const THREE = await import('three');
  const daily = await import('../src/daily-challenge.ts');
  const session = await import('../src/daily-session.ts');
  const records = await import('../src/daily-records.ts');
  const rc = await import('../src/run-context.ts');
  const { CourseModule } = await import('../src/course.ts');
  const { createShowGameOver } = await import('../src/ui/result-overlay.ts');
  const { closeOverlayFocus } = await import('../src/ui/accessibility.ts');
  const { localBestTimeKey, localBestMetaKey, localGhostKey, localBestSplitsKey } = await import('../src/difficulty.ts');
  const challenge = daily.createDailyChallenge('2026-11-08', 'blue');
  const href = daily.buildDailyChallengeUrl(challenge, 'https://snowglider.ai/', 26000);
  const now = new Date('2026-11-08T12:00:00Z');
  const FINISH = 'You reached the end of the slope!';
  const canonicalKeys = [
    localBestTimeKey('blue'), localBestMetaKey('blue'),
    localGhostKey('blue'), `${localGhostKey('blue')}_meta`, localBestSplitsKey('blue'),
  ];
  /** @type {string[]} */
  const writes = [];
  const originalSetItem = env.localStorage.setItem;
  const originalRemoveItem = env.localStorage.removeItem;
  env.localStorage.setItem = (key, value) => { writes.push(key); originalSetItem(key, value); };
  env.localStorage.removeItem = key => { writes.push(key); originalRemoveItem(key); };
  let accountWrites = 0;
  window.AuthModule = {
    recordScore: () => { accountWrites++; },
    getCurrentUser: () => null,
  };
  /** @type {import('three').Scene | null} */
  let scene = null;

  function closeScenario() {
    const overlay = document.getElementById('gameOverOverlay');
    if (overlay) closeOverlayFocus(overlay, false);
    CourseModule.teardown();
    scene?.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
          material.dispose();
        }
      }
    });
    scene = null;
  }

  function makeScenario() {
    closeScenario();
    env.localStorage.clear();
    clipboard.length = 0;
    accountWrites = 0;
    env.window.history.replaceState({}, '', href);
    session.configureDailySession(new URL(href).search, now);
    document.body.innerHTML = `
      <div id="gameAnnouncements"></div>
      <div id="leaderboard" style="display:none"></div>
      <div id="gameOverOverlay" style="display:none">
        <h1 id="gameOverMessage"></h1>
        <p id="gameOverDetail"></p>
        <p id="bestTimeDisplay"></p>
        <button id="restartButton">Restart</button>
      </div>`;
    const canonicalStamp = {
      seed: rc.CANONICAL_WORLD_SEED, practice: false, nonce: 42, physicsVersion: rc.PHYSICS_VERSION,
    };
    env.localStorage.setItem(localBestTimeKey('blue'), '19');
    env.localStorage.setItem(localBestMetaKey('blue'), JSON.stringify(canonicalStamp));
    env.localStorage.setItem(localGhostKey('blue'), JSON.stringify([
      { t: 0, x: 0, y: 0, z: -15, rot: 0 },
      { t: 19, x: 1, y: 0, z: -195, rot: 0 },
    ]));
    env.localStorage.setItem(`${localGhostKey('blue')}_meta`, JSON.stringify(canonicalStamp));
    env.localStorage.setItem(localBestSplitsKey('blue'), JSON.stringify([4, 9, 14, 19]));
    const canonicalBefore = canonicalKeys.map(key => env.localStorage.getItem(key));
    scene = new THREE.Scene();
    CourseModule.init({
      scene,
      getTerrainHeight: () => 0,
      createSnowman: () => new THREE.Group(),
      getDifficulty: () => 'blue',
    });
    CourseModule.reset();
    writes.length = 0;
    const state = {
      gameActive: true, bestTime: 19, startTime: performance.now(), simElapsed: 25,
      timingCompromised: false,
    };
    const show = createShowGameOver({
      state,
      gameOverOverlay: document.getElementById('gameOverOverlay'),
      gameOverDetail: document.getElementById('gameOverDetail'),
      restartButton: document.getElementById('restartButton'),
      bestTimeDisplay: document.getElementById('bestTimeDisplay'),
      getDifficulty: () => 'blue',
    });
    return {
      state,
      finish(time) { state.simElapsed = time; show(FINISH); },
      assertCanonicalUntouched() {
        assert.deepEqual(canonicalKeys.map(key => env.localStorage.getItem(key)), canonicalBefore);
        assert.deepEqual(writes.filter(key => canonicalKeys.includes(key)), [], 'daily finishes cannot write canonical bests, ghosts, splits or stamps');
        assert.equal(accountWrites, 0, 'a daily finish never calls canonical account saving');
        assert.equal(state.bestTime, 19, 'daily records do not replace the canonical in-memory best');
        assert.equal(document.getElementById('saveScoreButton'), null, 'daily results do not offer a canonical save');
      },
    };
  }

  function courseText() {
    const panel = document.getElementById('courseResult');
    assert.ok(panel, 'the real CourseModule result panel must be present');
    return panel.textContent;
  }

  async function copiedInvitation() {
    const primary = document.getElementById('shareResultBtn');
    const copy = document.getElementById('shareCopyBtn');
    assert.ok(primary && copy, 'the actual share controls remain available');
    primary.click();
    copy.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const message = clipboard.at(-1);
    assert.ok(message, 'Copy result + link must produce a message');
    const url = new URL(message.slice(message.lastIndexOf('\n') + 1));
    assert.equal(url.origin, 'https://snowglider.ai');
    const parsed = daily.parseDailyChallenge(url.search, now);
    assert.equal(parsed.kind, 'daily');
    if (parsed.kind === 'daily') assert.equal(parsed.challenge.id, challenge.id);
    return { message, url };
  }

  try {
    // A real first daily finish saves its own record even when a faster regular
    // course best and ghost are already present on the shared device.
    {
      const run = makeScenario();
      run.finish(25);
      assert.equal(records.readDailyBest(challenge), 25000);
      assert.match(courseText(), /First daily finish saved on this device/i);
      assert.match(document.getElementById('syncStatus').textContent, /Daily best saved on this device/i);
      const shared = await copiedInvitation();
      assert.equal(shared.url.searchParams.get('beat'), '25000');
      run.assertCanonicalUntouched();
    }

    // Accumulated 1/60-second clocks can be microscopically below a rounded
    // stored time. Identical integer-ms results must remain a tie in the UI.
    {
      const run = makeScenario();
      records.recordDailyBest(challenge, rc.getRunStamp(), 'blue', 25);
      run.finish(24.999999999999);
      assert.equal(records.readDailyBest(challenge), 25000);
      assert.match(courseText(), /Matched your daily best/i);
      assert.doesNotMatch(courseText(), /Daily best!|new (?:personal best|record)|[−-]0\.00s/i);
      const shared = await copiedInvitation();
      assert.equal(shared.url.searchParams.get('beat'), '25000', 'a tied valid finish is still an eligible invitation');
      run.assertCanonicalUntouched();
    }

    // Storage availability does not change a completed run's fairness. Fail
    // honestly without losing the challenge link or inventing a persisted PB.
    {
      const run = makeScenario();
      const globalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      const windowStorage = Object.getOwnPropertyDescriptor(env.window, 'localStorage');
      const denied = { configurable: true, get() { throw new Error('Storage denied'); } };
      Object.defineProperty(globalThis, 'localStorage', denied);
      Object.defineProperty(env.window, 'localStorage', denied);
      try {
        run.finish(24);
        assert.match(courseText(), /This finish is not stored on this device/i);
        assert.doesNotMatch(courseText(), /Daily best!|new (?:personal best|record)|First daily finish saved/i);
        assert.match(document.getElementById('syncStatus').textContent, /storage is unavailable/i);
        const shared = await copiedInvitation();
        assert.equal(shared.url.searchParams.get('beat'), '24000');
        assert.match(shared.message, /Can you beat my run\?/);
        assert.equal(env.localStorage.getItem(records.dailyBestKey(challenge)), null);
        run.assertCanonicalUntouched();
      } finally {
        if (globalStorage) Object.defineProperty(globalThis, 'localStorage', globalStorage);
        if (windowStorage) Object.defineProperty(env.window, 'localStorage', windowStorage);
      }
    }

    // The summary, main readout and shared link must agree about a compromised
    // attempt. A different world/nonce is just as ineligible as a bad clock.
    for (const invalid of ['timing', 'nonce', 'seed']) {
      const run = makeScenario();
      records.recordDailyBest(challenge, rc.getRunStamp(), 'blue', 25);
      if (invalid === 'timing') run.state.timingCompromised = true;
      else if (invalid === 'nonce') rc.rewindRunStreams(1);
      else rc.setWorldContext(challenge.seed + 1, true);
      run.finish(20);
      const readout = document.getElementById('bestTimeDisplay').textContent;
      assert.match(readout, /not comparable/i, invalid);
      assert.doesNotMatch(readout, /Daily best:|25\.00/, invalid);
      assert.doesNotMatch(courseText(), /Daily best!|new (?:personal best|record)/i, invalid);
      assert.match(document.getElementById('dailyRunResult').textContent, /couldn’t be compared fairly/i, invalid);
      const shared = await copiedInvitation();
      assert.equal(shared.url.searchParams.has('beat'), false, invalid);
      assert.doesNotMatch(shared.message, /Can you beat my run\?/, invalid);
      assert.equal(records.readDailyBest(challenge), 25000, invalid);
      run.assertCanonicalUntouched();
    }
  } finally {
    closeScenario();
    session.clearDailySession();
    rc.setRunSeed(null);
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    env.teardown();
  }
  console.log('Daily results: real overlay/course, first save, millisecond tie, denied storage, timing/provenance eligibility, sharing and canonical record isolation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
