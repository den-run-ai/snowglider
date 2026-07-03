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
      ".claude/skills/**",
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
  // Phase 3 (typescript-eslint): the `src/` + `types/` `.ts` sources are linted
  // with the typescript-eslint parser + the TYPE-CHECKED recommended rules
  // (`recommendedTypeChecked`, backed by the project's tsconfig via
  // `projectService`). `tsc --noEmit` remains the authoritative type gate; the
  // type-aware lint rules add behavioural checks tsc doesn't (floating/misused
  // promises, redundant assertions). The scope is `src/`+`types/` because those
  // are exactly what tsconfig includes — the Playwright e2e specs and *.config.ts
  // are excluded from tsconfig, so type-aware linting can't build a program for
  // them (they are linted non-type-checked in the block below).
  ...tseslint.config({
    files: ["src/**/*.ts", "types/**/*.ts"],
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
      // the eslint twin as a warning for consistency. The leading-underscore
      // ignore patterns mirror tsc's default so deliberately-unused
      // call-site-parity params (e.g. `_scene`) don't warn in either tool.
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      // Deliberate `any` lives only in boot/test seams + untyped Firestore
      // DocumentData.
      "@typescript-eslint/no-explicit-any": "warn",
      // recommendedTypeChecked's `no-unsafe-*` family fires pervasively wherever
      // a deliberate `any` flows — untyped Firestore DocumentData, the window.*
      // game/test handle casts, and untyped THREE.js internals. Mirror
      // no-explicit-any and keep them as WARNINGS (surfaced as debt to pay down
      // incrementally, but non-blocking) rather than dropping the whole
      // type-checked tier. `restrict-template-expressions` is downgraded for the
      // same reason (it trips on those `any`/`never`-typed Firestore fields).
      // The high-value behavioural rules below stay at their default `error`.
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn"
    }
  }),
  // The Playwright e2e specs and root *.config.ts files are excluded from
  // tsconfig (the tsc gate covers src/ + types/ only), so the type-aware program
  // above can't include them. Lint them with the non-type-checked recommended
  // ruleset so they still get baseline coverage without a parser project error.
  ...tseslint.config({
    files: ["tests/**/*.ts", "*.config.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "off"
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
