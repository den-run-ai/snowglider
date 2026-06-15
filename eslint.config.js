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
        Avalanche: "readonly",
        Camera: "readonly",
        Controls: "readonly",
        CourseModule: "readonly",
        EffectsModule: "readonly",
        Howl: "readonly",
        Howler: "readonly",
        Mountains: "readonly",
        ScoresModule: "readonly",
        Snow: "readonly",
        Snowman: "readonly",
        THREE: "readonly",
        Trees: "readonly",
        Utils: "readonly",
        avalanche: "writable",
        avalancheTriggered: "writable",
        bestTime: "writable",
        camera: "writable",
        cameraManager: "writable",
        gameActive: "writable",
        getTerrainHeight: "readonly",
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
    files: ["src/auth.js", "src/scores.js"],
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
