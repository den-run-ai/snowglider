// Render snowfall, ski spray and avalanche/tree powder in one sorted billboard draw.
// Simulation keeps its existing Sprite-shaped particle handles, but they are
// detached CPU state: only this mesh enters the scene graph/render list.
import * as THREE from 'three';
import { withPrivateThreeRandom } from './scenery/scenery-rng.js';

const MAX_PARTICLES = 1000 + 250 + 260 + 18; // all four existing fixed-size pools
type TextureSlot = 0 | 1 | 2 | 3 | 4;
const TEXTURE_UNIFORMS = ['flakeMap', 'puffMap', 'clumpMap', 'avalancheMap', 'treeMap'] as const;
interface ParticleEntry { sprite: THREE.Sprite; texture: TextureSlot; depth: number; }
// @types/three inherits Object3D's mesh callback on Scene; WebGLRenderer invokes
// Scene.onBeforeRender with these FOUR arguments (the fourth is render target).
type SceneBeforeRender = (renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  camera: THREE.Camera, target: THREE.WebGLRenderTarget | null) => void;
interface SceneRenderHooks { onBeforeRender: SceneBeforeRender; }

const vertexHeader = `
attribute vec3 aParticlePosition;
attribute vec3 aParticleSizeRotation;
attribute vec2 aParticleCenter;
attribute vec4 aParticleColor;
attribute float aParticleTexture;
varying vec2 vParticleUv;
varying vec4 vParticleColor;
varying float vParticleTexture;
`;
const fragmentHeader = `
uniform sampler2D flakeMap;
uniform sampler2D puffMap;
uniform sampler2D clumpMap;
uniform sampler2D avalancheMap;
uniform sampler2D treeMap;
varying vec2 vParticleUv;
varying vec4 vParticleColor;
varying float vParticleTexture;
`;

/** The pinned stock Sprite shader preserves size attenuation, rotation, fog,
 * tone/output conversion and blending used by these particle pools. Object uniforms become
 * per-instance attributes; the original textures keep their own filtering. */
function billboardMaterial(): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.clone(THREE.ShaderLib.sprite.uniforms);
  for (const name of TEXTURE_UNIFORMS) uniforms[name] = { value: null };
  const vertexShader = vertexHeader + THREE.ShaderLib.sprite.vertexShader
    .replace('vec4 mvPosition = modelViewMatrix[ 3 ];', `
      vParticleUv = uv;
      vParticleColor = aParticleColor;
      vParticleTexture = aParticleTexture;
      vec4 mvPosition = modelViewMatrix * vec4( aParticlePosition, 1.0 );`)
    .replace('vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );',
      'vec2 scale = aParticleSizeRotation.xy;')
    .replace('( center - vec2( 0.5 ) )', '( aParticleCenter - vec2( 0.5 ) )')
    .replaceAll('cos( rotation )', 'cos( aParticleSizeRotation.z )')
    .replaceAll('sin( rotation )', 'sin( aParticleSizeRotation.z )');
  const fragmentShader = fragmentHeader + THREE.ShaderLib.sprite.fragmentShader
    .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
      'vec4 diffuseColor = vec4( diffuse, opacity ) * vParticleColor;')
    .replace('#include <map_fragment>', `
      vec4 sampledDiffuseColor;
      if ( vParticleTexture < 0.5 ) sampledDiffuseColor = texture2D( flakeMap, vParticleUv );
      else if ( vParticleTexture < 1.5 ) sampledDiffuseColor = texture2D( puffMap, vParticleUv );
      else if ( vParticleTexture < 2.5 ) sampledDiffuseColor = texture2D( clumpMap, vParticleUv );
      else if ( vParticleTexture < 3.5 ) sampledDiffuseColor = texture2D( avalancheMap, vParticleUv );
      else sampledDiffuseColor = texture2D( treeMap, vParticleUv );
      diffuseColor *= sampledDiffuseColor;`);
  return new THREE.ShaderMaterial({
    name: 'SnowBillboards', uniforms, vertexShader, fragmentShader,
    defines: { USE_SIZEATTENUATION: '' },
    transparent: true, depthWrite: false, fog: true,
    blending: THREE.NormalBlending,
  });
}

const batches = new WeakMap<THREE.Scene, SnowBillboards>();

/** One scene-owned batch. Source materials/textures stay owned by Snow's pools;
 * dispose only releases this batch's geometry/material and render callback. */
export class SnowBillboards {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly entries: ParticleEntry[] = [];
  private readonly ordered: ParticleEntry[] = [];
  private readonly position = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
  private readonly sizeRotation = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
  private readonly center = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 2), 2);
  private readonly color = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 4), 4);
  private readonly texture = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly previousBeforeRender: SceneBeforeRender;
  private readonly beforeRender: SceneBeforeRender;
  private readonly scene: THREE.Scene;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aParticlePosition', this.position);
    geometry.setAttribute('aParticleSizeRotation', this.sizeRotation);
    geometry.setAttribute('aParticleCenter', this.center);
    geometry.setAttribute('aParticleColor', this.color);
    geometry.setAttribute('aParticleTexture', this.texture);
    for (const attribute of [this.position, this.sizeRotation, this.center, this.color, this.texture]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.mesh = new THREE.Mesh(geometry, billboardMaterial());
    this.mesh.name = 'snowBillboards';
    this.mesh.frustumCulled = false; // each billboard is culled below against its live position
    this.mesh.matrixAutoUpdate = false; // particle positions are world coordinates
    scene.add(this.mesh);

    // Mesh.onBeforeRender is TOO LATE: Three has already uploaded geometry
    // attributes while collecting the render list. The scene callback runs after
    // camera matrices update but before collection/upload, including intro/share
    // renders, so both order and buffer data correspond to this exact camera.
    const hooks = scene as unknown as SceneRenderHooks;
    this.previousBeforeRender = hooks.onBeforeRender;
    this.beforeRender = (renderer, renderedScene, camera, target) => {
      this.previousBeforeRender.call(scene, renderer, renderedScene, camera, target);
      this.sync(camera);
    };
    hooks.onBeforeRender = this.beforeRender;
  }

  add(sprites: THREE.Sprite[], textureFor: (sprite: THREE.Sprite) => TextureSlot): void {
    if (this.entries.length + sprites.length > MAX_PARTICLES) throw new Error('Snow billboard capacity exceeded');
    for (const sprite of sprites) {
      const texture = textureFor(sprite);
      const uniform = TEXTURE_UNIFORMS[texture];
      this.mesh.material.uniforms[uniform]!.value = sprite.material.map;
      this.entries.push({ sprite, texture, depth: 0 });
      sprite.removeFromParent();
    }
  }

  remove(sprites: THREE.Sprite[]): void {
    const removed = new Set(sprites);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (removed.has(this.entries[i]!.sprite)) this.entries.splice(i, 1);
    }
    for (const [slot, uniform] of TEXTURE_UNIFORMS.entries()) {
      if (!this.entries.some((entry) => entry.texture === slot)) this.mesh.material.uniforms[uniform]!.value = null;
    }
    this.ordered.length = 0;
    this.mesh.geometry.instanceCount = 0;
    if (this.entries.length === 0) this.dispose();
  }

  /** Pack visible particles in back-to-front order. Exposed for headless parity
   * tests; rendering calls it once before Three uploads the attributes. */
  sync(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem);
    const view = camera.matrixWorldInverse.elements;
    this.ordered.length = 0;
    for (const entry of this.entries) {
      const sprite = entry.sprite;
      if (!sprite.visible || !sprite.material.visible || sprite.material.opacity <= 0) continue;
      const { x, y, z } = sprite.position;
      const scale = Math.max(Math.abs(sprite.scale.x), Math.abs(sprite.scale.y), Math.abs(sprite.scale.z));
      if (!(scale > 0)) continue;
      this.sphere.center.copy(sprite.position);
      // Same conservative sphere as THREE.Frustum.intersectsSprite, without
      // composing every detached Object3D matrix on every render.
      this.sphere.radius = (Math.SQRT1_2 + Math.hypot(sprite.center.x - 0.5, sprite.center.y - 0.5)) * scale;
      if (sprite.frustumCulled && !this.frustum.intersectsSphere(this.sphere)) continue;
      entry.depth = view[2] * x + view[6] * y + view[10] * z + view[14];
      this.ordered.push(entry);
    }
    this.ordered.sort((a, b) => a.depth - b.depth || a.sprite.id - b.sprite.id);
    this.mesh.geometry.instanceCount = this.ordered.length;
    // Give Three's object-level transparent sort a live representative depth,
    // rather than the world origin. The identity mesh transform and world-space
    // particle attributes stay unchanged; only the sorting bound's center moves.
    if (this.ordered.length > 0) {
      const median = this.ordered[Math.floor(this.ordered.length / 2)]!.sprite.position;
      this.mesh.geometry.boundingSphere!.center.copy(median);
    }
    for (let i = 0; i < this.ordered.length; i++) {
      const { sprite, texture } = this.ordered[i]!;
      this.position.setXYZ(i, sprite.position.x, sprite.position.y, sprite.position.z);
      this.sizeRotation.setXYZ(i, Math.abs(sprite.scale.x), Math.abs(sprite.scale.y), sprite.material.rotation);
      this.center.setXY(i, sprite.center.x, sprite.center.y);
      this.color.setXYZW(i, sprite.material.color.r, sprite.material.color.g, sprite.material.color.b, sprite.material.opacity);
      this.texture.setX(i, texture);
    }
    if (this.ordered.length > 0) {
      for (const attribute of [this.position, this.sizeRotation, this.center, this.color, this.texture]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, this.ordered.length * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const hooks = this.scene as unknown as SceneRenderHooks;
    if (hooks.onBeforeRender === this.beforeRender) hooks.onBeforeRender = this.previousBeforeRender;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const uniform of TEXTURE_UNIFORMS) this.mesh.material.uniforms[uniform]!.value = null;
    this.entries.length = this.ordered.length = 0;
    batches.delete(this.scene);
  }
}

/** New THREE allocations are private RNG draws; the existing simulation and
 * historical Sprite creation consume exactly their original streams. */
export function snowBillboardsFor(scene: THREE.Scene): SnowBillboards {
  let batch = batches.get(scene);
  if (!batch) {
    batch = withPrivateThreeRandom(() => new SnowBillboards(scene));
    batches.set(scene, batch);
  }
  return batch;
}
