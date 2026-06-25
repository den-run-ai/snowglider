// @ts-check
// local-storage.mjs — in-memory localStorage shim for headless Node tests.
//
// jsdom either refuses localStorage on opaque origins or exposes a read-only one, so
// the score/auth/result-overlay harnesses each hand-rolled an object literal with the
// same getItem/setItem/removeItem/clear shape (7+ near-identical copies). This is that
// shape, factored out once, so a storage-contract change is a single edit.
//
// createLocalStorageMock() returns a fresh, isolated store. Mirroring the existing
// firebase.mjs precedent, the returned mock carries its own reset() so a test that
// reuses one instance across scenarios can clear it in setup; the per-file process
// isolation of the `test:*` scripts means cross-FILE contamination is already
// impossible. _raw() exposes the backing object for assertions that peek at the stored
// JSON directly (e.g. inspecting `snowgliderBestTime`).

/**
 * Build a standalone in-memory localStorage replacement.
 * @returns {{
 *   getItem: (key: string) => string | null,
 *   setItem: (key: string, value: unknown) => void,
 *   removeItem: (key: string) => void,
 *   clear: () => void,
 *   reset: () => void,
 *   _raw: () => Record<string, string>
 * }}
 */
export function createLocalStorageMock() {
  /** @type {Record<string, string>} */
  let store = {};
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: key => { delete store[key]; },
    clear: () => { store = {}; },
    /** Alias for clear(), matching the reset() naming used by other shared mocks. */
    reset: () => { store = {}; },
    /** The live backing object, for assertions that read stored values directly. */
    _raw: () => store
  };
}
