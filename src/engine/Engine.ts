import { BRUSH_PRESETS, buildBrush, type Brush } from './brushes';
import { GL, type DoubleTarget, type Format, type Program, type Rect, type Target } from './gl';
import { History } from './history';
import * as S from './shaders';
import { pigmentFromHex, type Pigment } from './spectral';

export type Tool = 'brush' | 'water' | 'pen' | 'lift';

/** All sliders are normalised 0..1. */
export interface Params {
  size: number;
  water: number;       // how much water the brush carries
  load: number;        // pigment concentration on the brush
  flow: number;        // strength of the water's motion
  bleed: number;       // diffusion of pigment through wet paper
  dry: number;         // drying speed
  edge: number;        // tide-line darkening at drying edges
  granulation: number; // pigment settling into the paper grain
}

export const DEFAULT_PARAMS: Params = {
  size: 0.5, water: 0.6, load: 0.5, flow: 0.45, bleed: 0.5, dry: 0.4, edge: 0.5, granulation: 0.45,
};

export interface EngineCallbacks {
  onHistoryChange?(canUndo: boolean): void;
  /** The active tool changed for the current stroke (pencil barrel / finger-as-water). */
  onStrokeTool?(tool: Tool | null): void;
}

interface Sample { x: number; y: number; p: number; t: number; tx: number; ty: number }

interface Stroke {
  pointerId: number;
  pointerType: string;
  tool: Tool;
  started: boolean;
  ending: boolean;
  x: number; y: number;       // smoothed position (uv)
  t: number;                  // time of last sample (ms)
  speed: number;              // doc heights / second
  simPressure: number;        // pressure stand-in for mice and fingers
  carry: number;              // distance travelled since the last stamp (doc heights)
  travelled: number;
  moved: boolean;             // received movement this frame
  dx: number; dy: number;     // smoothed direction (aspect-corrected, unit-ish)
  angle: number;              // tip angle of the last dab (radians, doc frame)
  azimuth: number | null;     // pen tilt direction, when the pen is tilted enough to tell
}

const DEG = Math.PI / 180;

interface HistoryMeta { wetAgo: number; wetPeak: number; active: Rect | null }

const HALF_FLOAT_RG: Format = { internal: WebGL2RenderingContext.RG16F, format: WebGL2RenderingContext.RG, type: WebGL2RenderingContext.HALF_FLOAT };
const HALF_FLOAT_R: Format = { internal: WebGL2RenderingContext.R16F, format: WebGL2RenderingContext.RED, type: WebGL2RenderingContext.HALF_FLOAT };
const HALF_FLOAT_RGBA: Format = { internal: WebGL2RenderingContext.RGBA16F, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.HALF_FLOAT };
const RGBA8: Format = { internal: WebGL2RenderingContext.RGBA8, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.UNSIGNED_BYTE };

const SIM_BASE = 256;          // short side of the velocity / pressure grid
const PRESSURE_ITERATIONS = 20;
const MAX_DOC_LONG = 2048;     // pigment / water grid limits (live state: ~56 bytes per texel)
const MAX_DOC_SHORT = 1536;    // (plus an undo atlas of ~52 bytes per texel)
const FIX_DURATION = 1.2;
const WET_THRESHOLD = 0.004;   // below this nothing moves, so the sim can sleep
const DESK = [0.86, 0.845, 0.815];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const union = (a: Rect | null, b: Rect): Rect =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };

export class WatercolorEngine {
  params: Params = { ...DEFAULT_PARAMS };
  tool: Tool = 'brush';
  pigment: Pigment = pigmentFromHex('#2338a8');
  brush: Brush = buildBrush(BRUSH_PRESETS[0]);
  /** Once an Apple Pencil / stylus is seen, fingers paint with clear water. */
  fingerIsWater = true;

  private tipTextures = new Map<string, WebGLTexture>();
  private lastDir: [number, number] = [1, 0];      // direction of the last stroke, for the first dab
  private lastAngle = 0;                            // tip angle shown by the hover cursor

  private g: GL;
  private gl: WebGL2RenderingContext;
  private programs: Record<string, Program>;
  private canvasSize: [number, number] = [1, 1];
  private dpr = 1;
  private view = { x: 0, y: 0, w: 1, h: 1 };   // document placement in canvas px

  // document state
  private dw = 1; private dh = 1;
  private velocity!: DoubleTarget;
  private pressure!: DoubleTarget;
  private divergence!: Target;
  private curl!: Target;
  private ink!: DoubleTarget;
  private fixed!: Target;
  private wet!: DoubleTarget;
  private paper!: Target;
  private history!: History;

  // simulation bookkeeping
  private active: Rect | null = null;          // document texels the sim must process
  private painted: Rect | null = null;         // where mobile pigment may exist (since the last fix)
  private dirty: Rect | null = null;           // document texels to redraw
  private dirtyAll = true;
  private lastWet = -Infinity;                 // ms timestamp of the last water added
  private wetPeak = 0;
  private minAwakeUntil = 0;
  private fixTimer = 0;
  private flowSpeed = 0;                       // upper bound on water speed (sim texels / s)
  private growCarry = 0;                       // fractional texels the active rect still has to grow
  private brushNow = { x: 0, y: 0, r: 0 };
  private raf = 0;
  private lastFrame = 0;

  // input
  private stroke: Stroke | null = null;
  private queue: Sample[] = [];
  private pencilSeen = false;
  private hover = { x: 0, y: 0, inside: false, type: 'mouse' };
  private force = { value: 0, t: -Infinity };
  private disposers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private cursor: HTMLElement | null, private callbacks: EngineCallbacks = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('This GPU cannot render to floating-point textures.');
    this.gl = gl;
    this.g = new GL(gl);
    gl.disable(gl.BLEND);
    this.programs = {
      splat: this.g.program(S.splatFS),
      stamp: this.g.program(S.stampFS),
      advectVelocity: this.g.program(S.advectVelocityFS),
      divergence: this.g.program(S.divergenceFS),
      pressure: this.g.program(S.pressureFS),
      gradient: this.g.program(S.gradientSubtractFS),
      curl: this.g.program(S.curlFS),
      vorticity: this.g.program(S.vorticityFS),
      scale: this.g.program(S.scaleFS),
      advectWet: this.g.program(S.advectWetFS),
      advectInk: this.g.program(S.advectInkFS),
      settle: this.g.program(S.settleFS),
      bleach: this.g.program(S.bleachFS),
      lift: this.g.program(S.liftFS),
      paper: this.g.program(S.paperFS),
      display: this.g.program(S.displayFS),
    };
    this.fitCanvas();
    this.createDocument();
    this.attachInput();
    this.schedule();
  }

  /* ------------------------------------------------------------------ setup */

  private fitCanvas() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width * this.dpr)), h = Math.max(2, Math.round(r.height * this.dpr));
    this.canvas.width = w; this.canvas.height = h;
    this.canvasSize = [w, h];
    this.fitView();
  }

  private fitView() {
    const [cw, ch] = this.canvasSize;
    const s = Math.min(cw / this.dw, ch / this.dh);
    const w = this.dw * s, h = this.dh * s;
    this.view = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    this.dirtyAll = true;
  }

  /** (Re)create the document to fill the current canvas. Discards the painting. */
  private createDocument() {
    const [cw, ch] = this.canvasSize;
    const s = Math.min(1, MAX_DOC_LONG / Math.max(cw, ch), MAX_DOC_SHORT / Math.min(cw, ch));
    this.dw = Math.round(cw * s); this.dh = Math.round(ch * s);
    const { gl, g } = this;
    g.disposeTargets();
    const ar = this.dw / this.dh;
    const sim = ar > 1 ? { w: Math.round(SIM_BASE * ar), h: SIM_BASE } : { w: SIM_BASE, h: Math.round(SIM_BASE / ar) };
    this.velocity = g.double(sim.w, sim.h, [HALF_FLOAT_RG], gl.LINEAR);
    this.pressure = g.double(sim.w, sim.h, [HALF_FLOAT_R], gl.NEAREST);
    this.divergence = g.target(sim.w, sim.h, [HALF_FLOAT_R], gl.NEAREST);
    this.curl = g.target(sim.w, sim.h, [HALF_FLOAT_R], gl.NEAREST);
    this.ink = g.double(this.dw, this.dh, [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA], gl.LINEAR);
    this.fixed = g.target(this.dw, this.dh, [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA], gl.LINEAR);
    this.wet = g.double(this.dw, this.dh, [HALF_FLOAT_R], gl.LINEAR);
    this.paper = g.target(this.dw, this.dh, [RGBA8], gl.LINEAR);
    this.history = new History(g, this.dw, this.dh, [
      { formats: [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA, HALF_FLOAT_R], documents: 2 }, // mobile pigment + water
      { formats: [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA], documents: 1 },               // fixed pigment
    ]);

    const p = this.programs.paper;
    p.bind();
    gl.uniform2f(p.u.uRes, this.dw, this.dh);
    gl.uniform1f(p.u.uSeed, Math.random() * 0.3);
    g.draw(this.paper);

    this.active = null;
    this.painted = null;
    this.lastWet = -Infinity;
    this.wetPeak = 0;
    this.fixTimer = 0;
    this.fitView();
    this.callbacks.onHistoryChange?.(false);
  }

  /* ------------------------------------------------------------- public API */

  setParams(p: Partial<Params>) { Object.assign(this.params, p); }

  setPigment(p: Pigment) { this.pigment = p; }

  setTool(t: Tool) { this.tool = t; this.updateCursor(); }

  setBrush(b: Brush) {
    this.brush = b;
    this.lastAngle = b.rotation === 'fixed' ? b.angle * DEG : b.rotation === 'follow' ? Math.atan2(this.lastDir[1], this.lastDir[0]) + b.angle * DEG : 0;
    this.updateCursor();
  }

  /** Drop the GPU copy of a brush tip (after a custom brush is removed or replaced). */
  forgetBrush(id: string) {
    const t = this.tipTextures.get(id);
    if (t) { this.gl.deleteTexture(t); this.tipTextures.delete(id); }
  }

  private tipTexture(b: Brush): WebGLTexture {
    let t = this.tipTextures.get(b.id);
    if (t) return t;
    const { gl } = this;
    t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, b.tipSize, b.tipSize, 0, gl.RED, gl.UNSIGNED_BYTE, b.tipData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tipTextures.set(b.id, t);
    return t;
  }

  /** Dry everything and bake the mobile pigment into the paper. */
  fix() {
    if (!this.painted || this.fixTimer > 0) return;
    this.beginStep();
    // the fixed layer only ever changes here, so it is only snapshotted here
    this.history.protect(1, this.painted, this.fixed.views);
    this.fixTimer = FIX_DURATION;
    // mobile pigment only exists where strokes have been, so only that needs settling
    this.touch(this.painted);
    this.schedule();
  }

  clear() {
    this.stroke = null;
    this.queue = [];
    this.createDocument();
    this.schedule();
  }

  undo() {
    if (!this.history.canUndo) return;
    this.stroke = null;
    this.queue = [];
    this.fixTimer = 0;
    this.sleep();
    const ink = this.ink, wet = this.wet;
    const res = this.history.undo([
      [[ink.read.views[0], ink.write.views[0]], [ink.read.views[1], ink.write.views[1]], [wet.read.views[0], wet.write.views[0]]],
      [[this.fixed.views[0]], [this.fixed.views[1]]],
    ]);
    if (!res) return;
    const meta = res.meta as HistoryMeta;
    const now = performance.now();
    // the restored water keeps drying from where it was when the step began
    this.lastWet = now - meta.wetAgo;
    this.wetPeak = meta.wetPeak;
    this.active = meta.active ? { ...meta.active } : null;
    if (res.rect) {
      this.dirty = union(this.dirty, res.rect);
      this.painted = union(this.painted, res.rect);
    }
    this.callbacks.onHistoryChange?.(this.history.canUndo);
    this.schedule();
  }

  get canUndo() { return this.history.canUndo; }

  /** Render the document at full resolution and return it as a PNG. */
  async exportPNG(): Promise<Blob> {
    const { gl, g, dw, dh } = this;
    const out = g.target(dw, dh, [RGBA8], gl.NEAREST);
    this.drawDisplay(out, { x: 0, y: 0, w: dw, h: dh }, null);
    const px = new Uint8Array(dw * dh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteFramebuffer(out.fbo);
    out.views.forEach(v => gl.deleteFramebuffer(v));
    gl.deleteTexture(out.tex[0]);
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(dw, dh);
    const row = dw * 4;
    for (let y = 0; y < dh; y++) img.data.set(px.subarray((dh - 1 - y) * row, (dh - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png'));
  }

  resize() {
    this.fitCanvas();
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach(d => d());
    this.tipTextures.forEach(t => this.gl.deleteTexture(t));
    this.tipTextures.clear();
    this.g.disposeTargets();
  }

  /* ------------------------------------------------------------------ input */

  private toUv(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) * this.dpr;
    const cy = this.canvasSize[1] - (e.clientY - r.top) * this.dpr;
    return [(cx - this.view.x) / this.view.w, (cy - this.view.y) / this.view.h];
  }

  private attachInput() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    on(c, 'pointerdown', e => {
      e.preventDefault();
      if (this.stroke) return;                       // one stroke at a time (palm rejection)
      if (e.pointerType === 'pen') this.pencilSeen = true;
      try { c.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      let tool = this.tool;
      if (e.pointerType === 'touch' && this.pencilSeen && this.fingerIsWater) tool = 'water';
      if (e.pointerType === 'pen' && e.buttons & 32) tool = 'lift';          // eraser end
      else if (e.pointerType === 'pen' && e.buttons & 2) tool = tool === 'water' ? 'brush' : 'water'; // barrel button
      this.stroke = {
        pointerId: e.pointerId, pointerType: e.pointerType, tool, started: false, ending: false,
        x: 0, y: 0, t: e.timeStamp, speed: 0, simPressure: 0.45, carry: 0, travelled: 0, moved: false,
        dx: this.lastDir[0], dy: this.lastDir[1], angle: this.lastAngle, azimuth: null,
      };
      if (tool !== this.tool) this.callbacks.onStrokeTool?.(tool);
      this.beginStep();
      this.pushSample(e);
      this.trackHover(e);
      this.schedule();
    });

    on(c, 'pointermove', e => {
      if (e.pointerType === 'pen') this.pencilSeen = true;
      this.trackHover(e);
      if (!this.stroke || e.pointerId !== this.stroke.pointerId) return;
      const events = e.getCoalescedEvents?.() ?? [];
      for (const s of events.length ? events : [e]) this.pushSample(s);
      this.schedule();
    });

    const end = (e: PointerEvent) => {
      if (!this.stroke || e.pointerId !== this.stroke.pointerId) return;
      this.stroke.ending = true;
      this.schedule();
    };
    on(c, 'pointerup', end);
    on(c, 'pointercancel', end);
    on(c, 'pointerleave', () => { this.hover.inside = false; this.updateCursor(); });
    on(c, 'contextmenu', e => e.preventDefault());
    on(window, 'blur', () => { if (this.stroke) this.stroke.ending = true; });

    // macOS Force Touch trackpads report pressure through a WebKit-only event
    on(c, 'webkitmouseforcechanged' as keyof HTMLElementEventMap, (e: Event) => {
      const f = (e as unknown as { webkitForce?: number }).webkitForce;
      if (typeof f === 'number') this.force = { value: clamp((f - 1) / 1.7, 0.04, 1), t: performance.now() };
    });
  }

  private pushSample(e: PointerEvent) {
    const [x, y] = this.toUv(e);
    let p = -1;
    if (e.pointerType === 'pen') p = e.pressure > 0 ? Math.pow(e.pressure, 0.8) : 0.5;
    else if (e.pointerType === 'mouse' && performance.now() - this.force.t < 3000) p = this.force.value;
    this.queue.push({ x, y, p, t: e.timeStamp, tx: e.tiltX || 0, ty: e.tiltY || 0 });
  }

  private trackHover(e: PointerEvent) {
    this.hover.x = e.clientX; this.hover.y = e.clientY;
    this.hover.inside = true; this.hover.type = e.pointerType;
    this.updateCursor();
  }

  private updateCursor() {
    const el = this.cursor;
    if (!el) return;
    if (!this.hover.inside || this.hover.type === 'touch') { el.style.opacity = '0'; return; }
    const tool = this.stroke?.tool ?? this.tool;
    const r = this.radius(tool, this.stroke ? this.pressureOf(this.stroke, -1) : 0.4, 0);
    const shaped = tool === 'brush' || tool === 'water';
    const b = this.brush;
    const d = Math.max(4, (2 * r * this.view.h) / this.dpr);
    const h = shaped ? Math.max(3, d * b.aspect) : d;
    // doc uv has y up, the screen has y down, so the angle flips
    const angle = shaped && b.rotation !== 'random' ? -(this.stroke?.angle ?? this.lastAngle) : 0;
    el.style.opacity = '1';
    el.style.width = `${d}px`;
    el.style.height = `${h}px`;
    el.style.transform = `translate(${this.hover.x - d / 2}px, ${this.hover.y - h / 2}px) rotate(${angle}rad)`;
    el.style.borderRadius = shaped && b.aspect < 0.6 ? `${h * 0.4}px / 50%` : '50%';
    el.dataset.tool = tool;
  }

  /* -------------------------------------------------------------- strokes */

  private sizeMult() { return Math.pow(3, (this.params.size - 0.5) * 2); }

  /** Footprint radius in document heights. */
  private radius(tool: Tool, pr: number, speed: number) {
    const m = this.sizeMult();
    switch (tool) {
      case 'pen': return (0.0016 + 0.0042 * pr) * clamp(1.12 - speed * 0.3, 0.55, 1.12) * m;
      case 'brush': return this.brushRadius(pr, speed);
      case 'water': return this.brushRadius(pr, speed) * 1.3 * (1 + Math.min(speed, 2.5) * 0.12);
      case 'lift': return (0.012 + 0.03 * pr) * m;
    }
  }

  /** Half the long axis of the current brush's footprint, in document heights. */
  private brushRadius(pr: number, speed: number) {
    const b = this.brush;
    const t = Math.pow(clamp(pr, 0, 1), b.pressureSize);
    // preset sizes describe the full footprint; 0.8 keeps a hard-pressed stroke on a desktop screen sane
    return (b.size[0] + (b.size[1] - b.size[0]) * t) * clamp(1 - speed * b.speedThin, 0.4, 1) * this.sizeMult() * 0.8;
  }

  /** Tip angle for the next dab, in the document frame. */
  private brushAngle(s: Stroke) {
    const b = this.brush;
    let a: number;
    if (b.rotation === 'random') a = Math.random() * Math.PI * 2;
    else if (b.rotation === 'follow') a = Math.atan2(s.dy, s.dx) + b.angle * DEG;
    else a = s.azimuth ?? b.angle * DEG;
    if (b.angleJitter) a += (Math.random() - 0.5) * 2 * b.angleJitter * DEG;
    s.angle = a;
    if (b.rotation !== 'random') this.lastAngle = a;
    return a;
  }

  private pressureOf(s: Stroke, p: number) { return p >= 0 ? p : s.simPressure; }

  private processInput(dt: number) {
    const s = this.stroke;
    if (!s) return;
    s.moved = false;
    const aspect = this.dw / this.dh;
    for (const q of this.queue) {
      // a tilted pen tells us which way it leans; a vertical one tells us nothing
      if (Math.hypot(q.tx, q.ty) > 12) s.azimuth = Math.atan2(-q.ty, q.tx);
      if (!s.started) {
        s.started = true;
        s.x = q.x; s.y = q.y; s.t = q.t;
        this.stamp(s, q.x, q.y, this.pressureOf(s, q.p), 0, 0, 1);
        continue;
      }
      const sdt = Math.max(q.t - s.t, 1) / 1000;
      s.t = q.t;
      // light smoothing; mice get a little more than styluses
      const k = s.pointerType === 'mouse' ? 0.5 : 0.65;
      const nx = s.x + (q.x - s.x) * k, ny = s.y + (q.y - s.y) * k;
      const dx = (nx - s.x) * aspect, dy = ny - s.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-5) {
        // direction smoothing scaled by distance, so a jittery stylus doesn't spin a flat brush
        const kd = 1 - Math.exp(-len / (this.radius(s.tool, this.pressureOf(s, q.p), s.speed) * 1.5 + 1e-4));
        s.dx += (dx / len - s.dx) * kd; s.dy += (dy / len - s.dy) * kd;
        const m = Math.hypot(s.dx, s.dy) || 1;
        s.dx /= m; s.dy /= m;
        this.lastDir = [s.dx, s.dy];
      }
      s.speed += (len / sdt - s.speed) * (1 - Math.exp(-sdt * 10));
      const target = clamp(1.18 - s.speed * 0.95, 0.12, 1);
      s.simPressure += (target - s.simPressure) * (1 - Math.exp(-sdt * 6));
      const pr = this.pressureOf(s, q.p);
      const vx = (nx - s.x) / sdt, vy = (ny - s.y) / sdt;
      // walk the segment, stamping every `spacing` so deposits don't depend on event rate
      const spacing = this.radius(s.tool, pr, s.speed) * this.spacingFrac(s.tool);
      let pos = 0;
      while (len - pos >= spacing - s.carry) {
        pos += spacing - s.carry;
        s.carry = 0;
        const t = pos / len;
        this.stamp(s, s.x + (nx - s.x) * t, s.y + (ny - s.y) * t, pr, vx, vy, 1);
      }
      s.carry += len - pos;
      s.travelled += len;
      if (len > 0) s.moved = true;
      s.x = nx; s.y = ny;
    }
    this.queue = [];
    // resting in place: pigment keeps soaking in, water keeps pooling
    if (!s.moved && s.started && !s.ending) this.stamp(s, s.x, s.y, this.pressureOf(s, -1), 0, 0, 0, dt);
    if (s.ending) {
      this.stroke = null;
      this.callbacks.onStrokeTool?.(null);
    }
  }

  /** Dab spacing as a fraction of the footprint radius. */
  private spacingFrac(tool: Tool) {
    const b = this.brush;
    // flat tips need tighter spacing: the footprint is thin across one axis
    return tool === 'brush' || tool === 'water' ? b.spacing * Math.sqrt(b.aspect) : 0.5;
  }

  /** One dab of the current tool. `moving` = 0 with `dt` set means a dwell. */
  private stamp(s: Stroke, x: number, y: number, pr: number, vx: number, vy: number, moving: number, dt = 0) {
    const P = this.params;
    const r = this.radius(s.tool, pr, s.speed);
    const dwell = moving ? 1 : dt * 8;
    switch (s.tool) {
      case 'brush': {
        const b = this.brush;
        // the brush empties as it travels; a dry brush skips the valleys of the paper
        const reservoir = 0.25 + 0.75 * Math.exp(-s.travelled / ((1.5 + 3 * P.water) * b.capacity));
        const dryness = clamp(b.grain + (1 - b.grain) * clamp((0.5 - reservoir) * 2.5, 0, 1) * 0.6, 0, 1);
        const grainThr = 0.74 - 0.45 * pr - 0.05 * P.water;   // pressing harder reaches into the valleys
        const conc = 0.15 * Math.exp(P.load * 2.8) * reservoir * (0.6 + 0.4 * pr) * b.load;
        // spacing / profile integral -> ~conc in the stroke, normalised for sparse tips
        const norm = clamp(Math.sqrt(0.5 / b.tipMean), 0.7, 2.2);
        const amount = conc * Math.min(b.spacing, 1) / 1.8 * norm * dwell;
        const wet = (0.25 + 0.75 * P.water) * (0.7 + 0.3 * pr) * b.water * (0.4 + 0.6 * reservoir);
        const c = this.pigment.coeffs;
        const c0 = [c[0] * amount, c[1] * amount, c[2] * amount, c[3] * amount];
        const c1 = [c[4] * amount, c[5] * amount, c[6] * amount, this.pigment.white * amount * 1.6];
        this.eachDab(s, x, y, r, (dx, dy, dr, angle) => {
          this.brushInk(dx, dy, dr, angle, c0, c1, dryness, grainThr);
          // soft brushes wet a little beyond the tip; textured ones keep their edges
          this.brushWet(dx, dy, dr * (1 + 0.12 * b.wetRound), angle, wet, b.wetRound, dryness, grainThr);
        });
        if (moving) this.splatVelocity(x, y, r * 1.2, vx, vy, (15 + P.flow * 95) * 0.25 * b.flow);
        break;
      }
      case 'water': {
        const b = this.brush;
        const reservoir = 0.25 + 0.75 * Math.exp(-s.travelled / ((3 + 4 * P.water) * b.capacity));
        const amp = (0.35 + 0.65 * P.water) * (0.5 + 0.5 * pr) * clamp(b.water, 0.6, 1.5) * (0.7 + 0.3 * reservoir);
        const dryness = b.grain * 0.7;
        const grainThr = 0.55 - 0.3 * pr;
        this.eachDab(s, x, y, r, (dx, dy, dr, angle) => {
          this.brushWet(dx, dy, dr, angle, amp, Math.max(b.wetRound, 0.3), dryness, grainThr);
        });
        this.brushNow = { x, y, r };
        if (moving) this.splatVelocity(x, y, r * 1.15, vx, vy, (15 + P.flow * 95) * b.flow);
        else {
          const a = Math.random() * Math.PI * 2, m = (6 + 26 * P.flow) * pr;
          this.splatVelocityRaw(x, y, r * 0.9, Math.cos(a) * m, Math.sin(a) * m);
        }
        break;
      }
      case 'pen': {
        const dens = (0.9 + 1.6 * pr) * clamp(1.25 - s.speed * 0.45, 0.6, 1.25) * (0.5 + P.load);
        const amount = dens * 0.5 / 1.8 * dwell;
        const c = this.pigment.coeffs;
        this.splatInk(x, y, r, [c[0] * amount, c[1] * amount, c[2] * amount, c[3] * amount],
          [c[4] * amount, c[5] * amount, c[6] * amount, this.pigment.white * amount * 3], 2);
        this.splatWet(x, y, r * 2.6, 0.13, 1);   // fresh ink is faintly wet, so it feathers a little
        break;
      }
      case 'lift': {
        const amount = Math.min(0.9, 0.22 * dwell);
        this.lift(x, y, r, amount);
        break;
      }
    }
  }

  /* --------------------------------------------------------------- splats */

  /** Run `fn` for every dab of a stamp: one for most brushes, a scattered burst for spatter. */
  private eachDab(s: Stroke, x: number, y: number, r: number, fn: (x: number, y: number, r: number, angle: number) => void) {
    const b = this.brush;
    const aspect = this.dw / this.dh;
    for (let i = 0; i < b.dabs; i++) {
      let dx = x, dy = y, dr = r;
      if (b.scatter > 0) {
        const a = Math.random() * Math.PI * 2, m = Math.sqrt(Math.random()) * b.scatter * r;
        dx += (Math.cos(a) * m) / aspect; dy += Math.sin(a) * m;
      }
      if (b.sizeJitter > 0) dr *= clamp(1 + (Math.random() * 2 - 1) * b.sizeJitter, 0.15, 2);
      fn(dx, dy, dr, this.brushAngle(s));
    }
  }

  private drawStamp(t: Target, x: number, y: number, r: number, angle: number, c0: number[], c1: number[], round: number, grain: number, grainThr: number) {
    const { gl, g } = this;
    const b = this.brush;
    const p = this.programs.stamp;
    p.bind();
    gl.uniform1i(p.u.uTip, g.bindTex(0, this.tipTexture(b)));
    gl.uniform1i(p.u.uPaper, g.bindTex(1, this.paper.tex[0]));
    gl.uniform1f(p.u.uAspect, t.w / t.h);
    gl.uniform2f(p.u.uPoint, x, y);
    gl.uniform1f(p.u.uRadius, r);
    gl.uniform1f(p.u.uTipAspect, b.aspect);
    gl.uniform2f(p.u.uAxis, Math.cos(angle), Math.sin(angle));
    gl.uniform1f(p.u.uRound, round);
    gl.uniform1f(p.u.uGrain, grain);
    gl.uniform1f(p.u.uGrainThr, grainThr);
    gl.uniform4fv(p.u.uColor0, c0);
    gl.uniform4fv(p.u.uColor1, c1);
    g.draw(t, this.stampRect(x, y, r, t.w, t.h, Math.sqrt(1 + b.aspect * b.aspect) * 1.02));
  }

  private brushInk(x: number, y: number, r: number, angle: number, c0: number[], c1: number[], grain: number, grainThr: number) {
    const { gl } = this;
    this.touch(this.stampRect(x, y, r, this.dw, this.dh, 1.5));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawStamp(this.ink.read, x, y, r, angle, c0, c1, 0, grain, grainThr);
    gl.disable(gl.BLEND);
  }

  private brushWet(x: number, y: number, r: number, angle: number, amount: number, round: number, grain: number, grainThr: number) {
    const { gl } = this;
    this.touch(this.stampRect(x, y, r, this.dw, this.dh, 1.5));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    this.drawStamp(this.wet.read, x, y, r, angle, [amount, 0, 0, 0], [0, 0, 0, 0], round, grain, grainThr);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    this.wetPeak = Math.max(this.wetPeak * this.wetDecay(), amount);
    this.lastWet = performance.now();
  }

  /** Rect (in texels of a w×h grid) covered by a stamp of radius r (doc heights). */
  private stampRect(x: number, y: number, r: number, w: number, h: number, extent: number): Rect {
    const e = Math.ceil(r * extent * h) + 2;
    const cx = Math.round(x * w), cy = Math.round(y * h);
    return { x0: clamp(cx - e, 0, w), y0: clamp(cy - e, 0, h), x1: clamp(cx + e, 0, w), y1: clamp(cy + e, 0, h) };
  }

  /** Grow the simulated region, saving tiles for undo before anything in them changes. */
  private touch(rect: Rect, wake = true) {
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
    const next = union(this.active, rect);
    this.history.protect(0, next, this.snapshotLayers());
    this.active = next;
    this.painted = union(this.painted, rect);
    this.dirty = union(this.dirty, rect);
    if (wake) this.minAwakeUntil = Math.max(this.minAwakeUntil, performance.now() + 250);
  }

  private snapshotLayers() {
    return [this.ink.read.views[0], this.ink.read.views[1], this.wet.read.views[0]];
  }

  private drawSplat(t: Target, x: number, y: number, r: number, c0: number[], c1: number[], hardness: number, extent: number) {
    const { gl, g } = this;
    const p = this.programs.splat;
    p.bind();
    gl.uniform1f(p.u.uAspect, t.w / t.h);
    gl.uniform2f(p.u.uPoint, x, y);
    gl.uniform1f(p.u.uRadius, r);
    gl.uniform1f(p.u.uHardness, hardness);
    gl.uniform4fv(p.u.uColor0, c0);
    gl.uniform4fv(p.u.uColor1, c1);
    g.draw(t, this.stampRect(x, y, r, t.w, t.h, extent));
  }

  private splatInk(x: number, y: number, r: number, c0: number[], c1: number[], hardness: number) {
    const { gl } = this;
    const extent = hardness > 1.4 ? 2.2 : 3.2;
    this.touch(this.stampRect(x, y, r, this.dw, this.dh, extent));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawSplat(this.ink.read, x, y, r, c0, c1, hardness, extent);
    gl.disable(gl.BLEND);
  }

  private splatWet(x: number, y: number, r: number, amount: number, hardness: number) {
    const { gl } = this;
    const extent = hardness > 1.4 ? 2.2 : 3.2;
    this.touch(this.stampRect(x, y, r, this.dw, this.dh, extent));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    this.drawSplat(this.wet.read, x, y, r, [amount, 0, 0, 0], [0, 0, 0, 0], hardness, extent);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    this.wetPeak = Math.max(this.wetPeak * this.wetDecay(), amount);
    this.lastWet = performance.now();
  }

  private splatVelocity(x: number, y: number, r: number, vx: number, vy: number, force: number) {
    let fx = vx * force, fy = vy * force;
    const m = Math.hypot(fx, fy), vmax = 240;
    if (m > vmax) { fx *= vmax / m; fy *= vmax / m; }
    this.flowSpeed = Math.max(this.flowSpeed, Math.min(m, vmax));
    this.splatVelocityRaw(x, y, r, fx, fy);
  }

  private splatVelocityRaw(x: number, y: number, r: number, fx: number, fy: number) {
    const { gl } = this;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawSplat(this.velocity.read, x, y, r, [fx, fy, 0, 0], [0, 0, 0, 0], 1, 3);
    gl.disable(gl.BLEND);
  }

  private lift(x: number, y: number, r: number, amount: number) {
    const { gl, g } = this;
    const rect = this.stampRect(x, y, r, this.dw, this.dh, 2);
    this.touch(rect);
    const p = this.programs.lift;
    p.bind();
    gl.uniform1f(p.u.uAspect, this.dw / this.dh);
    gl.uniform2f(p.u.uPoint, x, y);
    gl.uniform1f(p.u.uRadius, r);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
    gl.uniform1f(p.u.uAmount, amount);
    g.draw(this.ink.read, rect);
    gl.uniform1f(p.u.uAmount, amount * 0.8);   // the tissue soaks up water too
    g.draw(this.wet.read, rect);
    gl.disable(gl.BLEND);
  }

  /* ----------------------------------------------------------- simulation */

  private dryTau() { return this.fixTimer > 0 ? 0.25 : 2 + (1 - this.params.dry) * 16; }

  private wetDecay() { return Math.exp(-(performance.now() - this.lastWet) / 1000 / this.dryTau()); }

  /** Time (ms) until standing water everywhere has dried below the threshold. */
  private wetUntil() {
    if (this.wetPeak <= WET_THRESHOLD) return this.lastWet;
    return this.lastWet + this.dryTau() * Math.log(this.wetPeak / WET_THRESHOLD) * 1000;
  }

  private beginStep() {
    const now = performance.now();
    const meta: HistoryMeta = { wetAgo: now - this.lastWet, wetPeak: this.wetPeak, active: this.active ? { ...this.active } : null };
    this.history.begin(meta);
    if (this.active) this.history.protect(0, this.active, this.snapshotLayers());
    this.callbacks.onHistoryChange?.(true);
  }

  private step(dt: number) {
    const { gl, g, programs: P } = this;
    const fixing = this.fixTimer > 0;
    if (fixing) {
      this.fixTimer -= dt;
      if (this.fixTimer <= 0) {
        // everything has flash-dried: let the sim sleep so the next stroke starts
        // from a small active region (and a small undo snapshot)
        this.wetPeak = 0;
        this.minAwakeUntil = 0;
        this.painted = null;
      }
    }
    const vel = this.velocity;
    const simTexel = [1 / vel.w, 1 / vel.h];
    const texel = [1 / this.dw, 1 / this.dh];
    const flow = this.params.flow;
    const rect = this.active!;

    P.advectVelocity.bind();
    gl.uniform1i(P.advectVelocity.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform1i(P.advectVelocity.u.uWet, g.bindTex(1, this.wet.read.tex[0]));
    gl.uniform2fv(P.advectVelocity.u.uTexel, simTexel);
    gl.uniform1f(P.advectVelocity.u.uDt, dt);
    gl.uniform1f(P.advectVelocity.u.uDissipation, Math.exp(-dt * (3.0 - flow * 2.4)) * (fixing ? Math.exp(-dt * 7) : 1));
    g.draw(vel.write); vel.swap();

    P.curl.bind();
    gl.uniform1i(P.curl.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform2fv(P.curl.u.uTexel, simTexel);
    g.draw(this.curl);

    P.vorticity.bind();
    gl.uniform1i(P.vorticity.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform1i(P.vorticity.u.uCurl, g.bindTex(1, this.curl.tex[0]));
    gl.uniform2fv(P.vorticity.u.uTexel, simTexel);
    gl.uniform1f(P.vorticity.u.uCurlAmount, 4 + flow * 22);
    gl.uniform1f(P.vorticity.u.uDt, dt);
    g.draw(vel.write); vel.swap();

    P.divergence.bind();
    gl.uniform1i(P.divergence.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform2fv(P.divergence.u.uTexel, simTexel);
    g.draw(this.divergence);

    P.scale.bind();
    gl.uniform1i(P.scale.u.uTex, g.bindTex(0, this.pressure.read.tex[0]));
    gl.uniform1f(P.scale.u.uValue, 0.8);
    g.draw(this.pressure.write); this.pressure.swap();

    P.pressure.bind();
    gl.uniform1i(P.pressure.u.uDivergence, g.bindTex(1, this.divergence.tex[0]));
    gl.uniform2fv(P.pressure.u.uTexel, simTexel);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(P.pressure.u.uPressure, g.bindTex(0, this.pressure.read.tex[0]));
      g.draw(this.pressure.write); this.pressure.swap();
    }

    P.gradient.bind();
    gl.uniform1i(P.gradient.u.uPressure, g.bindTex(0, this.pressure.read.tex[0]));
    gl.uniform1i(P.gradient.u.uVelocity, g.bindTex(1, vel.read.tex[0]));
    gl.uniform2fv(P.gradient.u.uTexel, simTexel);
    g.draw(vel.write); vel.swap();

    // water: dries on a timescale set by the DRY slider (flash-dries while fixing)
    P.advectWet.bind();
    gl.uniform1i(P.advectWet.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform1i(P.advectWet.u.uWet, g.bindTex(1, this.wet.read.tex[0]));
    gl.uniform2fv(P.advectWet.u.uSimTexel, simTexel);
    gl.uniform2fv(P.advectWet.u.uTexel, texel);
    gl.uniform1f(P.advectWet.u.uDt, dt);
    gl.uniform1f(P.advectWet.u.uDecay, Math.exp(-dt / this.dryTau()));
    gl.uniform1f(P.advectWet.u.uSpread, 0.12);
    g.draw(this.wet.write, rect); this.wet.swap();

    // fixing: bleach under white gouache, then settle mobile pigment into the paper
    const settle = fixing ? 1 - Math.exp(-dt * 5) : 0;
    if (fixing) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      P.bleach.bind();
      gl.uniform1i(P.bleach.u.uInkB, g.bindTex(0, this.ink.read.tex[1]));
      gl.uniform1f(P.bleach.u.uSettle, settle);
      g.draw(this.fixed, rect);
      gl.blendFunc(gl.ONE, gl.ONE);
      P.settle.bind();
      gl.uniform1i(P.settle.u.uInkA, g.bindTex(0, this.ink.read.tex[0]));
      gl.uniform1i(P.settle.u.uInkB, g.bindTex(1, this.ink.read.tex[1]));
      gl.uniform1f(P.settle.u.uSettle, settle);
      g.draw(this.fixed, rect);
      gl.disable(gl.BLEND);
    }

    // pigment: flows, bleeds and gathers at drying edges, only where wet
    const p = P.advectInk;
    p.bind();
    gl.uniform1i(p.u.uVelocity, g.bindTex(0, vel.read.tex[0]));
    gl.uniform1i(p.u.uInkA, g.bindTex(1, this.ink.read.tex[0]));
    gl.uniform1i(p.u.uInkB, g.bindTex(2, this.ink.read.tex[1]));
    gl.uniform1i(p.u.uWet, g.bindTex(3, this.wet.read.tex[0]));
    gl.uniform2fv(p.u.uSimTexel, simTexel);
    gl.uniform2fv(p.u.uTexel, texel);
    gl.uniform1f(p.u.uDt, dt);
    gl.uniform1f(p.u.uBleed, this.params.bleed);
    gl.uniform1f(p.u.uEdge, this.params.edge * 1.4);
    gl.uniform1f(p.u.uAspect, this.dw / this.dh);
    gl.uniform1f(p.u.uKeep, 1 - settle);
    gl.uniform3f(p.u.uBrush, this.brushNow.x, this.brushNow.y, this.brushNow.r);
    g.draw(this.ink.write, rect); this.ink.swap();

    this.dirty = union(this.dirty, rect);
  }

  /** Make both halves of the ping-pong buffers identical, then stop simulating. */
  private sleep() {
    const rect = this.active;
    if (rect) {
      const { g } = this;
      const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
      for (const d of [this.ink, this.wet])
        d.read.views.forEach((v, i) => g.blit(v, rect.x0, rect.y0, d.write.views[i], rect.x0, rect.y0, w, h));
    }
    for (const d of [this.velocity, this.pressure]) { this.g.clearTarget(d.read); this.g.clearTarget(d.write); }
    this.active = null;
    this.wetPeak = 0;
    this.flowSpeed = 0;
  }

  /* -------------------------------------------------------------- display */

  private drawDisplay(target: Target | null, view: { x: number; y: number; w: number; h: number }, scissor: Rect | null) {
    const { gl, g } = this;
    const p = this.programs.display;
    p.bind();
    gl.uniform1i(p.u.uInkA, g.bindTex(0, this.ink.read.tex[0]));
    gl.uniform1i(p.u.uInkB, g.bindTex(1, this.ink.read.tex[1]));
    gl.uniform1i(p.u.uFixedA, g.bindTex(2, this.fixed.tex[0]));
    gl.uniform1i(p.u.uFixedB, g.bindTex(3, this.fixed.tex[1]));
    gl.uniform1i(p.u.uWet, g.bindTex(4, this.wet.read.tex[0]));
    gl.uniform1i(p.u.uPaper, g.bindTex(5, this.paper.tex[0]));
    gl.uniform4f(p.u.uView, view.x, view.y, view.w, view.h);
    gl.uniform2f(p.u.uTexel, 1 / this.dw, 1 / this.dh);
    gl.uniform1f(p.u.uGranulation, this.params.granulation * 0.55);
    gl.uniform1f(p.u.uEdgeDarken, 0.8);
    gl.uniform3fv(p.u.uDesk, DESK);
    g.draw(target, scissor, this.canvasSize);
  }

  private render() {
    if (!this.dirtyAll && !this.dirty) return;
    let rect: Rect | null = null;
    if (!this.dirtyAll && this.dirty) {
      const v = this.view, d = this.dirty;
      rect = {
        x0: Math.floor(v.x + (d.x0 / this.dw) * v.w) - 2, y0: Math.floor(v.y + (d.y0 / this.dh) * v.h) - 2,
        x1: Math.ceil(v.x + (d.x1 / this.dw) * v.w) + 2, y1: Math.ceil(v.y + (d.y1 / this.dh) * v.h) + 2,
      };
    }
    this.drawDisplay(null, this.view, rect);
    this.dirty = null;
    this.dirtyAll = false;
  }

  /* ------------------------------------------------------------ main loop */

  private schedule() {
    if (!this.raf) {
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = clamp((now - this.lastFrame) / 1000, 1 / 240, 1 / 30);
    this.lastFrame = now;
    this.brushNow.r = 0;

    this.processInput(dt);

    const awake = this.active !== null &&
      (this.stroke !== null || this.fixTimer > 0 || now < this.minAwakeUntil || now < this.wetUntil());
    if (awake) {
      // Grow the simulated region as fast as the wet front can move: slow diffusive
      // creep plus a share of the (decaying) flow speed
      this.flowSpeed *= Math.exp(-dt * (3.0 - this.params.flow * 2.4));
      // (velocity is masked to ~0 at the wet front, so the front itself only creeps)
      this.growCarry += 0.4 + Math.min(3, 0.15 * this.flowSpeed * dt * (this.dw / this.velocity.w));
      const grow = Math.floor(this.growCarry);
      if (grow > 0) {
        this.growCarry -= grow;
        const a = this.active!;
        this.touch({ x0: Math.max(0, a.x0 - grow), y0: Math.max(0, a.y0 - grow), x1: Math.min(this.dw, a.x1 + grow), y1: Math.min(this.dh, a.y1 + grow) }, false);
      }
      this.step(dt);
    }
    this.render();
    if (!awake && this.active) this.sleep();
    if (awake || this.stroke) this.schedule();
  };
}
