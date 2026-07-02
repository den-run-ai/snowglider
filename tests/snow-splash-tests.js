// @ts-check
// Headless coverage for snow-splash particle updates that do not need DOM canvas
// texture creation. createSnowSplash() is exercised by browser/Vite paths; this file
// drives updateSnowSplash() with a hand-built particle pool.

let pass = 0, fail = 0;
function check(name, cond) { console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}: ${name}`); cond ? pass++ : fail++; }

function mockParticle(active = false) {
  return {
    parent: null,
    position: { x: 0, y: 0, z: 0 },
    scale: {
      x: 0,
      y: 0,
      z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; }
    },
    material: { opacity: 0, rotation: 0 },
    userData: {
      active,
      lifetime: active ? 1 : 0,
      maxLifetime: active ? 1 : 0,
      xSpeed: 0,
      ySpeed: 0,
      zSpeed: 0,
      size: 0,
      rotationSpeed: 0,
      type: 0,
    }
  };
}

async function main() {
  const { Snow } = await import('../src/snow.ts');

  console.log('--- snow splash landing burst ---');
  {
    let added = 0;
    const scene = {
      add(particle) {
        particle.parent = this;
        added++;
      }
    };
    const splash = {
      particles: Array.from({ length: 24 }, () => mockParticle(false)),
      particleCount: 24,
      nextParticle: 0
    };
    const snowman = { position: { x: 3, y: 12, z: -40 }, rotation: { y: 0 } };
    const velocity = { x: 4, z: -6 };

    Snow.updateSnowSplash(splash, 1 / 60, snowman, velocity, true, scene, 0.5);

    const active = splash.particles.filter((p) => p.userData.active);
    check('landing burst activates the expected number of particles', active.length === 14);
    check('landing burst adds newly active particles to the scene', added === 14);
    check('landing burst advances the pool cursor', splash.nextParticle === 14);
    check('landing burst gives particles finite lifetimes and upward speed',
      active.every((p) => Number.isFinite(p.userData.lifetime) && p.userData.lifetime > 0 && p.userData.ySpeed >= 2));
  }

  {
    let added = 0;
    const scene = { add() { added++; } };
    const splash = {
      particles: Array.from({ length: 4 }, () => mockParticle(true)),
      particleCount: 4,
      nextParticle: 0
    };
    const snowman = { position: { x: 0, y: 10, z: 0 }, rotation: { y: 0 } };
    const velocity = { x: 0, z: 0 };

    Snow.updateSnowSplash(splash, 1 / 60, snowman, velocity, true, scene, 1);

    check('landing burst stops cleanly when the particle pool is full', added === 0);
    check('full-pool landing burst leaves the pool cursor wrapped', splash.nextParticle === 1);
  }

  console.log(`\nSNOW SPLASH TESTS: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
