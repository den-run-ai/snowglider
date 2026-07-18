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
import { cosmeticRandom } from './run-context.js';
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

/** Per-flake animation state kept on `sprite.userData` (typed view — `userData` is
 *  `any` in three's types, and the wobble math below would otherwise pass `any` into
 *  `Math.sin`/arithmetic). */
interface FlakeState {
  speed: number;
  wobble: number;
  wobbleSpeed: number;
  wobblePos: number;
  /** Wind susceptibility (#253); optional so flakes created before the field existed
   *  fall back to 1 (defensive). */
  windFactor?: number;
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

// Per-frame wobble rate multiplier: the sideways wobble was tuned as a per-FRAME
// displacement at 60 fps; ×60 converts that tuned look into a per-SECOND rate so
// `* delta` makes it frame-rate independent (the #209 bug class, still alive in the
// visuals until this fix: at 120 Hz flakes drifted sideways twice as fast as at 60 Hz).
const WOBBLE_RATE = 60;

// Shared flake materials, bucketed by opacity. Snow is a diffuse scatterer, not an
// emitter: NormalBlending keeps flakes readable *against* the bright sky/snow (slightly
// darker, correctly occluding) instead of additive-glowing cyan over dark trees — the
// same reasoning as the avalanche powder cloud (avalanche.ts). A radially symmetric
// sprite needs no per-flake rotation, and opacity variance only needs a few discrete
// levels, so ALL flakes share these few materials instead of cloning one each (1000
// clones -> FLAKE_OPACITY_BUCKETS.length). depthWrite stays off so the transparent
// sprites never punch holes in each other.
const FLAKE_OPACITY_BUCKETS: readonly number[] = [0.7, 0.85, 1.0];

/** Soft, near-white radial puff with a faint cool edge (SNOW_RENDERING.md palette):
 *  alpha carries visibility; the colour stays in "snow" range. */
function createFlakeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  gradient.addColorStop(0, 'rgba(250, 252, 255, 0.95)'); // near-white core
  gradient.addColorStop(0.4, 'rgba(242, 247, 253, 0.75)');
  gradient.addColorStop(1, 'rgba(228, 238, 250, 0)');    // faint cool edge -> transparent
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  return new THREE.CanvasTexture(canvas);
}

function createSnowflakes(scene: THREE.Scene) {
  const texture = createFlakeTexture();
  // One material per opacity bucket, all sharing the one texture.
  const materials = FLAKE_OPACITY_BUCKETS.map((opacity) => new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    blending: THREE.NormalBlending, // diffuse snow: never additive (see bucket note)
    depthWrite: false
  }));

  // Create individual snowflakes
  for (let i = 0; i < snowflakeCount; i++) {
    const snowflake = new THREE.Sprite(materials[i % materials.length]);

    // More varied size range for realistic snow
    const size = 0.1 + cosmeticRandom('snowParticles') * 0.4; // Wider range for more varied flakes
    snowflake.scale.set(size, size, size);

    // Wind susceptibility (issue #253): lighter (smaller) flakes are carried further by
    // the wind, so the snowfall slants instead of falling rigidly straight. sizeNorm 0
    // (smallest) => 0.40, sizeNorm 1 (largest) => 0.12.
    const sizeNorm = (size - 0.1) / 0.4; // 0..1 across the size range

    // Random positions in a box above the player
    resetSnowflakePosition(snowflake, { x: 0, y: 0, z: -40 });

    // Movement state (typed — see FlakeState) for realistic snow behaviour.
    const flake: FlakeState = {
      speed: (0.5 + cosmeticRandom('snowParticles') * 1.0) * snowflakeFallSpeed,
      wobble: 0.05 + cosmeticRandom('snowParticles') * 0.15,      // More natural wobble
      wobbleSpeed: 0.3 + cosmeticRandom('snowParticles') * 2.0,   // Varied wobble speeds
      wobblePos: cosmeticRandom('snowParticles') * Math.PI * 2,
      windFactor: 0.12 + 0.28 * (1 - sizeNorm)
    };
    snowflake.userData = flake;

    scene.add(snowflake);
    snowflakes.push(snowflake);
  }
}

// Clear the module-level snowflake pool (dispose-audit teardown / dev-HMR). The pool is
// a module-level array, so on an embed/remount path that reuses this module instance,
// createSnowflakes() would append another snowfall on top of the previous (detached)
// sprites while updateSnowflakes() kept iterating the stale ones. Detach every sprite,
// then dispose each UNIQUE material/texture exactly once — the flakes share the few
// opacity-bucket materials (and one texture), so a per-sprite dispose would free the
// same resource hundreds of times. Self-contained so it does not depend on disposeGame's
// scene sweep order; the array is emptied so a later createSnowflakes() starts clean.
// Idempotent.
function teardownSnowflakes(): void {
  const mats = new Set<THREE.SpriteMaterial>();
  const texes = new Set<THREE.Texture>();
  for (const flake of snowflakes) {
    flake.parent?.remove(flake);
    mats.add(flake.material);
    if (flake.material.map) texes.add(flake.material.map);
  }
  for (const mat of mats) mat.dispose();
  for (const tex of texes) tex.dispose();
  snowflakes.length = 0;
}

function resetSnowflakePosition(snowflake: THREE.Sprite, playerPos: Vec3Like) {
  // Position snowflakes randomly in a box above the player
  snowflake.position.x = playerPos.x + (cosmeticRandom('snowParticles') * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.z = playerPos.z + (cosmeticRandom('snowParticles') * snowflakeSpread - snowflakeSpread/2);
  snowflake.position.y = playerPos.y + cosmeticRandom('snowParticles') * snowflakeHeight;
}

function updateSnowflakes(delta: number, playerPos: Vec3Like, _scene: THREE.Scene) {
  // Sample the shared wind once per frame (zero under reduced motion); each flake drifts
  // by it scaled by its own wind factor, so the whole snowfall leans the same way (#253).
  const wind = windDrift();
  snowflakes.forEach(snowflake => {
    const flake = snowflake.userData as FlakeState;
    // Apply falling movement
    snowflake.position.y -= flake.speed * delta;

    // Add some gentle sideways wobble for realism. Delta-scaled (× WOBBLE_RATE to keep
    // the tuned 60 fps amplitude) so the drift rate is frame-rate independent — the
    // fall/wind/phase terms already were, but the displacement itself accumulated per
    // FRAME, doubling the sideways speed at 120 Hz (#209 bug class).
    flake.wobblePos += flake.wobbleSpeed * delta;
    snowflake.position.x += Math.sin(flake.wobblePos) * flake.wobble * delta * WOBBLE_RATE;
    // Add slight z-axis wobble too for more 3D movement
    snowflake.position.z += Math.cos(flake.wobblePos * 0.7) * flake.wobble * 0.5 * delta * WOBBLE_RATE;

    // Wind drift: blow the flake downwind, lighter flakes further (windFactor).
    const windFactor = flake.windFactor ?? 1;
    snowflake.position.x += wind.x * windFactor * delta;
    snowflake.position.z += wind.z * windFactor * delta;


    // Check if snowflake has fallen below the terrain or is too far from player
    // Cache-NEUTRAL sampler (#401): up to 1000 falling flakes query moving ad-hoc
    // coordinates every frame — routing them through the memoizing getTerrainHeight
    // grew and contaminated the gameplay-owned heightMap cache (whichever query
    // first lands in a 0.1-unit cell fixes that cell for later physics/placement
    // reads). Same rationale as the rock collars (#390 review).
    const terrainHeight = Mountains.getTerrainHeightUncached(snowflake.position.x, snowflake.position.z);
    const distanceToPlayer = Math.sqrt(
      Math.pow(snowflake.position.x - playerPos.x, 2) + 
      Math.pow(snowflake.position.z - playerPos.z, 2)
    );
    
    if (snowflake.position.y < terrainHeight || distanceToPlayer > snowflakeSpread) {
      resetSnowflakePosition(snowflake, playerPos);
    }
  });
}

/** Soft near-white radial puff — the base ski-spray mist. */
function createSplashPuffTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(250, 252, 255, 0.95)'); // near-white core
  gradient.addColorStop(0.3, 'rgba(244, 249, 254, 0.8)');
  gradient.addColorStop(0.7, 'rgba(236, 244, 252, 0.5)');
  gradient.addColorStop(1, 'rgba(226, 237, 249, 0)');    // faint cool edge
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

/** A second, irregular puff (a few overlapping soft blobs). Ski spray is an aggregate
 *  powder mist, so this replaces the old star/crystal texture that read as one giant
 *  snow crystal. */
function createSplashClumpTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  // Overlapping off-centre blobs -> an uneven, clumpy mist silhouette.
  const blobs: Array<[number, number, number, number]> = [
    [14, 15, 11, 0.85], // [cx, cy, radius, core alpha]
    [21, 12, 7, 0.6],
    [11, 21, 6, 0.55],
    [20, 21, 5, 0.5]
  ];
  for (const [cx, cy, r, a] of blobs) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(248, 251, 255, ${a})`);
    g.addColorStop(0.6, `rgba(240, 246, 253, ${a * 0.55})`);
    g.addColorStop(1, 'rgba(230, 240, 250, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(canvas);
}

// Create a snow splash particle system for ski effects
function createSnowSplash(): SnowSplash {
  const texture = createSplashPuffTexture();
  const texture2 = createSplashClumpTexture();

  // Follow the same approach as snowflakes - use individual sprites
  const splashParticles: THREE.Sprite[] = [];
  const particleCount = 250; // Increased for more dramatic effect

  // Base materials the pool clones from. NormalBlending like the flakes and the
  // avalanche powder — additive spray washed out to invisible over bright snow and
  // glowed cyan against dark trees. The pool DOES keep one material per sprite
  // (cloned once here, never per frame): unlike the flakes' static opacity buckets,
  // the splash animates `material.opacity`/`rotation` per particle over its lifetime,
  // and THREE.Sprite has no per-instance opacity — the two textures above are the
  // shared resources. Migrating the pool to Points/InstancedMesh is the separate V1b
  // follow-up, only if perf data demands it.
  const materials = [
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false
    }),
    new THREE.SpriteMaterial({
      map: texture2,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false
    })
  ];

  // Create individual particles
  for (let i = 0; i < particleCount; i++) {
    // Randomly choose between the two texture types
    const materialIndex = cosmeticRandom('snowParticles') > 0.3 ? 0 : 1;
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
      rotationSpeed: (cosmeticRandom('snowParticles') - 0.5) * 0.8, // Add rotation for some particles
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

// Update snow splash particles each frame.
// `landingBurst` (JP-5, optional — absent keeps every existing caller byte-identical):
// a one-shot 0..1 intensity for the frame a graded manual jump touches down. Emits a
// wide skidding ring of spray at the skis scaled by the intensity (the loop maps
// CLEAN → a crisp small puff, SKETCHY → a wide wash), independent of the grounded
// speed-gated emission below.
// 60 Hz-referenced accumulator for the ski-spray emission roll (#400) — see the
// emission block below. Module-level like the splash pool itself.
let splashEmitAccum = 0;

function updateSnowSplash(splash: SnowSplash | null, delta: number, snowman: THREE.Object3D, velocity: PlanarVelocity, isInAir: boolean, scene: THREE.Scene, landingBurst?: number) {
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
    particle.userData.ySpeed -= (11 + cosmeticRandom('snowParticles') * 2) * delta;
    
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

    // Frame-rate-independent emission (#400): the old per-render-frame roll made a
    // 144 Hz panel spray ~2.4x the particles of a 60 Hz one (and at the common
    // chance=1 it emitted every frame unconditionally). The accumulator rolls the
    // SAME chance at the 60 Hz reference cadence — identical expected particles
    // per second at any render rate. Catch-up after a stall is capped.
    splashEmitAccum = Math.min(splashEmitAccum + delta * 60, 4);
    while (splashEmitAccum >= 1) {
      splashEmitAccum -= 1;
      if (cosmeticRandom('snowParticles') >= emissionChance) continue;
      // Get ski positions (left and right of snowman)
      const skiOffsetLeft = new THREE.Vector3(-1.1, 0.1, 1);
      const skiOffsetRight = new THREE.Vector3(1.1, 0.1, 1);
      
      // Apply snowman's rotation to get correct ski positions
      skiOffsetLeft.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      skiOffsetRight.applyAxisAngle(new THREE.Vector3(0, 1, 0), snowman.rotation.y);
      
      // Choose which ski to emit from (or both at high speeds)
      const emitBoth = speed > 7 || cosmeticRandom('snowParticles') < 0.8; // Increased chance for both
      const emitLeft = emitBoth || cosmeticRandom('snowParticles') < 0.5;
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
        const randomX = (cosmeticRandom('snowParticles') - 0.5) * 1.2;
        const randomY = cosmeticRandom('snowParticles') * 0.3;
        const randomZ = (cosmeticRandom('snowParticles') - 0.5) * 1.2;
        
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
        const sideVelocity = sideBase + cosmeticRandom('snowParticles') * 3 * speed / 8;
        const upVelocity = 1.5 + cosmeticRandom('snowParticles') * 3 * speed / 10;
        const forwardVelocity = 0.8 + cosmeticRandom('snowParticles') * 2.0;
        
        // Set velocities - direction depending on which ski
        particle.userData.xSpeed = (skiOffset === skiOffsetLeft ? -1 : 1) * sideVelocity;
        particle.userData.ySpeed = upVelocity;
        particle.userData.zSpeed = -forwardVelocity; // Always spray behind
        
        // Additional velocity in direction of travel
        particle.userData.xSpeed += velocity.x * 0.35;
        particle.userData.zSpeed += velocity.z * 0.35;
        
        // Set larger base size for better visibility
        const baseSize = 1.3 + (speed / 16); // Increased base size
        particle.userData.size = baseSize + cosmeticRandom('snowParticles') * baseSize * 0.7;
        
        // Set initial scale
        particle.scale.set(
          particle.userData.size,
          particle.userData.size,
          particle.userData.size
        );
        
        // Set higher opacity for better visibility
        particle.material.opacity = 0.9 + cosmeticRandom('snowParticles') * 0.1;
        
        // Set lifetime and activate with more variation
        const speedFactor = Math.min(1, speed / 15);
        particle.userData.maxLifetime = 0.7 + cosmeticRandom('snowParticles') * 0.9 * (1 + speedFactor * 0.5);
        particle.userData.lifetime = particle.userData.maxLifetime;
        particle.userData.active = true;
        
        // Add to scene if not already added
        if (!particle.parent) {
          scene.add(particle);
        }
      }
    }
  } else {
    // Not grounded-and-moving: drop any banked emission ticks so touchdown doesn't
    // fire a phantom backlog on top of the explicit landing burst below (#400).
    splashEmitAccum = 0;
  }

  // Touchdown burst (JP-5): a one-shot radial puff on a graded manual-jump landing,
  // scaled by the loop-supplied intensity. Reuses the same pooled particles; skipped
  // entirely when the param is absent/zero, so legacy callers are untouched.
  if (landingBurst && landingBurst > 0) {
    const burstCount = Math.floor(6 + landingBurst * 16);
    for (let i = 0; i < burstCount; i++) {
      let nextIdx = splash.nextParticle;
      let tries = 0;
      while (splash.particles[nextIdx]!.userData.active && tries < splash.particleCount) {
        nextIdx = (nextIdx + 1) % splash.particleCount;
        tries++;
      }
      splash.nextParticle = (nextIdx + 1) % splash.particleCount;
      if (tries >= splash.particleCount) break;
      const particle = splash.particles[nextIdx]!;

      // A ring around the skis: spray kicked outward + up on impact.
      const ang = (i / burstCount) * Math.PI * 2 + cosmeticRandom('snowParticles') * 0.5;
      const ringR = 0.6 + cosmeticRandom('snowParticles') * 0.9;
      particle.position.x = snowman.position.x + Math.cos(ang) * ringR;
      particle.position.y = snowman.position.y + 0.15 + cosmeticRandom('snowParticles') * 0.2;
      particle.position.z = snowman.position.z + Math.sin(ang) * ringR;

      const kick = 2.5 + landingBurst * 5;
      particle.userData.xSpeed = Math.cos(ang) * kick * (0.6 + cosmeticRandom('snowParticles') * 0.6) + velocity.x * 0.25;
      particle.userData.ySpeed = 2 + landingBurst * 3 * cosmeticRandom('snowParticles');
      particle.userData.zSpeed = Math.sin(ang) * kick * (0.6 + cosmeticRandom('snowParticles') * 0.6) + velocity.z * 0.25;

      particle.userData.size = 1.1 + landingBurst * 1.2 * cosmeticRandom('snowParticles');
      particle.scale.set(particle.userData.size, particle.userData.size, particle.userData.size);
      particle.material.opacity = 0.85 + cosmeticRandom('snowParticles') * 0.15;
      particle.userData.maxLifetime = 0.5 + landingBurst * 0.6 + cosmeticRandom('snowParticles') * 0.3;
      particle.userData.lifetime = particle.userData.maxLifetime;
      particle.userData.active = true;
      if (!particle.parent) scene.add(particle);
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
  setTerrainKickers: Mountains.setTerrainKickers,
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