// snowtracks.ts - Temporary ski-track overlay (issue #17 follow-up).
//
// The static surface never "did anything" as the snowman moved, so the slope read
// as inert. This adds a transient track overlay: the skis carve faint grooves as
// the snowman moves, and each groove fades over a few seconds (reading as fresh
// snow settling back over it).
//
// Scope honesty (per PR #181 review): this is *temporary track feedback*, NOT a
// snow-accumulation model. It does not model falling snow building up depth on the
// surface or persistent compaction. A real accumulation pass would be a low-res
// persistent `SnowDepthField` (snowfall raises depth, skis compact it into a track
// mask, tracks refill over time, rocks/trees sample the same coverage) fed into the
// terrain material — a separate, larger effort tracked as a follow-up.
//
// Contract & safety:
//  - Purely cosmetic. It only READS snowman.position and the injected terrain
//    height; it never touches pos/velocity, the physics kernel, or the height
//    field, so the determinism/physics-invariant harness is unaffected (the trails
//    aren't even on the grounded path — they run from the main loop, gated on
//    gameActive, after the physics step).
//  - Perf-bounded: a fixed ring-buffer pool of instanced quads (no per-frame
//    allocation, one InstancedMesh draw), mirroring AvalancheSystem.
//  - Headless-safe: uses geometry + a colour material only (no canvas/DOM), so the
//    Node tests construct it exactly like the avalanche system.
//  - Respects `prefers-reduced-motion`: when set, stamping/animation are skipped
//    (the mesh stays empty), matching EffectsModule's reduced-motion gating.
//
// Groundwork note: the same per-dab pool + terrain sampler is the seam a fuller
// accumulation model (an actual deepening/snow-depth field, or persistent packed
// tracks) would extend — the stamping cadence and lifetime live behind named
// constants below.
import * as THREE from 'three';

/** Minimal positional shape (accepts a THREE.Vector3 or a plain literal). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Terrain sampler injected via {@link SnowTrails.setTerrainFunction}. */
export type TerrainHeightFn = (x: number, z: number) => number;

// --- Tunables ---
const POOL = 220;                 // ring-buffer of trail dabs (110 stamps x 2 skis)
const STAMP_SPACING = 1.1;        // world units of travel between stamps
const TRAIL_LIFETIME = 5.5;       // seconds for a dab to be covered by fresh snow
const DAB_WIDTH = 0.55;           // cross-track width of one ski groove
const DAB_LENGTH = 2.2;           // along-track length of one dab
const SKI_HALF_GAUGE = 1.1;       // half the distance between the two ski grooves
const SURFACE_LIFT = 0.06;        // sit just above terrain to avoid z-fighting
const SLOPE_SAMPLE = 0.5;         // central-difference eps for the terrain normal
const MIN_SPEED = 1.2;            // don't stamp when essentially stopped

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class SnowTrails {
  scene: THREE.Scene;
  count: number;
  enabled: boolean;
  getTerrainHeight: TerrainHeightFn | null;
  mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

  // Per-dab state (ring buffer). age >= life => inactive (scaled to 0).
  private ages: Float32Array;
  private lives: Float32Array;
  private px: Float32Array;
  private pz: Float32Array;
  private py: Float32Array;
  private quats: Float32Array; // per-dab orientation (x,y,z,w), pitched to the slope
  private next: number;

  private dummy: THREE.Object3D;
  private quat: THREE.Quaternion;
  // Scratch for building a slope-conforming orientation basis (no per-frame allocs).
  private basis: THREE.Matrix4;
  private vUp: THREE.Vector3;
  private vFwd: THREE.Vector3;
  private vRight: THREE.Vector3;

  // Stamp cadence: distance accumulated since the last pair of dabs.
  private lastX: number | null;
  private lastZ: number | null;
  private sinceStamp: number;

  constructor(scene: THREE.Scene, count: number = POOL) {
    this.scene = scene;
    this.count = count;
    this.enabled = !prefersReducedMotion();
    this.getTerrainHeight = null;
    this.next = 0;
    this.lastX = null;
    this.lastZ = null;
    this.sinceStamp = 0;

    this.ages = new Float32Array(count);
    this.lives = new Float32Array(count);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.quats = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) this.ages[i] = Infinity; // start inactive

    this.dummy = new THREE.Object3D();
    this.quat = new THREE.Quaternion();
    this.basis = new THREE.Matrix4();
    this.vUp = new THREE.Vector3();
    this.vFwd = new THREE.Vector3();
    this.vRight = new THREE.Vector3();

    // A flat quad lying in the XZ plane; the per-instance matrix scales/orients it.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    // Carved snow shows a faint cool shadow groove — translucent so the surface
    // texture shows through, depthWrite off so overlapping dabs don't z-fight.
    const material = new THREE.MeshStandardMaterial({
      color: 0x97a9bf,
      roughness: 1.0,
      metalness: 0.0,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false; // trails follow the player; never cull the batch
    this.mesh.renderOrder = 1;        // draw over the terrain
    // Hide every instance until it is stamped.
    for (let i = 0; i < count; i++) {
      this.dummy.position.set(0, -10000, 0);
      this.dummy.scale.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  setTerrainFunction(fn: TerrainHeightFn): void {
    this.getTerrainHeight = fn;
  }

  /**
   * Drop one dab into the ring buffer at the given ski-groove position, pitched to
   * the local terrain slope. A flat horizontal dab on the downhill run (terrain
   * drops ~0.12+/unit) would sink one end below the snow and get depth-culled, so
   * the track flickers (PR #181 codex review). Here the dab's up axis is set to the
   * terrain normal (finite-difference of getTerrainHeight) and its length axis to
   * the heading projected onto that slope, so the whole quad sits just above the
   * surface and reads as a continuous groove.
   */
  private stampDab(x: number, z: number, heading: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    const getH = this.getTerrainHeight;
    const groundY = getH ? getH(x, z) : 0;
    this.px[i] = x;
    this.pz[i] = z;
    this.py[i] = groundY + SURFACE_LIFT;

    // Terrain normal from a central difference; identity (flat) when no sampler.
    if (getH) {
      const e = SLOPE_SAMPLE;
      const nx = -(getH(x + e, z) - getH(x - e, z)) / (2 * e);
      const nz = -(getH(x, z + e) - getH(x, z - e)) / (2 * e);
      this.vUp.set(nx, 1, nz).normalize();
    } else {
      this.vUp.set(0, 1, 0);
    }
    // Heading direction (the dab's local +Z / length axis before conforming).
    this.vFwd.set(Math.sin(heading), 0, Math.cos(heading));
    // Orthonormal slope basis: right ⟂ up & heading, fwd back in the slope plane.
    this.vRight.crossVectors(this.vUp, this.vFwd).normalize();
    this.vFwd.crossVectors(this.vRight, this.vUp).normalize();
    this.basis.makeBasis(this.vRight, this.vUp, this.vFwd);
    this.quat.setFromRotationMatrix(this.basis);
    this.quats[i * 4] = this.quat.x;
    this.quats[i * 4 + 1] = this.quat.y;
    this.quats[i * 4 + 2] = this.quat.z;
    this.quats[i * 4 + 3] = this.quat.w;

    this.ages[i] = 0;
    this.lives[i] = TRAIL_LIFETIME;
  }

  /**
   * Advance one frame. Stamps a fresh pair of ski grooves once the snowman has
   * travelled `STAMP_SPACING`, then ages every live dab so it fades (shrinks) as
   * fresh snow covers it. No-op when airborne (skis aren't in the snow), disabled,
   * or before a terrain function is set.
   */
  update(delta: number, snowman: { position: Vec3Like; rotation: { y: number } }, isInAir: boolean): void {
    if (!this.enabled) return;

    const px = snowman.position.x;
    const pz = snowman.position.z;
    const heading = snowman.rotation.y;

    // Stamp new grooves only while grounded and moving.
    if (!isInAir && this.getTerrainHeight) {
      if (this.lastX === null || this.lastZ === null) {
        this.lastX = px;
        this.lastZ = pz;
      } else {
        const dx = px - this.lastX;
        const dz = pz - this.lastZ;
        const moved = Math.sqrt(dx * dx + dz * dz);
        const prevX = this.lastX;
        const prevZ = this.lastZ;
        this.lastX = px;
        this.lastZ = pz;
        if (moved > 0 && moved / Math.max(delta, 1e-3) > MIN_SPEED) {
          // Lay each missed stamp ALONG the segment travelled this frame, not all at
          // the current position. A fast or hitchy frame (or the capped 0.1s delta)
          // can cover several `STAMP_SPACING`s at once; stamping them all at `px/pz`
          // stacked a clump of dabs under the snowman and left the crossed segment
          // untracked (grooves became blobs + gaps). `sinceStamp` carries the residual
          // distance across frames so spacing stays even. (codex review, #181.)
          const inv = 1 / moved;
          const ux = dx * inv;
          const uz = dz * inv;
          // Two grooves, offset left/right of travel by the ski gauge.
          const sin = Math.sin(heading);
          const cos = Math.cos(heading);
          // Lateral (cross-track) offset = perpendicular to heading in XZ.
          const offX = cos * SKI_HALF_GAUGE;
          const offZ = -sin * SKI_HALF_GAUGE;
          // First stamp completes the spacing left over from the previous frame.
          let dist = STAMP_SPACING - this.sinceStamp;
          if (dist > moved) {
            this.sinceStamp += moved;
          } else {
            let lastDist = 0;
            while (dist <= moved) {
              const sx = prevX + ux * dist;
              const sz = prevZ + uz * dist;
              this.stampDab(sx + offX, sz + offZ, heading);
              this.stampDab(sx - offX, sz - offZ, heading);
              lastDist = dist;
              dist += STAMP_SPACING;
            }
            this.sinceStamp = moved - lastDist;
          }
        } else {
          // Creeping/stopped: accumulate travel (capped) but don't lay grooves at a
          // crawl, and don't let a backlog build up that would dump on the next glide.
          this.sinceStamp = Math.min(this.sinceStamp + moved, STAMP_SPACING);
        }
      }
    } else {
      // Airborne / stopped: keep the cadence anchored to current position so we
      // don't dump a burst of dabs on landing.
      this.lastX = px;
      this.lastZ = pz;
    }

    // Age + re-stamp the instance matrices (fade by shrinking the groove).
    let anyActive = false;
    for (let i = 0; i < this.count; i++) {
      const age = this.ages[i]!;
      if (!isFinite(age) || age >= this.lives[i]!) continue;
      const next = age + delta;
      this.ages[i] = next;
      if (next >= this.lives[i]!) {
        // Expired: hide it.
        this.dummy.position.set(0, -10000, 0);
        this.dummy.scale.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        this.ages[i] = Infinity;
        continue;
      }
      anyActive = true;
      const fade = 1 - next / this.lives[i]!; // 1 fresh -> 0 covered
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.quaternion.set(
        this.quats[i * 4]!, this.quats[i * 4 + 1]!, this.quats[i * 4 + 2]!, this.quats[i * 4 + 3]!
      );
      // Groove narrows as it fills in; length holds so it reads as a track, not a dot.
      this.dummy.scale.set(DAB_WIDTH * (0.35 + 0.65 * fade), 1, DAB_LENGTH);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    // Fade the whole batch out near the end too, for a softer disappearance.
    this.mesh.visible = anyActive;
  }

  /** Clear all trails (called on reset/restart). */
  reset(): void {
    for (let i = 0; i < this.count; i++) {
      this.ages[i] = Infinity;
      this.dummy.position.set(0, -10000, 0);
      this.dummy.scale.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.lastX = null;
    this.lastZ = null;
    this.sinceStamp = 0;
    this.next = 0;
  }

  /**
   * Free the GPU resources this system owns and detach it from the scene. The
   * trail pool is an app-lifetime singleton during normal play (allocated once,
   * reused for the page's life — `reset()` only zeroes the instance matrices), so
   * this is called ONLY from the teardown path (`disposeGame`) / dev-HMR, never on
   * a run reset. Mirrors {@link AvalancheSystem.dispose}: the InstancedMesh's
   * geometry + material are the disposable GPU handles; the typed-array ring
   * buffers are plain JS and are reclaimed with the instance. Idempotent — THREE's
   * `dispose()` tolerates a second call, and `scene.remove` of an absent child is a
   * no-op.
   */
  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /** Number of currently-live dabs (used by tests). */
  activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (isFinite(this.ages[i]!) && this.ages[i]! < this.lives[i]!) n++;
    }
    return n;
  }
}
