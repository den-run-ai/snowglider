// @ts-check
// Exercise Three's real WebGL disposal code without a driver: geometry disposal
// removes attributes, and a cached VAO cannot infer that an identical attribute's
// old GPU handle was deleted. Separate scene/family lifetimes must not overlap.
const assert = require('node:assert/strict');

async function main() {
  const THREE = await import('three');
  const { WebGLAttributes } = await import('three/src/renderers/webgl/WebGLAttributes.js');
  const { WebGLGeometries } = await import('three/src/renderers/webgl/WebGLGeometries.js');
  const { Trees } = await import('../src/trees.js');
  let serial = 0;
  const deleted = new Set();
  const gl = {
    ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, FLOAT: 5126, UNSIGNED_SHORT: 5123,
    createBuffer: () => ({ id: ++serial }),
    bindBuffer: () => {}, bufferData: () => {},
    deleteBuffer: buffer => deleted.add(buffer)
  };
  // Only allocation/disposal is exercised; the stub intentionally omits rendering APIs.
  const mockGl = /** @type {WebGL2RenderingContext} */ (/** @type {unknown} */ (gl));
  const attributes = new WebGLAttributes(mockGl);
  const info = { memory: { geometries: 0 } };
  // @types/three still declares the old three-argument internal constructor; r184
  // WebGLGeometries requires bindingStates as its fourth argument. Reflect keeps
  // this explicit source-verified test seam local without weakening production types.
  const geometries = /** @type {InstanceType<typeof WebGLGeometries>} */ (Reflect.construct(
    WebGLGeometries, [mockGl, attributes, info, { releaseStatesOfGeometry: () => {} }]));
  Trees.resetTreePools(); Trees.setEzForestEnabled(false);
  const sceneA = new THREE.Scene(), sceneB = new THREE.Scene();
  Trees.addTrees(sceneA); Trees.addTrees(sceneB);
  const trunks = scene => scene.children.filter(c => c.userData.forestPart === 'trunk');
  const a = trunks(sceneA), b = trunks(sceneB);
  assert(a.length > 2 && b.length > 2);
  const aPosition = a[0].geometry.getAttribute('position');
  const bPosition = b[0].geometry.getAttribute('position');
  assert.notEqual(aPosition, bPosition, 'independent forests have independent GPU attribute identities');
  assert.equal(aPosition.array, bPosition.array, 'pooled immutable CPU arrays are still shared');
  assert.notEqual(a[0].geometry.index, b[0].geometry.index, 'index GPU identity is isolated too');
  assert.equal(a[0].geometry.index.array, b[0].geometry.index.array);
  const register = mesh => {
    geometries.get(mesh, mesh.geometry);
    geometries.update(mesh.geometry);
    if (mesh.geometry.index) attributes.update(mesh.geometry.index, gl.ELEMENT_ARRAY_BUFFER);
  };
  // The last chunk never rendered. Its release still has to free GPU resources
  // via the disposal listeners on siblings that DID render.
  a.slice(0, -1).forEach(register); b.forEach(register);
  const aBuffer = attributes.get(aPosition).buffer;
  const bBuffer = attributes.get(bPosition).buffer;
  const bIndexBuffer = attributes.get(b[0].geometry.index).buffer;
  a[0].removeFromParent(); a[0].geometry.dispose(); a[0].dispose();
  assert.equal(attributes.get(aPosition).buffer, aBuffer, 'partial release retains surviving sibling GPU buffers');
  assert(!deleted.has(aBuffer));
  a.slice(1).forEach(mesh => { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.dispose(); });
  assert.equal(attributes.get(aPosition), undefined, 'final family release frees shared static GPU buffers');
  assert(deleted.has(aBuffer));
  assert.equal(attributes.get(bPosition).buffer, bBuffer, 'another scene retains its original VAO-bound buffer');
  assert.equal(attributes.get(b[0].geometry.index).buffer, bIndexBuffer);
  assert(!deleted.has(bBuffer) && !deleted.has(bIndexBuffer));
  assert(b.every(mesh => mesh.parent === sceneB));
  assert.equal(info.memory.geometries, b.length, 'all rendered A wrappers released, B residency unchanged');
  // Rebuilding B exercises the production cleanup path, including idempotent
  // repeated releases and families that had no renderer listeners at all.
  Trees.addTrees(sceneB);
  assert.equal(attributes.get(bPosition), undefined);
  assert(deleted.has(bBuffer) && deleted.has(bIndexBuffer));
  assert.equal(info.memory.geometries, 0);
  a.forEach(mesh => mesh.geometry.dispose()); b.forEach(mesh => mesh.geometry.dispose());
  assert.equal(info.memory.geometries, 0, 'double release cannot decrement renderer residency twice');
  Trees.resetTreePools(); Trees.setEzForestEnabled(null);
  console.log('Forest GPU lifetime: actual Three attribute disposal preserves sibling/other-scene buffers and frees every retired family.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
