// avalanche.ts - Simple avalanche system for Snowglider
// Triggered when player travels far enough downhill - burial = game over
//
// Phase 2.1 (issue #84): first module converted off the classic global model.
// `THREE` now comes from the npm package via a real ES-module import instead of
// the CDN global, and the class is `export`ed; it loads into the page through
// the bundle entry (src/main.js) rather than the classic script-loader.
//
// Phase 3.0 (issue #84): first module renamed `.js` -> `.ts`. The `@ts-check`
// pragma is gone (it is implied for a real `.ts` file) and the previously
// inferred JSDoc shapes are now real `interface`/`type` declarations. Behaviour
// is unchanged — every edit is type-only/erasable, so esbuild (Vite) and Node's
// native type-stripping both run it exactly as before.
import * as THREE from 'three';
import { gameplayRandom, cosmeticRandom } from './run-context.js';

// Number of billowing powder-cloud sprites kicked up by the slide (see the
// `powder` field below). Sized like the ski snow-splash pool in snow.ts.
const POWDER_COUNT = 260;

/** Per-puff animation state stored on each powder sprite's userData. Typed so the
 *  per-frame integration/emission code stays off the `any` chain (reviewdog). */
interface PowderPuffData {
  active: boolean;
  life: number;
  maxLife: number;
  vx: number; vy: number; vz: number;
  size: number;
  opacity0: number;
  rotSpeed: number;
}

/**
 * Minimal positional shape the avalanche reads. Accepts both a real
 * `THREE.Vector3` (the live game passes `snowman.position`) and the plain
 * `{ x, y, z }` literals the Node tests construct.
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Terrain sampler injected via {@link AvalancheSystem.setTerrainFunction}. */
export type TerrainHeightFn = (x: number, z: number) => number;

/**
 * Per-tier avalanche knobs (the subset of difficulty.ts's `AvalancheTuning` the system
 * itself reads). Every field is optional and DEFAULTS to today's shipped Blue slide, so an
 * existing `new AvalancheSystem(scene, count)` call — and the byte-identical Blue path —
 * is unchanged. Bunny passes `enabled: false` (the slide never arms); Black passes a
 * shorter `triggerDistance` and a higher `slideSpeedBase` (earlier + faster).
 */
export interface AvalancheParams {
  /** false ⇒ the slide never arms (main-loop skips `trigger()`); the system stays inert. */
  enabled?: boolean;
  /** Downhill units the player travels before a slide (re)arms (read by main-loop.ts). */
  triggerDistance?: number;
  /** Base initial downhill boulder speed (m/s). */
  slideSpeedBase?: number;
  /** Random 0..jitter added to the base, per boulder. */
  slideSpeedJitter?: number;
}

export class AvalancheSystem {
  scene: THREE.Scene;
  count: number;
  active: boolean;
  // --- Per-tier tuning (difficulty.ts AvalancheTuning) ----------------------
  // enabled gates the trigger (Bunny is off); triggerDistance is read by main-loop.ts;
  // slideSpeedBase/Jitter set each boulder's initial downhill speed in trigger(). All
  // default to today's Blue slide so the default tier is byte-identical.
  enabled: boolean;
  triggerDistance: number;
  slideSpeedBase: number;
  slideSpeedJitter: number;
  dummy: THREE.Object3D;
  /** Terrain height function - set via setTerrainFunction(). */
  getTerrainHeight: TerrainHeightFn | null;
  positions: Float32Array;
  velocities: Float32Array;
  sizes: Float32Array;
  rotations: Float32Array;
  // Parameterised so `mesh.material` is the single MeshStandardMaterial we build
  // (not the default `Material | Material[]`), keeping `dispose()` type-safe.
  mesh: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>;

  // --- Powder cloud (issue #49 / ROADMAP Finding 3) -------------------------
  // A diffuse plume of billowing snow sprites kicked up by the tumbling boulders,
  // so an approaching slide reads as a rolling cloud of powder and not just a
  // cluster of spheres. Sprite-based (like the ski snow-splash in snow.ts) rather
  // than instanced because each puff fades, expands and rotates independently.
  // Built only when a DOM is present — the headless Node avalanche tests construct
  // the system without a `document`, so the pool stays empty and the powder
  // emit/update calls below are no-ops there.
  powder: THREE.Sprite[];
  powderNext: number;            // round-robin cursor into the powder pool
  powderEmitAccum: number;       // frame-rate-independent puff-emission accumulator (#400)
  powderTexture: THREE.Texture | null;  // shared puff texture (disposed once)

  constructor(scene: THREE.Scene, count: number = 120, params: AvalancheParams = {}) {
    this.scene = scene;
    this.count = count;
    this.active = false;
    // Per-tier tuning, defaulting to today's Blue slide (byte-identical when omitted).
    this.enabled = params.enabled ?? true;
    this.triggerDistance = params.triggerDistance ?? 80;
    this.slideSpeedBase = params.slideSpeedBase ?? 7;
    this.slideSpeedJitter = params.slideSpeedJitter ?? 3;
    this.dummy = new THREE.Object3D();

    // Terrain height function - set via setTerrainFunction()
    this.getTerrainHeight = null;

    // Physics data arrays
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.rotations = new Float32Array(count * 3);

    // Create instanced mesh for snow boulders
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xeef4ff,
      roughness: 0.7,
      flatShading: true
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // three r160+ frustum-culls an InstancedMesh against a bounding sphere derived
    // from its instance matrices. _hideAll() parks every boulder at y=-500 before
    // the first render, so the cached bounds sit far offscreen; once trigger() moves
    // boulders to real positions, update() refreshes matrices but not the bounds, so
    // the whole mesh could be culled — leaving burial/warnings from invisible boulders.
    // Only 120 instances, all near the player when active, so just never cull.
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // Powder cloud pool (empty/no-op when there is no DOM, e.g. Node tests).
    this.powder = [];
    this.powderNext = 0;
    this.powderEmitAccum = 0;
    this.powderTexture = null;
    this._initPowder();

    // Hide initially
    this._hideAll();
  }

  // Build the billowing-powder sprite pool. Guarded on `document` so the headless
  // Node avalanche tests (which `new AvalancheSystem(...)` without a DOM) skip it
  // and the powder methods below safely operate on an empty pool.
  _initPowder(): void {
    if (typeof document === 'undefined') return;

    // Soft, faintly cool-white radial puff that fades to transparent at the rim.
    // Paint it only when a real 2D context is available; a headless DOM (jsdom in
    // the smoke test) may expose only a partial stub, so guard the drawing and
    // still build the pool below — degrading to a blank texture rather than
    // silently disabling the effect.
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.createRadialGradient === 'function') {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.4, 'rgba(238,244,255,0.55)');
      g.addColorStop(0.75, 'rgba(220,232,255,0.2)');
      g.addColorStop(1, 'rgba(220,232,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }

    const texture = new THREE.CanvasTexture(canvas);
    this.powderTexture = texture;

    // Template material. Cloned per particle so each puff fades/rotates on its own.
    // Alpha (not additive) blending with depthWrite off so the cloud reads as a
    // translucent billow against the bright snow rather than washing out to white.
    const base = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      opacity: 0
    });

    for (let i = 0; i < POWDER_COUNT; i++) {
      const sprite = new THREE.Sprite(base.clone());
      sprite.scale.set(0, 0, 0);
      sprite.visible = false; // skip render traversal/sort until emitted
      const puff: PowderPuffData = {
        active: false,
        life: 0,
        maxLife: 0,
        vx: 0, vy: 0, vz: 0,
        size: 0,
        opacity0: 0,
        rotSpeed: (cosmeticRandom('avalanchePowder') - 0.5) * 1.2
      };
      sprite.userData = puff;
      this.scene.add(sprite);
      this.powder.push(sprite);
    }

    base.dispose(); // only the per-particle clones are kept
  }

  // Connect to terrain system
  setTerrainFunction(fn: TerrainHeightFn): void {
    this.getTerrainHeight = fn;
  }

  // Trigger avalanche behind player position
  trigger(playerPos: Vec3Like): void {
    this.active = true;
    console.log("AVALANCHE TRIGGERED at player position:", playerPos.x.toFixed(1), playerPos.z.toFixed(1));

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;

      // Spawn in arc behind player (uphill, positive Z direction from player)
      const angle = (gameplayRandom('avalanche') - 0.5) * Math.PI * 0.6;
      const dist = 25 + gameplayRandom('avalanche') * 15;

      // Player moves in -Z direction (downhill), so spawn behind = +Z offset
      this.positions[idx]     = playerPos.x + Math.sin(angle) * dist;
      this.positions[idx + 1] = playerPos.y + 8 + gameplayRandom('avalanche') * 6;
      this.positions[idx + 2] = playerPos.z + dist * Math.cos(angle); // Behind player (uphill)

      // Initial velocity - moving toward player (downhill = -Z)
      this.velocities[idx]     = (gameplayRandom('avalanche') - 0.5) * 2;
      this.velocities[idx + 1] = 0;
      // Initial downhill speed of the slide. Blue's default is -(7 + rand*3): softened from
      // -(8 + rand*4) so a skilled, full-speed line can actually outrun it — after the
      // frame-rate physics fixes (#209 drag + the avalanche friction fix) removed the low-FPS
      // speed bonus mobile players were unknowingly riding, the real top skiing speed
      // (~8.2 m/s, only ~6.5 where the slide fires) sat below the old slide's reach, so even a
      // clean centered line was buried on most seeds. -(7 + rand*3) keeps the slide a real
      // threat to a genuinely slow line (<~5.5 m/s) while staying escapable at speed. Per
      // tier now (D3.2d): Black raises slideSpeedBase (a faster slide against its faster
      // physics). Gated by the winnability harness (G2/G3 for Blue, the per-tier follow-the-
      // line gate for the rest); one gameplayRandom('avalanche') call, so Blue stays byte-identical.
      this.velocities[idx + 2] = -(this.slideSpeedBase + gameplayRandom('avalanche') * this.slideSpeedJitter); // Negative Z = downhill

      // Random sizes
      this.sizes[i] = 0.4 + gameplayRandom('avalanche') * 1.2;

      // Random initial rotation
      this.rotations[idx]     = gameplayRandom('avalanche') * Math.PI * 2;
      this.rotations[idx + 1] = gameplayRandom('avalanche') * Math.PI * 2;
      this.rotations[idx + 2] = gameplayRandom('avalanche') * Math.PI * 2;
    }
  }

  // Call every frame with delta time
  update(dt: number): void {
    if (!this.active) return;

    const gravity = 18;
    const friction = 0.98;
    const bounce = 0.25;

    // Ground friction is a continuous per-second decay, so it must scale with the
    // frame time the same way the snowman drag does (see snowman/physics.ts
    // `dragFactor`). Applying the raw 0.98 once per frame made boulders decay ~4x
    // less at the capped 10 FPS delta than at 60 FPS — the same frame-rate-dependent
    // bug class as PR #209, here inflating avalanche reach/speed (and thus burial
    // fairness) on slow devices. `frictionFactor` is byte-identical at the 60 Hz
    // baseline (dt*60 === 1 when dt === 1/60, and Math.pow(x, 1) === x). The debris
    // loop in _updatePowder already drag-scales correctly; this brings the boulders
    // in line. (bounce stays a per-contact impulse, not a continuous decay.)
    const frictionFactor = Math.pow(friction, dt * 60);

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;

      // Apply gravity
      this.velocities[idx + 1]! -= gravity * dt;

      // Update positions
      this.positions[idx]     = this.positions[idx]!     + this.velocities[idx]! * dt;
      this.positions[idx + 1] = this.positions[idx + 1]! + this.velocities[idx + 1]! * dt;
      this.positions[idx + 2] = this.positions[idx + 2]! + this.velocities[idx + 2]! * dt;

      // Get terrain height at current position
      let floorY = 0;
      if (this.getTerrainHeight) {
        floorY = this.getTerrainHeight(this.positions[idx], this.positions[idx + 2]!);
      }

      const radius = this.sizes[i]!;

      // Ground collision
      if (this.positions[idx + 1]! < floorY + radius) {
        this.positions[idx + 1] = floorY + radius;
        this.velocities[idx + 1]! *= -bounce;

        // Apply friction on ground (frame-rate-independent; see frictionFactor above)
        this.velocities[idx]! *= frictionFactor;
        this.velocities[idx + 2]! *= frictionFactor;

        // Slide acceleration (downhill push in -Z direction)
        this.velocities[idx + 2]! -= 2 * dt;
      }

      // Update rotation (tumbling effect)
      const speed = Math.abs(this.velocities[idx + 2]!);
      this.rotations[idx]     = this.rotations[idx]!     + speed * dt * 2;
      this.rotations[idx + 1] = this.rotations[idx + 1]! + this.velocities[idx]! * dt;

      // Update instance matrix
      this.dummy.position.set(
        this.positions[idx],
        this.positions[idx + 1]!,
        this.positions[idx + 2]!
      );
      this.dummy.rotation.set(
        this.rotations[idx],
        this.rotations[idx + 1]!,
        this.rotations[idx + 2]!
      );
      this.dummy.scale.setScalar(radius);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;

    // Billowing powder kicked up by the tumbling boulders.
    this._updatePowder(dt);
  }

  // Advance the existing powder puffs and spawn a few new ones from random
  // boulders each frame, so a live slide trails a rolling cloud of snow. No-op
  // when the pool is empty (headless Node). Driven only while `active`, since
  // update() early-returns otherwise.
  _updatePowder(dt: number): void {
    if (this.powder.length === 0) return;

    // 1) Integrate active puffs: drift, light gravity, air drag, expand + fade.
    for (const sprite of this.powder) {
      const ud = sprite.userData as PowderPuffData;
      if (!ud.active) continue;

      ud.life -= dt;
      if (ud.life <= 0) {
        ud.active = false;
        sprite.visible = false; // drop it from the render traversal again
        sprite.scale.set(0, 0, 0);
        sprite.material.opacity = 0;
        continue;
      }

      sprite.position.x += ud.vx * dt;
      sprite.position.y += ud.vy * dt;
      sprite.position.z += ud.vz * dt;

      ud.vy -= 4.5 * dt;               // light gravity: lofts, then settles
      ud.vx *= (1 - 1.4 * dt);         // air drag billows and slows the spread
      ud.vz *= (1 - 1.4 * dt);
      ud.vy *= (1 - 0.6 * dt);

      const ratio = ud.life / ud.maxLife;       // 1 at birth -> 0 at death
      const grow = ud.size * (1 + (1 - ratio) * 2.0); // clouds expand as they age
      sprite.scale.set(grow, grow, grow);

      // Quick fade-in over the first ~12% of life, hold, then fade out below 55%.
      const fade = Math.max(0, Math.min(1, Math.min((1 - ratio) / 0.12, ratio / 0.55)));
      sprite.material.opacity = ud.opacity0 * fade;
      sprite.material.rotation += ud.rotSpeed * dt;
    }

    // 2) Emit new puffs from random boulders at a frame-rate-INDEPENDENT rate
    //    (#400). The old code emitted 3-7 puffs per RENDER frame, so a 144 Hz
    //    panel produced ~2.4x the powder of a 60 Hz one. The accumulator ticks
    //    at the 60 Hz reference rate — the same puffs-per-second at any render
    //    rate — and each tick emits the familiar 3-7 puff group. Catch-up after
    //    a stall is capped (the pool's round-robin bail saturates it anyway).
    this.powderEmitAccum = Math.min(this.powderEmitAccum + dt * 60, 4);
    while (this.powderEmitAccum >= 1) {
      this.powderEmitAccum -= 1;
      const emit = 3 + Math.floor(cosmeticRandom('avalanchePowder') * 5); // ~3..7 per 60 Hz tick
      for (let k = 0; k < emit; k++) {
        // Find the next inactive puff (round-robin); bail this tick if all in use.
        let n = this.powderNext;
        let tries = 0;
        while ((this.powder[n]!.userData as PowderPuffData).active && tries < this.powder.length) {
          n = (n + 1) % this.powder.length;
          tries++;
        }
        this.powderNext = (n + 1) % this.powder.length;
        if (tries >= this.powder.length) break;

        const bi = Math.floor(cosmeticRandom('avalanchePowder') * this.count);
        const bidx = bi * 3;
        const r = this.sizes[bi]!;

        const sprite = this.powder[n]!;
        sprite.position.set(
          this.positions[bidx]!     + (cosmeticRandom('avalanchePowder') - 0.5) * (1.5 + r),
          this.positions[bidx + 1]! + 0.3 + cosmeticRandom('avalanchePowder') * r,
          this.positions[bidx + 2]! + (cosmeticRandom('avalanchePowder') - 0.5) * (1.5 + r)
        );

        const ud = sprite.userData as PowderPuffData;
        ud.vx = this.velocities[bidx]! * 0.25 + (cosmeticRandom('avalanchePowder') - 0.5) * 4;
        ud.vy = 2 + cosmeticRandom('avalanchePowder') * 4;                           // loft upward
        ud.vz = this.velocities[bidx + 2]! * 0.35 - cosmeticRandom('avalanchePowder') * 1.5; // carried downhill
        ud.size = 3 + cosmeticRandom('avalanchePowder') * 3.5 + r;
        ud.opacity0 = 0.4 + cosmeticRandom('avalanchePowder') * 0.35;
        ud.maxLife = 1.1 + cosmeticRandom('avalanchePowder') * 1.4;
        ud.life = ud.maxLife;
        ud.active = true;
        sprite.visible = true; // back into the render traversal while it's live
        sprite.scale.set(ud.size, ud.size, ud.size);
        sprite.material.opacity = 0; // ramps in on the next update
      }
    }
  }

  // Check if player is buried by avalanche (collision = burial). NOTE: whether an
  // overlap actually ENDS the run is decided by resolveBurialOutcome (below) at the
  // loop's burial-check site — a deliberate jump can dodge the slide (JP-3, #47).
  checkBurial(playerPos: Vec3Like, hitRadius: number = 2): boolean {
    if (!this.active) return false;

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const dx = this.positions[idx]! - playerPos.x;
      const dy = this.positions[idx + 1]! - playerPos.y;
      const dz = this.positions[idx + 2]! - playerPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const threshold = hitRadius + this.sizes[i]!;

      if (distSq < threshold * threshold) {
        return true;
      }
    }
    return false;
  }

  // Get closest boulder distance (for warnings)
  getClosestDistance(playerPos: Vec3Like): number {
    if (!this.active) return Infinity;

    let minDist = Infinity;
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const dx = this.positions[idx]! - playerPos.x;
      const dz = this.positions[idx + 2]! - playerPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  // Check if avalanche has passed player (all boulders ahead of player)
  hasPassed(playerPos: Vec3Like): boolean {
    if (!this.active) return false;

    let passedCount = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      // Boulder is ahead if its Z is less than player Z (further downhill)
      if (this.positions[idx + 2]! < playerPos.z - 10) {
        passedCount++;
      }
    }
    // Consider passed if 80% of boulders are ahead
    return passedCount > this.count * 0.8;
  }

  reset(): void {
    this.active = false;
    this._hideAll();
    this._hidePowder();
  }

  _hidePowder(): void {
    for (const sprite of this.powder) {
      sprite.userData.active = false;
      sprite.visible = false; // keep inactive puffs out of the render traversal
      sprite.scale.set(0, 0, 0);
      sprite.material.opacity = 0;
    }
    this.powderNext = 0;
    this.powderEmitAccum = 0;
  }

  _hideAll(): void {
    for (let i = 0; i < this.count; i++) {
      this.dummy.position.set(0, -500, 0);
      this.dummy.scale.setScalar(0.01);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();

    for (const sprite of this.powder) {
      this.scene.remove(sprite);
      sprite.material.dispose();
    }
    this.powder.length = 0;
    if (this.powderTexture) {
      this.powderTexture.dispose();
      this.powderTexture = null;
    }
  }
}

// --- Avalanche-dodge window (jump-system completion JP-3 — the #47 headline) ----
// The pure decision core for one frame's burial overlap, applied at the loop's
// checkBurial() site in game/main-loop.ts (NEVER in the physics kernel — #245).
// A player who is airborne on a DELIBERATE jump (playerJump provenance) while the
// front overlaps them dodges the slide instead of being buried; the first dodging
// frame of a slide additionally awards the once-per-slide bonus. Exploit guards,
// pinned headlessly in tests/avalanche-tests.js:
//   - provenance: auto-jump / hop air (playerJump false) is buried like grounded;
//   - once per slide: `dodgeAwarded` (GameState, reset when the slide resets)
//     collapses later dodging frames to 'dodged' (immune, no second award);
//   - no grounded farming: without overlap the outcome is 'safe' regardless of
//     input, and a grounded press during overlap is simply 'buried' — holding Jump
//     near the slide does nothing (a grounded press spends its cooldown before the
//     front arrives; the award needs airborne overlap).

/** Outcome of one frame's burial check.
 *  'safe'        — no boulder overlaps the player; nothing happens.
 *  'buried'      — overlap without a deliberate-jump air phase: run over.
 *  'dodgedFirst' — overlap dodged mid-jump, first time this slide: award + immune.
 *  'dodged'      — overlap dodged mid-jump, already awarded: immune only. */
export type BurialOutcome = 'safe' | 'buried' | 'dodgedFirst' | 'dodged';

export function resolveBurialOutcome(
  overlapping: boolean,
  isInAir: boolean,
  playerJump: boolean,
  dodgeAwarded: boolean
): BurialOutcome {
  if (!overlapping) return 'safe';
  if (isInAir && playerJump) return dodgeAwarded ? 'dodged' : 'dodgedFirst';
  return 'buried';
}

// The window.Avalanche bridge was removed (issue #84): snowglider.js imports
// AvalancheSystem and the avalanche browser tests import it too.
