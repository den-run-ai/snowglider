// @ts-check
// Slope display must settle in elapsed time and start each run with its own pitch.
const assert = require('node:assert/strict');

async function main() {
  const { setupDom } = await import('./mocks/dom.mjs');
  const env = setupDom({ html: '<body><span id="slopeValue"></span><span id="groundStatus"></span></body>' });
  const { resetStatsHud, updateStatsHud } = await import('../src/ui/hud.ts');
  const { Physics } = await import('../src/player-state.ts');
  const { createLifecycle } = await import('../src/game/lifecycle.ts');
  const { Snow } = await import('../src/snow.ts');
  const THREE = await import('three');
  const pos = { x: 0, y: 20, z: -15 };
  /** @type {import('../src/snowman.js').UpdateResult} */
  const result = {
    isInAir: false, verticalVelocity: 0, lastTerrainHeight: 20, airTime: 0,
    jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 0,
    currentSpeed: 12, technique: 'carve', justLanded: false, landingForce: 0,
    landingQuality: null, airScoreDelta: 0, trickName: null, obstacleCleared: null,
    obstaclesClearedCount: 0,
  };
  const slopeText = () => env.document.getElementById('slopeValue').textContent;
  const draw = (slope, dt = 1 / 60) => updateStatsHud(result, pos, false, slope, dt);

  resetStatsHud();
  draw(0.9);
  assert.equal(slopeText(), '42° (90%) ◆ Black', 'first steep sample must not show Blue');
  assert.equal(env.document.getElementById('groundStatus').textContent, '🎿 Carving');
  for (const [slope, label] of [[0.32, 'Green'], [0.33, 'Blue'], [0.58, 'Blue'], [0.59, 'Black']]) {
    resetStatsHud();
    draw(slope);
    assert.ok(slopeText().endsWith(String(label)), `initial tier for ${slope} must be ${label}`);
  }

  // Sample the same pitch changes at equal elapsed times, with several frames per
  // segment. The old constant per-frame weight produces different grades/tiers.
  const snapshots = [30, 60, 144].map((hz) => {
    resetStatsHud();
    draw(0.1);
    const readings = [];
    for (const slope of [0.9, 0.9, 0.2, 0.2]) {
      for (let i = 0; i < hz / 6; i++) draw(slope, 1 / hz);
      readings.push(slopeText());
    }
    return readings;
  });
  assert.deepEqual(snapshots[0], snapshots[1], '30/60 Hz slope feedback must agree');
  assert.deepEqual(snapshots[2], snapshots[1], '144/60 Hz slope feedback must agree');
  assert.deepEqual(snapshots[1], [
    '34° (68%) ◆ Black', '40° (84%) ◆ Black', '21° (38%) ■ Blue', '14° (25%) ● Green',
  ], 'retain the existing 60 Hz smoothing response');

  resetStatsHud();
  draw(0.4);
  draw(0.9, 0);
  assert.equal(slopeText(), '22° (40%) ■ Blue', 'zero elapsed time must not advance smoothing');
  draw(0.9, -1);
  assert.equal(slopeText(), '22° (40%) ■ Blue', 'negative elapsed time must not advance smoothing');
  for (const slope of [NaN, Infinity, -1]) draw(slope);
  assert.equal(slopeText(), '22° (40%) ■ Blue', 'invalid slope must retain the last valid reading');
  draw(0.4, NaN);
  draw(0.4, Infinity);
  assert.equal(slopeText(), '22° (40%) ■ Blue', 'invalid delta cannot poison the slope filter');
  for (let i = 0; i < 120; i++) draw(i % 2 ? 0.60 : 0.58);
  assert.match(slopeText(), /■ Blue$/, 'retain the tier deadband near the Black threshold');

  // Drive the actual Reset entry point: it must clear the display even though
  // the existing scene and panel listeners are reused on same-tier replay.
  resetStatsHud();
  draw(0.9);
  const snowman = new THREE.Object3D();
  const player = Physics.createPlayerState(Snow.getTerrainHeight);
  const lifecycle = createLifecycle(/** @type {any} */ ({
    state: { difficulty: 'blue', gameActive: false },
    cameraManager: { initialize() {} }, snowman, player,
    gameOverOverlay: env.document.createElement('div'),
    restartButton: env.document.createElement('button'),
    startLoop() {}, resetLoopState() {},
  }));
  lifecycle.resetSnowman();
  draw(0.1);
  assert.equal(slopeText(), '6° (10%) ● Green', 'Reset must not inherit the previous run slope');
  assert.deepEqual(pos, { x: 0, y: 20, z: -15 }, 'HUD reads cannot move the player');
  assert.equal(result.technique, 'carve', 'HUD reads cannot alter the technique');
  env.teardown();
  console.log('PASS: HUD first sample, refresh-rate parity, hysteresis and live reset regressions');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
