// tree-shed.ts — gust-driven snow shedding off laden trees (issue #253, Phase B).
//
// The forest carries a per-tree snow load (see the load registry in
// src/mountains/trees.ts): laden trees sway damped and bow under the weight. This
// module makes that load DYNAMIC — when a strong gust arrives, the most laden trees
// near the player dump their snow (a soft powder puff bursts off the crown, the
// shelves visibly shrink, the branches spring back up) and then re-laden slowly as
// the snowfall settles back in. update() returns the frame's shed events so the
// caller can voice them (Sfx.treeShed) without this module knowing about audio.
//
// DESIGN CONSTRAINTS (mirroring wind.ts / snowtracks.ts / the sway in trees.ts):
//   - **Cosmetic only.** Loads drive shader attributes and sprites; collision
//     (treePositions) and the physics kernel are never touched, so the grounded
//     no-input baseline (docs/PHYSICS.md §6) stays byte-identical.
//   - **Deterministic.** Shedding keys off the shared Wind field's gust cycle (a
//     seeded clock), target selection is a pure sort, and the puff jitter draws from
//     a private xorshift — this module never calls the global Math.random, so
//     seeded placement streams and screenshot reproducibility are unaffected.
//   - **Headless-safe.** No DOM requirement: the puff pool is guarded on `document`
//     (like the avalanche powder), so Node tests drive the load dynamics directly.
//   - **Reduced-motion aware.** Under prefers-reduced-motion the whole system is
//     inert: loads stay at their static base, no puffs burst.
import * as THREE from 'three';
import { Wind } from './wind.js';
import { Trees } from './trees.js';
import type { TreePosition } from './trees.js';

/** One shed this frame: where it happened and how far from the player (for audio). */
export interface ShedEvent {
  x: number;
  z: number;
  distance: number;
}

/** Tunables; configure() lets tests (and future difficulty tiers) retune them. */
export interface TreeShedConfig {
  /** Gust factor (Wind.gust(), 0..1) whose upward crossing triggers a shed check. */
  gustEdge: number;
  /** Field strength (Wind.strength(), 0..1) floor: light winds never shed. */
  minStrength: number;
  /** Trees below this load have nothing worth dumping. */
  minLoad: number;
  /** World-unit radius around the player eligible to shed (the audible/visible band). */
  radius: number;
  /** How many trees a single gust can strip. */
  maxTrees: number;
  /** Seconds between shed events (a gust front, not a machine gun). */
  cooldown: number;
  /** Fraction of the load that survives a shed (branches keep a dusting). */
  keep: number;
  /** Load units/s the dump sheds at (fast: the visible spring-back). */
  shedRate: number;
  /** Load units/s the snowfall re-ladens at (slow: ~1.5 min back to base). */
  reloadRate: number;
}

const DEFAULT_CONFIG: TreeShedConfig = {
  gustEdge: 0.78,
  minStrength: 0.55,
  minLoad: 0.45,
  radius: 42,
  maxTrees: 3,
  cooldown: 2.0,
  keep: 0.22,
  shedRate: 1.6,
  reloadRate: 1 / 90
};

const MAX_DT = 0.1;           // clamp a hitch frame so loads can't teleport
const PUFF_POOL_SIZE = 18;    // round-robin sprite pool (2-3 puffs per shed tree)
const PUFF_LIFE = 1.5;        // seconds a puff billows before it's reclaimed
const PROXIMITY_RADIUS = 24;  // world units the rustle bed "hears" trees within
const PROXIMITY_SATURATION = 5; // ~this many close trees = a full forest around you

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const finite = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback);

// --- Pure helpers (exported for the headless Node tests) --------------------------

/** True when the gust factor crosses `threshold` upward between two samples — the
 *  moment a gust front ARRIVES, which is when real trees dump their snow. */
export function gustRisingEdge(prev: number, cur: number, threshold: number): boolean {
  return Number.isFinite(prev) && Number.isFinite(cur) && prev < threshold && cur >= threshold;
}

/** Options for {@link selectShedTargets}; mirrors the relevant config subset. */
export interface ShedSelectOptions {
  radius: number;
  maxTrees: number;
  minLoad: number;
}

/** Pick which trees a gust strips: the most laden trees within `radius` of the
 *  player (ties broken by distance, then index — fully deterministic). Pure. */
export function selectShedTargets(
  positions: readonly TreePosition[],
  loads: ArrayLike<number>,
  px: number,
  pz: number,
  opts: ShedSelectOptions
): number[] {
  const r2 = opts.radius * opts.radius;
  const count = Math.min(positions.length, loads.length);
  const candidates: Array<{ i: number; load: number; d2: number }> = [];
  for (let i = 0; i < count; i++) {
    const load = loads[i]!;
    if (!(load >= opts.minLoad)) continue;
    const t = positions[i]!;
    const dx = t.x - px;
    const dz = t.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    candidates.push({ i, load, d2 });
  }
  candidates.sort((a, b) => (b.load - a.load) || (a.d2 - b.d2) || (a.i - b.i));
  return candidates.slice(0, opts.maxTrees).map(c => c.i);
}

/** How much forest surrounds (x, z), 0..1: closer trees weigh more, saturating at a
 *  handful of close trees. Feeds the needle-rustle bed's gain (sfx.ts) — skiing a
 *  tight glade rustles, an open bowl doesn't. Pure and cheap (one pass). */
export function forestProximityAt(
  positions: readonly TreePosition[] | null | undefined,
  x: number,
  z: number,
  radius = PROXIMITY_RADIUS
): number {
  if (!positions || positions.length === 0 || !(radius > 0)) return 0;
  const r2 = radius * radius;
  let sum = 0;
  for (const t of positions) {
    const dx = t.x - x;
    const dz = t.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r2) continue;
    sum += 1 - Math.sqrt(d2) / radius;
    if (sum >= PROXIMITY_SATURATION) return 1;
  }
  return sum / PROXIMITY_SATURATION;
}

// --- The live system ---------------------------------------------------------------

interface Puff {
  sprite: THREE.Sprite;
  life: number;       // seconds remaining; <= 0 means free
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  grow: number;       // scale units/s the puff expands at
  peakOpacity: number;
}

export const TreeShed = (function() {
  let config: TreeShedConfig = { ...DEFAULT_CONFIG };

  // Per-tree dynamics, indexed like treePositions / the trees.ts load registry.
  let loads: Float32Array | null = null;
  let targets: Float32Array | null = null;
  let baseLoads: Float32Array | null = null;
  let dumping: Uint8Array | null = null;
  const active = new Set<number>(); // trees currently dumping or recovering
  let registryVersion = -1;
  let prevGust = 0;
  let cooldown = 0;

  // Private deterministic RNG for cosmetic puff jitter AND for the uuid draws three
  // makes while the pool is built — this module must never advance the global
  // Math.random stream (the verification harnesses seed and baseline it). xorshift32.
  let rngState = 0x9e3779b9;
  function rng(): number {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 0x100000000;
  }

  // Puff pool (lazy; requires a document for the radial-gradient texture).
  let puffTexture: THREE.CanvasTexture | null = null;
  let puffMaterialTemplate: THREE.SpriteMaterial | null = null;
  let puffs: Puff[] = [];
  let puffNext = 0;

  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensurePuffPool(): boolean {
    if (puffs.length > 0) return true;
    if (typeof document === 'undefined') return false;
    const savedRandom = Math.random;
    Math.random = rng; // stream-neutral: textures/materials/sprites mint uuids
    try {
      if (!puffTexture) {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof ctx.createRadialGradient !== 'function') return false;
        const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(250, 252, 255, 0.9)');
        grad.addColorStop(0.55, 'rgba(240, 246, 253, 0.42)');
        grad.addColorStop(1, 'rgba(235, 242, 250, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        puffTexture = new THREE.CanvasTexture(canvas);
      }
      if (!puffMaterialTemplate) {
        puffMaterialTemplate = new THREE.SpriteMaterial({
          map: puffTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false
        });
      }
      for (let i = 0; i < PUFF_POOL_SIZE; i++) {
        const sprite = new THREE.Sprite(puffMaterialTemplate.clone());
        sprite.visible = false;
        sprite.name = 'treeShedPuff';
        puffs.push({ sprite, life: 0, maxLife: PUFF_LIFE, vx: 0, vy: 0, vz: 0, grow: 0, peakOpacity: 0 });
      }
    } finally {
      Math.random = savedRandom;
    }
    return true;
  }

  function spawnPuffs(scene: THREE.Scene, tree: TreePosition, load: number): void {
    if (!ensurePuffPool()) return;
    const wv = Wind.vector();
    const scale = tree.scale || 1.0;
    const crownY = tree.y + (5.5 + 3.5 * rng()) * scale; // upper canopy band
    const count = 2 + (load > 0.7 ? 1 : 0);
    for (let n = 0; n < count; n++) {
      const puff = puffs[puffNext]!;
      puffNext = (puffNext + 1) % puffs.length;
      const s = puff.sprite;
      if (s.parent !== scene) {
        s.removeFromParent();
        scene.add(s);
      }
      s.position.set(
        tree.x + (rng() - 0.5) * 1.6 * scale,
        crownY - n * 1.1 * scale,
        tree.z + (rng() - 0.5) * 1.6 * scale
      );
      const startScale = (1.4 + rng() * 0.8) * scale;
      s.scale.set(startScale, startScale * 0.85, 1);
      s.visible = true;
      puff.life = puff.maxLife = PUFF_LIFE * (0.8 + rng() * 0.4);
      // Falling snow dust: drops with a touch of the wind that knocked it loose.
      puff.vx = wv.x * 0.35 + (rng() - 0.5) * 0.6;
      puff.vy = -(1.0 + rng() * 0.8);
      puff.vz = wv.z * 0.35 + (rng() - 0.5) * 0.6;
      puff.grow = (2.2 + rng() * 1.2) * scale;
      puff.peakOpacity = 0.28 + 0.32 * clamp01(load);
      (s.material).opacity = 0;
    }
  }

  function advancePuffs(dt: number): void {
    for (const puff of puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      const s = puff.sprite;
      if (puff.life <= 0) {
        s.visible = false;
        (s.material).opacity = 0;
        continue;
      }
      s.position.x += puff.vx * dt;
      s.position.y += puff.vy * dt;
      s.position.z += puff.vz * dt;
      s.scale.x += puff.grow * dt;
      s.scale.y += puff.grow * 0.85 * dt;
      // Quick bloom, long dissolve.
      const t = 1 - puff.life / puff.maxLife;
      const envelope = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      (s.material).opacity = puff.peakOpacity * Math.max(0, envelope);
    }
  }

  function hidePuffs(): void {
    for (const puff of puffs) {
      puff.life = 0;
      puff.sprite.visible = false;
      (puff.sprite.material).opacity = 0;
      puff.sprite.removeFromParent();
    }
  }

  /** Re-sync the per-tree dynamics with a (re)built forest's load registry. */
  function syncRegistry(version: number, base: readonly number[]): void {
    registryVersion = version;
    loads = Float32Array.from(base);
    targets = Float32Array.from(base);
    baseLoads = Float32Array.from(base);
    dumping = new Uint8Array(base.length);
    active.clear();
    cooldown = 0;
    hidePuffs(); // a rebuilt forest orphans in-flight puffs (and maybe their scene)
  }

  /** Advance the dump/recover dynamics for the trees that are off their base load. */
  function advanceLoads(dt: number): void {
    if (!loads || !targets || !baseLoads || !dumping) return;
    for (const i of active) {
      if (dumping[i]) {
        const next = Math.max(targets[i]!, loads[i]! - config.shedRate * dt);
        loads[i] = next;
        Trees.setTreeLoad(i, next);
        if (next <= targets[i]! + 1e-4) dumping[i] = 0;
      } else {
        const base = baseLoads[i]!;
        const next = Math.min(base, loads[i]! + config.reloadRate * dt);
        loads[i] = next;
        Trees.setTreeLoad(i, next);
        if (next >= base - 1e-4) active.delete(i);
      }
    }
  }

  return {
    /** Advance the shed system one render frame. `treePositions` is the live
     *  collision array (pass the collider-gated one so invisible forests don't
     *  shed); returns this frame's shed events for the caller to voice. */
    update: function(
      dt: number,
      playerPos: { x: number; y: number; z: number },
      treePositions: readonly TreePosition[] | null | undefined,
      scene: THREE.Scene | null | undefined
    ): ShedEvent[] {
      const events: ShedEvent[] = [];
      const state = Trees.getTreeLoadState();
      if (state.version !== registryVersion) syncRegistry(state.version, state.baseLoads);
      if (!loads || loads.length === 0) return events;
      if (prefersReducedMotion()) return events; // fully inert: static loads, no puffs

      const d = Math.min(MAX_DT, Math.max(0, finite(dt)));
      cooldown = Math.max(0, cooldown - d);
      advanceLoads(d);
      advancePuffs(d);

      const gust = Wind.gust();
      const strength = Wind.strength();
      if (
        cooldown === 0 &&
        treePositions && treePositions.length > 0 &&
        gustRisingEdge(prevGust, gust, config.gustEdge) &&
        strength >= config.minStrength
      ) {
        const picks = selectShedTargets(treePositions, loads, playerPos.x, playerPos.z, {
          radius: config.radius,
          maxTrees: config.maxTrees,
          minLoad: config.minLoad
        });
        if (picks.length > 0) {
          cooldown = config.cooldown;
          for (const i of picks) {
            targets![i] = loads[i]! * config.keep;
            dumping![i] = 1;
            active.add(i);
            const tree = treePositions[i]!;
            if (scene) spawnPuffs(scene, tree, loads[i]!);
            events.push({
              x: tree.x,
              z: tree.z,
              distance: Math.hypot(tree.x - playerPos.x, tree.z - playerPos.z)
            });
          }
        }
      }
      prevGust = gust;
      return events;
    },

    /** Restore every tree to its base load and clear in-flight puffs (run reset). */
    reset: function(): void {
      if (loads && baseLoads && dumping) {
        for (const i of active) {
          loads[i] = baseLoads[i]!;
          if (targets) targets[i] = baseLoads[i]!;
          dumping[i] = 0;
          Trees.setTreeLoad(i, baseLoads[i]!);
        }
      }
      active.clear();
      cooldown = 0;
      prevGust = 0;
      hidePuffs();
    },

    /** Merge in partial tunables (tests, future difficulty tiers, demos). */
    configure: function(partial: Partial<TreeShedConfig>): void {
      config = { ...config, ...partial };
    },

    /** Current tunables (copy). */
    getConfig: function(): TreeShedConfig {
      return { ...config };
    },

    /** Snapshot of a tree's current load (tests/diagnostics); NaN when unknown. */
    getLoad: function(index: number): number {
      return loads && index >= 0 && index < loads.length ? loads[index]! : NaN;
    },

    /** Dispose the pooled puff resources (dispose-audit teardown / dev-HMR). */
    teardown: function(): void {
      hidePuffs();
      for (const puff of puffs) {
        puff.sprite.material.dispose();
      }
      puffs = [];
      puffNext = 0;
      if (puffMaterialTemplate) {
        puffMaterialTemplate.dispose();
        puffMaterialTemplate = null;
      }
      if (puffTexture) {
        puffTexture.dispose();
        puffTexture = null;
      }
      loads = targets = baseLoads = null;
      dumping = null;
      active.clear();
      registryVersion = -1;
    }
  };
})();
