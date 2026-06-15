# SnowGlider Agent Guide

## Project Context

SnowGlider is a browser game built with plain JavaScript, Three.js, Firebase auth, and browser-based tests. The main entry point is `index.html`; gameplay logic lives across `snowglider.js`, `snowman.js`, `mountains.js`, `trees.js`, `avalanche.js`, `camera.js`, `controls.js`, `audio.js`, `auth.js`, and `scores.js`.

## Commands

- Install dependencies: `npm ci`
- Run lint: `npm run lint`
- Run Node tests with coverage: `npm run test:coverage`
- Run browser tests: `npm run test:browser`
- Start local server: `npm start`

## Review Guidelines

- Focus on serious correctness, security, deployment, and user-visible behavior issues.
- Flag changes that can break skiing physics, terrain height consistency, tree collision detection, avalanche behavior, camera tracking, touch controls, authentication, score syncing, or GitHub Pages deployment.
- Treat missing tests as important when gameplay mechanics, shared module contracts, Firebase behavior, or CI/CD workflows change.
- Check that GitHub Actions remain least-privileged and do not publish generated folders, dependency directories, coverage reports, test artifacts, or local-only files.
- Verify that GitHub Pages deployment runs only after the test job succeeds.
- Preserve local development and `file://` fallbacks when reviewing Firebase/auth changes.
- Treat audio changes as high risk because mobile browsers require user gestures and can suspend audio contexts.
- Prefer concrete bug findings over style-only comments. Avoid broad refactor suggestions unless they directly reduce a clear risk in the changed code.

## Style Notes

- Match the existing browser-script style unless a file already uses ES modules.
- Use 2-space indentation and semicolons.
- Use camelCase for variables/functions and PascalCase for classes.
- Preserve global module exports such as `window.Mountains`, `window.Controls`, `window.AuthModule`, and `window.ScoresModule` when touching existing modules.
- Use `THREE.Vector3` and existing helper functions for position and terrain calculations instead of duplicating math ad hoc.
