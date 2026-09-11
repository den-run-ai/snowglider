// @ts-check
// Stacked PRs filter on their BASE branch. Gate/review jobs must run above the
// first PR too, while production push/deploy scope stays main-only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml'); // already supplied by the pinned ESLint toolchain

for (const filename of ['ci.yml', 'pr-review.yml']) {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows', filename), 'utf8'));
  const branches = workflow.on.pull_request.branches;
  for (const base of ['main', 'claude/feature/pr1', 'codex/three-gates', 'codex/three/controls']) {
    assert.ok(branches.some(pattern => path.matchesGlob(base, pattern)), `${filename} must run for base ${base}`);
  }
  if (workflow.on.push) assert.deepEqual(workflow.on.push.branches, ['main']);
}
console.log('CI and review run for main and both stacked-PR namespaces; production pushes remain main-only.');
