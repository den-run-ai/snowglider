// @ts-check
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const { auditTypecheckCoverage } = await import('../scripts/check-typecheck-coverage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'snowglider-type-coverage-'));
  const write = (name, content) => writeFileSync(path.join(root, name), content);
  const config = (include, options = {}) => JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: true, noEmit: true, types: [], ...options }, include,
  });
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'tests'));
    write('src/main.ts', 'export const ready = true;\n');
    write('src/worker.ts', 'export const worker = true;\n');
    write('tests/example.js', 'module.exports = 1;\n');
    write('tsconfig.json', config(['src/main.ts']));
    write('tsconfig.worker.json', config(['src/worker.ts']));
    write('tsconfig.e2e.json', config(['src/main.ts'], { checkJs: false }));
    write('tsconfig.tests.json', config(['tests/**/*.js']));
    assert.deepEqual(auditTypecheckCoverage(root, {}).errors, []);

    // A new test is checked without an opt-in directive or inventory edit.
    write('tests/new-tests.js', 'module.exports = 2;\n');
    assert.deepEqual(auditTypecheckCoverage(root, {}).errors, []);
    // Narrowing a glob must not turn the same test silently unchecked.
    write('tsconfig.tests.json', config(['tests/example.js']));
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('new-tests.js: missing')));
    write('tsconfig.tests.json', config(['tests/**/*.js']));

    write('tests/new-tests.js', '// @ts-nocheck\nmodule.exports = 2;\n');
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('@ts-nocheck')));
    write('tests/new-tests.js', '/// @ts-nocheck\nmodule.exports = 2;\n');
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('@ts-nocheck')));
    write('tests/new-tests.js', 'module.exports = 2;\n');
    write('tsconfig.tests.json', config(['tests/**/*.js'], { checkJs: false }));
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('require checkJs:true')));
    write('tsconfig.tests.json', config(['tests/**/*.js'], { noCheck: true }));
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('noCheck:false')));

    write('tsconfig.tests.json', config(['tests/**/*.js']));
    assert(auditTypecheckCoverage(root, { 'tests/example.js': 'stale debt' }).errors
      .some(e => e.includes('now-unnecessary legacy exemption')));
    write('vite.config.mjs', 'export default {};\n');
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('vite.config.mjs: missing')));
    write('tool.config.cjs', 'module.exports = {};\n');
    assert(auditTypecheckCoverage(root, {}).errors.some(e => e.includes('tool.config.cjs: missing')));
    console.log('Type-check coverage guard: 10 regression checks passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
