// firebase-cdn-mock.hooks.mjs — Node ESM resolution hook that redirects the
// Firebase SDK CDN imports to the in-memory mock in tests/mocks/firebase.mjs.
//
// src/scores.ts and src/auth.ts statically import the Firebase SDK from gstatic
// CDN URLs, e.g.
//   import { getFirestore, ... } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-firestore.js";
// Node's default loader only understands `file:`/`data:` URLs, so importing those
// modules directly fails with ERR_UNSUPPORTED_ESM_URL_SCHEME. This hook rewrites
// any `firebase-{app,firestore,analytics,auth}.js` CDN specifier to the local mock
// module, letting the Node test harnesses `import` the REAL `.ts` under test
// (rather than eval it) so c8 instruments it with correct source-mapped lines.
//
// Registered via tests/loaders/register-firebase-mock.mjs. It never touches the
// browser, Vite, or build paths.
const MOCK_URL = new URL('../mocks/firebase.mjs', import.meta.url).href;

const FIREBASE_CDN_MODULE = /\/firebasejs\/[\d.]+\/firebase-(app|firestore|analytics|auth)\.js$/;

export async function resolve(specifier, context, nextResolve) {
  if (FIREBASE_CDN_MODULE.test(specifier)) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
