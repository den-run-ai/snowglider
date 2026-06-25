// course.ts - Course structure, split timing, ghost racing and result screen for SnowGlider
//
// This module turns the open slope into a timed course:
//   - Visible checkpoint gates and a finish arch placed down the fall line
//   - Live split times at each checkpoint, compared against your personal best
//   - A progress bar / distance-to-finish HUD so the objective is always legible
//   - A translucent "ghost" of your best run that you race in real time
//   - A result screen with per-checkpoint splits and a medal
//
// Design notes:
//   - The course runs from START_Z (top) to FINISH_Z (bottom); the snowman moves
//     in the -Z direction, matching the finish trigger in snowman.js (pos.z < -195).
//   - Gates are decorative (non-colliding) so they never fight the tree-collision
//     system; they exist to mark the line and the split points.
//   - Best splits and the best-run trajectory are persisted in localStorage and only
//     committed when a run sets a new personal best, so the ghost is always your best.
//
// Phase 2.2 (issue #84): second module converted off the classic global model.
// `THREE` now comes from the npm package via a real ES-module import instead of
// the CDN global, and `CourseModule` is `export`ed; it is loaded into the page
// through the bundle entry (src/main.js) and imported directly by snowglider.js.
//
// Phase 3.1 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file) and the previously inferred course/ghost/HUD
// shapes are now real `interface`/`type` declarations. Behaviour is unchanged —
// every edit is type-only/erasable, so esbuild (Vite) and Node's native
// type-stripping both run it exactly as before.
import * as THREE from 'three';
import { buildShareControls } from './ui/share-menu.js';
import type { CaptureContext } from './share-card.js';

/** Terrain sampler injected via {@link CourseModule.init}. */
export type TerrainHeightFn = (x: number, z: number) => number;

/** Factory that builds a fresh snowman group, reused to spawn the ghost. */
export type CreateSnowmanFn = (scene: THREE.Scene) => THREE.Object3D;

/** One recorded point on a run's trajectory; the persisted ghost is an array of these. */
export interface GhostSample {
  t: number;   // seconds since run start
  x: number;
  y: number;
  z: number;
  rot: number; // snowman heading (radians)
}

/** A checkpoint or the finish line along the fall line. */
export interface SplitPoint {
  z: number;
  label: string;
}

/** Options handed to {@link CourseModule.init}. */
export interface CourseInitOptions {
  scene: THREE.Scene;
  getTerrainHeight: TerrainHeightFn;
  createSnowman: CreateSnowmanFn;
  // Optional renderer/camera so the result screen's "Save image" share can
  // capture the live game frame (see src/share-card.ts). Omitted in headless
  // tests, where the share card falls back to a gradient background.
  renderer?: THREE.WebGLRenderer;
  camera?: THREE.Camera;
}

/** Result of {@link medalFor}: which medal a finished run earned. */
export interface Medal {
  key: 'gold' | 'silver' | 'bronze' | 'finish';
  icon: string;
  label: string;
}

/** Minimal positional shape the course reads from the player each frame. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Lazily-built course HUD element handles. */
interface CourseHud {
  root?: HTMLDivElement;
  fill?: HTMLDivElement;
  distance?: HTMLSpanElement;
  ghostDelta?: HTMLSpanElement;
  flash?: HTMLDivElement;
}

export const CourseModule = (function () {
  'use strict';

  // --- Course geometry (world units; 1 unit == 1 metre for the HUD) ---
  const START_Z = -15;
  const FINISH_Z = -195;
  const CHECKPOINT_Z = [-60, -105, -150]; // intermediate gates; finish handled separately
  const GATE_HALF_WIDTH = 9;              // poles sit at x = +/- this, framing the lane
  const FINISH_HALF_WIDTH = 14;
  const COURSE_LENGTH = Math.abs(FINISH_Z - START_Z);

  // Ghost sampling cadence
  const SAMPLE_INTERVAL = 0.05; // seconds between recorded trajectory samples (~20 Hz)

  // localStorage keys
  const LS_SPLITS = 'snowgliderBestSplits';
  const LS_GHOST = 'snowgliderGhost';

  // --- Module state ---
  let scene: THREE.Scene | null = null;
  let getTerrainHeight: TerrainHeightFn | null = null;
  let createSnowman: CreateSnowmanFn | null = null;
  let renderer: THREE.WebGLRenderer | null = null;  // for share-image frame capture
  let camera: THREE.Camera | null = null;

  let gateGroup: THREE.Group | null = null;        // container for all gate meshes
  let ghost: THREE.Object3D | null = null;         // ghost snowman group (or null)
  let ghostSamples: GhostSample[] | null = null;   // loaded best-run trajectory for playback
  let ghostTotalTime = 0;

  let bestSplits: number[] | null = null;  // best split times (per checkpoint + finish), or null

  // Per-run state
  let nextIndex = 0;           // index into the combined checkpoint+finish list
  let runSplits: number[] = [];          // split times recorded this run
  let recordSamples: GhostSample[] = []; // trajectory recorded this run
  let runActive = false;
  let airScore = 0;            // accumulated air-score for this run (meaningful jumps #47)

  // Combined list of split gates (checkpoints then finish)
  const splitPoints: SplitPoint[] = CHECKPOINT_Z.map((z, i) => ({ z, label: `CHECKPOINT ${i + 1}` }))
    .concat([{ z: FINISH_Z, label: 'Finish' }]);

  const reduceMotion = typeof window !== 'undefined' &&
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // HUD construction
  // ---------------------------------------------------------------------------
  let hud: CourseHud = {};

  function buildHud() {
    if (hud.root) return;

    const root = document.createElement('div');
    root.id = 'courseHud';
    Object.assign(root.style, {
      position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '900', display: 'none', flexDirection: 'column', alignItems: 'center',
      gap: '6px', pointerEvents: 'none', fontFamily: 'Arial, sans-serif',
      textShadow: '0 1px 3px rgba(0,0,0,0.8)', width: 'min(420px, 86vw)'
    });

    // Progress bar
    const track = document.createElement('div');
    Object.assign(track.style, {
      width: '100%', height: '8px', borderRadius: '5px',
      background: 'rgba(0,0,0,0.35)', overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.25)'
    });
    const fill = document.createElement('div');
    Object.assign(fill.style, {
      width: '0%', height: '100%', borderRadius: '5px',
      background: 'linear-gradient(90deg,#4a69bd,#74b9ff)', transition: 'width 0.12s linear'
    });
    track.appendChild(fill);

    // Distance + ghost delta row
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', justifyContent: 'space-between', width: '100%',
      fontSize: '13px', color: '#fff', fontWeight: '600'
    });
    const distance = document.createElement('span');
    distance.textContent = `${COURSE_LENGTH} m to finish`;
    const ghostDelta = document.createElement('span');
    ghostDelta.textContent = '';
    row.appendChild(distance);
    row.appendChild(ghostDelta);

    root.appendChild(track);
    root.appendChild(row);
    document.body.appendChild(root);

    // Split flash (briefly shows the time + delta when crossing a checkpoint; also
    // reused for the meaningful-jumps air toast). Given an id so it is addressable.
    const flash = document.createElement('div');
    flash.id = 'courseFlash';
    Object.assign(flash.style, {
      position: 'fixed', top: '64px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '901', padding: '8px 18px', borderRadius: '10px',
      background: 'rgba(0,0,0,0.6)', color: '#fff', fontFamily: 'Arial, sans-serif',
      fontSize: '18px', fontWeight: '700', textAlign: 'center', opacity: '0',
      transition: reduceMotion ? 'none' : 'opacity 0.25s ease', pointerEvents: 'none',
      textShadow: '0 1px 3px rgba(0,0,0,0.8)'
    });
    document.body.appendChild(flash);

    hud = { root, fill, distance, ghostDelta, flash };
  }

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function showFlash(html: string, color?: string) {
    if (!hud.flash) return;
    const flashEl = hud.flash;
    flashEl.innerHTML = html;
    flashEl.style.color = color || '#fff';
    flashEl.style.opacity = '1';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.style.opacity = '0'; }, 1600);
  }

  // Public, purpose-built toast for a graded manual-jump landing (meaningful jumps
  // #47 §3.6), surfaced from the main loop through the same HUD flash element +
  // styling the split timing already uses. Keeping the label/colour mapping here
  // (next to the flash element it drives) keeps the loop a thin dispatcher and makes
  // the presentation unit-testable. showFlash itself stays private.
  function flashAir(quality: 'clean' | 'ok' | 'sketchy', seconds: number) {
    const label = quality === 'clean' ? 'CLEAN' : quality === 'ok' ? 'OK' : 'SKETCHY';
    const color = quality === 'clean' ? '#55efc4' : quality === 'ok' ? '#74b9ff' : '#ff7675';
    showFlash(`✈ AIR ${seconds.toFixed(1)}s &middot; ${label}`, color);
  }

  // Bank air-score points earned this run (from a graded manual-jump landing in the
  // physics kernel). Reset to 0 each run in reset(); surfaced on the result screen.
  function addAirScore(points: number) {
    if (points > 0) airScore += points;
  }

  // ---------------------------------------------------------------------------
  // Gate / finish meshes
  // ---------------------------------------------------------------------------
  function makeGate(zPos: number, colorHex: number, label: string, isFinish: boolean): THREE.Group {
    const sampleHeight = getTerrainHeight;
    if (!sampleHeight) throw new Error('CourseModule.makeGate called before init()');
    const group = new THREE.Group();
    const halfW = isFinish ? FINISH_HALF_WIDTH : GATE_HALF_WIDTH;
    const poleMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6 });
    const poleHeight = isFinish ? 9 : 6;
    const poleRadius = isFinish ? 0.35 : 0.25;

    [-halfW, halfW].forEach((xOff) => {
      const groundY = sampleHeight(xOff, zPos);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(poleRadius, poleRadius, poleHeight, 10),
        poleMat
      );
      pole.position.set(xOff, groundY + poleHeight / 2, zPos);
      pole.castShadow = true;
      group.add(pole);

      // Small flag near the top of each pole
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 1.1),
        new THREE.MeshStandardMaterial({
          color: colorHex, side: THREE.DoubleSide, roughness: 0.8
        })
      );
      flag.position.set(xOff + (xOff < 0 ? 1.0 : -1.0), groundY + poleHeight - 0.9, zPos);
      group.add(flag);
    });

    // Banner across the top spanning the gate
    const midY = (sampleHeight(-halfW, zPos) + sampleHeight(halfW, zPos)) / 2;
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, isFinish ? 1.6 : 1.0, 0.2),
      new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.7 })
    );
    banner.position.set(0, midY + poleHeight - 0.4, zPos);
    banner.castShadow = true;
    group.add(banner);

    // Text label on the banner (canvas texture)
    if (label) {
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 96;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 70px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, canvas.width / 2, canvas.height / 2);
      const tex = new THREE.CanvasTexture(canvas);
      const textMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      const textPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(halfW * 2 * 0.9, (isFinish ? 1.6 : 1.0) * 0.9),
        textMat
      );
      textPlane.position.set(0, midY + poleHeight - 0.4, zPos + 0.12);
      group.add(textPlane);
    }

    return group;
  }

  function buildGates() {
    if (gateGroup || !scene) return;
    const group = new THREE.Group();
    gateGroup = group;

    const palette = [0x00b894, 0x0984e3, 0xfdcb6e]; // green, blue, amber for CPs
    CHECKPOINT_Z.forEach((z, i) => {
      // Single source of truth for the label so the 3D banner and the HUD/result
      // table never drift apart (was "CHECKPOINT n" here vs "CP n" in the HUD).
      group.add(makeGate(z, palette[i % palette.length]!, splitPoints[i]!.label, false));
    });
    group.add(makeGate(FINISH_Z, 0xffd700, 'FINISH', true));

    scene.add(group);
  }

  // ---------------------------------------------------------------------------
  // Ghost
  // ---------------------------------------------------------------------------
  function loadGhost() {
    ghostSamples = null;
    ghostTotalTime = 0;
    try {
      const raw = localStorage.getItem(LS_GHOST);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 1) {
          ghostSamples = data;
          ghostTotalTime = data[data.length - 1].t;
        }
      }
    } catch {
      ghostSamples = null;
    }
  }

  // Load the persisted best splits into module state. Used by both init() and
  // reset() so the in-memory baseline never goes stale after a personal best
  // within a session (the split flash + result table compare against this).
  function loadBests() {
    try {
      const raw = localStorage.getItem(LS_SPLITS);
      bestSplits = raw ? JSON.parse(raw) : null;
    } catch {
      bestSplits = null;
    }
  }

  function buildGhost() {
    if (!ghostSamples || ghost || !createSnowman || !scene) return;
    ghost = createSnowman(scene);
    // Make it a translucent blue apparition that never collides or shadows.
    ghost.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        // Ghost snowman meshes use a single MeshStandardMaterial (never an array).
        const cloned = (mesh.material as THREE.MeshStandardMaterial).clone();
        cloned.transparent = true;
        cloned.opacity = 0.32;
        if (cloned.color) cloned.color.lerp(new THREE.Color(0x66ccff), 0.6);
        if ('emissive' in cloned && cloned.emissive) cloned.emissive = new THREE.Color(0x113355);
        mesh.material = cloned;
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
    ghost.visible = false;
  }

  // Interpolate the ghost's recorded position at time t (seconds since run start).
  function ghostPositionAt(t: number) {
    if (!ghostSamples) return null;
    const s = ghostSamples;
    if (t <= s[0]!.t) return s[0]!;
    if (t >= s[s.length - 1]!.t) return s[s.length - 1]!;
    // Linear scan is fine for a few hundred samples.
    for (let i = 1; i < s.length; i++) {
      if (s[i]!.t >= t) {
        const a = s[i - 1]!, b = s[i]!;
        const f = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          rot: a.rot + (b.rot - a.rot) * f
        };
      }
    }
    return s[s.length - 1]!;
  }

  // The time at which the ghost reached a given downhill depth (z).
  function ghostTimeAtZ(z: number) {
    if (!ghostSamples) return null;
    const s = ghostSamples;
    if (z >= s[0]!.z) return 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i]!.z <= z) {
        const a = s[i - 1]!, b = s[i]!;
        const f = (a.z - z) / Math.max(1e-4, a.z - b.z);
        return a.t + (b.t - a.t) * f;
      }
    }
    return ghostTotalTime;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(opts: CourseInitOptions) {
    scene = opts.scene;
    getTerrainHeight = opts.getTerrainHeight;
    createSnowman = opts.createSnowman;
    renderer = opts.renderer ?? null;
    camera = opts.camera ?? null;

    // Load persisted bests
    loadBests();

    buildHud();
    buildGates();
    loadGhost();
    buildGhost();
  }

  // Called from resetSnowman(): start a fresh timed run.
  function reset() {
    nextIndex = 0;
    runSplits = [];
    recordSamples = [];
    runActive = true;
    airScore = 0;

    // Refresh ghost + best splits in case a previous run set a new best.
    loadBests();
    loadGhost();
    buildGhost();
    if (ghost) ghost.visible = false;

    if (hud.root && hud.fill && hud.distance && hud.ghostDelta && hud.flash) {
      hud.root.style.display = 'flex';
      hud.fill.style.width = '0%';
      hud.distance.textContent = `${COURSE_LENGTH} m to finish`;
      hud.ghostDelta.textContent = ghostSamples ? 'Racing your ghost' : 'No ghost yet';
      hud.ghostDelta.style.color = '#74b9ff';
      hud.flash.style.opacity = '0';
    }
  }

  function formatTime(t: number): string {
    return `${t.toFixed(2)}s`;
  }

  function formatDelta(d: number): string {
    const sign = d <= 0 ? '−' : '+';
    return `${sign}${Math.abs(d).toFixed(2)}s`;
  }

  // Called every frame from the animation loop.
  // pos: snowman position, elapsed: seconds since run start, snowman: the player group.
  function update(pos: Vec3Like, elapsed: number, snowman?: THREE.Object3D) {
    if (!runActive) return;

    // --- Progress HUD ---
    const progressed = Math.min(COURSE_LENGTH, Math.max(0, START_Z - pos.z));
    const frac = progressed / COURSE_LENGTH;
    if (hud.fill) hud.fill.style.width = `${(frac * 100).toFixed(1)}%`;
    if (hud.distance) {
      const remaining = Math.max(0, COURSE_LENGTH - progressed);
      hud.distance.textContent = `${remaining.toFixed(0)} m to finish`;
    }

    // --- Split detection ---
    if (nextIndex < splitPoints.length && pos.z <= splitPoints[nextIndex]!.z) {
      const idx = nextIndex;
      const sp = splitPoints[idx]!;
      runSplits[idx] = elapsed;
      nextIndex++;

      let deltaHtml = '';
      let color = '#74b9ff';
      if (bestSplits && typeof bestSplits[idx] === 'number') {
        const d = elapsed - bestSplits[idx];
        color = d <= 0 ? '#55efc4' : '#ff7675';
        deltaHtml = `<div style="font-size:14px;margin-top:2px;color:${color}">${formatDelta(d)} vs best</div>`;
      }
      if (idx < splitPoints.length - 1) {
        showFlash(`${sp.label} &middot; ${formatTime(elapsed)}${deltaHtml}`, color);
      }
    }

    // --- Ghost playback ---
    if (ghost && ghostSamples) {
      ghost.visible = true;
      const gp = ghostPositionAt(elapsed);
      if (gp) {
        ghost.position.set(gp.x, gp.y, gp.z);
        if (typeof gp.rot === 'number') ghost.rotation.y = gp.rot;
      }
      // Ahead/behind readout, expressed in time at the player's current depth.
      const gt = ghostTimeAtZ(pos.z);
      if (gt !== null && hud.ghostDelta) {
        const delta = elapsed - gt; // +ve: ghost was here earlier => you're behind
        if (pos.z > START_Z - 2) {
          hud.ghostDelta.textContent = 'Racing your ghost';
          hud.ghostDelta.style.color = '#74b9ff';
        } else if (delta <= 0) {
          hud.ghostDelta.textContent = `AHEAD ${formatDelta(delta).replace('−', '')}`;
          hud.ghostDelta.style.color = '#55efc4';
        } else {
          hud.ghostDelta.textContent = `BEHIND ${formatDelta(delta).replace('+', '')}`;
          hud.ghostDelta.style.color = '#ff7675';
        }
      }
    }

    // --- Record this run's trajectory for a future ghost ---
    // Throttled by wall-clock (elapsed - lastSample >= SAMPLE_INTERVAL) below.
    if (recordSamples.length === 0 ||
        elapsed - recordSamples[recordSamples.length - 1]!.t >= SAMPLE_INTERVAL) {
      recordSamples.push({
        t: elapsed,
        x: +pos.x.toFixed(2),
        y: +pos.y.toFixed(2),
        z: +pos.z.toFixed(2),
        rot: snowman ? +snowman.rotation.y.toFixed(3) : 0
      });
    }
  }

  function hideHud() {
    runActive = false;
    if (hud.root) hud.root.style.display = 'none';
    if (hud.flash) hud.flash.style.opacity = '0';
    if (ghost) ghost.visible = false;
  }

  // Decide a medal based on the player's own pace (robust without a global par).
  function medalFor(total: number, previousBest: number, isFirst: boolean): Medal {
    if (isFirst) return { key: 'gold', icon: '🥇', label: 'First descent!' };
    if (total < previousBest) return { key: 'gold', icon: '🥇', label: 'New record!' };
    if (total <= previousBest * 1.10) return { key: 'silver', icon: '🥈', label: 'Silver run' };
    if (total <= previousBest * 1.25) return { key: 'bronze', icon: '🥉', label: 'Bronze run' };
    return { key: 'finish', icon: '🏁', label: 'Finished' };
  }

  // Called from showGameOver() on a successful finish.
  // Returns a DOM node (the result panel) to insert into the game-over overlay.
  function onFinish(totalTime: number, previousBest: number): HTMLDivElement {
    hideHud();

    const isFirst = !(previousBest < Infinity);
    const isBest = isFirst || totalTime < previousBest;

    // Record the finish split.
    runSplits[splitPoints.length - 1] = totalTime;

    // Commit best splits + ghost if this is the best run so far.
    if (isBest) {
      try {
        localStorage.setItem(LS_SPLITS, JSON.stringify(runSplits));
        // Ensure the final sample lands exactly on the finish time, but keep the
        // player's real x/y/rotation so the ghost doesn't snap to center or dip
        // at the line (terrain-y at the finish is not 0).
        const lastReal = recordSamples[recordSamples.length - 1];
        recordSamples.push({
          t: totalTime,
          x: lastReal ? lastReal.x : 0,
          y: lastReal ? lastReal.y : (getTerrainHeight ? getTerrainHeight(0, FINISH_Z) : 0),
          z: FINISH_Z,
          rot: lastReal ? lastReal.rot : Math.PI
        });
        localStorage.setItem(LS_GHOST, JSON.stringify(recordSamples));
      } catch { /* storage may be unavailable; ignore */ }
    }

    const medal = medalFor(totalTime, previousBest, isFirst);
    return buildResultPanel(totalTime, previousBest, isBest, isFirst, medal);
  }

  function buildResultPanel(totalTime: number, previousBest: number, isBest: boolean, isFirst: boolean, medal: Medal): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'courseResult';
    Object.assign(panel.style, {
      background: 'rgba(20,24,38,0.78)', borderRadius: '14px', padding: '18px 22px',
      margin: '6px 0 18px', color: '#fff', fontFamily: 'Arial, sans-serif',
      width: 'min(380px, 88vw)', boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
      border: '1px solid rgba(255,255,255,0.12)'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px'
    });
    const icon = document.createElement('div');
    icon.textContent = medal.icon;
    icon.style.fontSize = '40px';
    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = medal.label;
    Object.assign(title.style, { fontSize: '20px', fontWeight: '800' });
    const time = document.createElement('div');
    time.textContent = formatTime(totalTime);
    Object.assign(time.style, {
      fontSize: '30px', fontWeight: '800',
      color: isBest ? '#ffd700' : '#fff', lineHeight: '1.1'
    });
    titleWrap.appendChild(title);
    titleWrap.appendChild(time);
    header.appendChild(icon);
    header.appendChild(titleWrap);
    panel.appendChild(header);

    // Improvement line
    const improve = document.createElement('div');
    Object.assign(improve.style, { fontSize: '14px', marginBottom: '12px' });
    if (isFirst) {
      improve.textContent = 'Set the time to beat — your ghost will race you next run.';
      improve.style.color = '#74b9ff';
    } else if (isBest) {
      const d = totalTime - previousBest;
      improve.textContent = `${formatDelta(d)} — new personal best!`;
      improve.style.color = '#55efc4';
    } else {
      const d = totalTime - previousBest;
      improve.textContent = `${formatDelta(d)} vs best (${formatTime(previousBest)})`;
      improve.style.color = '#dfe6e9';
    }
    panel.appendChild(improve);

    // Air score (meaningful jumps #47, §3.6): a per-run flourish, shown only when
    // the run actually banked air from graded manual jumps, so a no-jump run's
    // result screen is unchanged.
    if (airScore > 0) {
      const air = document.createElement('div');
      air.id = 'resultAirScore';
      Object.assign(air.style, {
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
        fontSize: '15px', fontWeight: '700', color: '#74b9ff'
      });
      air.innerHTML = `<span style="font-size:18px">✈</span> Air score <span style="color:#fff">${airScore}</span>`;
      panel.appendChild(air);
    }

    // Split table
    const table = document.createElement('div');
    table.id = 'resultSplitTable';
    Object.assign(table.style, {
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '4px 14px',
      fontSize: '13px', alignItems: 'center'
    });
    const head = (txt: string, align?: string) => {
      const c = document.createElement('div');
      c.textContent = txt;
      Object.assign(c.style, {
        color: '#9aa6b2', fontWeight: '700', textAlign: align || 'left',
        borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: '4px'
      });
      return c;
    };
    table.appendChild(head('Split'));
    table.appendChild(head('Time', 'right'));
    table.appendChild(head('Δ Best', 'right'));

    splitPoints.forEach((sp, i) => {
      const name = document.createElement('div');
      name.textContent = i < splitPoints.length - 1 ? sp.label : 'Finish';
      name.style.color = '#fff';

      const t = document.createElement('div');
      t.textContent = typeof runSplits[i] === 'number' ? formatTime(runSplits[i]) : '—';
      t.style.textAlign = 'right';
      t.style.color = '#fff';

      const d = document.createElement('div');
      d.style.textAlign = 'right';
      if (bestSplits && typeof bestSplits[i] === 'number' && typeof runSplits[i] === 'number') {
        const diff = runSplits[i] - bestSplits[i];
        d.textContent = formatDelta(diff);
        d.style.color = diff <= 0 ? '#55efc4' : '#ff7675';
      } else {
        d.textContent = '—';
        d.style.color = '#9aa6b2';
      }
      table.appendChild(name);
      table.appendChild(t);
      table.appendChild(d);
    });
    panel.appendChild(table);

    // Share controls (hybrid: native sheet on mobile, per-platform menu +
    // screenshot card on desktop). Built only here, inside the finish result
    // panel, so they appear solely on a valid successful finish and are cleaned
    // up with the panel on restart. See src/ui/share-menu.ts.
    panel.appendChild(buildShareControls({
      time: totalTime,
      isBest,
      getCapture: getCaptureContext,
    }));

    return panel;
  }

  /** Provide the live renderer/scene/camera for share-image capture, or null
   *  (headless tests / pre-init) so the card uses its gradient fallback. */
  function getCaptureContext(): CaptureContext | null {
    if (!renderer || !scene || !camera) return null;
    return { renderer, scene, camera };
  }

  return {
    init,
    reset,
    update,
    flashAir,
    addAirScore,
    hideHud,
    onFinish,
    // exposed for potential tests
    _config: { START_Z, FINISH_Z, CHECKPOINT_Z, COURSE_LENGTH, splitPoints }
  };
})();

// CourseModule is imported directly by snowglider.js (issue #84).
