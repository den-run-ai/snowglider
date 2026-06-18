// register-ts-resolve.mjs — registers the .js -> .ts resolution hook.
//
// Used via `node --import ./tests/loaders/register-ts-resolve.mjs <test>` for the
// Node test runs that load a still-`.js` module which statically imports a
// renamed `.ts` sibling. See tests/loaders/ts-js-resolve.mjs for the rationale.
import { register } from 'node:module';

register('./ts-js-resolve.mjs', import.meta.url);
