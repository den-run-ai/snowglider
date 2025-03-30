// Utils.js - Utility functions for the snowman skiing game

// Mountains features are now in mountains.js
// This file now delegates terrain/mountain calls to mountains.js

// --- Snow Particle System ---
const snowflakes = [];
const snowflakeCount = 1000;
const snowflakeSpread = 100; // Spread area around player
const snowflakeHeight = 50; // Height above player
const snowflakeFallSpeed = 5;

// Snowman code moved to snowman.js

function createSnowflakes(scene) {
  // Create a simple white circle texture for snowflakes
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  
  // Draw a soft, white circle
  const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ 
    map: texture,
    transparent: true
  });
  
  // Create individual snowflakes
  for (let i = 0; i < snowflakeCount; i++) {
    const snowflake = new THREE.Sprite(material);
    
    // Random size (smaller snowflakes to look more realistic)
    const size = 0.2 + Math.random() * 0.4;
    snowflake.scale.set(size, size, size);
    
    // Random positions in a box above the player
    resetSnowflakePosition(snowflake, { x: 0, y: 0, z: -40 });
    
    // Random speeds for natural variation
    snowflake.userData.speed = (0.7 + Math.random() * 0.6) * snowflakeFallSpeed;
    snowflake.userData.wobble = Math.random() * 0.1;
    snowflake.userData.wobbleSpeed = 0.5 + Math.random() * 1.5;
    snowflake.userData.wobblePos = Math.random() * Math.PI * 2;
    
    scene.add(snowflake);
    snowflakes.push(snowflake);
  }
}

function resetSnowflakePosition(snowflake, playerPos) {
  // Position snowflakes randomly in a box above the player
  snowflake.position.x = playerPos.x + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.z = playerPos.z + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.y = playerPos.y + Math.random() * snowflakeHeight;
}

function updateSnowflakes(delta, playerPos, scene) {
  snowflakes.forEach(snowflake => {
    // Apply falling movement
    snowflake.position.y -= snowflake.userData.speed * delta;
    
    // Add some gentle sideways wobble for realism
    snowflake.userData.wobblePos += snowflake.userData.wobbleSpeed * delta;
    snowflake.position.x += Math.sin(snowflake.userData.wobblePos) * snowflake.userData.wobble;
    
    // Check if snowflake has fallen below the terrain or is too far from player
    const terrainHeight = Mountains.getTerrainHeight(snowflake.position.x, snowflake.position.z);
    const distanceToPlayer = Math.sqrt(
      Math.pow(snowflake.position.x - playerPos.x, 2) + 
      Math.pow(snowflake.position.z - playerPos.z, 2)
    );
    
    if (snowflake.position.y < terrainHeight || distanceToPlayer > snowflakeSpread) {
      resetSnowflakePosition(snowflake, playerPos);
    }
  });
}

// Create a snow splash particle system for ski effects
function createSnowSplash() {
  // Create a simple white circle texture for snow splash
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  
  // Draw a bright white circle with soft edges
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.8)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  
  const texture = new THREE.CanvasTexture(canvas);
  
  // Follow the same approach as snowflakes - use individual sprites
  // which is proven to work well in this codebase
  const splashParticles = [];
  const particleCount = 200; // Good balance of performance and effect
  
  // Create the base material that all particles will use
  const material = new THREE.SpriteMaterial({ 
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending // Make particles brighter where they overlap
  });
  
  // Create individual particles
  for (let i = 0; i < particleCount; i++) {
    const particle = new THREE.Sprite(material.clone()); // Clone material for unique opacity
    
    // Start with zero size (invisible)
    particle.scale.set(0, 0, 0);
    
    // Store particle-specific data
    particle.userData = {
      active: false,
      lifetime: 0,
      maxLifetime: 0,
      xSpeed: 0,
      ySpeed: 0,
      zSpeed: 0
    };
    
    // Add to scene and tracking array
    splashParticles.push(particle);
  }
  
  return {
    particles: splashParticles,
    particleCount,
    nextParticle: 0
  };
}

// Update snow splash particles each frame
function updateSnowSplash(splash, delta, snowman, velocity, isInAir, scene) {
  // Early return if not initialized
  if (!splash || !splash.particles) return;
  
  // Calculate current speed
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  
  // Update existing active particles
  splash.particles.forEach(particle => {
    if (!particle.userData.active) return;
    
    // Decrease lifetime
    particle.userData.lifetime -= delta;
    
    // Deactivate if lifetime is over
    if (particle.userData.lifetime <= 0) {
      particle.userData.active = false;
      particle.scale.set(0, 0, 0); // Make invisible
      return;
    }
    
    // Move particle
    particle.position.x += particle.userData.xSpeed * delta;
    particle.position.y += particle.userData.ySpeed * delta;
    particle.position.z += particle.userData.zSpeed * delta;
    
    // Apply gravity
    particle.userData.ySpeed -= 12 * delta;
    
    // Fade out based on lifetime
    const lifeRatio = particle.userData.lifetime / particle.userData.maxLifetime;
    particle.material.opacity = lifeRatio * 0.9;
    
    // Scale down slightly over time
    const scaleRatio = 0.3 + lifeRatio * 0.7; // Keep some minimum size
    const size = particle.userData.size * scaleRatio;
    particle.scale.set(size, size, size);
  });
  
  // Only generate particles when in contact with snow and moving
  // Lower threshold makes particles appear earlier
  if (!isInAir && speed > 1.5) {
    // Generate more particles when turning or at high speeds
    const turnFactor = Math.abs(velocity.x) / (speed + 0.1); // 0 to ~1 
    
    // Emit chance increases with speed and turning
    const emissionChance = Math.min(1, 0.7 + (speed / 15) + (turnFactor * 0.8));
    
    if (Math.random() < emissionChance) {
      // Get ski positions (left and right of snowman)
      const skiOffsetLeft = new THREE.Vector3(-1, 0.1, 1);
      const skiOffsetRight = new THREE.Vector3(1, 0.1, 1);
      
      // Apply snowman's rotation to get correct ski positions
      skiOffsetLeft.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      skiOffsetRight.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      
      // Choose which ski to emit from (or both at high speeds)
      const emitBoth = speed > 8 || Math.random() < 0.7; // Increased chance for both
      const emitLeft = emitBoth || Math.random() < 0.5;
      const emitRight = emitBoth || !emitLeft;
      
      // Calculate particle count based on speed and turning
      const particlesToEmit = Math.floor(2 + speed / 5 + turnFactor * 6);
      
      // Emit particles
      for (let i = 0; i < particlesToEmit; i++) {
        // Get next available particle
        let nextIdx = splash.nextParticle;
        const maxTries = splash.particleCount; // Prevent infinite loop
        let tries = 0;
        
        // Find an inactive particle
        while (splash.particles[nextIdx].userData.active && tries < maxTries) {
          nextIdx = (nextIdx + 1) % splash.particleCount;
          tries++;
        }
        
        // Update next particle index
        splash.nextParticle = (nextIdx + 1) % splash.particleCount;
        
        // If we couldn't find an inactive particle, skip this one
        if (tries >= maxTries) continue;
        
        // Get the particle
        const particle = splash.particles[nextIdx];
        
        // Choose which ski to emit from
        const skiOffset = (emitLeft && emitRight) 
          ? (i % 2 === 0 ? skiOffsetLeft : skiOffsetRight)
          : (emitLeft ? skiOffsetLeft : skiOffsetRight);
        
        // Create randomness for more natural effect
        const randomX = (Math.random() - 0.5) * 1.0;
        const randomY = Math.random() * 0.2;
        const randomZ = (Math.random() - 0.5) * 1.0;
        
        // Position at ski - use a new Vector3 to avoid modifying snowman's position
        const snowmanPos = new THREE.Vector3(
          snowman.position.x,
          snowman.position.y,
          snowman.position.z
        );
        particle.position.x = snowmanPos.x + skiOffset.x + randomX;
        particle.position.y = snowmanPos.y + skiOffset.y + randomY;
        particle.position.z = snowmanPos.z + skiOffset.z + randomZ;
        
        // Generate random speed components
        // Side velocity gives more spread
        const sideVelocity = 2 + Math.random() * 3 * speed / 10;
        const upVelocity = 1 + Math.random() * 2 * speed / 10;
        const forwardVelocity = 0.5 + Math.random() * 1.5;
        
        // Set velocities - direction depending on which ski
        particle.userData.xSpeed = (skiOffset === skiOffsetLeft ? -1 : 1) * sideVelocity;
        particle.userData.ySpeed = upVelocity;
        particle.userData.zSpeed = -forwardVelocity; // Always spray behind
        
        // Additional velocity in direction of travel
        particle.userData.xSpeed += velocity.x * 0.3;
        particle.userData.zSpeed += velocity.z * 0.3;
        
        // Set larger size for better visibility
        const baseSize = 1.0 + (speed / 15);
        particle.userData.size = baseSize + Math.random() * baseSize;
        
        // Set initial scale
        particle.scale.set(
          particle.userData.size,
          particle.userData.size,
          particle.userData.size
        );
        
        // Set higher opacity for better visibility
        particle.material.opacity = 0.9 + Math.random() * 0.1;
        
        // Set lifetime and activate
        particle.userData.maxLifetime = 0.5 + Math.random() * 0.7; // 0.5-1.2 seconds
        particle.userData.lifetime = particle.userData.maxLifetime;
        particle.userData.active = true;
        
        // Add to scene if not already added
        if (!particle.parent) {
          scene.add(particle);
        }
      }
    }
  }
}

// Export utility functions and classes
// We leverage the Mountains export from mountains.js and add our own
const Utils = {
  // Mountain features are now imported from mountains.js
  // For backward compatibility, provide the same API via delegation
  SimplexNoise: Mountains.SimplexNoise,
  getTerrainHeight: Mountains.getTerrainHeight,
  getTerrainGradient: Mountains.getTerrainGradient,
  getDownhillDirection: Mountains.getDownhillDirection,
  createTerrain: Mountains.createTerrain,
  createTree: Mountains.createTree,
  createRock: Mountains.createRock,
  addTrees: Mountains.addTrees,
  addRocks: Mountains.addRocks,
  addBranchesAtLayer: Mountains.addBranchesAtLayer,
  addSnowCaps: Mountains.addSnowCaps,
  debugHeightMap: Mountains.debugHeightMap,
  heightMap: Mountains.heightMap,
  
  // Snow effects (snowman code moved to snowman.js)
  createSnowflakes,
  updateSnowflakes,
  createSnowSplash,
  updateSnowSplash
};

// In a module environment, you would use:
// export { 
//   SimplexNoise, getTerrainHeight, getTerrainGradient,
//   getDownhillDirection, createTerrain, createSnowman, 
//   createSnowflakes, updateSnowflakes, createTree, createRock,
//   addTrees, addRocks, addBranchesAtLayer, addSnowCaps
// };