// @ts-check
/**
 * Pure geometry + vertex-colour metrics for rock meshes (rock realism recovery, PR 1).
 *
 * Everything here is derived from the raw non-indexed BufferGeometry attribute arrays
 * (position/normal/color) plus the rock's nominal `size` — no THREE dependency, no DOM,
 * no randomness — so the same numbers come out on every platform and CI can gate on
 * them. The metric set encodes the two historical failure modes:
 *
 *  - #344 (convex hulls): intrinsic MASS LOSS (avgRadius/aabbVolume floors) and
 *    whole-facet snow saturation (largeWhiteFaceRatio, sideStoneRatio).
 *  - #304 (scraped dodecahedron, current main): soft spherical relief — the relief
 *    set (radialVariance, radius percentile spread, normal-area entropy, silhouette
 *    variance) is RECORDED as the baseline for PR 3 to push *up*, not just floors
 *    to avoid.
 *
 * Snow-ness heuristic: applyRockSnowColors lerps each vertex from a stone base toward
 * SNOW_WHITE ≈ (0.97, 0.98, 1.0). Every stone tone in ROCK_STONES has a clearly lower
 * minimum channel (≤ ~0.6 after jitter), so the min RGB channel maps monotonically to
 * the snow blend: snowness = clamp01((minChannel − 0.60) / (0.97 − 0.60)). It is a
 * *metric* heuristic (stable, monotone, discriminating), not a physical inverse.
 */

/** Luminance (Rec.709). @param {number} r @param {number} g @param {number} b */
function lum(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {number} v */
function clamp01(v) {
  // NaN-safe (see CLAUDE.md review notes): NaN fails `v > 0` and returns 0.
  return v > 0 ? Math.min(v, 1) : 0;
}

/** Per-vertex snow blend estimate from a vertex colour. @param {number} r @param {number} g @param {number} b */
function snowness(r, g, b) {
  const minC = Math.min(r, g, b);
  return clamp01((minC - 0.60) / (0.97 - 0.60));
}

/** Sorted-array percentile (linear index, no interpolation). @param {number[]} sorted @param {number} p */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Compute the full metric set for one rock.
 *
 * @param {{ position: ArrayLike<number>, normal: ArrayLike<number>, color: ArrayLike<number> }} attrs
 *   The geometry's non-indexed attribute arrays (each 3 floats per vertex).
 * @param {number} size The rock's nominal createRock size (world units).
 * @returns {Record<string, number>} metric name → value (all finite).
 */
export function computeRockMetrics(attrs, size) {
  const pos = attrs.position;
  const col = attrs.color;
  const vertexCount = pos.length / 3;
  const triCount = vertexCount / 3;

  // ---- Vertex-level shape stats -------------------------------------------------
  const radii = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let maxHorizontalRadius = 0;
  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    radii.push(Math.hypot(x, y, z));
    maxHorizontalRadius = Math.max(maxHorizontalRadius, Math.hypot(x, z));
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const avgRadius = radii.reduce((s, r) => s + r, 0) / radii.length;
  const aabbVolume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);
  const topYLocal = maxY;
  // Bounding sphere about the AABB centre (matches THREE's computeBoundingSphere seed).
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let boundingSphereRadius = 0;
  for (let i = 0; i < vertexCount; i++) {
    boundingSphereRadius = Math.max(boundingSphereRadius,
      Math.hypot(pos[i * 3] - cx, pos[i * 3 + 1] - cy, pos[i * 3 + 2] - cz));
  }

  // Relief: radial variance + percentile spread (normalised by size so thresholds
  // transfer across sample sizes).
  const nr = radii.map((r) => r / size);
  const nrMean = nr.reduce((s, r) => s + r, 0) / nr.length;
  const radialVariance = nr.reduce((s, r) => s + (r - nrMean) ** 2, 0) / nr.length;
  const sortedNr = [...nr].sort((a, b) => a - b);
  const radiusP90P10 = percentile(sortedNr, 0.9) / percentile(sortedNr, 0.1);
  const extents = [maxX - minX, maxY - minY, maxZ - minZ];
  const axisRatio = Math.max(...extents) / Math.min(...extents);

  // ---- Triangle walk: areas, face normals, facet clusters, snow/stone reads ------
  /** Facet clusters keyed by quantized face normal (flat-shaded planes merge). */
  const clusters = new Map();
  let totalArea = 0;
  let snowAreaSum = 0;          // Σ area · faceSnow
  let topShelfArea = 0;         // faces with ny > 0.75
  let sideArea = 0, sideStoneArea = 0, sideLumSum = 0;
  let downArea = 0, downLumSum = 0;
  let snowVertices = 0;

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
    const bx = pos[i0 + 3], by = pos[i0 + 4], bz = pos[i0 + 5];
    const cxx = pos[i0 + 6], cyy = pos[i0 + 7], czz = pos[i0 + 8];
    // Cross product of the two edges → face normal (length = 2·area).
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxx - ax, vy = cyy - ay, vz = czz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len2 = Math.hypot(nx, ny, nz);
    const area = len2 / 2;
    if (!(area > 0)) continue; // degenerate sliver — contributes nothing
    const fnx = nx / len2, fny = ny / len2, fnz = nz / len2;
    totalArea += area;

    // Face snow/luminance from the three vertex colours (flat shading makes them
    // equal in practice; averaging keeps the metric robust if that ever changes).
    let faceSnow = 0, faceLum = 0;
    for (let k = 0; k < 3; k++) {
      const ci = i0 + k * 3;
      const r = col[ci], g = col[ci + 1], b = col[ci + 2];
      const s = snowness(r, g, b);
      faceSnow += s / 3;
      faceLum += lum(r, g, b) / 3;
      if (s > 0.5) snowVertices++;
    }
    snowAreaSum += area * faceSnow;
    if (fny > 0.75) topShelfArea += area;
    if (Math.abs(fny) < 0.35) {
      sideArea += area;
      sideLumSum += area * faceLum;
      if (faceSnow < 0.35) sideStoneArea += area;
    }
    if (fny < -0.3) {
      downArea += area;
      downLumSum += area * faceLum;
    }

    // Facet cluster: quantize the face normal so triangles flattened onto the same
    // scrape plane (or the same dodecahedron facet) merge into one "visual face".
    const q = 0.05;
    const key = `${Math.round(fnx / q)},${Math.round(fny / q)},${Math.round(fnz / q)}`;
    const c = clusters.get(key) || { area: 0, snowArea: 0, nySum: 0 };
    c.area += area;
    c.snowArea += area * faceSnow;
    c.nySum += area * fny;
    clusters.set(key, c);
  }

  // Largest visual face + normal-area entropy + the #344 killer: area sitting in
  // LARGE (>4% of surface), fully-white (snow ≥ 0.9) facets that are NOT genuine
  // top shelves (face ny ≥ 0.75) — full snow on a high up-facing shelf is the
  // *desired* look; whole side/slab facets saturating white is the failure mode.
  let largestFaceArea = 0;
  let largeWhiteArea = 0;
  let entropy = 0;
  for (const c of clusters.values()) {
    largestFaceArea = Math.max(largestFaceArea, c.area);
    const p = c.area / totalArea;
    if (p > 0) entropy -= p * Math.log(p);
    const cSnow = c.snowArea / c.area;
    const cNy = c.nySum / c.area;
    if (c.area > 0.04 * totalArea && cSnow >= 0.9 && cNy < 0.75) largeWhiteArea += c.area;
  }

  // Silhouette variance: projected-AABB area from 8 fixed horizontal view angles.
  // A sphere scores ~0 variance; lobed/sheared silhouettes score higher.
  const silAreas = [];
  for (let a = 0; a < 8; a++) {
    const th = (a / 8) * Math.PI;
    const rx = Math.cos(th), rz = Math.sin(th);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const u = pos[i * 3] * rx + pos[i * 3 + 2] * rz;
      const v = pos[i * 3 + 1];
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    silAreas.push((maxU - minU) * (maxV - minV));
  }
  const silMean = silAreas.reduce((s, v) => s + v, 0) / silAreas.length;
  const silVar = silAreas.reduce((s, v) => s + (v - silMean) ** 2, 0) / silAreas.length;
  const silhouetteAreaCV = Math.sqrt(silVar) / silMean;

  return {
    // Mass / shape (absolute, world units — floors guard the #344 shrinkage)
    avgRadius,
    aabbVolume,
    boundingSphereRadius,
    topYLocal,
    topEnvelope: topYLocal / size,
    maxHorizontalRadius,
    // Snow read (caps guard the over-white failure)
    snowVertexRatio: snowVertices / vertexCount,
    areaWeightedSnowRatio: snowAreaSum / totalArea,
    largeWhiteFaceRatio: largeWhiteArea / totalArea,
    topShelfAreaRatio: topShelfArea / totalArea,
    // Stone read
    sideStoneRatio: sideArea > 0 ? sideStoneArea / sideArea : 0,
    undersideLumRatio: downArea > 0 && sideArea > 0
      ? (downLumSum / downArea) / (sideLumSum / sideArea)
      : 1,
    // Relief targets (recorded now; PR 3 raises floors)
    radialVariance,
    radiusP90P10,
    axisRatio,
    largestFaceAreaRatio: largestFaceArea / totalArea,
    normalAreaEntropy: entropy,
    silhouetteAreaCV,
    // Bookkeeping
    triangleCount: triCount,
    facetClusterCount: clusters.size,
  };
}
