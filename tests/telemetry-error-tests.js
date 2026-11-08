// @ts-check
const assert = require('node:assert/strict');

async function main() {
  const { buildErrorReport, ErrorReportBudget, errorLocation } = await import('../src/telemetry-error.js');
  const sensitive = 'person@example.invalid https://example.invalid/callback?token=secret';
  const report = buildErrorReport(Object.assign(new TypeError(sensitive), {
    code: sensitive,
  }), sensitive, '', Infinity, 12);
  assert.equal(report.params.error_type, 'TypeError');
  assert.equal(report.params.error_code, 'unknown');
  assert.equal(report.params.source, 'caught_error');
  assert.equal(report.params.line, 0);
  assert.equal(report.params.column, 12);
  assert.ok(!JSON.stringify(report.params).includes(sensitive));
  assert.ok(!('message' in report.params) && !('stack' in report.params));
  assert.ok(report.local.message.includes(sensitive));
  assert.ok(report.local.stack.includes(sensitive));
  assert.ok(Object.values(report.params).every(v => typeof v !== 'string' || v.length <= 100));

  const hostile = new Proxy({}, { get() { throw new Error('hostile getter'); } });
  assert.equal(buildErrorReport(hostile, 'animation_loop').local.message, 'error');
  assert.equal(buildErrorReport({ message: 'm'.repeat(2000), stack: 's'.repeat(8000) }, '').local.message.length, 1000);
  assert.equal(buildErrorReport({ stack: 's'.repeat(8000) }, '').local.stack.length, 4000);
  assert.equal(buildErrorReport('plain string', '').local.message, 'plain string');
  assert.equal(buildErrorReport({ code: 'auth/popup-blocked' }, '').params.error_code, 'auth/popup-blocked');

  const location = errorLocation(
    'TypeError: private\n at handler (https://snowglider.ai/assets/index-ABC123.js?token=secret#person:12:34)',
    '', 0, 0, 'https://snowglider.ai');
  assert.deepEqual(location, { script: '/assets/index-ABC123.js', line: 12, column: 34 });
  assert.equal(errorLocation('', 'https://elsewhere.invalid/src/private.ts', 1, 2,
    'https://snowglider.ai').script, 'unknown');
  assert.equal(errorLocation('', 'https://snowglider.ai/users/person@example.invalid', 1, 2,
    'https://snowglider.ai').script, 'unknown');
  assert.equal(errorLocation('', 'https://user:password@snowglider.ai/src/auth.ts', 1, 2,
    'https://snowglider.ai').script, 'unknown');
  assert.deepEqual(errorLocation('', 'https://snowglider.ai/src/game/main-loop.ts?debug=private', 7, 8,
    'https://snowglider.ai'), { script: '/src/game/main-loop.ts', line: 7, column: 8 });

  const budget = new ErrorReportBudget(2);
  const first = buildErrorReport(new TypeError('first'), 'animation_loop').params;
  assert.equal(budget.accept('client_error', first), true);
  assert.equal(budget.accept('client_error', first), false);
  assert.equal(budget.accept('client_error', buildErrorReport(new RangeError('second'), 'animation_loop').params), true);
  assert.equal(budget.accept('client_error', buildErrorReport(new ReferenceError('third'), 'animation_loop').params), false);
  budget.clear();
  assert.equal(budget.accept('client_error', first), true);
  console.log('PASS: private error text, hostile getters, GA4 limits, deduplication and upload budget');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
