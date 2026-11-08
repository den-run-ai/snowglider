// @ts-check
const assert = require('node:assert/strict');

async function main() {
  const THREE = await import('three');
  const { createSnowLighting } = await import('../src/game/snow-lighting.js');
  const { Sky } = await import('../src/sky.js');
  // Match the live renderer: authored colours and framebuffer are linear.
  THREE.ColorManagement.enabled = false;
  const scene = new THREE.Scene();
  const sun = createSnowLighting(scene);
  const ambient = /** @type {import('three').AmbientLight} */ (scene.children.find(c => c.type === 'AmbientLight'));
  const hemi = /** @type {import('three').HemisphereLight} */ (scene.children.find(c => c.type === 'HemisphereLight'));
  const fillBefore = [ambient.intensity, hemi.intensity, ...hemi.color.toArray(), ...hemi.groundColor.toArray()];
  const middayBefore = [sun.intensity, ...sun.color.toArray(), ...sun.position.toArray()];
  Sky.applyAtmosphericSky(scene, sun);

  // Three r184's Lambert diffuse on white powder, before clamping. Ignore the
  // material's 4% dielectric energy reduction for a conservative upper bound.
  // Test the real light instances, not a second hand-copied set of coefficients.
  function diffuse(normal, shadow = false) {
    const skyWeight = normal.y * 0.5 + 0.5;
    const direction = Sky.getSunDirection();
    const lambert = shadow ? 0 : Math.max(0, normal.dot(direction));
    return ['r', 'g', 'b'].map(c => (
      ambient.color[c] * ambient.intensity +
      (hemi.groundColor[c] * (1 - skyWeight) + hemi.color[c] * skyWeight) * hemi.intensity +
      sun.color[c] * sun.intensity * lambert
    ) / Math.PI);
  }
  let peak = 0;
  for (let phase = 0; phase <= Sky.CYCLE_DURATION_S; phase++) {
    if (phase) Sky.update(1);
    // Every visible slope aspect, from a flat to near-vertical faces; sunlight
    // travels from midday to golden and back during the sweep.
    for (let tilt = 0; tilt <= 85; tilt += 5) {
      const angle = tilt * Math.PI / 180;
      for (let yaw = 0; yaw < 360; yaw += 10) {
        const azimuth = yaw * Math.PI / 180;
        const normal = new THREE.Vector3(Math.sin(angle) * Math.cos(azimuth), Math.cos(angle), Math.sin(angle) * Math.sin(azimuth));
        const lit = diffuse(normal);
        const shade = diffuse(normal, true);
        peak = Math.max(peak, ...lit);
        assert.ok(lit.every(c => c > 0 && c < 0.97), `highlight clips at phase=${phase}, tilt=${tilt}, yaw=${yaw}: ${lit}`);
        assert.ok(shade[2] - shade[0] > 0.04, 'shaded snow retains cool skylight');
        assert.ok(shade.every(c => c > 0.45), 'shadow fill remains readable');
      }
    }
  }
  assert.deepEqual([ambient.intensity, hemi.intensity, ...hemi.color.toArray(), ...hemi.groundColor.toArray()], fillBefore);
  const middayAfter = [sun.intensity, ...sun.color.toArray(), ...sun.position.toArray()];
  assert.ok(middayAfter.every((value, i) => Math.abs(value - middayBefore[i]) < 1e-12));
  const flat = new THREE.Vector3(0, 1, 0);
  const facing = new THREE.Vector3(0.4, 1, 0.4).normalize();
  const away = new THREE.Vector3(-0.4, 1, -0.4).normalize();
  assert.ok(diffuse(flat).every(c => c > 0.80), 'midday powder stays bright');
  assert.ok(diffuse(facing)[0] - diffuse(away)[0] > 0.07, 'sun-facing and lee slopes remain distinct');
  assert.ok(diffuse(flat)[0] - diffuse(flat, true)[0] > 0.16, 'contact shadows remain visible');
  Sky.teardown();
  console.log(`PASS: snow highlights, cool fill and slope contrast across 90-second cycle (peak diffuse ${peak.toFixed(4)})`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
