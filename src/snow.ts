// snow.ts - Utility functions for the snowman skiing game
//
// Phase 2.6/cluster (issue #84): converted off the classic global model. `THREE`,
// `Mountains` and `Trees` now come from real ES-module imports, and `Snow` is
// `export`ed. snow.js builds its `Snow` namespace from `Mountains.*` and `Trees.*`
// at module-eval time; the imports guarantee both are evaluated first, so the
// previous bare-global reads (via window bridges) are gone. Loaded via the bundle
// entry, not the classic script-loader.
//
// Phase 3.5 (issue #84): renamed `.js` -> `.ts`. The `@ts-check` pragma is gone
// (implied for a real `.ts` file) and the snow particle/splash state, helper
// params and the `SnowSplash` pool shape are now real `interface`/`type`
// declarations. The `Snow` facade keeps delegating to the imported `Mountains`/
// `Trees` modules unchanged. Behaviour is unchanged — every edit is
// type-only/erasable, so esbuild (Vite) and Node's native type-stripping both run
// it exactly as before. The `./mountains.js` / `./trees.js` specifiers stay `.js`
// (Vite/tsc resolve them to the `.ts` files; the Node terrain/regression tests use
// the `.js`->`.ts` resolve hook added in PR 3.3).
import * as THREE from 'three';
import { Mountains } from './mountains.js';
import { Trees } from './trees.js';
import { Wind } from './wind.js';

/** Minimal positional shape the snow systems read from the player. */
interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Horizontal velocity the splash reads (only x/z are used). */
interface PlanarVelocity {
  x: number;
  z: number;
}

/** Pooled snow-splash particle system returned by {@link createSnowSplash}. */
interface SnowSplash {
  particles: THREE.Sprite[];
  particleCount: number;
  nextParticle: number;
}

// Mountains features are now in mountains.js
// This file now delegates terrain/mountain calls to mountains.js

// --- Snow Particle System ---
const snowflakes: THREE.Sprite[] = [];
const snowflakeCount = 1000;
const snowflakeSpread = 100; // Spread area around player
const snowflakeHeight = 50; // Height above player
const snowflakeFallSpeed = 5;

// --- Wind drift (issue #253) ---
// The shared wind field (wind.ts) blows the falling snow sideways and pushes the ski
// splash downwind. Cosmetic only — like the rest of this module it never touches the
// player. How strongly a particle drifts is its WIND FACTOR: lighter (smaller) flakes
// are carried further, so the snowfall reads as slanted rather than rigidly vertical.
const SPLASH_WIND = 0.5; // fraction of the wind vector the spray is advected by

/** Honour prefers-reduced-motion (same gating as Flex/Sky/snowtracks): the snowfall
 *  falls straight and the splash stays put when the user asks for calmer motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The wind vector the snow systems should drift by this frame — the live field, or a
 *  zero vector under reduced motion so everything falls/sprays straight. */
function windDrift(): { x: number; z: number } {
  if (prefersReducedMotion()) return { x: 0, z: 0 };
  return Wind.vector();
}

// Snowman code moved to snowman.js

function createSnowflakes(scene: THREE.Scene) {
  // Create a simple white circle texture for snowflakes
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  
  // Draw a soft, more prominent blueish circle
  const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  // Enhanced blue tint for better visibility against white snow
  gradient.addColorStop(0, 'rgba(180, 210, 255, 0.95)'); // More saturated blueish center
  gradient.addColorStop(0.4, 'rgba(200, 225, 255, 0.8)'); // Mid-tone with blue
  gradient.addColorStop(1, 'rgba(220, 240, 255, 0)'); // Fade to transparent with slight blue
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ 
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending // Add blending for more visible particles
  });
  
  // Create individual snowflakes
  for (let i = 0; i < snowflakeCount; i++) {
    const snowflake = new THREE.Sprite(material.clone()); // Clone material for individual properties
    
    // More varied size range for realistic snow
    const size = 0.1 + Math.random() * 0.4; // Wider range for more varied flakes
    snowflake.scale.set(size, size, size);

    // Wind susceptibility (issue #253): lighter (smaller) flakes are carried further by
    // the wind, so the snowfall slants instead of falling rigidly straight. sizeNorm 0
    // (smallest) => 0.40, sizeNorm 1 (largest) => 0.12.
    const sizeNorm = (size - 0.1) / 0.4; // 0..1 across the size range
    snowflake.userData.windFactor = 0.12 + 0.28 * (1 - sizeNorm);
    
    // Random positions in a box above the player
    resetSnowflakePosition(snowflake, { x: 0, y: 0, z: -40 });
    
    // Enhanced movement properties for more realistic snow behavior
    snowflake.userData.speed = (0.5 + Math.random() * 1.0) * snowflakeFallSpeed;
    snowflake.userData.wobble = 0.05 + Math.random() * 0.15; // More natural wobble
    snowflake.userData.wobbleSpeed = 0.3 + Math.random() * 2.0; // Varied wobble speeds
    snowflake.userData.wobblePos = Math.random() * Math.PI * 2;
    // Add rotation for some flakes
    snowflake.userData.rotationSpeed = (Math.random() - 0.5) * 0.5;
    // Randomize opacity slightly
    snowflake.material.opacity = 0.7 + Math.random() * 0.3;
    
    scene.add(snowflake);
    snowflakes.push(snowflake);
  }
}

// Clear the module-level snowflake pool (dispose-audit teardown / dev-HMR). The pool is
// a module-level array, so on an embed/remount path that reuses this module instance,
// createSnowflakes() would append another snowfall on top of the previous (detached)
// sprites while updateSnowflakes() kept iterating the stale ones. Detach + dispose each
// sprite's (cloned) material and its shared texture here — self-contained so it does not
// depend on disposeGame's scene sweep order — then empty the array so a later
// createSnowflakes() starts clean. Idempotent.
function teardownSnowflakes(): void {
  for (const flake of snowflakes) {
    flake.parent?.remove(flake);
    const mat = flake.material;
    mat.map?.dispose();   // shared across clones — dispose is idempotent
    mat.dispose();
  }
  snowflakes.length = 0;
}

function resetSnowflakePosition(snowflake: THREE.Sprite, playerPos: Vec3Like) {
  // Position snowflakes randomly in a box above the player
  snowflake.position.x = playerPos.x + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.z = playerPos.z + (Math.random() * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.y = playerPos.y + Math.random() * snowflakeHeight;
}

function updateSnowflakes(delta: number, playerPos: Vec3Like, _scene: THREE.Scene) {
  // Sample the shared wind once per frame (zero under reduced motion); each flake drifts
  // by it scaled by its own wind factor, so the whole snowfall leans the same way (#253).
  const wind = windDrift();
  snowflakes.forEach(snowflake => {
    // Apply falling movement
    snowflake.position.y -= snowflake.userData.speed * delta;

    // Add some gentle sideways wobble for realism
    snowflake.userData.wobblePos += snowflake.userData.wobbleSpeed * delta;
    snowflake.position.x += Math.sin(snowflake.userData.wobblePos) * snowflake.userData.wobble;
    // Add slight z-axis wobble too for more 3D movement
    snowflake.position.z += Math.cos(snowflake.userData.wobblePos * 0.7) * snowflake.userData.wobble * 0.5;

    // Wind drift: blow the flake downwind, lighter flakes further (windFactor). Falls back
    // to 1 for any flake created before this field existed (defensive).
    const windFactor = snowflake.userData.windFactor ?? 1;
    snowflake.position.x += wind.x * windFactor * delta;
    snowflake.position.z += wind.z * windFactor * delta;
    
    // Add rotation if this flake has rotation speed
    if (snowflake.userData.rotationSpeed) {
      snowflake.material.rotation += snowflake.userData.rotationSpeed * delta;
    }
    
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
function createSnowSplash(): SnowSplash {
  // Create a simple white circle texture for snow splash
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  
  // Draw a bright, more prominent blueish circle with soft edges
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  // Enhanced blue tint for the splash
  gradient.addColorStop(0, 'rgba(160, 200, 255, 1.0)'); // Stronger blueish center
  gradient.addColorStop(0.3, 'rgba(190, 215, 255, 0.9)'); // Mid-blue tone
  gradient.addColorStop(0.7, 'rgba(210, 230, 255, 0.6)'); // Light blue
  gradient.addColorStop(1, 'rgba(230, 240, 255, 0)'); // Fade to transparent with blue hint
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  
  // Create a second texture variation for more diversity
  const canvas2 = document.createElement('canvas');
  canvas2.width = 32;
  canvas2.height = 32;
  const ctx2 = canvas2.getContext('2d')!;
  
  // Create a more irregular, crystalline shape
  ctx2.fillStyle = 'rgba(180, 210, 255, 0)';
  ctx2.fillRect(0, 0, 32, 32);
  
  // Draw a star-like shape
  ctx2.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const radius = i % 2 === 0 ? 14 : 6;
    const x = 16 + Math.cos(angle) * radius;
    const y = 16 + Math.sin(angle) * radius;
    if (i === 0) ctx2.moveTo(x, y);
    else ctx2.lineTo(x, y);
  }
  ctx2.closePath();
  
  // Fill with blue gradient
  const gradient2 = ctx2.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient2.addColorStop(0, 'rgba(150, 190, 255, 1.0)');
  gradient2.addColorStop(0.5, 'rgba(180, 205, 255, 0.8)');
  gradient2.addColorStop(1, 'rgba(200, 225, 255, 0)');
  ctx2.fillStyle = gradient2;
  ctx2.fill();
  
  const texture = new THREE.CanvasTexture(canvas);
  const texture2 = new THREE.CanvasTexture(canvas2);

  // Follow the same approach as snowflakes - use individual sprites
  const splashParticles: THREE.Sprite[] = [];
  const particleCount = 250; // Increased for more dramatic effect
  
  // Create the base materials that particles will use
  const materials = [
    new THREE.SpriteMaterial({ 
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending
    }),
    new THREE.SpriteMaterial({
      map: texture2,
      transparent: true,
      blending: THREE.AdditiveBlending
    })
  ];
  
  // Create individual particles
  for (let i = 0; i < particleCount; i++) {
    // Randomly choose between the two texture types
    const materialIndex = Math.random() > 0.3 ? 0 : 1;
    const particle = new THREE.Sprite(materials[materialIndex]!.clone());
    
    // Start with zero size (invisible)
    particle.scale.set(0, 0, 0);
    
    // Store particle-specific data
    particle.userData = {
      active: false,
      lifetime: 0,
      maxLifetime: 0,
      xSpeed: 0,
      ySpeed: 0,
      zSpeed: 0,
      size: 0, // Store base size
      rotationSpeed: (Math.random() - 0.5) * 0.8, // Add rotation for some particles
      type: materialIndex // Remember texture type
    };
    
    // Add to tracking array
    splashParticles.push(particle);
  }
  
  return {
    particles: splashParticles,
    particleCount,
    nextParticle: 0
  };
}

// Update snow splash particles each frame
function updateSnowSplash(splash: SnowSplash | null, delta: number, snowman: THREE.Object3D, velocity: PlanarVelocity, isInAir: boolean, scene: THREE.Scene) {
  // Early return if not initialized
  if (!splash || !splash.particles) return;
  
  // Calculate current speed
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

  // Wind advection for the spray (issue #253): the kicked-up snow blows downwind as it
  // hangs in the air. Sampled once per frame; zero under reduced motion.
  const wind = windDrift();

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

    // Drift the airborne spray downwind (#253).
    particle.position.x += wind.x * SPLASH_WIND * delta;
    particle.position.z += wind.z * SPLASH_WIND * delta;

    // Apply gravity with slight random variation
    particle.userData.ySpeed -= (11 + Math.random() * 2) * delta;
    
    // Apply slight air resistance/drag
    particle.userData.xSpeed *= (1 - 0.2 * delta);
    particle.userData.zSpeed *= (1 - 0.2 * delta);
    
    // Fade out based on lifetime with improved curve
    const lifeRatio = particle.userData.lifetime / particle.userData.maxLifetime;
    // Use cubic ease-out for more natural fade
    const opacity = lifeRatio < 0.3 ? lifeRatio * 3 * lifeRatio : lifeRatio;
    particle.material.opacity = opacity * 0.95;
    
    // Apply rotation if this particle has rotation
    if (particle.userData.rotationSpeed) {
      particle.material.rotation += particle.userData.rotationSpeed * delta;
    }
    
    // Scale down slightly over time
    const scaleRatio = 0.2 + lifeRatio * 0.8; // Keep some minimum size, fade more gradually
    const size = particle.userData.size * scaleRatio;
    particle.scale.set(size, size, size);
  });
  
  // Only generate particles when in contact with snow and moving
  if (!isInAir && speed > 1.3) { // Lower threshold for earlier particles
    // Generate more particles when turning or at high speeds
    const turnFactor = Math.abs(velocity.x) / (speed + 0.1); // 0 to ~1
    
    // Emit chance increases with speed and turning
    const emissionChance = Math.min(1, 0.7 + (speed / 16) + (turnFactor * 0.8));
    
    if (Math.random() < emissionChance) {
      // Get ski positions (left and right of snowman)
      const skiOffsetLeft = new THREE.Vector3(-1.1, 0.1, 1);
      const skiOffsetRight = new THREE.Vector3(1.1, 0.1, 1);
      
      // Apply snowman's rotation to get correct ski positions
      skiOffsetLeft.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      skiOffsetRight.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      
      // Choose which ski to emit from (or both at high speeds)
      const emitBoth = speed > 7 || Math.random() < 0.8; // Increased chance for both
      const emitLeft = emitBoth || Math.random() < 0.5;
      const emitRight = emitBoth || !emitLeft;
      
      // Calculate particle count based on speed and turning
      const particlesToEmit = Math.floor(2 + speed / 5 + turnFactor * 6);
      
      // Emit particles
      for (let i = 0; i < particlesToEmit; i++) {
        // Get next available particle
        let nextIdx = splash.nextParticle;
        const maxTries = splash.particleCount;
        let tries = 0;
        
        // Find an inactive particle
        while (splash.particles[nextIdx]!.userData.active && tries < maxTries) {
          nextIdx = (nextIdx + 1) % splash.particleCount;
          tries++;
        }
        
        // Update next particle index
        splash.nextParticle = (nextIdx + 1) % splash.particleCount;
        
        // If we couldn't find an inactive particle, skip this one
        if (tries >= maxTries) continue;
        
        // Get the particle
        const particle = splash.particles[nextIdx]!;
        
        // Choose which ski to emit from
        const skiOffset = (emitLeft && emitRight) 
          ? (i % 2 === 0 ? skiOffsetLeft : skiOffsetRight)
          : (emitLeft ? skiOffsetLeft : skiOffsetRight);
        
        // Create randomness for more natural effect
        const randomX = (Math.random() - 0.5) * 1.2;
        const randomY = Math.random() * 0.3;
        const randomZ = (Math.random() - 0.5) * 1.2;
        
        // Position at ski
        const snowmanPos = new THREE.Vector3(
          snowman.position.x,
          snowman.position.y,
          snowman.position.z
        );
        particle.position.x = snowmanPos.x + skiOffset.x + randomX;
        particle.position.y = snowmanPos.y + skiOffset.y + randomY;
        particle.position.z = snowmanPos.z + skiOffset.z + randomZ;
        
        // Generate random speed components with more realistic spread
        // Side velocity depends on turn factor
        const sideBase = 2 + turnFactor * 4;
        const sideVelocity = sideBase + Math.random() * 3 * speed / 8;
        const upVelocity = 1.5 + Math.random() * 3 * speed / 10;
        const forwardVelocity = 0.8 + Math.random() * 2.0;
        
        // Set velocities - direction depending on which ski
        particle.userData.xSpeed = (skiOffset === skiOffsetLeft ? -1 : 1) * sideVelocity;
        particle.userData.ySpeed = upVelocity;
        particle.userData.zSpeed = -forwardVelocity; // Always spray behind
        
        // Additional velocity in direction of travel
        particle.userData.xSpeed += velocity.x * 0.35;
        particle.userData.zSpeed += velocity.z * 0.35;
        
        // Set larger base size for better visibility
        const baseSize = 1.3 + (speed / 16); // Increased base size
        particle.userData.size = baseSize + Math.random() * baseSize * 0.7;
        
        // Set initial scale
        particle.scale.set(
          particle.userData.size,
          particle.userData.size,
          particle.userData.size
        );
        
        // Set higher opacity for better visibility
        particle.material.opacity = 0.9 + Math.random() * 0.1;
        
        // Set lifetime and activate with more variation
        const speedFactor = Math.min(1, speed / 15);
        particle.userData.maxLifetime = 0.7 + Math.random() * 0.9 * (1 + speedFactor * 0.5);
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
// We leverage the Mountains export from mountains.js and add our own.
// `Mountains` and `Trees` are read from the ES-module imports above, so this
// object literal must evaluate after those modules — guaranteed by main.js's
// import order (and by the static imports at the top of this file).
export const Snow = {
  // Mountain features are now imported from mountains.js
  // For backward compatibility, provide the same API via delegation
  SimplexNoise: Mountains.SimplexNoise,
  getTerrainHeight: Mountains.getTerrainHeight,
  getTerrainGradient: Mountains.getTerrainGradient,
  getDownhillDirection: Mountains.getDownhillDirection,
  createTerrain: Mountains.createTerrain,
  setTerrainCorridor: Mountains.setTerrainCorridor,
  createTree: Trees.createTree,
  createRock: Mountains.createRock,
  addTrees: Trees.addTrees,
  addRocks: Mountains.addRocks,
  addBranchesAtLayer: Trees.addBranchesAtLayer,
  addSnowCaps: Trees.addSnowCaps,
  // Wind sway for the instanced forest (issue #253) — advanced/rewound by the main loop
  // alongside the snow drift, so the whole scene reads one wind clock.
  updateTreeWind: Trees.updateWind,
  resetTreeWind: Trees.resetWind,
  debugHeightMap: Mountains.debugHeightMap,
  heightMap: Mountains.heightMap,
  
  // Snow effects (snowman code moved to snowman.js)
  createSnowflakes,
  updateSnowflakes,
  teardownSnowflakes,
  createSnowSplash,
  updateSnowSplash
};

// Snow is imported directly by snowglider.js, and the browser tests import it as
// `Snow as Utils` (issue #84). Mountains/Trees are read via the ES-module imports
// at the top of this file.