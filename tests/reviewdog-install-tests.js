// @ts-check
// Exercise the real installer without network access. A local archive stands in
// for the upstream binary; the checksum command checks the pinned release digest
// supplied by the installer, then verifies our fixture's real SHA-256.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts/install-reviewdog.sh');
const releaseSha256 = 'ad5ce7d5ffa52aaa7ec8710a8fa764181b6cecaab843cc791e1cce1680381569';
const releaseUrl = 'https://github.com/reviewdog/reviewdog/releases/download/v0.21.0/reviewdog_0.21.0_Linux_x86_64.tar.gz';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewdog install test-'));
const commands = path.join(scratch, 'commands');
fs.mkdirSync(commands);

const commandStub = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const assert = require('node:assert/strict');",
  "const { createHash } = require('node:crypto');",
  'const args = process.argv.slice(2);',
  'const command = path.basename(process.argv[1]);',
  "if (command === 'uname') {",
  "  console.log(process.env.REVIEWDOG_TEST_PLATFORM || 'Linux x86_64');",
  "} else if (command === 'curl') {",
  "  fs.writeFileSync(process.env.REVIEWDOG_TEST_CURL_ARGS, JSON.stringify(args));",
  "  const output = args[args.indexOf('--output') + 1];",
  "  if (process.env.REVIEWDOG_TEST_DOWNLOAD_FAIL === '1') {",
  "    fs.writeFileSync(output, 'partial download');",
  "    console.error('curl: (22) fixture HTTP 503');",
  '    process.exit(22);',
  '  }',
  '  fs.copyFileSync(process.env.REVIEWDOG_TEST_ARCHIVE, output);',
  "  if (process.env.REVIEWDOG_TEST_CORRUPT === '1') fs.appendFileSync(output, 'corruption');",
  "} else if (command === 'sha256sum') {",
  "  assert.deepEqual(args, ['--check', '--strict']);",
  "  const line = fs.readFileSync(0, 'utf8').trimEnd();",
  "  assert.ok(line.startsWith(process.env.REVIEWDOG_TEST_RELEASE_SHA + '  '));",
  '  const archive = line.slice(66);',
  "  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');",
  '  if (digest !== process.env.REVIEWDOG_TEST_FIXTURE_SHA) {',
  "    console.error('sha256sum: checksum did NOT match');",
  '    process.exit(1);',
  '  }',
  "  console.log(archive + ': OK');",
  '} else { process.exit(2); }',
].join('\n');
for (const command of ['curl', 'sha256sum', 'uname']) {
  fs.writeFileSync(path.join(commands, command), commandStub, { mode: 0o755 });
}

/**
 * @param {string} name
 * @param {{ version?: string, corrupt?: boolean, downloadFails?: boolean, platform?: string, omitContext?: boolean }} options
 */
function runCase(name, options = {}) {
  const directory = path.join(scratch, name);
  const payload = path.join(directory, 'payload');
  const runnerTemp = path.join(directory, 'runner temp');
  const githubPath = path.join(directory, 'github-path');
  const archive = path.join(directory, 'fixture.tar.gz');
  const curlArgs = path.join(directory, 'curl-args.json');
  const executed = path.join(directory, 'executed');
  fs.mkdirSync(payload, { recursive: true });
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(githubPath, '');
  fs.writeFileSync(path.join(payload, 'reviewdog'), [
    '#!/bin/sh',
    'printf "ran\\n" >> "$REVIEWDOG_TEST_EXECUTED"',
    '[ "$1" = "-version" ] || exit 2',
    'printf "%s\\n" "' + (options.version ?? '0.21.0') + '"',
  ].join('\n'), { mode: 0o755 });
  const packed = spawnSync('tar', ['-czf', archive, '-C', payload, 'reviewdog'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const env = {
    ...process.env,
    PATH: commands + path.delimiter + process.env.PATH,
    RUNNER_TEMP: runnerTemp,
    GITHUB_PATH: githubPath,
    REVIEWDOG_TEST_ARCHIVE: archive,
    REVIEWDOG_TEST_CURL_ARGS: curlArgs,
    REVIEWDOG_TEST_RELEASE_SHA: releaseSha256,
    REVIEWDOG_TEST_FIXTURE_SHA: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    REVIEWDOG_TEST_EXECUTED: executed,
    REVIEWDOG_TEST_DOWNLOAD_FAIL: options.downloadFails ? '1' : '0',
    REVIEWDOG_TEST_CORRUPT: options.corrupt ? '1' : '0',
    REVIEWDOG_TEST_PLATFORM: options.platform ?? 'Linux x86_64',
  };
  if (options.omitContext) {
    delete env.RUNNER_TEMP;
    delete env.GITHUB_PATH;
  }
  const result = spawnSync('bash', [installer], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, name + ' must complete without a timeout');
  assert.ok(!fs.readdirSync(runnerTemp).some(entry => entry.startsWith('reviewdog-install.')),
    name + ' cleans its staging directory');
  return { ...result, env, githubPath, runnerTemp, curlArgs, executed };
}

try {
  const success = runCase('success');
  assert.equal(success.status, 0, success.stderr);
  const published = fs.readFileSync(success.githubPath, 'utf8').trim();
  assert.equal(published, path.join(success.runnerTemp, 'reviewdog-bin'));
  assert.match(success.stdout, /Verified reviewdog 0\.21\.0/);
  const args = JSON.parse(fs.readFileSync(success.curlArgs, 'utf8'));
  assert.equal(args.at(-1), releaseUrl);
  for (const flag of ['--fail', '--show-error', '--location', '--retry-all-errors']) assert.ok(args.includes(flag));
  for (const [flag, value] of [
    ['--retry', '3'], ['--retry-delay', '2'], ['--retry-max-time', '180'],
    ['--connect-timeout', '10'], ['--max-time', '45'],
    ['--proto', '=https'], ['--proto-redir', '=https'],
  ]) assert.equal(args[args.indexOf(flag) + 1], value, flag + ' stays bounded');

  // action-eslint@v1.34.0's exact script prepends an empty temporary directory,
  // retains inherited PATH, ignores its installer failure, then invokes reviewdog.
  // Pin that fallback contract without making tests download or execute an action.
  const fallback = spawnSync('sh', ['-c', [
    'TEMP_PATH="$(mktemp -d "$RUNNER_TEMP/action.XXXXXX")"',
    'trap \'rm -rf "$TEMP_PATH"\' EXIT',
    'PATH="$TEMP_PATH:$PATH"',
    'false',
    'reviewdog -version',
  ].join('\n')], {
    env: { ...success.env, PATH: published + path.delimiter + success.env.PATH },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout.trim(), '0.21.0');

  for (const { name, options, diagnostic, canExecute } of [
    { name: 'download-failure', options: { downloadFails: true }, diagnostic: /fixture HTTP 503/, canExecute: false },
    { name: 'corrupt-archive', options: { corrupt: true }, diagnostic: /checksum did NOT match/, canExecute: false },
    { name: 'wrong-version', options: { version: '0.20.0' }, diagnostic: /Expected reviewdog 0\.21\.0; received 0\.20\.0/, canExecute: true },
    { name: 'unsupported-platform', options: { platform: 'Linux aarch64' }, diagnostic: /requires Linux x86_64/, canExecute: false },
    { name: 'missing-context', options: { omitContext: true }, diagnostic: /RUNNER_TEMP and GITHUB_PATH must be set/, canExecute: false },
  ]) {
    const result = runCase(name, options);
    assert.notEqual(result.status, 0, name + ' must fail closed');
    assert.match(result.stderr, diagnostic);
    assert.equal(fs.readFileSync(result.githubPath, 'utf8'), '', name + ' must not publish PATH');
    assert.ok(!fs.existsSync(path.join(result.runnerTemp, 'reviewdog-bin')), name + ' must not install');
    assert.equal(fs.existsSync(result.executed), canExecute, name + ' execution boundary');
  }

  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/pr-review.yml'), 'utf8'));
  const steps = workflow.jobs['eslint-reviewdog'].steps;
  const setup = steps.findIndex(step => step.run === 'bash scripts/install-reviewdog.sh');
  const review = steps.findIndex(step => step.uses === 'reviewdog/action-eslint@v1.34.0');
  assert.ok(setup >= 0 && setup < review, 'verified setup must precede review');
  assert.equal(steps[setup]['timeout-minutes'], 4);
  assert.equal(steps[setup]['continue-on-error'], undefined);
  assert.deepEqual(steps[review].with, {
    github_token: '$' + '{{ secrets.GITHUB_TOKEN }}',
    reporter: 'github-pr-review',
    filter_mode: 'added',
    fail_level: 'none',
    level: 'warning',
    eslint_flags: '.',
  });
  console.log('Reviewdog installer: verified PATH fallback, download/checksum/version/platform failures, cleanup and unchanged review policy pass.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
