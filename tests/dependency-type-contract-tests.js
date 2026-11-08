// @ts-check
// Runtime SDKs and compiler-visible declarations must advance together. Firebase
// runs from the CDN, while TypeScript resolves its declarations from npm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
/** @typedef {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, version?: string }} PackageInfo */
/** @type {PackageInfo} */
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
/** @type {{ packages: Record<string, PackageInfo> }} */
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

for (const name of ['firebase', 'three', '@types/three', '@dgreenheck/ez-tree']) {
  const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `${name}: exact version required for SDK adapter`);
  assert.equal(lock.packages['node_modules/' + name]?.version, version, `${name}: lockfile parity`);
  /** @type {PackageInfo} */
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  assert.equal(installed.version, version, `${name}: installed SDK parity`);
}
assert.equal(manifest.dependencies?.three, manifest.devDependencies?.['@types/three'], 'Three.js runtime/type parity');

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.(?:[cm]?js|ts)$/.test(name) ? [name] : [];
  });
}

const declarations = fs.readFileSync(path.join(root, 'types/firebase-cdn.d.ts'), 'utf8');
const declaredUrls = new Set(Array.from(declarations.matchAll(/declare module ["']([^"']+)["']/g), (match) => match[1]));
const runtimeUrls = new Set();
for (const file of [...sourceFiles('src'), 'index.html', 'auth.html']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/https:\/\/www\.gstatic\.com\/firebasejs\/([^/"'\s]+)\/firebase-([a-z-]+)\.js/g)) {
    assert.equal(match[1], manifest.dependencies?.firebase, `${file}: Firebase CDN matches npm types`);
    assert.ok(declaredUrls.has(match[0]), `${file}: CDN import has official SDK declarations`);
    runtimeUrls.add(match[0]);
  }
}
assert.ok(runtimeUrls.size >= 4, 'Firebase runtime imports were discovered');
assert.deepEqual(declaredUrls, runtimeUrls, 'every CDN declaration corresponds to a runtime SDK import');
console.log('PASS: installed SDKs, lockfile, CDN imports and compiler declarations agree');
