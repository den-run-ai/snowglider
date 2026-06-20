// debris.ts — SnowmanDebris: the crash "breaks down on impact" wipeout (issue #53).
//
// On a CRASH (not a finish), the live snowman is hidden and replaced with a burst of
// free-flying, terrain-aware snow-ball fragments (its three balls + head cluster +
// arms + buttons, cracked into chunks) plus a puff of small snow clumps — the classic
// SkiFree-style wipeout. It is purely cosmetic: it owns its own settle loop so it can
// animate AFTER the run loop has stopped (showGameOver sets gameActive=false), and it
// never touches the physics kernel.
//
// Resource ownership is load-bearing: the snowman is only HIDDEN (visible=false), so
// its geometry/material must survive a crash->restart cycle. Every fragment therefore
// uses geometry/material the debris system *owns* and creates itself (generic snow
// chunks — never a clone that shares the snowman's buffers), tracked so reset() can
// dispose exactly what it made and nothing of the snowman's.
//
// Imports only three (bare), so it loads headless under Node for the unit tests (like
// avalanche.ts); the settle loop self-guards on requestAnimationFrame so headless
// callers drive update(dt) directly.
import * as THREE from 'three';

type TerrainFn = (x: number, z: number) => number;
interface PlanarVelocityLike { x: number; z: number; }
interface ShatterOptions { reducedMotion?: boolean; render?: () => void; }

interface Fragment {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  radius: number;
  life: number;
  maxLife: number;
  puff: boolean;
}

const GRAVITY = 18;
const BOUNCE = 0.35;
const FRICTION = 0.9;
const SETTLE_SECONDS = 2.5;   // how long the burst animates before it's done
const MAX_DT = 0.05;          // clamp per-tick dt for stability

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** A random horizontal burst with an upward pop. */
function radialBurst(horiz: number, up: number): THREE.Vector3 {
  const a = Math.random() * Math.PI * 2;
  const h = horiz * (0.5 + Math.random() * 0.5);
  return new THREE.Vector3(Math.cos(a) * h, up * (0.6 + Math.random() * 0.6), Math.sin(a) * h);
}
function jitter(amount: number): THREE.Vector3 {
  return new THREE.Vector3(rand(-amount, amount), rand(-amount, amount), rand(-amount, amount));
}

export class SnowmanDebris {
  private getTerrainHeight: TerrainFn | null = null;
  private scene: THREE.Scene | null = null;
  private snowman: THREE.Object3D | null = null;
  private fragments: Fragment[] = [];
  private ownedGeometries = new Set<THREE.BufferGeometry>();
  private ownedMaterials = new Set<THREE.Material>();
  private _active = false;
  private rafId: number | null = null;
  private settleTime = 0;
  private render: (() => void) | null = null;

  /** True while the burst is still settling. */
  get active(): boolean { return this._active; }

  /** Inject the terrain sampler so fragments rest on the slope (not at y=0). */
  setTerrainFunction(fn: TerrainFn): void { this.getTerrainHeight = fn; }

  private ownGeo<T extends THREE.BufferGeometry>(g: T): T { this.ownedGeometries.add(g); return g; }
  private ownMat<T extends THREE.Material>(m: T): T { this.ownedMaterials.add(m); return m; }

  /** Burst the snowman apart. Hides `snowman`, spawns owned fragments at the snowman's
   *  world location, and (in a browser) starts a private rAF settle loop that repaints
   *  via `opts.render` — REQUIRED because the main loop has stopped after game over. */
  shatter(scene: THREE.Scene, snowman: THREE.Object3D, velocity: PlanarVelocityLike, opts: ShatterOptions = {}): void {
    this.reset(); // clear any prior burst (and re-show whatever was hidden) first
    this.scene = scene;
    this.snowman = snowman;
    this.render = opts.render || null;
    this._active = true;
    this.settleTime = 0;

    snowman.visible = false;

    const reduced = !!opts.reducedMotion;
    const inheritedX = finite(velocity && velocity.x) * 0.6;
    const inheritedZ = finite(velocity && velocity.z) * 0.6;
    const impact = Math.min(1, Math.hypot(inheritedX, inheritedZ) / 14);

    // One owned white-snow material shared by every fragment (disposed on reset).
    const snowMat = this.ownMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));

    // --- Body fragments: one generic owned chunk per shatter root, big balls cracked
    // into a few sub-chunks so it reads as "the balls breaking". The head cluster /
    // arms are Groups; getWorldPosition + a bounding-box radius handle them uniformly,
    // so we never read .geometry/.material off a Group. ---
    const roots: THREE.Object3D[] = (snowman.userData && snowman.userData.shatterRoots) || [];
    const worldPos = new THREE.Vector3();
    for (const root of roots) {
      root.getWorldPosition(worldPos);
      const size = this.estimateRadius(root);
      const chunks = reduced ? 1 : (size > 1.0 ? 3 : 1);
      for (let c = 0; c < chunks; c++) {
        const r = Math.max(0.2, size * (chunks > 1 ? 0.55 : 0.85) * (0.8 + Math.random() * 0.4));
        const mesh = new THREE.Mesh(this.ownGeo(new THREE.IcosahedronGeometry(r, 0)), snowMat);
        mesh.castShadow = true;
        mesh.position.copy(worldPos);
        if (!reduced) mesh.position.add(jitter(0.4));
        scene.add(mesh);
        const vel = new THREE.Vector3(inheritedX, 0, inheritedZ);
        if (!reduced) vel.add(radialBurst(6 + impact * 5, 4 + impact * 4));
        this.fragments.push({
          mesh, vel, radius: r, life: SETTLE_SECONDS, maxLife: SETTLE_SECONDS, puff: false,
          angVel: reduced ? new THREE.Vector3() : new THREE.Vector3(rand(-6, 6), rand(-6, 6), rand(-6, 6))
        });
      }
    }

    // --- Snow puff: a cloud of small white clumps so the break-up is wrapped in powder. ---
    const center = new THREE.Vector3();
    snowman.getWorldPosition(center);
    center.y += 3;
    const puffCount = reduced ? 4 : 16;
    const puffGeo = this.ownGeo(new THREE.IcosahedronGeometry(0.35, 0));
    for (let i = 0; i < puffCount; i++) {
      const mesh = new THREE.Mesh(puffGeo, snowMat);
      mesh.position.copy(center).add(jitter(0.6));
      scene.add(mesh);
      this.fragments.push({
        mesh, radius: 0.35, puff: true,
        vel: radialBurst(3 + impact * 3, 5 + impact * 3),
        angVel: new THREE.Vector3(),
        life: 0.8 + Math.random() * 0.5, maxLife: 1.3
      });
    }

    // Start the private settle loop only where rAF exists (browser). Headless callers
    // (the unit tests) drive update(dt) directly and never enter this branch.
    if (typeof requestAnimationFrame === 'function') this.startLoop();
  }

  private startLoop(): void {
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let last = clock();
    const tick = () => {
      const now = clock();
      const dt = (now - last) / 1000;
      last = now;
      const settling = this.update(dt);
      if (this.render) this.render();
      this.rafId = settling ? requestAnimationFrame(tick) : null;
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Advance the burst one step. Returns true while still settling. */
  update(dt: number): boolean {
    if (!this._active) return false;
    dt = Math.min(MAX_DT, Math.max(0, finite(dt)));
    this.settleTime += dt;

    for (const f of this.fragments) {
      f.life -= dt;
      f.vel.y -= GRAVITY * dt;
      f.mesh.position.x += f.vel.x * dt;
      f.mesh.position.y += f.vel.y * dt;
      f.mesh.position.z += f.vel.z * dt;
      f.mesh.rotation.x += f.angVel.x * dt;
      f.mesh.rotation.y += f.angVel.y * dt;
      f.mesh.rotation.z += f.angVel.z * dt;

      const floor = this.getTerrainHeight ? this.getTerrainHeight(f.mesh.position.x, f.mesh.position.z) : 0;
      if (f.mesh.position.y < floor + f.radius) {
        f.mesh.position.y = floor + f.radius;
        f.vel.y *= -BOUNCE;
        f.vel.x *= FRICTION;
        f.vel.z *= FRICTION;
        f.angVel.multiplyScalar(FRICTION);
      }

      if (f.puff) {
        f.mesh.scale.setScalar(Math.max(0, f.life / f.maxLife)); // shrink + vanish
      }
    }

    if (this.settleTime >= SETTLE_SECONDS) { this._active = false; return false; }
    return true;
  }

  /** Remove + dispose every debris-owned resource and re-show the snowman. Never
   *  disposes the snowman's own geometry/material (the burst owns separate assets). */
  reset(): void {
    if (this.rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.scene) {
      for (const f of this.fragments) this.scene.remove(f.mesh);
    }
    this.fragments = [];
    for (const g of this.ownedGeometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedGeometries.clear();
    this.ownedMaterials.clear();
    if (this.snowman) this.snowman.visible = true;
    this._active = false;
    this.settleTime = 0;
  }

  /** A clamped bounding-sphere radius for a part (works for Mesh and Group alike). */
  private estimateRadius(obj: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    return Math.max(0.3, Math.min(2.5, Math.max(size.x, size.y, size.z) * 0.5));
  }
}
