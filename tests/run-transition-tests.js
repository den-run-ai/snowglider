// @ts-check
// The same one-shot tier intent must feed the next scene and menu even without
// browser storage. Consuming it prevents accidental replay after refresh/sharing.
const assert = require('node:assert/strict');
(async () => {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ url: 'https://snowglider.ai/?seed=123&play=black#run' });
  const transition = await import('../src/game/run-transition.ts');
  assert.equal(transition.readRunLaunch('?play=expert'), 'expert');
  assert.equal(transition.readRunLaunch('?play=invalid'), null);
  assert.equal(transition.readRunLaunch('?play=<script>'), null);
  assert.equal(transition.readRunLaunch('?play=bunny&play=black'), null);
  assert.equal(transition.readRunLaunch('?play=%E0%A4%A'), null);
  assert.equal(transition.readRunLaunch(''), null);
  assert.equal(transition.initialRunDifficulty(), 'black');
  assert.equal(transition.consumeRunLaunch(), 'black');
  assert.equal(transition.consumeRunLaunch(), null);
  assert.equal(transition.initialRunDifficulty(), 'black', 'consuming intent cannot change the scene tier');
  assert.equal(env.window.location.href, 'https://snowglider.ai/?seed=123#run');
  const next = transition.runLaunchUrl(env.window.location.href, 'bunny');
  assert.equal(next, 'https://snowglider.ai/?seed=123&play=bunny#run');
  // No storage operation participates in the handoff, including URL replacement.
  Object.defineProperty(env.window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  assert.equal(transition.initialRunDifficulty(), 'black');
  assert.equal(transition.readRunLaunch(new URL(next).search), 'bunny');
  env.teardown();
  console.log('Run transition: enum validation, one-shot consumption, scene consistency, URL cleanup, blocked storage passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
