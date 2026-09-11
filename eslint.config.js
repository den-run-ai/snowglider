const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  {
    ignores: [
      ".claude/skills/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "test-results/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
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
        // (Howl/Howler were removed alongside the `howler` dependency — audio is
        // native HTML5 now and nothing references those globals.)
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
      ...js.configs.recommended.rules,
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
  // modules, so the default JS block (sourceType:"script") above is
  // correct for them.
  //
  // Phase 3 (typescript-eslint): the `src/` + `types/` `.ts` sources are linted
  // with the typescript-eslint parser + the TYPE-CHECKED recommended rules
  // (`recommendedTypeChecked`, backed by the project's tsconfig via
  // `projectService`). `tsc --noEmit` remains the authoritative type gate; the
  // type-aware lint rules add behavioural checks tsc doesn't (floating/misused
  // promises, redundant assertions). App, E2E and worker use separate typed
  // projects so each retains the correct runtime globals and strictness.
  ...tseslint.config({
    files: ["src/**/*.ts", "types/**/*.ts"],
    // The worker has a separate WebWorker compiler project below.
    ignores: ["src/pwa/sw.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.browser
      }
    },
    rules: {
      // The TypeScript migration is complete and `tsc --noEmit` now enforces
      // noUnusedLocals/noUnusedParameters (it FAILS on unused code), so re-enable
      // the eslint twin as an error for consistency. The leading-underscore
      // ignore patterns mirror tsc's default so deliberately-unused
      // call-site-parity params (e.g. `_scene`) don't warn in either tool.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      // Production boundaries must narrow SDK/user-data values before use. These
      // are errors so dependency upgrades cannot silently reintroduce unsafe flows.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/restrict-template-expressions": "error"
    }
  }),
  // E2E TypeScript and Playwright configs retain full strict checking in their
  // own project; typed lint also catches floating promises and unsafe SDK flows.
  ...tseslint.config({
    files: ["tests/**/*.ts", "*.config.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.e2e.json",
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "off"
    }
  }),
  // The worker is type-checked against WebWorker globals in its own project.
  ...tseslint.config({
    files: ["src/pwa/sw.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.worker.json",
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.serviceworker,
        ...globals.browser
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  }),
  {
    files: ["vite.config.js", "**/*.mjs"],
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
