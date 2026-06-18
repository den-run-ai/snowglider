const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");

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
  // Phase 3 (issue #84) renamed every src game/app module to .ts — the game
  // modules (3.0-3.7), auth/scores (3.8), the snowglider orchestrator (3.9),
  // audio.js (3.10) and finally the bundle entry + boot/ui scripts (main.js,
  // boot/script-loader.js, ui/start-menu.js → .ts, 3.11). The only remaining
  // `.js` files under src are the classic Firebase/local-auth bootstrap
  // `<script>`s (boot/firebase-bootstrap.js, boot/local-auth.js); they are NOT
  // modules, so the default `**/*.js` block (sourceType:"script") above is
  // correct for them.
  //
  // Phase 3 (typescript-eslint): `.ts` sources are now linted with the
  // typescript-eslint parser + recommended rules (non-type-checked — `tsc
  // --noEmit` remains the type gate). Severities are downgraded to "warn" to
  // mirror the JS block (warnings don't fail `eslint .`), and a few rules are
  // relaxed for deliberate migration patterns documented in
  // docs/TYPESCRIPT_MIGRATION.md (intentional `any` boot/test seams, the
  // `window.*` handle casts).
  ...tseslint.config({
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.browser
      }
    },
    rules: {
      // Mirror the JS block: surface issues as warnings, don't fail the build,
      // and don't fight unused vars during the migration.
      "@typescript-eslint/no-unused-vars": "off",
      // Deliberate `any` lives only in boot/test seams + untyped Firestore
      // DocumentData (see TYPESCRIPT_MIGRATION.md exit criteria).
      "@typescript-eslint/no-explicit-any": "warn"
    }
  }),
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
