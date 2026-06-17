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

export class AvalancheSystem {
  scene: THREE.Scene;
  count: number;
  active: boolean;
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

  constructor(scene: THREE.Scene, count: number = 120) {
    this.scene = scene;
    this.count = count;
    this.active = false;
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

    // Hide initially
    this._hideAll();
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
      const angle = (Math.random() - 0.5) * Math.PI * 0.6;
      const dist = 25 + Math.random() * 15;

      // Player moves in -Z direction (downhill), so spawn behind = +Z offset
      this.positions[idx]     = playerPos.x + Math.sin(angle) * dist;
      this.positions[idx + 1] = playerPos.y + 8 + Math.random() * 6;
      this.positions[idx + 2] = playerPos.z + dist * Math.cos(angle); // Behind player (uphill)

      // Initial velocity - moving toward player (downhill = -Z)
      this.velocities[idx]     = (Math.random() - 0.5) * 2;
      this.velocities[idx + 1] = 0;
      this.velocities[idx + 2] = -(8 + Math.random() * 4); // Negative Z = downhill

      // Random sizes
      this.sizes[i] = 0.4 + Math.random() * 1.2;

      // Random initial rotation
      this.rotations[idx]     = Math.random() * Math.PI * 2;
      this.rotations[idx + 1] = Math.random() * Math.PI * 2;
      this.rotations[idx + 2] = Math.random() * Math.PI * 2;
    }
  }

  // Call every frame with delta time
  update(dt: number): void {
    if (!this.active) return;

    const gravity = 18;
    const friction = 0.98;
    const bounce = 0.25;

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;

      // Apply gravity
      this.velocities[idx + 1] -= gravity * dt;

      // Update positions
      this.positions[idx]     += this.velocities[idx] * dt;
      this.positions[idx + 1] += this.velocities[idx + 1] * dt;
      this.positions[idx + 2] += this.velocities[idx + 2] * dt;

      // Get terrain height at current position
      let floorY = 0;
      if (this.getTerrainHeight) {
        floorY = this.getTerrainHeight(this.positions[idx], this.positions[idx + 2]);
      }

      const radius = this.sizes[i];

      // Ground collision
      if (this.positions[idx + 1] < floorY + radius) {
        this.positions[idx + 1] = floorY + radius;
        this.velocities[idx + 1] *= -bounce;

        // Apply friction on ground
        this.velocities[idx] *= friction;
        this.velocities[idx + 2] *= friction;

        // Slide acceleration (downhill push in -Z direction)
        this.velocities[idx + 2] -= 2 * dt;
      }

      // Update rotation (tumbling effect)
      const speed = Math.abs(this.velocities[idx + 2]);
      this.rotations[idx]     += speed * dt * 2;
      this.rotations[idx + 1] += this.velocities[idx] * dt;

      // Update instance matrix
      this.dummy.position.set(
        this.positions[idx],
        this.positions[idx + 1],
        this.positions[idx + 2]
      );
      this.dummy.rotation.set(
        this.rotations[idx],
        this.rotations[idx + 1],
        this.rotations[idx + 2]
      );
      this.dummy.scale.setScalar(radius);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Check if player is buried by avalanche (collision = burial)
  checkBurial(playerPos: Vec3Like, hitRadius: number = 2): boolean {
    if (!this.active) return false;

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const dx = this.positions[idx] - playerPos.x;
      const dy = this.positions[idx + 1] - playerPos.y;
      const dz = this.positions[idx + 2] - playerPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const threshold = hitRadius + this.sizes[i];

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
      const dx = this.positions[idx] - playerPos.x;
      const dz = this.positions[idx + 2] - playerPos.z;
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
      if (this.positions[idx + 2] < playerPos.z - 10) {
        passedCount++;
      }
    }
    // Consider passed if 80% of boulders are ahead
    return passedCount > this.count * 0.8;
  }

  reset(): void {
    this.active = false;
    this._hideAll();
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
  }
}

// The window.Avalanche bridge was removed (issue #84): snowglider.js imports
// AvalancheSystem and the avalanche browser tests import it too.
