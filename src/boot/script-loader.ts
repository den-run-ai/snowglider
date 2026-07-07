// Phase 2 (issue #84): converted to an ES module so it imports AudioModule from
// the real src module instead of reading the window.AudioModule bridge. index.html
// loads it as `<script type="module">` (deferred, like every module script), so it
// still registers its DOMContentLoaded handler before that event fires.
//
// Phase 3.11 (issue #84): renamed `.js` -> `.ts`. No type surface to promote (this
// is a boot orchestration script with implicitly-`any` DOM helper params under the
// current non-strict config); the only edit is the JSDoc `(window)` cast → `as`.
// The `../audio.js` import specifier is unchanged — Vite/tsc Bundler resolve it to
// audio.ts.
import { AudioModule } from '../audio.js';

(function () {
  const GAME_SCRIPT_ORDER: string[] = [
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
    // audio.js converted to an ES module (issue #84); it now loads via the
    // bundle entry (src/main.js), not this classic loader. GAME_SCRIPT_ORDER is
    // now empty — every game module loads through src/main.js.
    // controls.js converted to an ES module (issue #84, PR 2.5); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // avalanche.js converted to an ES module (issue #84, PR 2.1); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // effects.js converted to an ES module (issue #84, PR 2.6); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // course.js converted to an ES module (issue #84, PR 2.2); it now loads
    // via the bundle entry (src/main.js), not this classic loader.
    // snowglider.js converted to an ES module (issue #84, PR 2.9); it can't be a
    // classic <script>, so it loads via the deferred dynamic-import hook below
    // (window.__loadSnowGliderOrchestrator, set by src/main.js) — kept LAST so it
    // still runs after audio.js + Auth, sharing the bundled module graph.
  ];

  const TEST_SCRIPTS: Record<string, string[]> = {
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

  function appendScript(src: string, configureScript?: (script: HTMLScriptElement) => void) {
    return new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      if (typeof configureScript === 'function') {
        configureScript(script);
      }
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.body.appendChild(script);
    });
  }

  function loadScript(src: string) {
    return appendScript(src);
  }

  function loadModuleScript(src: string) {
    return appendScript(src, (script) => {
      script.type = 'module';
    });
  }

  function loadScriptsInOrder(scripts: string[]) {
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

    // Every browser-test suite is now an ES module (issue #84): loaded as
    // `<script type="module">` so they `import` the real src modules instead of
    // reading window.* bridges. (unified-test-runner.js stays a classic script —
    // it imports nothing and only reads window.run*Tests, which the modules set.)
    const selectedScripts = TEST_SCRIPTS[testParam] || [];

    if (testParam === 'unified') {
      // Set this before module test suites evaluate so they publish their
      // window.run*Tests hooks without also self-starting.
      window._unifiedTestRunnerActive = true;
    }

    const testModuleLoads = selectedScripts.map((scriptName) => {
      return loadModuleScript(`tests/${scriptName}.js`);
    });

    Promise.allSettled(testModuleLoads)
      .then((results) => {
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(`Failed to load test module ${selectedScripts[index]}:`, result.reason);
          }
        });

        return loadScript('tests/unified-test-runner.js');
      })
      .catch((error) => {
        console.error("Failed to load unified test runner:", error);
      });
  }

  function preloadAudio() {
    setTimeout(() => {
      if (AudioModule && typeof AudioModule.preloadAudio === 'function') {
        AudioModule.preloadAudio('bad_cat')
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
    window.SnowGliderGameScriptsReady = true;
    window.dispatchEvent(new CustomEvent('snowglider:game-scripts-ready'));
  }

  function initializeGameScripts() {
    const firebaseBoot = window.SnowGliderFirebase;
    const authReady: Promise<void> = firebaseBoot && typeof firebaseBoot.waitForAuthModule === 'function'
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
        // snowglider.js (the orchestrator) is now an ES module loaded by the
        // bundle entry's deferred dynamic-import hook (GAME_SCRIPT_ORDER above is
        // empty — every game module loads through src/main.js). Run it after the
        // module bundle has loaded, then proceed exactly as before. If the hook is
        // missing (bundle failed to load), fall through so the catch below surfaces
        // the error rather than silently hanging.
        const loadOrchestrator = window.__loadSnowGliderOrchestrator;
        return typeof loadOrchestrator === 'function'
          ? loadOrchestrator()
          : Promise.reject(new Error('SnowGlider orchestrator loader unavailable (src/main.js did not run)'));
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
