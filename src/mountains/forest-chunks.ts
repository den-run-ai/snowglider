import * as THREE from 'three';
import { withPrivateThreeRandom } from '../scenery/scenery-rng.js';

// Large enough to amortize draw calls, small enough to reject uphill/off-screen
// stands in both the camera and directional-light frusta. No per-frame rebucketing.
export const FOREST_CHUNK_SIZE = 80;

export interface ForestChunk {
  mesh: THREE.InstancedMesh;
  /** Original indices in ascending order: matrices, colours and loads stay paired. */
  sourceIndices: number[];
}

/** Three does not reference-count BufferAttributes across geometries. Retire a
 * family's geometry wrappers together, after its last chunk releases ownership,
 * so disposing one chunk cannot delete a GPU buffer still bound by a sibling VAO.
 * Dispatch on every wrapper: the last released chunk may never have been rendered
 * and therefore may have no renderer disposal listener of its own. */
class ChunkGeometryFamily {
  private geometries: THREE.BufferGeometry[] = [];
  private remaining = 0;

  create(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    this.geometries.push(geometry);
    this.remaining++;
    let released = false;
    geometry.dispose = (): void => {
      if (released) return;
      released = true;
      if (--this.remaining > 0) return;
      for (const sibling of this.geometries) THREE.BufferGeometry.prototype.dispose.call(sibling);
      this.geometries = [];
    };
    return geometry;
  }
}

/** Separate GPU lifetime from the pooled source/other forests while retaining the
 * same immutable CPU data. All chunks in this one family share the new identity. */
function shareStaticData(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  if (attribute instanceof THREE.InterleavedBufferAttribute) return attribute.clone();
  const shared = new THREE.BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized);
  shared.name = attribute.name;
  shared.setUsage(attribute.usage);
  shared.gpuType = attribute.gpuType;
  return shared;
}

/** Split an identity-transform forest family without touching placement or RNG.
 * Static vertex/index buffers stay shared within the family; CPU arrays also stay
 * shared with the pooled source. Only per-instance attribute data is copied.
 * The caller owns removing/disposing the source and remapping its load bindings. */
export function splitForestMesh(source: THREE.InstancedMesh, motionPadding: number): ForestChunk[] {
  return withPrivateThreeRandom(() => {
    const cells = new Map<string, number[]>();
    const matrices = source.instanceMatrix.array;
    for (let i = 0; i < source.count; i++) {
      const key = `${Math.floor(matrices[i * 16 + 12]! / FOREST_CHUNK_SIZE)},${Math.floor(matrices[i * 16 + 14]! / FOREST_CHUNK_SIZE)}`;
      const indices = cells.get(key);
      if (indices) indices.push(i);
      else cells.set(key, [i]);
    }
    const family = new ChunkGeometryFamily();
    const staticAttributes = new Map<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>();
    for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
      if (!(attribute instanceof THREE.InstancedBufferAttribute)) staticAttributes.set(name, shareStaticData(attribute));
    }
    const index = source.geometry.index
      ? new THREE.BufferAttribute(source.geometry.index.array, 1).setUsage(source.geometry.index.usage)
      : null;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const chunks: ForestChunk[] = [];
    for (const [cell, sourceIndices] of cells) {
      // One static GPU buffer set per family, with independent identities from
      // pooled sources/other forests. Geometry disposal is owned by the family.
      const geometry = family.create();
      geometry.setIndex(index);
      for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
        if (attribute instanceof THREE.InstancedBufferAttribute) {
          const array = new Float32Array(sourceIndices.length * attribute.itemSize);
          sourceIndices.forEach((original, local) => {
            for (let k = 0; k < attribute.itemSize; k++) {
              array[local * attribute.itemSize + k] = attribute.array[original * attribute.itemSize + k]!;
            }
          });
          geometry.setAttribute(name, new THREE.InstancedBufferAttribute(
            array, attribute.itemSize, attribute.normalized, attribute.meshPerAttribute
          ).setUsage(attribute.usage));
        } else geometry.setAttribute(name, staticAttributes.get(name)!);
      }
      geometry.boundingBox = source.geometry.boundingBox?.clone() ?? null;
      geometry.boundingSphere = source.geometry.boundingSphere?.clone() ?? null;
      for (const group of source.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      geometry.setDrawRange(source.geometry.drawRange.start, source.geometry.drawRange.count);
      const mesh = new THREE.InstancedMesh(geometry, source.material, sourceIndices.length);
      mesh.name = source.name;
      mesh.userData = { ...source.userData, ownsGeometry: true, forestChunk: cell };
      mesh.castShadow = source.castShadow;
      mesh.receiveShadow = source.receiveShadow;
      mesh.customDepthMaterial = source.customDepthMaterial;
      mesh.customDistanceMaterial = source.customDistanceMaterial;
      sourceIndices.forEach((original, local) => {
        source.getMatrixAt(original, matrix);
        mesh.setMatrixAt(local, matrix);
        if (source.instanceColor) {
          source.getColorAt(original, color);
          mesh.setColorAt(local, color);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      // Shrinking snow contracts toward its instance origin; include that origin
      // too so any local geometry offset cannot escape the full-size bounds.
      if (geometry.hasAttribute('aSnowRatio')) {
        const origin = new THREE.Vector3();
        sourceIndices.forEach((original) => {
          origin.fromArray(matrices, original * 16 + 12);
          mesh.boundingBox!.expandByPoint(origin);
        });
      }
      mesh.boundingBox!.expandByScalar(motionPadding);
      mesh.boundingSphere = mesh.boundingBox!.getBoundingSphere(new THREE.Sphere());
      chunks.push({ mesh, sourceIndices });
    }
    return chunks;
  });
}
