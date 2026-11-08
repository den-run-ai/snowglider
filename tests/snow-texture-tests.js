// @ts-check
// Exercise the generated material maps, including a spectrum guard against the
// coherent crossed ripples in the former eight-wave normal texture.
const assert = require('node:assert/strict');

function spectrum(values, size) {
  const rowR = new Float64Array(size * size), rowI = new Float64Array(size * size);
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  for (let y = 0; y < size; y++) {
    for (let k = 0; k < size; k++) {
      for (let x = 0; x < size; x++) {
        const angle = -2 * Math.PI * k * x / size;
        const value = values[y * size + x] - mean;
        rowR[y * size + k] += value * Math.cos(angle);
        rowI[y * size + k] += value * Math.sin(angle);
      }
    }
  }
  const power = [];
  for (let ky = 0; ky < size; ky++) {
    for (let kx = 0; kx < size; kx++) {
      let re = 0, im = 0;
      for (let y = 0; y < size; y++) {
        const angle = -2 * Math.PI * ky * y / size;
        const c = Math.cos(angle), s = Math.sin(angle);
        re += rowR[y * size + kx] * c - rowI[y * size + kx] * s;
        im += rowR[y * size + kx] * c + rowI[y * size + kx] * s;
      }
      if (kx || ky) power.push(re * re + im * im);
    }
  }
  return Math.max(...power) / power.reduce((sum, p) => sum + p, 0);
}

(async () => {
  const { snowMottle, snowGrain, snowRelief, SNOW_RELIEF_TILE_SIZE } = await import('../src/mountains/snow-texture.ts');
  const { createSnowAlbedoTexture, createSnowNormalTexture, createTerrainSnowTextures } = await import('../src/mountains/snow-surface.ts');
  const originalRandom = Math.random;
  try {
    Math.random = () => { throw new Error('texture fields consumed the gameplay RNG'); };
    for (const field of [snowMottle, snowGrain, (u, v) => snowRelief(u, v).height,
      (u, v) => snowRelief(u, v).crust]) {
      for (let v = -0.7; v < 1.7; v += 0.137) {
        const u = v * 0.719;
        const sample = field(u, v);
        assert.equal(sample, field(u, v));
        assert(Number.isFinite(sample) && Math.abs(sample) <= 1);
        assert(Math.abs(sample - field(u + 1, v)) < 1e-12, 'horizontal tile seam');
        assert(Math.abs(sample - field(u, v - 1)) < 1e-12, 'vertical tile seam');
        const e = 1e-5;
        const dx0 = (field(e, v) - field(0, v)) / e;
        const dx1 = (field(1, v) - field(1 - e, v)) / e;
        assert(Math.abs(dx0 - dx1) < 0.1, 'normal discontinuity at horizontal seam');
        const dy0 = (field(u, e) - field(u, 0)) / e;
        const dy1 = (field(u, 1) - field(u, 1 - e)) / e;
        assert(Math.abs(dy0 - dy1) < 0.1, 'normal discontinuity at vertical seam');
      }
    }
  } finally {
    Math.random = originalRandom;
  }

  // Minimal canvas capture exercises the actual texture-producing functions with
  // no browser/GPU dependency; Three still constructs the production textures.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const images = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: image => images.push(image.data)
    }) })
  } });
  try {
    let oldDraws = 0;
    Math.random = () => { oldDraws++; return 0.5; };
    const albedo = createSnowAlbedoTexture();
    const normal = createSnowNormalTexture();
    Math.random = originalRandom;
    const colors = images[0], normals = images[1];
    let minAlbedo = 255, maxAlbedo = 0, sumX = 0, sumY = 0, energy = 0;
    for (let i = 0; i < colors.length; i += 4) {
      minAlbedo = Math.min(minAlbedo, colors[i], colors[i + 1], colors[i + 2]);
      maxAlbedo = Math.max(maxAlbedo, colors[i], colors[i + 1], colors[i + 2]);
      assert(colors[i + 2] >= colors[i], 'powder dips must remain cool');
      assert.equal(colors[i + 3], 255);
      const x = normals[i] / 255 * 2 - 1;
      const y = normals[i + 1] / 255 * 2 - 1;
      const z = normals[i + 2] / 255 * 2 - 1;
      assert(Math.abs(Math.hypot(x, y, z) - 1) < 0.012, 'normal must be unit length');
      assert(z > 0.7, 'micro-relief must not contain cliff-like normals');
      sumX += x; sumY += y; energy += x * x + y * y;
    }
    assert(minAlbedo >= 235 && maxAlbedo < 255, 'keep bright snow below painted white clipping');
    assert(maxAlbedo - minAlbedo > 5, 'retain subtle powder variation');
    const count = colors.length / 4;
    assert(Math.abs(sumX / count) < 0.002 && Math.abs(sumY / count) < 0.002,
      'grain must not tilt the whole material');
    assert(energy / count > 0.005 && energy / count < 0.08, 'retain bounded relief energy');
    for (const channel of [0, 1]) {
      const samples = [];
      for (let y = 0; y < 256; y += 4) {
        for (let x = 0; x < 256; x += 4) samples.push(normals[(y * 256 + x) * 4 + channel]);
      }
      const peak = spectrum(samples, 64);
      assert(peak < 0.025, `coherent normal-map ripple: one Fourier mode owns ${peak * 100}% of energy`);
    }
    albedo.dispose(); normal.dispose();

    // The new terrain skin must have visible, physically scaled shape; its old
    // .12-strength grain alone tilted the surface by only ~1.8 degrees RMS.
    // Its extra map is cosmetic: Three UUID allocation must retain the EXACT
    // previous two-texture draw count, so the seeded obstacle world cannot change.
    let terrainDraws = 0;
    Math.random = () => { terrainDraws++; return 0.5; };
    const terrain = createTerrainSnowTextures();
    Math.random = originalRandom;
    assert.equal(terrainDraws, oldDraws, 'new material maps shifted gameplay RNG');
    const terrainColor = images[2], terrainNormal = images[3], terrainRough = images[4];
    const size = Math.sqrt(terrainColor.length / 4), spacing = SNOW_RELIEF_TILE_SIZE / size;
    const hollowStep = 0.5 / SNOW_RELIEF_TILE_SIZE;
    let slopeEnergy = 0, lowRough = 0, minRough = 1, maxRough = 0;
    let slopeXX = 0, slopeYY = 0, slopeXY = 0;
    let minTerrainColor = 255, hollowColor = 0, crestColor = 0, hollows = 0, crests = 0;
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const i = (y * size + x) * 4;
        const nx = terrainNormal[i] / 255 * 2 - 1;
        const ny = terrainNormal[i + 1] / 255 * 2 - 1;
        const nz = terrainNormal[i + 2] / 255 * 2 - 1;
        assert(Math.abs(Math.hypot(nx, ny, nz) - 1) < 0.012);
        assert(nz > 0.7, 'snow skin contains a cliff-like normal');
        slopeEnergy += (nx * nx + ny * ny) / (nz * nz);
        slopeXX += nx * nx; slopeYY += ny * ny; slopeXY += nx * ny;
        const rough = terrainRough[i + 1] / 255;
        minRough = Math.min(minRough, rough); maxRough = Math.max(maxRough, rough);
        if (rough < 0.75) lowRough++;
        minTerrainColor = Math.min(minTerrainColor, terrainColor[i]);
        assert(terrainColor[i + 2] >= terrainColor[i], 'hollows need cool sky tint');
        // Check the normal actually points away from the height gradient, rather
        // than testing noise amplitude alone. This catches inverted UV normals.
        if (x % 16 === 0 && y % 16 === 0) {
          const u = x / size, v = y / size, step = 1 / size;
          const dx = (snowRelief(u + step, v).height - snowRelief(u - step, v).height) / (2 * spacing);
          const dy = (snowRelief(u, v + step).height - snowRelief(u, v - step).height) / (2 * spacing);
          assert(Math.abs(nx / nz + dx) < 0.015 && Math.abs(ny / nz + dy) < 0.015,
            'normals no longer follow the material height in metres');
          const h = snowRelief(u, v).height;
          const surround = (snowRelief(u - hollowStep, v).height + snowRelief(u + hollowStep, v).height +
            snowRelief(u, v - hollowStep).height + snowRelief(u, v + hollowStep).height) / 4;
          if (surround - h > 0.02) { hollowColor += terrainColor[i]; hollows++; }
          if (surround - h < -0.02) { crestColor += terrainColor[i]; crests++; }
        }
      }
    }
    const terrainCount = (size / 2) ** 2;
    const rmsTilt = Math.atan(Math.sqrt(slopeEnergy / terrainCount)) * 180 / Math.PI;
    assert(rmsTilt > 5 && rmsTilt < 13, `snow relief is flat or over-corrugated (${rmsTilt} degrees)`);
    // A broad Fourier spectrum alone can still look like groomed corduroy when
    // nearly every slope faces one axis. Irregular mounds need varied directions.
    const discriminant = Math.hypot(slopeXX - slopeYY, 2 * slopeXY);
    const directionRatio = (slopeXX + slopeYY + discriminant) / (slopeXX + slopeYY - discriminant);
    assert(directionRatio < 4, `snow relief became a sheet of parallel ridges (${directionRatio})`);
    assert(minTerrainColor < 235 && minTerrainColor >= 210, 'coherent hollows must have visible bounded colour depth');
    assert(hollows > 10 && crests > 10 && hollowColor / hollows < crestColor / crests - 8,
      'colour is unrelated to the shaded hollows');
    assert(minRough >= 0.575 && maxRough <= 0.935 && maxRough > 0.9);
    assert(lowRough / terrainCount > 0.1 && lowRough / terrainCount < 0.4,
      'wind crust must catch light without turning the whole powder field glossy');
    for (const texture of Object.values(terrain)) {
      assert.equal(texture.repeat.x, 300 / SNOW_RELIEF_TILE_SIZE);
      assert.equal(texture.repeat.y, 400 / SNOW_RELIEF_TILE_SIZE);
      assert.equal(texture.flipY, false, 'normal derivative and colour/roughness must use the same +v bake axis');
      texture.dispose();
    }
  } finally {
    Math.random = originalRandom;
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  console.log('Snow texture fields, seams, normal energy and anti-grid spectrum passed.');
})().catch(error => { console.error(error); process.exit(1); });
