// @ts-check
// Fail-closed result contract shared by the real Puppeteer process and its Node
// regression suite. Console errors from tested fallback paths are not globally
// fatal; uncaught page errors and renderer/shader failures are.
const EXPECTED_SUITES = ['controls', 'camera', 'audio', 'gameplay', 'tree', 'avalanche', 'regression'];

/** @param {string} message */
function isRendererFailure(message) {
  return /WebGLProgram: Shader Error|WebGLRenderer: (?:A WebGL context could not be created|Error creating WebGL context|Context Lost\.)|(?:GL_)?INVALID_(?:OPERATION|VALUE|ENUM):|\[SnowGlider\] Fatal animation-loop error/.test(message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Browser snapshots cross the CDP boundary and can be incomplete or malformed.
 * @param {unknown} results
 * @param {readonly string[]} [pageErrors]
 * @param {readonly string[]} [rendererErrors]
 * @returns {string[]}
 */
function validateBrowserResults(results, pageErrors = [], rendererErrors = []) {
  const failures = [];
  if (!isRecord(results)) return ['Browser results are missing'];
  if (results.timeout) failures.push('Browser tests timed out');
  if (typeof results.passed !== 'number' || !Number.isInteger(results.passed) || results.passed < 0 ||
      typeof results.failed !== 'number' || !Number.isInteger(results.failed) || results.failed < 0) {
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
    const suite = isRecord(results.suiteResults) ? results.suiteResults[name] : undefined;
    if (!isRecord(suite) || typeof suite.assertions !== 'number' || !Number.isInteger(suite.assertions) || suite.assertions <= 0) {
      failures.push(`${name}: no valid assertion count reported`);
    }
    if (isRecord(suite) && suite.error) failures.push(`${name}: ${suite.error}`);
  }
  if (!Array.isArray(results.runnerErrors) || !results.runnerErrors.every(error => typeof error === 'string')) failures.push('Runner error report is missing or invalid');
  else failures.push(...results.runnerErrors);
  failures.push(...pageErrors.map(error => `Uncaught page error: ${error}`));
  failures.push(...rendererErrors.map(error => `Renderer error: ${error}`));
  return failures;
}

module.exports = { EXPECTED_SUITES, isRendererFailure, validateBrowserResults };
