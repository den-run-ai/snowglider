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
        // camera.js is now an ES module (PR 2.3), but the still-classic
        // snowglider.js reads `Camera` by bare name (`new Camera(scene)`), so
        // keep it declared here until snowglider.js is converted (PR 2.9).
        // (Like CourseModule; contrast avalanche.js, only read as window.Avalanche.)
        Camera: "readonly",
        // controls.js is now an ES module (PR 2.5), but the still-classic
        // snowglider.js reads `Controls` by bare name (`Controls.setupControls()`),
        // so keep it declared here until snowglider.js is converted (PR 2.9).
        Controls: "readonly",
        // course.js is now an ES module (PR 2.2), but the still-classic
        // snowglider.js reads `CourseModule` by bare name, so keep it declared
        // here until snowglider.js is converted (PR 2.9). (Contrast avalanche.js,
        // which is only read as `window.Avalanche`, so its global was dropped.)
        CourseModule: "readonly",
        // effects.js is now an ES module (PR 2.6), but the still-classic
        // snowglider.js reads `EffectsModule` by bare name (`EffectsModule.tickCamera`),
        // so keep it declared here until snowglider.js is converted (PR 2.9).
        EffectsModule: "readonly",
        Howl: "readonly",
        Howler: "readonly",
        // mountains.js is now an ES module (PR 2.7), but trees.js + snow.js read
        // `Mountains` by bare name (as the window bridge), so keep it declared
        // here until those + snowglider.js are converted (PR 2.9).
        Mountains: "readonly",
        ScoresModule: "readonly",
        // snow.js is now an ES module (cluster), but the still-classic
        // snowglider.js reads `Snow` by bare name (`Snow.getTerrainHeight`, …),
        // so keep it declared here until snowglider.js is converted (PR 2.9).
        Snow: "readonly",
        Snowman: "readonly",
        THREE: "readonly",
        // trees.js is now an ES module (PR 2.4), but the still-classic snow.js
        // reads `Trees` by bare name (at eval, to build the `Snow` namespace), so
        // keep it declared here until snow.js is converted (this same cluster).
        Trees: "readonly",
        Utils: "readonly",
        avalanche: "writable",
        avalancheTriggered: "writable",
        bestTime: "writable",
        camera: "writable",
        cameraManager: "writable",
        gameActive: "writable",
        // Terrain samplers: mountains.js (now an ES module, PR 2.7) republishes
        // these onto window; snowman.js / camera.js / course.js read them by bare
        // name. Kept until snowglider.js is converted (PR 2.9).
        getTerrainHeight: "readonly",
        getTerrainGradient: "readonly",
        getDownhillDirection: "readonly",
        isInAir: "writable",
        lastAvalancheZ: "writable",
        pos: "writable",
        resetSnowman: "readonly",
        scene: "writable",
        showGameOver: "readonly",
        snowman: "writable",
        startTime: "writable",
        updateCamera: "readonly",
        updateSnowman: "readonly",
        velocity: "writable",
        verticalVelocity: "writable"
      }
    },
    rules: {
      ...warningRules,
      "no-redeclare": "off",
      "no-unused-vars": "off"
    }
  },
  {
    files: ["src/auth.js", "src/avalanche.js", "src/camera.js", "src/controls.js", "src/course.js", "src/effects.js", "src/main.js", "src/mountains.js", "src/scores.js", "src/snow.js", "src/trees.js"],
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
