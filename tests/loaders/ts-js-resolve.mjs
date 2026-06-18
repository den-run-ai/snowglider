// ts-js-resolve.mjs — Node ESM resolution hook for the TypeScript migration.
//
// Phase 3 (issue #84) renames src modules `.js` -> `.ts` one at a time while the
// still-`.js` modules keep importing their browser-facing `./*.js` specifiers
// (the migration keeps source specifiers as `.js` so Vite/tsc — and the deployed
// static artifact — stay unchanged; both transparently resolve `./x.js` to `x.ts`).
//
// Node does NOT perform that `.js` -> `.ts` remap. So when a Node test imports a
// still-`.js` module that statically imports a now-renamed sibling (e.g.
// `mountains.js` / `snow.js` import `./trees.js`, which is now `trees.ts`),
// resolution fails with ERR_MODULE_NOT_FOUND.
//
// This hook closes only that gap: if a specifier ending in `.js` cannot be
// resolved, it retries the same path with a `.ts` extension. It is registered for
// the affected Node test runs only (see tests/loaders/register-ts-resolve.mjs and
// the package.json scripts); it never touches the browser, Vite, or build paths.
// Node's native type-stripping then loads the resolved `.ts` file.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -'.js'.length) + '.ts', context);
    }
    throw err;
  }
}
