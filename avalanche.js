// avalanche.js - Simple avalanche system for Snowglider
// Triggered when player travels far enough downhill - burial = game over

class AvalancheSystem {
  constructor(scene, count = 120) {
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
    this.scene.add(this.mesh);
    
    // Hide initially
    this._hideAll();
  }
  
  // Connect to terrain system
  setTerrainFunction(fn) {
    this.getTerrainHeight = fn;
  }
  
  // Trigger avalanche behind player position
  trigger(playerPos) {
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
  update(dt) {
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
  checkBurial(playerPos, hitRadius = 2) {
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
  getClosestDistance(playerPos) {
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
  hasPassed(playerPos) {
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
  
  reset() {
    this.active = false;
    this._hideAll();
  }
  
  _hideAll() {
    for (let i = 0; i < this.count; i++) {
      this.dummy.position.set(0, -500, 0);
      this.dummy.scale.setScalar(0.01);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// Export globally like other modules
const Avalanche = {
  AvalancheSystem
};

if (typeof window !== 'undefined') {
  window.Avalanche = Avalanche;
}
