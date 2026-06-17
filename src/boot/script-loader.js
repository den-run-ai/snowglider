// @ts-check
(function () {
  const GAME_SCRIPT_ORDER = [
    // mountains.js converted to an ES module (issue #84, PR 2.7); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // trees.js converted to an ES module (issue #84, PR 2.4); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // snow.js converted to an ES module (issue #84, cluster); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // camera.js converted to an ES module (issue #84, PR 2.3); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // snowman.js converted to an ES module (issue #84, PR 2.8); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    'src/audio.js',
    // controls.js converted to an ES module (issue #84, PR 2.5); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // avalanche.js converted to an ES module (issue #84, PR 2.1); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // effects.js converted to an ES module (issue #84, PR 2.6); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // course.js converted to an ES module (issue #84, PR 2.2); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    'src/snowglider.js'
  ];

  const TEST_SCRIPTS = {
    true: ['browser-tests'],
    all: [
      'browser-tests',
      'camera-tests',
      'browser-tree-tests',
      'browser-regression-tests',
      'controls-tests',
      'audio-tests',
      'browser-avalanche-tests'
    ],
    unified: [
      'browser-tests',
      'camera-tests',
      'browser-tree-tests',
      'browser-regression-tests',
      'controls-tests',
      'audio-tests',
      'browser-avalanche-tests'
    ],
    camera: ['camera-tests'],
    trees: ['browser-tree-tests'],
    regression: ['browser-regression-tests'],
    controls: ['controls-tests'],
    audio: ['audio-tests'],
    avalanche: ['browser-avalanche-tests']
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.body.appendChild(script);
    });
  }

  function loadScriptsInOrder(scripts) {
    return scripts.reduce((promise, src) => {
      return promise.then(() => loadScript(src));
    }, Promise.resolve());
  }

  function loadTests() {
    const urlParams = new URLSearchParams(window.location.search);
    const testParam = urlParams.get('test');

    if (!testParam) {
      return;
    }

    console.log(`Loading test scripts for test parameter: ${testParam}`);

    const testUtils = document.createElement('script');
    testUtils.src = 'tests/unified-test-runner.js';
    document.body.appendChild(testUtils);

    const selectedScripts = TEST_SCRIPTS[testParam] || [];
    selectedScripts.forEach((scriptName) => {
      const testScript = document.createElement('script');
      testScript.src = `tests/${scriptName}.js`;
      document.body.appendChild(testScript);
    });
  }

  function preloadAudio() {
    setTimeout(() => {
      if (window.AudioModule && typeof window.AudioModule.preloadAudio === 'function') {
        window.AudioModule.preloadAudio('drum_loop')
          .then(() => {
            console.log("Audio pre-loaded and ready for user interaction");
          })
          .catch((err) => {
            console.warn("Could not pre-load audio:", err);
          });
      }
    }, 500);
  }

  function announceGameScriptsReady() {
    /** @type {any} */ (window).SnowGliderGameScriptsReady = true;
    window.dispatchEvent(new CustomEvent('snowglider:game-scripts-ready'));
  }

  function initializeGameScripts() {
    const firebaseBoot = window.SnowGliderFirebase;
    const authReady = firebaseBoot && typeof firebaseBoot.waitForAuthModule === 'function'
      ? firebaseBoot.waitForAuthModule()
      : Promise.resolve();

    authReady
      .then(() => {
        console.log("AuthModule ready, proceeding with game scripts and Auth initialization.");
        if (firebaseBoot && typeof firebaseBoot.initializeAuthModule === 'function') {
          firebaseBoot.initializeAuthModule();
        }
        return loadScriptsInOrder(GAME_SCRIPT_ORDER);
      })
      .then(() => {
        loadTests();
        console.log("Main game script loaded.");
        announceGameScriptsReady();
        preloadAudio();
      })
      .catch((error) => {
        console.error("Failed to load or initialize game scripts:", error);
      });
  }

  document.addEventListener('DOMContentLoaded', initializeGameScripts);

  window.SnowGliderScriptLoader = {
    loadScript,
    loadScriptsInOrder,
    loadTests,
    initializeGameScripts,
    announceGameScriptsReady
  };
})();
