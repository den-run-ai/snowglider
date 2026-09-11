// @ts-check
// Lifecycle event ownership; real driver loss is covered in context-loss.spec.ts.
const assert = require('node:assert/strict');

async function main() {
  const { watchContextLoss } = await import('../src/game/context-loss.ts');
  const canvas = new EventTarget();
  const controller = new AbortController();
  let stops = 0;
  watchContextLoss(canvas, {
    signal: controller.signal,
    isContextLost: () => false,
    onLost: () => { stops++; },
  });
  const loss = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(loss);
  assert.equal(loss.defaultPrevented, true, 'allows the browser restoration protocol');
  assert.equal(stops, 1, 'loss stops this instance');
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(stops, 1, 'restoration and repeated loss cannot restart or redispose');
  controller.abort();
  const afterAbort = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(afterAbort);
  assert.equal(afterAbort.defaultPrevented, false, 'abort removes the canvas listener');

  const earlyController = new AbortController();
  watchContextLoss(canvas, {
    signal: earlyController.signal,
    isContextLost: () => true,
    onLost: () => { stops++; earlyController.abort(); },
  });
  assert.equal(stops, 2, 'loss before listener installation is detected');
  watchContextLoss(canvas, {
    signal: earlyController.signal,
    isContextLost: () => { throw new Error('must not query a disposed renderer'); },
    onLost: () => { throw new Error('must not stop a disposed instance'); },
  });
  console.log('Context loss: 6 assertions passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
