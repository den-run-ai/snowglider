// @ts-check
// Fail-closed result contract shared by the real Puppeteer process and its Node
// regression suite. Console errors from tested fallback paths are not globally
// fatal; uncaught page errors and renderer/shader failures are.
const EXPECTED_SUITES = ['controls', 'camera', 'audio', 'gameplay', 'tree', 'avalanche', 'regression'];

function isRendererFailure(message) {
  return /WebGLProgram: Shader Error|WebGLRenderer: (?:A WebGL context could not be created|Error creating WebGL context)|(?:GL_)?INVALID_(?:OPERATION|VALUE|ENUM):|\[SnowGlider\] Fatal animation-loop error/.test(message);
}

function validateBrowserResults(results, pageErrors = [], rendererErrors = []) {
  const failures = [];
  if (!results || typeof results !== 'object') return ['Browser results are missing'];
  if (results.timeout) failures.push('Browser tests timed out');
  if (!Number.isInteger(results.passed) || results.passed < 0 ||
      !Number.isInteger(results.failed) || results.failed < 0) {
    failures.push('Assertion totals are invalid');
  } else {
    if (results.failed > 0) failures.push(`${results.failed} browser assertions/runner checks failed`);
    if (results.passed + results.failed === 0) failures.push('No browser assertions ran');
  }
  const expected = results.expectedSuites;
  if (!Array.isArray(expected) || expected.length !== EXPECTED_SUITES.length ||
      EXPECTED_SUITES.some((name, index) => expected[index] !== name)) {
    failures.push('Expected suite manifest is missing or changed');
  }
  const completed = Array.isArray(results.completed) ? results.completed : [];
  if (completed.length !== EXPECTED_SUITES.length || new Set(completed).size !== completed.length ||
      EXPECTED_SUITES.some(name => !completed.includes(name))) {
    failures.push('Browser suites are missing, unknown, or completed more than once');
  }
  for (const name of EXPECTED_SUITES) {
    const suite = results.suiteResults?.[name];
    if (!suite || !Number.isInteger(suite.assertions) || suite.assertions <= 0) {
      failures.push(`${name}: no valid assertion count reported`);
    }
    if (suite?.error) failures.push(`${name}: ${suite.error}`);
  }
  if (!Array.isArray(results.runnerErrors)) failures.push('Runner error report is missing');
  else failures.push(...results.runnerErrors);
  failures.push(...pageErrors.map(error => `Uncaught page error: ${error}`));
  failures.push(...rendererErrors.map(error => `Renderer error: ${error}`));
  return failures;
}

module.exports = { EXPECTED_SUITES, isRendererFailure, validateBrowserResults };
