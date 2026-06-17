// @ts-check
// course.js - Course structure, split timing, ghost racing and result screen for SnowGlider
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
// the CDN global, and `CourseModule` is `export`ed. The window.CourseModule
// assignment below is kept so the still-classic consumer (snowglider.js, which
// reads it by bare name and as window.CourseModule, converted last in PR 2.9)
// keeps working during the staged migration; it is loaded into the page through
// the bundle entry (src/main.js) rather than the classic script-loader.
import * as THREE from 'three';

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
  let scene = null;
  let getTerrainHeight = null;
  let createSnowman = null;

  let gateGroup = null;        // container for all gate meshes
  let ghost = null;            // ghost snowman group (or null)
  let ghostSamples = null;     // loaded best-run trajectory for playback
  let ghostTotalTime = 0;

  let bestSplits = null;       // array of best split times (per checkpoint + finish), or null

  // Per-run state
  let nextIndex = 0;           // index into the combined checkpoint+finish list
  let runSplits = [];          // split times recorded this run
  let recordSamples = [];      // trajectory recorded this run
  let sampleAccum = 0;
  let runActive = false;

  // Combined list of split gates (checkpoints then finish)
  const splitPoints = CHECKPOINT_Z.map((z, i) => ({ z, label: `CHECKPOINT ${i + 1}` }))
    .concat([{ z: FINISH_Z, label: 'Finish' }]);

  const reduceMotion = typeof window !== 'undefined' &&
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // HUD construction
  // ---------------------------------------------------------------------------
  let hud = {};

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

    // Split flash (briefly shows the time + delta when crossing a checkpoint)
    const flash = document.createElement('div');
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

  let flashTimer = null;
  function showFlash(html, color) {
    if (!hud.flash) return;
    hud.flash.innerHTML = html;
    hud.flash.style.color = color || '#fff';
    hud.flash.style.opacity = '1';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { hud.flash.style.opacity = '0'; }, 1600);
  }

  // ---------------------------------------------------------------------------
  // Gate / finish meshes
  // ---------------------------------------------------------------------------
  function makeGate(zPos, colorHex, label, isFinish) {
    const group = new THREE.Group();
    const halfW = isFinish ? FINISH_HALF_WIDTH : GATE_HALF_WIDTH;
    const poleMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6 });
    const poleHeight = isFinish ? 9 : 6;
    const poleRadius = isFinish ? 0.35 : 0.25;

    [-halfW, halfW].forEach((xOff) => {
      const groundY = getTerrainHeight(xOff, zPos);
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
    const midY = (getTerrainHeight(-halfW, zPos) + getTerrainHeight(halfW, zPos)) / 2;
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
      const ctx = canvas.getContext('2d');
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
    if (gateGroup) return;
    gateGroup = new THREE.Group();

    const palette = [0x00b894, 0x0984e3, 0xfdcb6e]; // green, blue, amber for CPs
    CHECKPOINT_Z.forEach((z, i) => {
      // Single source of truth for the label so the 3D banner and the HUD/result
      // table never drift apart (was "CHECKPOINT n" here vs "CP n" in the HUD).
      gateGroup.add(makeGate(z, palette[i % palette.length], splitPoints[i].label, false));
    });
    gateGroup.add(makeGate(FINISH_Z, 0xffd700, 'FINISH', true));

    scene.add(gateGroup);
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
    } catch (e) {
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
    } catch (e) {
      bestSplits = null;
    }
  }

  function buildGhost() {
    if (!ghostSamples || ghost || !createSnowman) return;
    ghost = createSnowman(scene);
    // Make it a translucent blue apparition that never collides or shadows.
    ghost.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const m = obj.material.clone();
        m.transparent = true;
        m.opacity = 0.32;
        if (m.color) m.color.lerp(new THREE.Color(0x66ccff), 0.6);
        if ('emissive' in m && m.emissive) m.emissive = new THREE.Color(0x113355);
        obj.material = m;
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
    ghost.visible = false;
  }

  // Interpolate the ghost's recorded position at time t (seconds since run start).
  function ghostPositionAt(t) {
    if (!ghostSamples) return null;
    const s = ghostSamples;
    if (t <= s[0].t) return s[0];
    if (t >= s[s.length - 1].t) return s[s.length - 1];
    // Linear scan is fine for a few hundred samples.
    for (let i = 1; i < s.length; i++) {
      if (s[i].t >= t) {
        const a = s[i - 1], b = s[i];
        const f = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          rot: a.rot + (b.rot - a.rot) * f
        };
      }
    }
    return s[s.length - 1];
  }

  // The time at which the ghost reached a given downhill depth (z).
  function ghostTimeAtZ(z) {
    if (!ghostSamples) return null;
    const s = ghostSamples;
    if (z >= s[0].z) return 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i].z <= z) {
        const a = s[i - 1], b = s[i];
        const f = (a.z - z) / Math.max(1e-4, a.z - b.z);
        return a.t + (b.t - a.t) * f;
      }
    }
    return ghostTotalTime;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(opts) {
    scene = opts.scene;
    getTerrainHeight = opts.getTerrainHeight;
    createSnowman = opts.createSnowman;

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
    sampleAccum = 0;
    runActive = true;

    // Refresh ghost + best splits in case a previous run set a new best.
    loadBests();
    loadGhost();
    buildGhost();
    if (ghost) ghost.visible = false;

    if (hud.root) {
      hud.root.style.display = 'flex';
      hud.fill.style.width = '0%';
      hud.distance.textContent = `${COURSE_LENGTH} m to finish`;
      hud.ghostDelta.textContent = ghostSamples ? 'Racing your ghost' : 'No ghost yet';
      hud.ghostDelta.style.color = '#74b9ff';
      hud.flash.style.opacity = '0';
    }
  }

  function formatTime(t) {
    return `${t.toFixed(2)}s`;
  }

  function formatDelta(d) {
    const sign = d <= 0 ? '−' : '+';
    return `${sign}${Math.abs(d).toFixed(2)}s`;
  }

  // Called every frame from the animation loop.
  // pos: snowman position, elapsed: seconds since run start, snowman: the player group.
  function update(pos, elapsed, snowman) {
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
    if (nextIndex < splitPoints.length && pos.z <= splitPoints[nextIndex].z) {
      const idx = nextIndex;
      const sp = splitPoints[idx];
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
    sampleAccum += 1; // accumulate frames; we throttle by wall-clock via elapsed below
    if (recordSamples.length === 0 ||
        elapsed - recordSamples[recordSamples.length - 1].t >= SAMPLE_INTERVAL) {
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
  function medalFor(total, previousBest, isFirst) {
    if (isFirst) return { key: 'gold', icon: '🥇', label: 'First descent!' };
    if (total < previousBest) return { key: 'gold', icon: '🥇', label: 'New record!' };
    if (total <= previousBest * 1.10) return { key: 'silver', icon: '🥈', label: 'Silver run' };
    if (total <= previousBest * 1.25) return { key: 'bronze', icon: '🥉', label: 'Bronze run' };
    return { key: 'finish', icon: '🏁', label: 'Finished' };
  }

  // Called from showGameOver() on a successful finish.
  // Returns a DOM node (the result panel) to insert into the game-over overlay.
  function onFinish(totalTime, previousBest) {
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
      } catch (e) { /* storage may be unavailable; ignore */ }
    }

    const medal = medalFor(totalTime, previousBest, isFirst);
    return buildResultPanel(totalTime, previousBest, isBest, isFirst, medal);
  }

  function buildResultPanel(totalTime, previousBest, isBest, isFirst, medal) {
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

    // Split table
    const table = document.createElement('div');
    Object.assign(table.style, {
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '4px 14px',
      fontSize: '13px', alignItems: 'center'
    });
    const head = (txt, align) => {
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

    return panel;
  }

  return {
    init,
    reset,
    update,
    hideHud,
    onFinish,
    // exposed for potential tests
    _config: { START_Z, FINISH_Z, CHECKPOINT_Z, COURSE_LENGTH, splitPoints }
  };
})();

// Backward-compat global export for the still-classic consumer (snowglider.js
// reads `CourseModule`/`window.CourseModule`). Drop this once snowglider.js is
// converted to import CourseModule directly (PR 2.9, issue #84).
if (typeof window !== 'undefined') {
  window.CourseModule = CourseModule;
}
