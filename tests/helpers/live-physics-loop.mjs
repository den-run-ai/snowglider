// @ts-check
// Drive the SHIPPED createMainLoop accumulator, replacing only its DOM/renderer
// dependencies. The stepPlayer wrapper supplies simulated held controls and observes
// each real collision-time step; it does not replace physics or accumulator math.
import { setupDom } from '../mocks/dom.mjs';
import { createMainLoop, FIXED_DT, MAX_SUBSTEPS } from '../../src/game/main-loop.ts';
import { Physics } from '../../src/player-state.ts';
import { CourseModule } from '../../src/course.ts';
export { FIXED_DT, MAX_SUBSTEPS };

export function livePhysicsLoop({ snowman, pos, velocity, treePositions, rockPositions,
  controlsAt, onStep, showGameOver, stopOnOutcome = true }) {
  const g = /** @type {any} */ (globalThis);
  const saved = { window: g.window, document: g.document, raf: g.requestAnimationFrame };
  const env = setupDom();
  env.window.HTMLCanvasElement.prototype.getContext = () => null;
  env.window.testHooks = {};
  env.window.isTestMode = false; // preserve actual collision eligibility
  g.requestAnimationFrame = () => 1;
  const savedStep = Physics.stepPlayer;
  const savedCourse = CourseModule.update;
  CourseModule.update = () => {};
  const player = { pos, velocity, isInAir: false, verticalVelocity: 0,
    lastTerrainHeight: pos.y, airTime: 0, jumpCooldown: 0,
    turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
  const state = /** @type {any} */ ({
    gameActive: true, animationRunning: true, gameInitialized: true,
    avalanche: null, snowTrails: null, snowDepth: null, debris: null, scenery: null,
    avalancheTriggered: false, lastAvalancheZ: pos.z, dodgeAwarded: false,
    startTime: 0, bestTime: Infinity, difficulty: 'blue', builtDifficulty: 'blue',
  });
  let simulationTime = 0;
  Physics.stepPlayer = (p, deps) => {
    const prev = { x: pos.x, y: pos.y, z: pos.z };
    const result = savedStep(p, { ...deps, controls: controlsAt(simulationTime) });
    simulationTime += deps.delta;
    onStep({ prev, result, time: simulationTime, delta: deps.delta });
    return result;
  };
  const loop = createMainLoop(/** @type {any} */ ({
    state, player, snowman, treePositions, rockPositions, snowSplash: null,
    scene: { children: [] },
    renderer: { render() {}, setSize() {}, domElement: env.document.createElement('canvas') },
    camera: { position: { x: 0, y: 0, z: 0 }, fov: 75, updateProjectionMatrix() {} },
    cameraManager: { update() {}, handleResize() {} },
    directionalLight: { position: { set() {}, copy() {} },
      target: { position: { set() {} }, updateMatrixWorld() {} }, shadow: { normalBias: 0 } },
    showGameOver(reason) { if (stopOnOutcome) state.gameActive = false; showGameOver(reason); },
  }));
  // animate's initial lastTime is zero. No performance.now() rounding may change
  // profile step counts: start directly at timestamp zero on a reset loop.
  loop.resetLoopState();
  let timestamp = 0;
  return {
    frame(delta) {
      timestamp += delta * 1000;
      loop.animate(timestamp);
      if (!state.animationRunning) throw new Error('live accumulator stopped after a fatal frame');
    },
    stop() { state.gameActive = false; },
    dispose() {
      Physics.stepPlayer = savedStep;
      CourseModule.update = savedCourse;
      env.teardown();
      g.window = saved.window;
      g.document = saved.document;
      g.requestAnimationFrame = saved.raf;
    },
  };
}
