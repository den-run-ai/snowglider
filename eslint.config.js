const js = require("@eslint/js");
const globals = require("globals");

const warningRules = Object.fromEntries(
  Object.entries(js.configs.recommended.rules).map(([ruleName, ruleConfig]) => {
    if (Array.isArray(ruleConfig)) {
      return [ruleName, ["warn", ...ruleConfig.slice(1)]];
    }

    return [ruleName, "warn"];
  })
);

module.exports = [
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "test-results/**"
    ]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.node,
        AuthModule: "readonly",
        // Camera/Controls/CourseModule/EffectsModule/Snow/Snowman were kept here
        // only for snowglider.js's old bare reads. As of PR 2.9 snowglider.js is
        // an ES module that imports them, and the later Phase 2 cleanup removed
        // their window namespace bridges too.
        Howl: "readonly",
        Howler: "readonly",
        ScoresModule: "readonly",
        // three.js + Mountains + Trees + the terrain samplers (getTerrainHeight/
        // getTerrainGradient/getDownhillDirection) are single-sourced from npm and
        // reached via imports (terrain trio + camera.js) or injected parameters
        // (snowman.js, course.js), so their bare globals + window bridges were all
        // removed (issue #84).
        // snowman.js's checkTreeCollision test hook reads these two as bare globals
        // (not its parameters), and the browser test suites reassign them to drive
        // the live game; snowglider.js re-publishes them on window via accessors
        // (PR 2.9), so they stay declared (writable) until those reads/writes move
        // to an explicit handle.
        isInAir: "writable",
        verticalVelocity: "writable"
        // The rest of the shared mutable game state (scene/camera/snowman/velocity/pos/
        // gameActive/bestTime/…) and the orchestrator helpers (resetSnowman/
        // showGameOver/updateCamera/updateSnowman) used to be snowglider.js script
        // globals. As of PR 2.9 snowglider.js is an ES module: that state is
        // module-scoped and re-published on window (see snowglider.js), so the
        // bare-name globals were dropped here too.
      }
    },
    rules: {
      ...warningRules,
      "no-redeclare": "off",
      "no-unused-vars": "off"
    }
  },
  {
    // Every game/app module was renamed to .ts through Phase 3 (issue #84):
    // avalanche/course/effects/camera/trees/controls/snow/mountains/snowman
    // (3.0-3.7), auth/scores (3.8) and the snowglider.js orchestrator (3.9).
    // `eslint .` does not lint .ts (no typescript-eslint configured), so they are
    // dropped from this module override. Only audio.js + the boot/bundle-entry/ui
    // scripts remain as `.js` ES modules here.
    files: ["src/audio.js", "src/boot/script-loader.js", "src/main.js", "src/ui/start-menu.js"],
    languageOptions: {
      sourceType: "module"
    }
  },
  {
    files: ["vite.config.js"],
    languageOptions: {
      sourceType: "module"
    }
  },
  {
    files: ["tests/**/*.js"],
    rules: {
      "no-undef": "off"
    }
  },
  {
    // Browser-test suites converted to ES modules (issue #84) — they `import` the
    // real src modules instead of the window.* bridges. (unified-test-runner.js is
    // still a classic script; the node-only test files stay sourceType: script.)
    files: [
      "tests/audio-tests.js",
      "tests/controls-tests.js",
      "tests/camera-tests.js",
      "tests/browser-avalanche-tests.js",
      "tests/browser-tests.js",
      "tests/browser-tree-tests.js",
      "tests/browser-regression-tests.js"
    ],
    languageOptions: {
      sourceType: "module"
    }
  }
];
