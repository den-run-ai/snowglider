# SnowGlider Review Guide

SnowGlider is a browser game built with plain JavaScript, Three.js, Firebase auth, and browser-based tests. Review comments should focus on defects that affect gameplay, deployment, security, performance, or maintainability.

## Review Priorities

- Prefer correctness, user-visible behavior, and regression risk over stylistic suggestions.
- Flag changes that can break skiing physics, terrain height consistency, tree collision detection, avalanche behavior, camera tracking, touch controls, authentication, score syncing, or GitHub Pages deployment.
- Call out missing tests when gameplay mechanics, shared module contracts, Firebase behavior, or CI/CD workflows change.
- Avoid suggesting broad refactors unless they directly reduce a concrete bug risk in the changed code.

## JavaScript Style

- Match the existing browser-script style unless a file already uses ES modules.
- Use 2-space indentation and semicolons.
- Keep functions and object names descriptive; use camelCase for variables/functions and PascalCase for classes.
- Preserve global module exports such as `window.Mountains`, `window.Controls`, `window.AuthModule`, and `window.ScoresModule` when touching existing modules.
- Use `THREE.Vector3` and existing helper functions for position and terrain calculations instead of duplicating math ad hoc.

## Game And Browser Behavior

- Maintain compatibility with keyboard and touch controls.
- Keep terrain height calculations consistent between rendering, physics, collision detection, trees, rocks, and avalanche boulders.
- Ensure Three.js objects are cleaned up or reused where repeated creation could affect frame rate.
- Treat audio changes as high risk because mobile browsers require user gestures and can suspend audio contexts.
- For Firebase changes, preserve local development and `file://` fallbacks.

## CI/CD And Review Automation

- Keep workflows least-privileged and avoid adding secrets unless they are required.
- Do not suggest deployment changes that would publish generated folders, dependency directories, coverage reports, test artifacts, or local-only files.
- GitHub Pages should deploy only after the test job succeeds.
- PR review automation should be helpful without blocking unrelated work on existing legacy warnings.
