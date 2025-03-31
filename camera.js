// camera.js - Camera management for SnowGlider

class Camera {
  constructor(scene) {
    // Create the camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    
    // Initialize camera vectors for smoothing
    this.smoothingVectors = {
      lastPosition: new THREE.Vector3(),
      targetPosition: new THREE.Vector3(),
      lookAtPosition: new THREE.Vector3()
    };
    
    // Camera parameters
    this.smoothing = 0.08; // Lower value for smoother camera
    this.minDistance = 15;
    this.maxDistance = 25;
    this.speedThreshold = 20; // Speed at which we reach max distance
    this.frameCount = 0;
    this.isFirstFrame = true;
    
    // Camera mode - "thirdPerson" (default) or "firstPerson"
    this.mode = "thirdPerson";
  }

  // Position camera initially behind the player
  initialize(playerPosition, playerRotation) {
    if (this.mode === "firstPerson") {
      // First-person camera initialization
      const angle = playerRotation.y;
      
      // Position camera significantly above and behind the head
      const cameraOffset = new THREE.Vector3(
        // Slightly to the right of center (0.2 units) to avoid the nose
        -Math.sin(angle) * 2.5 + 0.2,
        // Well above the head (head is at 7.5, camera at 10.0)
        10.0,
        // Further behind the head by 2.5 units
        -Math.cos(angle) * 2.5
      );
      
      // Position camera relative to player
      const cameraPosition = new THREE.Vector3().copy(playerPosition).add(cameraOffset);
      this.camera.position.copy(cameraPosition);
      
      // Match snowman's rotation
      this.camera.rotation.set(playerRotation.x, playerRotation.y, playerRotation.z);
      
      // Look further ahead to compensate for the higher and more distant camera position
      const lookTarget = new THREE.Vector3(
        playerPosition.x + Math.sin(playerRotation.y) * 8,
        playerPosition.y + 6.5, // Look more downward for better terrain visibility
        playerPosition.z + Math.cos(playerRotation.y) * 8
      );
      this.camera.lookAt(lookTarget);
    } else {
      // Original third-person camera initialization
      // Calculate the exact position where the camera should be
      const angle = playerRotation.y;
      // Start with the base distance of 15 - will adjust dynamically during gameplay
      const offset = new THREE.Vector3(0, 8, 15);
      const camOffset = new THREE.Vector3(
        Math.sin(angle) * offset.z,
        offset.y,
        Math.cos(angle) * offset.z
      );
      
      // Place camera exactly where it should be in its final position
      const initialPos = new THREE.Vector3(playerPosition.x, playerPosition.y, playerPosition.z).add(camOffset);
      this.camera.position.copy(initialPos);
      this.camera.lookAt(playerPosition.x, playerPosition.y, playerPosition.z);
      
      // Initialize smoothing vectors exactly matching the final position
      this.smoothingVectors.targetPosition.copy(initialPos);
      this.smoothingVectors.lastPosition.copy(initialPos);
      this.smoothingVectors.lookAtPosition.set(playerPosition.x, playerPosition.y, playerPosition.z);
    }
    
    // Reset frame counter
    this.frameCount = 0;
    this.isFirstFrame = true;
  }

  // Toggle between first-person and third-person views
  toggleCameraMode() {
    this.mode = this.mode === "thirdPerson" ? "firstPerson" : "thirdPerson";
    console.log(`Camera mode switched to: ${this.mode}`);
    return this.mode;
  }
  
  // Update camera position based on player position, rotation, and velocity
  update(playerPosition, playerRotation, velocity, getTerrainHeight) {
    // Track frames for smoothing transitions
    this.frameCount++;
    
    if (this.mode === "firstPerson") {
      this.updateFirstPerson(playerPosition, playerRotation, velocity);
      return;
    }
    
    // Third-person camera mode (original implementation)
    
    // Special handling for the first frame to ensure proper initialization
    if (this.isFirstFrame) {
      this.isFirstFrame = false;
      this.frameCount = 0;
      
      // Calculate the exact position where the camera should be based on the player's rotation
      const angle = playerRotation.y;
      const offset = new THREE.Vector3(0, 8, 15);
      const camOffset = new THREE.Vector3(
        Math.sin(angle) * offset.z,
        offset.y,
        Math.cos(angle) * offset.z
      );
      
      // Set camera directly to its final position
      const camPos = new THREE.Vector3().copy(playerPosition).add(camOffset);
      this.camera.position.copy(camPos);
      
      // Ensure all vectors are properly set to match this position
      this.smoothingVectors.lastPosition.copy(camPos);
      this.smoothingVectors.targetPosition.copy(camPos);
      this.smoothingVectors.lookAtPosition.copy(playerPosition);
      
      // Look at the player
      this.camera.lookAt(playerPosition);
      return;
    }
    
    // Calculate current speed for dynamic camera positioning
    const currentSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    
    // Calculate dynamic distance based on speed
    const dynamicDistance = this.minDistance + Math.min(1.0, currentSpeed / this.speedThreshold) * (this.maxDistance - this.minDistance);
    
    // Position camera above and behind the player with dynamic distance
    const offset = new THREE.Vector3(0, 8, dynamicDistance);
    const angle = playerRotation.y;
    
    const camOffset = new THREE.Vector3(
      Math.sin(angle) * offset.z,
      offset.y,
      Math.cos(angle) * offset.z
    );
    
    // Calculate target position
    this.smoothingVectors.targetPosition.copy(playerPosition).add(camOffset);
    
    // For the first 2 frames, use a higher smoothing factor to quickly snap to position if needed
    let effectiveSmoothingFactor = this.smoothing;
    if (this.frameCount <= 2) {
      effectiveSmoothingFactor = 0.5; // Quick correction in first frames if needed
    }
    
    // Apply smoothing - interpolate current position toward target
    this.camera.position.lerp(this.smoothingVectors.targetPosition, effectiveSmoothingFactor);
    
    // Maintain minimum height above terrain to prevent camera from going below ground
    const terrainHeightAtCamera = getTerrainHeight(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < terrainHeightAtCamera + 5) {
      this.camera.position.y = terrainHeightAtCamera + 5;
    }
    
    // Also smooth the lookAt point, focusing slightly ahead of the player in movement direction
    this.smoothingVectors.lookAtPosition.copy(playerPosition);
    
    // Add a small forward offset based on speed vector to look ahead slightly
    const speedMagnitude = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (speedMagnitude > 1) {
      const lookAheadFactor = Math.min(5, speedMagnitude * 0.3);
      this.smoothingVectors.lookAtPosition.x += (velocity.x / speedMagnitude) * lookAheadFactor;
      this.smoothingVectors.lookAtPosition.z += (velocity.z / speedMagnitude) * lookAheadFactor;
    }
    
    this.camera.lookAt(this.smoothingVectors.lookAtPosition);
    
    // Save current position for next frame
    this.smoothingVectors.lastPosition.copy(this.camera.position);
  }
  
  // First-person camera update method
  updateFirstPerson(playerPosition, playerRotation, velocity) {
    // Calculate a position slightly behind and above the snowman's head
    // to prevent obstruction by the character model
    const angle = playerRotation.y;
    
    // Position camera significantly above and behind the head
    const cameraOffset = new THREE.Vector3(
      // Slightly to the right of center (0.2 units) to avoid the nose
      -Math.sin(angle) * 2.5 + 0.2,
      // Well above the head (head is at 7.5, camera at 10.0)
      10.0,
      // Further behind the head by 2.5 units
      -Math.cos(angle) * 2.5
    );
    
    // Position camera relative to player
    const cameraPosition = new THREE.Vector3().copy(playerPosition).add(cameraOffset);
    this.camera.position.copy(cameraPosition);
    
    // Match camera rotation with snowman's rotation direction
    this.camera.rotation.set(playerRotation.x, playerRotation.y, playerRotation.z);
    
    // Add a more significant forward-looking offset for better visibility
    const speedMagnitude = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    
    // Calculate a point to look at ahead of the snowman, increased distance for better visibility
    const lookAheadFactor = Math.min(10, Math.max(6, speedMagnitude * 0.5));
    const lookTarget = new THREE.Vector3(
      playerPosition.x + Math.sin(angle) * lookAheadFactor,
      // Look more downward for better terrain visibility due to higher camera
      playerPosition.y + 6.0, 
      playerPosition.z + Math.cos(angle) * lookAheadFactor
    );
    this.camera.lookAt(lookTarget);
  }

  // Handle window resize
  handleResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // Get camera for rendering
  getCamera() {
    return this.camera;
  }
}

// In a module environment, you would use:
// export default Camera;