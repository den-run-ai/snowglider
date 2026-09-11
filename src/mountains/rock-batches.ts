import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withPrivateThreeRandom } from '../scenery/scenery-rng.js';

// Smaller than forest cells: rocks are dense, low and opaque, so fewer draws
// outweigh a little extra off-screen geometry without one mountain-wide batch.
export const ROCK_CHUNK_SIZE = 40;

function isStaticRock(child: THREE.Object3D): child is THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
  return child instanceof THREE.Mesh && child.userData.isRock === true &&
    child.geometry instanceof THREE.BufferGeometry && child.material instanceof THREE.Material;
}

/** Merge already-placed static rocks, after collision tops and contact-shadow
 * positions have been recorded. Original shapes, vertex colours, UVs, material
 * identities and shadows are retained. Nothing reads the gameplay RNG. */
export function batchStaticRocks(scene: THREE.Scene): void {
  withPrivateThreeRandom(() => {
    const cells = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>();
    for (const child of scene.children) {
      if (!isStaticRock(child)) continue;
      const key = `${Math.floor(child.position.x / ROCK_CHUNK_SIZE)},${Math.floor(child.position.z / ROCK_CHUNK_SIZE)},${child.material.uuid}`;
      const group = cells.get(key);
      if (group) group.push(child);
      else cells.set(key, [child]);
    }
    for (const [cell, rocks] of cells) {
      if (rocks.length < 2) continue;
      const first = rocks[0]!;
      // Bake in cell-relative space to preserve float precision on a long run.
      const origin = new THREE.Vector3(
        (Math.floor(first.position.x / ROCK_CHUNK_SIZE) + 0.5) * ROCK_CHUNK_SIZE,
        first.position.y,
        (Math.floor(first.position.z / ROCK_CHUNK_SIZE) + 0.5) * ROCK_CHUNK_SIZE
      );
      const matrix = new THREE.Matrix4();
      const geometries = rocks.map(rock => {
        rock.updateMatrix();
        matrix.copy(rock.matrix);
        matrix.elements[12] -= origin.x;
        matrix.elements[13] -= origin.y;
        matrix.elements[14] -= origin.z;
        return rock.geometry.clone().applyMatrix4(matrix);
      });
      // Every createRock shape has the same position/normal/uv/colour layout.
      // If a future shape violates that contract, retain its original meshes.
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const batch = new THREE.Mesh(geometry, first.material);
      batch.position.copy(origin);
      batch.name = 'rockBatch';
      batch.castShadow = first.castShadow;
      batch.receiveShadow = first.receiveShadow;
      batch.userData.isRock = true;
      batch.userData.rockCount = rocks.length;
      batch.userData.rockChunk = cell;
      for (const rock of rocks) {
        scene.remove(rock);
        // Each original rock geometry is unique and no longer rendered; materials
        // and their textures are pooled and remain owned by resetRockCaches.
        rock.geometry.dispose();
      }
      scene.add(batch);
    }
  });
}
