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
  const { snowMottle, snowGrain } = await import('../src/mountains/snow-texture.ts');
  const { createSnowAlbedoTexture, createSnowNormalTexture } = await import('../src/mountains/snow-surface.ts');
  const originalRandom = Math.random;
  try {
    Math.random = () => { throw new Error('texture fields consumed the gameplay RNG'); };
    for (const field of [snowMottle, snowGrain]) {
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
    const albedo = createSnowAlbedoTexture();
    const normal = createSnowNormalTexture();
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
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  console.log('Snow texture fields, seams, normal energy and anti-grid spectrum passed.');
})().catch(error => { console.error(error); process.exit(1); });
