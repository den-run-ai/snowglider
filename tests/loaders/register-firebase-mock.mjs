// register-firebase-mock.mjs — registers the resolution hooks the headless
// score/auth coverage harnesses need.
//
// Used via `node --import ./tests/loaders/register-firebase-mock.mjs <test>`:
//  1. firebase-cdn-mock.hooks.mjs redirects the Firebase SDK CDN imports in
//     src/scores.ts / src/auth.ts to the in-memory mock (tests/mocks/firebase.mjs),
//     so the real `.ts` can be imported (and c8-instrumented) instead of eval'd.
//  2. ts-js-resolve.mjs keeps the `.js` -> `.ts` fallback so a module that imports a
//     renamed sibling via a `./x.js` specifier still resolves under Node.
import { register } from 'node:module';

register('./firebase-cdn-mock.hooks.mjs', import.meta.url);
register('./ts-js-resolve.mjs', import.meta.url);
