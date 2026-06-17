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
        AudioModule: "readonly",
        AuthModule: "readonly",
        // Camera/Controls/CourseModule/EffectsModule/Snow/Snowman were kept here
        // only for the still-classic snowglider.js bare reads. As of PR 2.9
        // snowglider.js is an ES module that imports them, so those globals were
        // dropped (their window.* bridges persist until the loader is retired, PR
        // 2.10). avalanche.js is likewise only read as window.Avalanche.
        Howl: "readonly",
        Howler: "readonly",
        // mountains.js is now an ES module (PR 2.7), but trees.js + snow.js read
        // `Mountains` by bare name (the window bridge) at eval, so keep it declared
        // here until those bare reads are removed.
        Mountains: "readonly",
        ScoresModule: "readonly",
        THREE: "readonly",
        // trees.js is now an ES module (PR 2.4), but the still-classic snow.js
        // reads `Trees` by bare name (at eval, to build the `Snow` namespace), so
        // keep it declared here until snow.js is converted (this same cluster).
        Trees: "readonly",
        Utils: "readonly",
        // Terrain samplers republished onto window by mountains.js (PR 2.7). Kept
        // for the window bridge; the converted modules take them as parameters.
        getTerrainHeight: "readonly",
        getTerrainGradient: "readonly",
        getDownhillDirection: "readonly",
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
    files: ["src/auth.js", "src/avalanche.js", "src/camera.js", "src/controls.js", "src/course.js", "src/effects.js", "src/main.js", "src/mountains.js", "src/scores.js", "src/snow.js", "src/snowglider.js", "src/snowman.js", "src/trees.js"],
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
  }
];
