// Minimal WebGL2 plumbing: full-screen-triangle programs and (multi-)render targets.

export const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export interface Program {
  bind(): void;
  /** Uniform locations by name (missing/optimised-out uniforms are null). */
  u: Record<string, WebGLUniformLocation | null>;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface Format { internal: number; format: number; type: number }

/** A framebuffer with one or more colour attachments of identical size. */
export interface Target {
  w: number;
  h: number;
  fbo: WebGLFramebuffer;
  tex: WebGLTexture[];
  /** Single-attachment framebuffers per texture, used as blit sources/destinations. */
  views: WebGLFramebuffer[];
}

export interface DoubleTarget {
  w: number;
  h: number;
  readonly read: Target;
  readonly write: Target;
  swap(): void;
}

export class GL {
  readonly gl: WebGL2RenderingContext;
  private vs: WebGLShader;
  private resources: (() => void)[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vs = this.compile(gl.VERTEX_SHADER, QUAD_VS);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private compile(type: number, src: string): WebGLShader {
    const { gl } = this;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
      throw new Error(`${gl.getShaderInfoLog(s)}\n${numbered}`);
    }
    return s;
  }

  program(fs: string): Program {
    const { gl } = this;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.vs);
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { u, bind: () => gl.useProgram(p) };
  }

  target(w: number, h: number, formats: Format[], filter: number): Target {
    const { gl } = this;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const tex: WebGLTexture[] = [];
    const views: WebGLFramebuffer[] = [];
    formats.forEach((f, i) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, f.internal, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      tex.push(t);
    });
    gl.drawBuffers(formats.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
    for (const t of tex) {
      const v = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, v);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      views.push(v);
    }
    const target = { w, h, fbo, tex, views };
    this.clearTarget(target);
    this.resources.push(() => {
      gl.deleteFramebuffer(fbo);
      views.forEach(v => gl.deleteFramebuffer(v));
      tex.forEach(t => gl.deleteTexture(t));
    });
    return target;
  }

  double(w: number, h: number, formats: Format[], filter: number): DoubleTarget {
    let a = this.target(w, h, formats, filter);
    let b = this.target(w, h, formats, filter);
    return {
      w, h,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
    };
  }

  clearTarget(t: Target, rect?: Rect) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    if (rect) this.scissor(rect);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  scissor(r: Rect) {
    const { gl } = this;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x0, r.y0, Math.max(0, r.x1 - r.x0), Math.max(0, r.y1 - r.y0));
  }

  /** Draw the full-screen triangle into `target` (or the canvas), optionally scissored. */
  draw(target: Target | null, rect?: Rect | null, canvasSize?: [number, number]) {
    const { gl } = this;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasSize![0], canvasSize![1]);
    }
    if (rect) this.scissor(rect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (rect) gl.disable(gl.SCISSOR_TEST);
  }

  /** Upload a CPU image as a texture. The caller owns it (it is not freed by disposeTargets). */
  texture(w: number, h: number, f: Format, data: ArrayBufferView | null, filter: number): WebGLTexture {
    const { gl } = this;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, f.type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  bindTex(unit: number, tex: WebGLTexture): number {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    return unit;
  }

  /** Copy a rectangle between single-texture framebuffers (same format). */
  blit(src: WebGLFramebuffer, sx: number, sy: number, dst: WebGLFramebuffer, dx: number, dy: number, w: number, h: number) {
    const { gl } = this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(sx, sy, sx + w, sy + h, dx, dy, dx + w, dy + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** Free every target created so far (used on document re-creation). */
  disposeTargets() {
    this.resources.forEach(f => f());
    this.resources = [];
  }
}
