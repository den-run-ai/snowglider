import type { Page } from '@playwright/test';
import { ShaderChunk } from 'three';

/** Execute the real material's vertex deformation on the GPU, then compare its
 * normals with finite differences of its actual displaced positions. No wind
 * formula is copied into this test; it catches the old silhouette-only shader. */
export async function measureTreeWindNormals(page: Page) {
  const chunks = {
    common: ShaderChunk.common,
    beginnormal_vertex: ShaderChunk.beginnormal_vertex,
    defaultnormal_vertex: ShaderChunk.defaultnormal_vertex,
    begin_vertex: ShaderChunk.begin_vertex,
    project_vertex: ShaderChunk.project_vertex,
  };
  return page.evaluate(chunks => {
    const w = window as unknown as { scene: import('three').Scene };
    const meshes = w.scene.children.filter(c =>
      (c as import('three').InstancedMesh).isInstancedMesh &&
      ['ezBranches', 'ezLeaves', 'ezSnowPatch'].includes(String(c.userData.forestPart))
    ) as import('three').InstancedMesh[];
    const materials = new Map<string, { part: string; material: import('three').Material }>();
    for (const mesh of meshes) {
      const material = mesh.material as import('three').Material;
      materials.set(material.customProgramCacheKey(), { part: String(mesh.userData.forestPart), material });
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('Wind qualification requires WebGL2');
    const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map(v => v / l); };
    const dot = (a: number[], b: number[]) => a.reduce((v, x, i) => v + x * b[i]!, 0);
    const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const shaderTemplate = '#include <common>\nvoid main() {\n#include <beginnormal_vertex>\n#include <defaultnormal_vertex>\n#include <begin_vertex>\n#include <project_vertex>\nvPosition = mvPosition.xyz;\nvNormal = normalize(transformedNormal);\n}';
    const results = [];
    try {
      for (const [key, { part, material }] of materials) {
        const shader = { uniforms: {}, vertexShader: shaderTemplate, fragmentShader: '' };
        material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0], {} as import('three').WebGLRenderer);
        let src = shader.vertexShader.replaceAll('attribute ', 'in ');
        src = src.replace(/#include <(\w+)>/g, (_, name: string) => {
          const chunk = chunks[name as keyof typeof chunks];
          if (chunk === undefined) throw new Error(`Unrecognized vertex chunk: ${name}`);
          return chunk;
        });
        src = '#version 300 es\nprecision highp float;\n#define USE_INSTANCING\nin vec3 position; in vec3 normal; in mat4 instanceMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; uniform mat3 normalMatrix; out vec3 vPosition; out vec3 vNormal;\n' + src;
        const compile = (type: number, source: string) => {
          const sh = gl.createShader(type)!;
          gl.shaderSource(sh, source); gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(sh)}`);
          return sh;
        };
        const program = gl.createProgram();
        const vs = compile(gl.VERTEX_SHADER, src);
        const fs = compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 color; void main(){color=vec4(1); }');
        gl.attachShader(program, vs); gl.attachShader(program, fs);
        gl.transformFeedbackVaryings(program, ['vPosition', 'vNormal'], gl.INTERLEAVED_ATTRIBS);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(program)}`);
        gl.deleteShader(vs); gl.deleteShader(fs); gl.useProgram(program);
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const height = Number(src.match(/#define TREE_SWAY_ROOT_HEIGHT ([\d.]+)/)?.[1] || 10);
        const normal = norm([1, 0.4, 0.2]);
        const tangent = norm(cross(normal, [0, 0, 1]));
        const bitangent = norm(cross(normal, tangent));
        const point = [1, height * 0.43, 0.4];
        const epsilon = 0.02;
        const positions = new Float32Array([...point, ...point.map((p, i) => p + tangent[i]! * epsilon), ...point.map((p, i) => p + bitangent[i]! * epsilon)]);
        const input = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, input); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        const positionLoc = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(positionLoc); gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);
        const normalLoc = gl.getAttribLocation(program, 'normal');
        gl.vertexAttrib3f(normalLoc, normal[0]!, normal[1]!, normal[2]!);
        for (const [name, value] of [['aSnowLoad', 0.7], ['aSnowRatio', 0.65], ['aSwayWeight', 0.43]] as const) {
          const loc = gl.getAttribLocation(program, name); if (loc >= 0) gl.vertexAttrib1f(loc, value);
        }
        const originLoc = gl.getAttribLocation(program, 'aSwayOrigin');
        if (originLoc >= 0) gl.vertexAttrib2f(originLoc, 12, -60);
        gl.uniform2f(gl.getUniformLocation(program, 'uWindDir'), 0.8, 0.6);
        gl.uniform1f(gl.getUniformLocation(program, 'uWindAmp'), 0.9);
        gl.uniform1f(gl.getUniformLocation(program, 'uWindSwayTime'), 2.3);
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'modelViewMatrix'), false, identity);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'projectionMatrix'), false, identity);
        gl.uniformMatrix3fv(gl.getUniformLocation(program, 'normalMatrix'), false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        // Rotated, nonuniformly scaled tree: catches accidental local-space wind
        // and normal transforms that only work for identity instance matrices.
        const c = Math.cos(1.4), s = Math.sin(1.4);
        const matrix = [0.17 * c, 0, -0.17 * s, 0, 0, 0.21, 0, 0, 0.13 * s, 0, 0.13 * c, 0, 12, -1, -60, 1];
        const matrixLoc = gl.getAttribLocation(program, 'instanceMatrix');
        for (let i = 0; i < 4; i++) gl.vertexAttrib4fv(matrixLoc + i, matrix.slice(i * 4, i * 4 + 4));
        const output = gl.createBuffer();
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 72, gl.STREAM_READ);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
        gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, 3); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
        const data = new Float32Array(18); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
        const dx = [0, 1, 2].map(i => data[i + 6]! - data[i]!);
        const dy = [0, 1, 2].map(i => data[i + 12]! - data[i]!);
        const expected = norm(cross(dx, dy));
        const observed = norm(Array.from(data.slice(3, 6)));
        const unbent = norm([c * normal[0]! / 0.17 + s * normal[2]! / 0.13, normal[1]! / 0.21, -s * normal[0]! / 0.17 + c * normal[2]! / 0.13]);
        const degrees = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
        results.push({ key, part, normalErrorDegrees: degrees(observed, expected), unbentErrorDegrees: degrees(unbent, expected), finite: Array.from(data).every(Number.isFinite), glError: gl.getError() });
        gl.bindVertexArray(null); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.deleteVertexArray(vao); gl.deleteBuffer(input); gl.deleteBuffer(output); gl.deleteProgram(program);
      }
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return results;
  }, chunks);
}
