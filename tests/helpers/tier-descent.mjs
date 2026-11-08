// @ts-check
// Shared G5 course rider and finish-time probe. Tests only: production physics unchanged.
import { Snowman } from '../../src/snowman.ts';
import { AvalancheSystem } from '../../src/avalanche.ts';
import * as terrain from '../../src/mountains/terrain.ts';
import { CourseModule } from '../../src/course.ts';
import { getDifficultyConfig } from '../../src/difficulty.ts';
import { courseLineFor } from '../../src/course-line.ts';
import { FIXED_DT } from '../../src/game/main-loop.ts';
const { getTerrainHeight, getTerrainGradient, getDownhillDirection } = terrain;
const { START_Z, FINISH_Z } = CourseModule._config;
const MAX_TIME = 120;

export const HISTORICAL_SEEDS = Object.freeze([12345, 777, 42, 9001, 31337, 1, 2, 3, 4, 5]);
// Keep every historical seed, then extend mechanically: no outcome-based seed selection.
export const ENSEMBLE_SEEDS = Object.freeze([...HISTORICAL_SEEDS,
  ...Array.from({ length: 56 }, (_, i) => i + 6).filter(s => !HISTORICAL_SEEDS.includes(s)).slice(0, 50)]);

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function fakeSnowman() {
  const ski = () => ({ position: { x: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  return /** @type {any} */ ({
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: Math.PI, z: 0 },
    userData: { targetRotationY: Math.PI, currentRotX: 0, currentRotZ: 0,
      leftSki: ski(), rightSki: ski(), leftSkiBaseX: -1, rightSkiBaseX: 1 },
  });
}
export function summarizeTimes(runs) {
  const times = runs.filter(r => r.finished && !r.buried).map(r => r.time).sort((a, b) => a - b);
  const at = p => times.length ? times[Math.ceil((times.length - 1) * p)] : Infinity;
  return { count: times.length, min: at(0), median: at(0.5), p95: at(0.95), max: at(1) };
}

const LOOKAHEAD = 10;   // z-units downhill to aim at (anticipate the turn)
const DEADBAND = 1.0;   // ignore sub-metre error (avoid steering chatter that bleeds speed)
export function runTierDescent(seed, tier, { mode = 'none', withAvalanche = true } = {}) {
  const config = getDifficultyConfig(tier);
  const line = courseLineFor(config);          // laneX(z); straight tiers ⇒ laneX ≡ 0
  const winds = config.line.curviness > 0 && !!config.terrain;
  // Bank the tier's terrain into its winding channel so the skier skis the REAL corridor
  // (getTerrainHeight then returns the walled channel; setTerrainCorridor resets the
  // height cache). Straight tiers set null ⇒ today's terrain. ALWAYS cleared in the
  // `finally` so the later straight-terrain gates are never served stale corridor heights.
  if (winds) terrain.setTerrainCorridor({ line, params: config.terrain });
  else terrain.setTerrainCorridor(null);
  // Sculpted kickers (JP-6): the tier's designed air is part of its real course —
  // a line rider goes straight off every kicker (they sit ON laneX), so this gate
  // also proves the kicker+lipLaunch arcs land back in the corridor and the run
  // still finishes / out-skis the slide. Cleared in the finally with the corridor.
  terrain.setTerrainKickers(config.features ?? null, line);
  const savedRandom = Math.random;
  const savedLog = console.log;
  let avalanche;
  try {
    Math.random = makeRng(seed);               // one stream: kernel auto-turn AND boulder spawn
    const _log = console.log; console.log = () => {};
    const scene = /** @type {any} */ ({ children: [], add() {}, remove() {}, userData: {} });
    const avc = config.avalanche;
    const av = avalanche = new AvalancheSystem(scene, avc.boulderCount, {
      enabled: withAvalanche && avc.enabled, triggerDistance: avc.triggerDistance,
      slideSpeedBase: avc.slideSpeedBase, slideSpeedJitter: avc.slideSpeedJitter });
    av.setTerrainFunction(getTerrainHeight);
    const snowman = fakeSnowman();
    const startX = line.laneX(START_Z);        // 0 (line is pinned centered at the top)
    const pos = { x: startX, z: START_Z, y: getTerrainHeight(startX, START_Z) };
    const velocity = { x: 0, z: -3 };
    snowman.position.set(pos.x, pos.y, pos.z);
    let st = { isInAir: false, verticalVelocity: 0, lastTerrainHeight: getTerrainHeight(startX, START_Z),
               airTime: 0, jumpCooldown: 0, turnPhase: 0, currentTurnDirection: 0, turnChangeCooldown: 3 };
    const skiTuning = config.ski;              // the tier's kernel tuning (Black runs faster)
    const showGameOver = reason => { outcome = reason; };

    let triggered = false, lastAvZ = START_Z, buried = false, finished = false, t = 0;
    let maxSpeed = 0, minDist = Infinity, maxOffLine = 0, jumps = 0, cleanLandings = 0, jumpedOnce = false;
    let outcome = null;
    while (t < MAX_TIME) {
      t += FIXED_DT;
      // Avalanche FIRST (trigger + advance), exactly as the live loop orders it — gated by
      // the tier's own enabled + arm distance (Bunny never arms; Black arms sooner).
      if (withAvalanche && avc.enabled && !triggered && (lastAvZ - pos.z) > avc.triggerDistance) { av.trigger(snowman.position); triggered = true; }
      if (triggered) av.update(FIXED_DT);

      // Skilled carve: aim at the line a LOOKAHEAD ahead, steer back with a deadband, hold Up.
      const targetX = line.laneX(pos.z - LOOKAHEAD);
      const err = pos.x - targetX;             // + ⇒ too far +x ⇒ press LEFT (LEFT moves toward -x)
      const wantJump = config.ski.manualJump && mode !== 'none' && !st.isInAir && st.jumpCooldown <= 0
        && Math.abs(err) <= DEADBAND && (mode === 'chain' || !jumpedOnce);
      const controls = { left: err > DEADBAND, right: err < -DEADBAND, up: true, down: false, jump: wantJump };
      if (wantJump) { jumps++; jumpedOnce = true; }

      st = Snowman.updateSnowman(snowman, FIXED_DT, pos, velocity, st.isInAir, st.verticalVelocity,
        st.lastTerrainHeight, st.airTime, st.jumpCooldown, controls, st.turnPhase, st.currentTurnDirection,
        st.turnChangeCooldown, 3.0, getTerrainHeight, getTerrainGradient, getDownhillDirection,
        [], true, showGameOver, [], undefined, skiTuning);
      snowman.position.set(pos.x, pos.y, pos.z);

      if (st.landingQuality === 'clean') cleanLandings++;
      if (st.landingQuality === 'wipeout' || (outcome && pos.z > FINISH_Z)) break;
      const sp = Math.hypot(velocity.x, velocity.z); if (sp > maxSpeed) maxSpeed = sp;
      // How far the skier drifts off the centerline: climbing the wall = leaving the makeable
      // corridor. Tracked as the out-of-bounds signal (asserted below).
      maxOffLine = Math.max(maxOffLine, Math.abs(pos.x - line.laneX(pos.z)));
      if (triggered) {
        if (av.checkBurial(snowman.position)) { buried = true; break; }
        minDist = Math.min(minDist, av.getClosestDistance(snowman.position));
        if (av.hasPassed(snowman.position)) { av.reset(); triggered = false; lastAvZ = pos.z; }
      }
      if (pos.z <= FINISH_Z) { finished = true; break; }
    }
    console.log = _log;
    return { tier, buried, finished, maxSpeed, minDist, maxOffLine, z: pos.z,
      time: finished ? t : Infinity, jumps, cleanLandings, outcome };
  } finally {
    avalanche?.dispose();
    Math.random = savedRandom;
    console.log = savedLog;
    terrain.setTerrainCorridor(null);          // restore straight terrain + clear the cache
    terrain.setTerrainKickers(null);           // and drop the tier's kickers (JP-6)
  }
}

