// Exercise the real CLI entry points using disposable git refs and mocked HTTP.
// No release, issue, comment, branch, or credential outside the fixture is touched.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const scripts = resolve(__dirname, '../scripts');
const scratch = mkdtempSync(join(tmpdir(), 'snowglider-assets-test-'));
const oldUrl = 'https://raw.githubusercontent.com/fixture/repo/assets/proof/shot.png';
const newUrl = 'https://github.com/fixture/repo/releases/download/assets/proof$&.png';
let passed = 0;
let failed = 0;

function check(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixture(name, files = ['shot.png']) {
  const cwd = join(scratch, name);
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('config', 'user.name', 'Asset test');
  git('config', 'user.email', 'asset-test@example.invalid');
  for (const file of files) {
    mkdirSync(resolve(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), 'synthetic image fixture');
  }
  git('add', '--all');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Asset fixture');
  git('update-ref', 'refs/remotes/origin/assets/proof', 'HEAD');
  return cwd;
}

function invoke(cwd, script, args = [], mode = 'deny') {
  const requests = join(cwd, 'requests.jsonl');
  const hook = join(cwd, 'mock-http.mjs');
  writeFileSync(requests, '');
  writeFileSync(hook, `
    import { appendFileSync } from 'node:fs';
    const oldUrl = ${JSON.stringify(oldUrl)};
    const newUrl = ${JSON.stringify(newUrl)};
    const mode = ${JSON.stringify(mode)};
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      const method = options.method || 'GET';
      appendFileSync(${JSON.stringify(requests)}, JSON.stringify({
        url, method, body: method === 'PATCH' ? JSON.parse(options.body) : null,
      }) + '\\n');
      if (mode === 'deny') throw new Error('Unexpected network access');
      if (mode === 'upload') {
        if (url.includes('/releases/tags/')) return Response.json({ id: 1, assets: [] });
        if (url.startsWith('https://uploads.github.com/')) return Response.json({ browser_download_url: newUrl });
      }
      if (mode === 'rewrite') {
        if (method === 'PATCH') return Response.json({});
        if (url.includes('/issues?')) return Response.json([{ number: 1,
          body: '![shot](' + oldUrl + '?v=1) ' + oldUrl + '.backup <img src="' + oldUrl + '?v=2">',
        }]);
        if (url.includes('/issues/comments?')) return Response.json([{ id: 2, body: oldUrl }]);
      }
      throw new Error('Unexpected mocked request: ' + method + ' ' + url);
    };
  `);
  const result = spawnSync(process.execPath, ['--import', hook, resolve(scripts, script), ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'synthetic-test-token', GH_TOKEN: '' },
  });
  if (result.error) throw result.error;
  return { ...result, requests: readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

try {
  const cwd = fixture('ordinary');
  const manifest = join(cwd, 'asset-manifest.json');
  check('migration dry-run never creates a manifest or sends requests', () => {
    const result = invoke(cwd, 'migrate-asset-branches.mjs', ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would upload/);
    assert.equal(existsSync(manifest), false);
    assert.equal(result.requests.length, 0);
  });

  check('migration dry-run preserves a completed manifest byte for byte', () => {
    const saved = JSON.stringify({ [oldUrl]: newUrl }, null, 2) + '\n';
    writeFileSync(manifest, saved);
    const result = invoke(cwd, 'migrate-asset-branches.mjs', ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(manifest, 'utf8'), saved);
    assert.equal(result.requests.length, 0);
  });

  check('flat-name collisions stop a real migration before uploading', () => {
    const collision = fixture('collision', ['a/b.png', 'a__b.png']);
    const result = invoke(collision, 'migrate-asset-branches.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Asset name collision/);
    assert.equal(result.requests.length, 0);
    assert.equal(existsSync(join(collision, 'asset-manifest.json')), false);
  });

  check('misspelled dry-run and incomplete tag arguments cannot trigger migration', () => {
    for (const args of [['--dryrun'], ['--tag'], ['--tag', '--dry-run']]) {
      const result = invoke(cwd, 'migrate-asset-branches.mjs', args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unexpected or incomplete argument/);
      assert.equal(result.requests.length, 0);
    }
  });

  check('legacy dry-run placeholders are rejected before any GitHub request', () => {
    writeFileSync(manifest, JSON.stringify({ [oldUrl]: '(dry-run) -> release:assets/proof.png' }));
    const result = invoke(cwd, 'rewrite-asset-links.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid asset manifest/);
    assert.equal(result.requests.length, 0);
  });

  check('invalid and cross-repository manifests fail closed', () => {
    for (const bad of [null, [], {}, { [oldUrl]: null }, { [oldUrl]: 'javascript:bad' },
      { [oldUrl]: 'https://github.com/other/repo/releases/download/assets/shot.png' },
      { [oldUrl]: 'https://github.com/fixture/repo/releases/download/assets/' },
      { [oldUrl]: 'https://github.com/fixture/repo/releases/download/../shot.png' },
      { 'https://example.invalid/shot.png': newUrl }]) {
      writeFileSync(manifest, JSON.stringify(bad));
      const result = invoke(cwd, 'rewrite-asset-links.mjs', ['--dry-run']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid asset manifest/);
      assert.equal(result.requests.length, 0);
    }
  });

  check('rewrite dry-run reads bodies but never patches them', () => {
    writeFileSync(manifest, JSON.stringify({ [oldUrl]: newUrl }));
    const result = invoke(cwd, 'rewrite-asset-links.mjs', ['--dry-run'], 'rewrite');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 bodies\/comments would be rewritten/);
    assert(result.requests.length > 0);
    assert(result.requests.every(request => request.method === 'GET'));
  });

  check('rewrites exact URLs and cache-busters without changing longer filenames', () => {
    const result = invoke(cwd, 'rewrite-asset-links.mjs', [], 'rewrite');
    assert.equal(result.status, 0, result.stderr);
    const patches = result.requests.filter(request => request.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.equal(patches[0].body.body,
      `![shot](${newUrl}) ${oldUrl}.backup <img src="${newUrl}">`);
    assert.equal(patches[1].body.body, newUrl, 'replacement dollar signs stay literal');
  });

  check('a misspelled rewrite dry-run flag cannot patch anything', () => {
    const result = invoke(cwd, 'rewrite-asset-links.mjs', ['--dryrun'], 'rewrite');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected argument/);
    assert.equal(result.requests.length, 0);
  });

  check('incomplete uploader flags cannot replace a default-named asset', () => {
    for (const args of [['--name'], ['--tag'], ['--name', '--tag'], ['--tag', '--name']]) {
      const result = invoke(cwd, 'upload-release-asset.mjs', [join(cwd, 'shot.png'), ...args], 'upload');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Missing value for/);
      assert.equal(result.requests.length, 0);
    }
  });

  check('the uploader executes from a checkout path containing spaces', () => {
    const directory = join(cwd, 'tools with spaces');
    mkdirSync(directory);
    const uploader = join(directory, 'upload-release-asset.mjs');
    writeFileSync(uploader, readFileSync(join(scripts, 'upload-release-asset.mjs')));
    const result = invoke(cwd, uploader, [join(cwd, 'shot.png')], 'upload');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), newUrl);
    assert(result.requests.some(request => request.method === 'POST'));
  });

  check('only a successful migration writes real returned download URLs', () => {
    const result = invoke(cwd, 'migrate-asset-branches.mjs', [], 'upload');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), { [oldUrl]: newUrl });
    const saved = readFileSync(manifest, 'utf8');
    const interrupted = invoke(cwd, 'migrate-asset-branches.mjs');
    assert.notEqual(interrupted.status, 0);
    assert.equal(readFileSync(manifest, 'utf8'), saved, 'a failed upload preserves the previous complete manifest');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`Asset migration: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
