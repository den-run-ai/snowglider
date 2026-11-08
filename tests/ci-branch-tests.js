// @ts-check
// Stacked PRs filter on their BASE branch. Gate/review jobs must run above the
// first PR too, while production push/deploy scope stays main-only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml'); // already supplied by the pinned ESLint toolchain
const coverage = require('./coverage/playwright-coverage.js');

for (const filename of ['ci.yml', 'pr-review.yml']) {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows', filename), 'utf8'));
  const branches = workflow.on.pull_request.branches;
  for (const base of ['main', 'claude/feature/pr1', 'codex/three-gates', 'codex/three/controls']) {
    assert.ok(branches.some(pattern => path.matchesGlob(base, pattern)), `${filename} must run for base ${base}`);
  }
  if (workflow.on.push) assert.deepEqual(workflow.on.push.branches, ['main']);
}
console.log('CI and review run for main and both stacked-PR namespaces; production pushes remain main-only.');

// Real frame probes need their own resources, but splitting the job must not
// omit other browser specs, discard capture attachments or disable UI coverage.
const ci = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
const steps = ci.jobs.e2e.steps;
const captureIndex = steps.findIndex(step => step.run?.includes('performance-capture.spec.ts --workers=1'));
const matrixIndex = steps.findIndex(step => step.run?.includes('--grep-invert'));
assert.ok(captureIndex >= 0 && matrixIndex > captureIndex);
const capture = steps[captureIndex];
const matrix = steps[matrixIndex];
assert.equal(capture['continue-on-error'], undefined);
assert.equal(capture.if, '$' + '{{ !cancelled() }}');
assert.equal(matrix.if, '$' + '{{ !cancelled() }}');
assert.ok(ci.jobs['deploy-pages'].needs.includes('e2e'), 'all browser stages remain a publication gate');

const report = steps[captureIndex + 1];
assert.equal(report.uses, 'actions/upload-artifact@v7');
assert.equal(report.if, 'always()');
assert.equal(report.with.name, 'playwright-report-performance-capture');
assert.equal(report.with.path.replace(/\/$/, ''), capture.env.PLAYWRIGHT_HTML_OUTPUT_DIR);
assert.notEqual(capture.env.PLAYWRIGHT_HTML_OUTPUT_DIR, matrix.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? 'playwright-report');

const previousCoverage = process.env.E2E_COVERAGE;
try {
  process.env.E2E_COVERAGE = capture.env.E2E_COVERAGE;
  assert.equal(coverage.isEnabled(), false, 'capture must observe uninstrumented frames');
  process.env.E2E_COVERAGE = matrix.env.E2E_COVERAGE;
  assert.equal(coverage.isEnabled(), true, 'the normal UI matrix still collects coverage');
} finally {
  if (previousCoverage === undefined) delete process.env.E2E_COVERAGE;
  else process.env.E2E_COVERAGE = previousCoverage;
}

const exclusion = new RegExp(matrix.run.match(/--grep-invert '([^']+)'/)[1]);
const isolatedSpecs = new Set(['perf-budget.spec.ts', 'performance-capture.spec.ts']);
for (const spec of fs.readdirSync(path.join(__dirname, 'e2e')).filter(name => name.endsWith('.spec.ts') && !name.startsWith('pwa-'))) {
  assert.equal(exclusion.test(spec), isolatedSpecs.has(spec), spec + ' must run in exactly its intended browser stage');
}
console.log('Capture runs alone with durable reports; all other UI specs, coverage and publication gates stay active.');
