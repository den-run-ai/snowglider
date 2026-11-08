// @ts-check
const assert = require('node:assert/strict');
(async () => {
  const { runTelemetryContext } = await import('../src/run-telemetry.js');
  const { setWorldContext, setRunSeed, PHYSICS_VERSION } = await import('../src/run-context.js');
  setWorldContext(1234, true);
  assert.deepEqual(runTelemetryContext('expert', true), {
    difficulty: 'expert', physics_version: PHYSICS_VERSION,
    practice: 'true', timing_compromised: 'true',
  });
  setRunSeed(null);
  assert.deepEqual(runTelemetryContext('blue'), {
    difficulty: 'blue', physics_version: PHYSICS_VERSION,
    practice: 'false', timing_compromised: 'false',
  });
  console.log('Run telemetry: practice/restart isolation and bounded context passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
