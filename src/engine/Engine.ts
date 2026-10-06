import { BRUSH_PRESETS, buildBrush, type Brush } from './brushes';
import { GL, type DoubleTarget, type Format, type Program, type Rect, type Target } from './gl';
import { History, type StepInfo, type StepKind } from './history';
import { DEFAULT_PAPER, linearRGB, PAPERS, type PaperPreset } from './papers';
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
  /** The undo history changed: every step (oldest first) and how many of them are applied. */
  onHistoryChange?(steps: StepInfo[], index: number): void;
  /** Paper or reference state changed from inside the engine (undo, redo, a project opened). */
  onDocumentChange?(state: DocState): void;
  /** The active tool changed for the current stroke (pencil barrel / finger-as-water). */
  onStrokeTool?(tool: Tool | null): void;
  /** The view was zoomed or panned (`zoom` 1 = one document texel per CSS pixel). */
  onViewChange?(zoom: number, docSize: [number, number]): void;
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';
export type ExportBackground = 'transparent' | 'paper' | 'white';
/** `texture` false exports the paper (or white) as a flat sheet; true uses the on-screen texture strength. */
export interface ExportOptions { format: ExportFormat; background: ExportBackground; quality?: number; texture?: boolean }

/** Placement of the reference image in document uv (y up): origin and size. */
export interface RefRect { x: number; y: number; w: number; h: number }

export type LayerId = 'inkA' | 'inkB' | 'fixedA' | 'fixedB' | 'wet';

/**
 * The paint layers as half floats (RGBA for ink and fixed, one channel for wet), cropped
 * to `rect`, the texel rect holding everything ever painted (null: a blank sheet).
 */
export interface WholeDoc { w: number; h: number; rect: Rect | null; layers: Record<LayerId, Uint16Array> }

/** Document-level state that undo tracks besides the paint. */
export interface DocState {
  paperId: string;
  paperStrength: number;
  reference: { image: HTMLCanvasElement | null; rect: RefRect; opacity: number; visible: boolean };
}

/** Everything needed to bring a painting back exactly as it is. */
export interface DocumentSnapshot {
  whole: WholeDoc;
  paper: { id: string; seed: number; origin: [number, number]; scale: number; strength: number };
  wet: { wetAgo: number; wetPeak: number; active: Rect | null; painted: Rect | null };
  reference: DocState['reference'];
  view: { zoom: number; pan: [number, number]; fitted: boolean };
}

/** How the display shader composites: on screen (with the reference) or for an export. */
const MODE = { screen: 0, paper: 1, transparent: 2, white: 3 } as const;
const MAX_REF_SIDE = 4096;

interface Sample { x: number; y: number; p: number; t: number; tx: number; ty: number }

interface Stroke {
  pointerId: number;
  pointerType: string;
  tool: Tool;
  started: boolean;
  ending: boolean;
  x: number; y: number;       // where the drawn stroke currently ends (uv)
  cx: number; cy: number;     // latest smoothed sample: the curve's control point, drawn up to on the next sample
  pr: number;                 // pressure at (x, y), so pressure ramps along each curve
  t: number;                 // time of last sample (ms)
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
const SCRIPT_POINTER = -1;

interface StepMeta {
  wetAgo: number; wetPeak: number; active: Rect | null; painted: Rect | null;
  doc: DocState;
  /** Boundary (resize) steps: the whole sheet as it was, and where its paper sat. */
  whole?: WholeDoc; paperOrigin?: [number, number];
}
const STROKE_LABEL: Record<Tool, string> = { brush: 'Brush stroke', water: 'Water', pen: 'Pen', lift: 'Lift' };

const HALF_FLOAT_RG: Format = { internal: WebGL2RenderingContext.RG16F, format: WebGL2RenderingContext.RG, type: WebGL2RenderingContext.HALF_FLOAT };
const HALF_FLOAT_R: Format = { internal: WebGL2RenderingContext.R16F, format: WebGL2RenderingContext.RED, type: WebGL2RenderingContext.HALF_FLOAT };
const HALF_FLOAT_RGBA: Format = { internal: WebGL2RenderingContext.RGBA16F, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.HALF_FLOAT };
const RGBA8: Format = { internal: WebGL2RenderingContext.RGBA8, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.UNSIGNED_BYTE };
const FLOAT_RG: Format = { internal: WebGL2RenderingContext.RG32F, format: WebGL2RenderingContext.RG, type: WebGL2RenderingContext.FLOAT };
const FILL_WATER_LEAD = 10;    // px the water runs ahead of the pigment in a bucket fill
const FILL_WIDTH = 24;         // px over which a bucket fill's front ramps up
const FILL_JITTER = 3;         // px the paper grain roughens a bucket fill's front

const SIM_BASE = 256;          // short side of the velocity / pressure grid
const PRESSURE_ITERATIONS = 20;
const SCREEN_DOC_LONG = 2048;   // a "screen" sheet follows the window, within these limits
const SCREEN_DOC_SHORT = 1536;
const MAX_DOC_LONG = 3072;     // pigment / water grid limits (live state: ~56 bytes per texel)
const MAX_DOC_PIXELS = 4_200_000;   // (plus an undo atlas of ~52 bytes per texel)
export const MIN_DOC_SIDE = 256;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
const FIT_PADDING = 24;        // CSS px around the sheet when zoomed to fit
const PAN_KEEP = 48;           // CSS px of the sheet that always stays on screen
const FIX_DURATION = 1.2;
const WET_THRESHOLD = 0.004;   // below this nothing moves, so the sim can sleep
const MASK_BLOCK = 16;         // texels per wet-mask cell
const MASK_EVERY = 10;         // frames between wet-mask readbacks that trim the active rect
const MASK_MARGIN = MASK_BLOCK + 8;
const PROTECT_MARGIN = 24;     // texels around a dab / fill band saved for undo, where its water and pigment spread to
const DESK = [1, 1, 1];      // the table the sheet lies on (sRGB)
const PAPER_UNITS = 1100;      // paper features are drawn for a sheet this many texels tall

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A sheet size within the memory limits: the same shape, scaled down if too big. */
export function clampDocSize(w: number, h: number, maxSide = MAX_DOC_LONG): [number, number] {
  w = Math.max(MIN_DOC_SIDE, Math.round(w) || MIN_DOC_SIDE);
  h = Math.max(MIN_DOC_SIDE, Math.round(h) || MIN_DOC_SIDE);
  const s = Math.min(1, Math.min(MAX_DOC_LONG, maxSide) / Math.max(w, h), Math.sqrt(MAX_DOC_PIXELS / (w * h)));
  return [Math.max(MIN_DOC_SIDE, Math.round(w * s)), Math.max(MIN_DOC_SIDE, Math.round(h * s))];
}

const union = (a: Rect | null, b: Rect): Rect =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };

export class WatercolorEngine {
  params: Params = { ...DEFAULT_PARAMS };
  tool: Tool = 'brush';
  pigment: Pigment = pigmentFromHex('#2338a8');
  brush: Brush = buildBrush(BRUSH_PRESETS[0]);
  /** Once an Apple Pencil / stylus is seen, fingers paint with clear water. */
  fingerIsWater = true;
  /** When false, pointers on the paper are ignored (another tool, e.g. text, is driving it). */
  interactive = true;
  private nav = false;

  private tipTextures = new Map<string, WebGLTexture>();
  private paperPreset: PaperPreset = DEFAULT_PAPER;
  private paperSeed = 0;
  private paperStrength = 1;
  private paperScale = 1;                           // paper units per texel, fixed when the sheet is made
  private paperOrigin: [number, number] = [0, 0];   // where the sheet sits in the paper's field (texels)
  // reference image: shown under the paint on screen only, never exported
  private ref: { tex: WebGLTexture; aspect: number; src: HTMLCanvasElement } | null = null;
  private refRect: RefRect = { x: 0, y: 0, w: 1, h: 1 };
  private refOpacity = 0.5;
  private refVisible = true;
  private lastDir: [number, number] = [1, 0];      // direction of the last stroke, for the first dab
  private lastAngle = 0;                            // tip angle shown by the hover cursor

  private g: GL;
  private gl: WebGL2RenderingContext;
  private programs: Record<string, Program>;
  private canvasSize: [number, number] = [1, 1];
  private dpr = 1;
  private view = { x: 0, y: 0, w: 1, h: 1 };   // document placement in canvas px
  private zoomLevel = 1;                        // 1 = one document texel per CSS px
  private pan: [number, number] = [0, 0];       // sheet centre from canvas centre (canvas px, y up)
  private fitMode = true;                       // keep the sheet fitted as the window changes

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
  private wetMask!: Target;                    // coarse "is there water here" map, read back to bound the sim
  private maskPixels = new Uint8Array(0);
  private maskCounter = 0;
  private history!: History;

  // simulation bookkeeping
  private active: Rect | null = null;          // document texels the sim must process
  private painted: Rect | null = null;         // where mobile pigment may exist (since the last fix)
  private everPainted: Rect | null = null;     // where any pigment, mobile or fixed, may exist
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
  private seenEvictions = 0;           // history.evictions as of the last onHistoryChange

  // input
  private stroke: Stroke | null = null;
  private fill: { tex: WebGLTexture; bbox: Rect } | null = null;   // a paint-bucket wash in progress
  private queue: Sample[] = [];
  private pencilSeen = false;
  private hover = { x: 0, y: 0, inside: false, type: 'mouse' };
  private force = { value: 0, t: -Infinity };
  private disposers: (() => void)[] = [];

  /** `size` is the sheet in texels; omitted, the sheet follows the window ("screen"). */
  constructor(private canvas: HTMLCanvasElement, private cursor: HTMLElement | null, private callbacks: EngineCallbacks = {}, size?: [number, number] | null) {
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
      fill: this.g.program(S.fillFS),
      advectVelocity: this.g.program(S.advectVelocityFS),
      divergence: this.g.program(S.divergenceFS),
      pressure: this.g.program(S.pressureFS),
      gradient: this.g.program(S.gradientSubtractFS),
      curl: this.g.program(S.curlFS),
      vorticity: this.g.program(S.vorticityFS),
      scale: this.g.program(S.scaleFS),
      advectWet: this.g.program(S.advectWetFS),
      wetMask: this.g.program(S.wetMaskFS),
      advectInk: this.g.program(S.advectInkFS),
      settle: this.g.program(S.settleFS),
      bleach: this.g.program(S.bleachFS),
      lift: this.g.program(S.liftFS),
      paperField: this.g.program(S.paperFieldFS),
      paperLight: this.g.program(S.paperLightFS),
      paperSwatch: this.g.program(S.paperSwatchFS),
      display: this.g.program(S.displayFS),
    };
    this.fitCanvas();
    this.createDocument(size ?? this.screenSize);
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
    if (this.fitMode) this.fitZoom(); else this.updateView();
  }

  /** The zoom that shows the whole sheet with a margin. */
  private fitZoom() {
    const [cw, ch] = this.canvasSize;
    const pad = 2 * FIT_PADDING * this.dpr;
    const z = Math.min((cw - pad) / this.dw, (ch - pad) / this.dh) / this.dpr;
    this.zoomLevel = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this.pan = [0, 0];
    this.fitMode = true;
    this.updateView();
  }

  /** Place the sheet from zoom and pan; everything that maps pointers goes through `view`. */
  private updateView() {
    const [cw, ch] = this.canvasSize;
    const s = this.zoomLevel * this.dpr, w = this.dw * s, h = this.dh * s;
    // keep a strip of the sheet on screen so it can't be lost off the edge
    const keep = PAN_KEEP * this.dpr;
    const mx = Math.max(0, (cw + w) / 2 - keep), my = Math.max(0, (ch + h) / 2 - keep);
    this.pan = [clamp(this.pan[0], -mx, mx), clamp(this.pan[1], -my, my)];
    this.view = { x: (cw - w) / 2 + this.pan[0], y: (ch - h) / 2 + this.pan[1], w, h };
    this.dirtyAll = true;
    this.updateCursor();
    this.callbacks.onViewChange?.(this.zoomLevel, [this.dw, this.dh]);
  }

  /** A sheet the shape of the window, in device pixels, within the "screen" limits. */
  get screenSize(): [number, number] {
    const [cw, ch] = this.canvasSize;
    const s = Math.min(1, SCREEN_DOC_LONG / Math.max(cw, ch), SCREEN_DOC_SHORT / Math.min(cw, ch));
    return clampDocSize(cw * s, ch * s, this.maxSide);
  }

  /** The longest sheet side this GPU allows. */
  get maxSide() { return Math.min(MAX_DOC_LONG, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number); }

  /** Allocate every document-sized target for a `dw`×`dh` sheet (the old ones are the caller's to free). */
  private allocateTargets() {
    const { gl, g } = this;
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
    this.wetMask = g.target(Math.ceil(this.dw / MASK_BLOCK), Math.ceil(this.dh / MASK_BLOCK), [RGBA8], gl.NEAREST);
    this.maskPixels = new Uint8Array(this.wetMask.w * this.wetMask.h * 4);
  }

  private allocateHistory() {
    this.history = new History(this.g, this.dw, this.dh, [
      { formats: [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA, HALF_FLOAT_R], documents: 2 }, // mobile pigment + water
      { formats: [HALF_FLOAT_RGBA, HALF_FLOAT_RGBA], documents: 1 },               // fixed pigment
    ]);
  }

  /** The targets that hold the sheet (not the sim grids, not the history atlases). */
  private docTargets(): Target[] {
    return [this.velocity.read, this.velocity.write, this.pressure.read, this.pressure.write, this.divergence, this.curl,
      this.ink.read, this.ink.write, this.fixed, this.wet.read, this.wet.write, this.paper, this.wetMask];
  }

  /** (Re)create a blank `w`×`h` sheet. Discards the painting. */
  private createDocument([w, h]: [number, number]) {
    const oldAspect = this.aspect;
    [this.dw, this.dh] = clampDocSize(w, h, this.maxSide);
    // a reference placed on paper of another shape would be stretched; fit it afresh
    if (this.ref && Math.abs(this.aspect - oldAspect) > 1e-3) this.fitReference();
    this.g.disposeTargets();
    this.allocateTargets();
    this.allocateHistory();

    this.paperSeed = Math.random();
    this.paperScale = PAPER_UNITS / this.dh;
    this.paperOrigin = [0, 0];
    this.drawPaper(this.paper, this.paperOrigin, this.paperScale);

    this.resetPaintState();
    if (this.fitMode) this.fitZoom(); else this.updateView();
    this.notifyHistory();
  }

  private resetPaintState() {
    this.active = null;
    this.painted = null;
    this.everPainted = null;
    this.dirty = null;
    this.dirtyAll = true;
    this.lastWet = -Infinity;
    this.wetPeak = 0;
    this.fixTimer = 0;
    this.flowSpeed = 0;
  }

  /**
   * Change the sheet to `w`×`h` texels, keeping the painting at its size and centred:
   * a bigger sheet adds blank paper around it, a smaller one crops it. The paper grain
   * stays registered under the paint. The change is one undo step; the steps before it
   * are forgotten (their undo tiles belong to the old sheet).
   */
  resizeDocument(w: number, h: number) {
    [w, h] = clampDocSize(w, h, this.maxSide);
    const ow = this.dw, oh = this.dh;
    if (w === ow && h === oh) return;
    this.stroke = null;
    this.dropFill();
    this.queue = [];
    const { g } = this;
    const ox = Math.round((w - ow) / 2), oy = Math.round((h - oh) / 2);
    const meta: StepMeta = { ...this.currentMeta(), whole: this.captureWhole(), paperOrigin: [...this.paperOrigin] };
    const old = { targets: this.docTargets(), ink: this.ink.read, fixed: this.fixed, wet: this.wet.read };
    this.dw = w; this.dh = h;
    this.allocateTargets();
    this.history.beginBoundary({ kind: 'resize', label: `Resize ${w} × ${h}` }, meta, w, h);

    // the overlap of the old sheet (shifted by ox, oy) and the new one
    const sx = Math.max(0, -ox), sy = Math.max(0, -oy), dx = Math.max(0, ox), dy = Math.max(0, oy);
    const cw = Math.min(ow - sx, w - dx), ch = Math.min(oh - sy, h - dy);
    const copy = (src: Target, dsts: Target[]) => {
      if (cw > 0 && ch > 0) src.views.forEach((v, i) => dsts.forEach(d => g.blit(v, sx, sy, d.views[i], dx, dy, cw, ch)));
    };
    copy(old.ink, [this.ink.read, this.ink.write]);
    copy(old.wet, [this.wet.read, this.wet.write]);
    copy(old.fixed, [this.fixed]);
    old.targets.forEach(t => g.disposeTarget(t));

    this.paperOrigin = [this.paperOrigin[0] - ox, this.paperOrigin[1] - oy];
    this.drawPaper(this.paper, this.paperOrigin, this.paperScale);

    const shift = (r: Rect | null): Rect | null => {
      if (!r) return null;
      const n = { x0: Math.max(0, r.x0 + ox), y0: Math.max(0, r.y0 + oy), x1: Math.min(w, r.x1 + ox), y1: Math.min(h, r.y1 + oy) };
      return n.x1 > n.x0 && n.y1 > n.y0 ? n : null;
    };
    this.active = shift(this.active);
    this.painted = shift(this.painted);
    this.everPainted = shift(this.everPainted);
    this.dirty = null;
    const rr = this.refRect;
    this.refRect = { x: (rr.x * ow + ox) / w, y: (rr.y * oh + oy) / h, w: (rr.w * ow) / w, h: (rr.h * oh) / h };

    if (this.fitMode) this.fitZoom(); else this.updateView();
    this.notifyHistory();
    this.callbacks.onDocumentChange?.(this.docState());
    this.schedule();
  }

  /* ------------------------------------------------- whole-document state */

  /** The paint layers, cropped to where anything was ever painted. */
  private captureWhole(): WholeDoc {
    const r = this.everPainted;
    const { g, dw, dh } = this;
    const read = (fb: WebGLFramebuffer, ch: 1 | 4) => (r ? g.readHalf(fb, dw, dh, ch, r) : new Uint16Array(0));
    return {
      w: dw, h: dh, rect: r ? { ...r } : null,
      layers: {
        inkA: read(this.ink.read.views[0], 4), inkB: read(this.ink.read.views[1], 4),
        fixedA: read(this.fixed.views[0], 4), fixedB: read(this.fixed.views[1], 4),
        wet: read(this.wet.read.views[0], 1),
      },
    };
  }

  /** Put `whole`'s layers into the (blank) current targets; both halves of the ping-pong pairs. */
  private uploadWhole(whole: WholeDoc) {
    const r = whole.rect;
    if (!r) return;
    const { gl, g } = this;
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const up = (tex: WebGLTexture, format: number, data: Uint16Array) => g.uploadHalf(tex, r.x0, r.y0, w, h, format, data);
    for (const t of [this.ink.read, this.ink.write]) { up(t.tex[0], gl.RGBA, whole.layers.inkA); up(t.tex[1], gl.RGBA, whole.layers.inkB); }
    up(this.fixed.tex[0], gl.RGBA, whole.layers.fixedA);
    up(this.fixed.tex[1], gl.RGBA, whole.layers.fixedB);
    for (const t of [this.wet.read, this.wet.write]) up(t.tex[0], gl.RED, whole.layers.wet);
    this.everPainted = { ...r };
  }

  /** Replace the sheet with `whole` (another size, usually), keeping the history atlases. */
  private applyWhole(whole: WholeDoc, paperOrigin: [number, number]) {
    const old = this.docTargets();
    this.dw = whole.w; this.dh = whole.h;
    this.allocateTargets();
    old.forEach(t => this.g.disposeTarget(t));
    this.history.resize(this.dw, this.dh);
    this.paperOrigin = [...paperOrigin];
    this.drawPaper(this.paper, this.paperOrigin, this.paperScale);
    this.everPainted = null;
    this.uploadWhole(whole);
    this.dirty = null;
    this.dirtyAll = true;
    if (this.fitMode) this.fitZoom(); else this.updateView();
  }

  private docState(): DocState {
    return {
      paperId: this.paperPreset.id,
      paperStrength: this.paperStrength,
      reference: { image: this.ref?.src ?? null, rect: { ...this.refRect }, opacity: this.refOpacity, visible: this.refVisible },
    };
  }

  /** Paper and reference state as undo tracks it. */
  get documentState(): DocState { return this.docState(); }

  /** Bring paper / reference state back (after undo, redo or a project opened). */
  private applyDocState(d: DocState) {
    const preset = PAPERS.find(p => p.id === d.paperId);
    if (preset && preset !== this.paperPreset) { this.paperPreset = preset; this.drawPaper(this.paper, this.paperOrigin, this.paperScale); }
    this.paperStrength = clamp(d.paperStrength, 0, 1);
    const r = d.reference;
    if (r.image !== (this.ref?.src ?? null)) this.uploadReference(r.image);
    this.refRect = { ...r.rect };
    this.refOpacity = r.opacity;
    this.refVisible = r.visible;
    this.dirtyAll = true;
  }

  /**
   * Record a document-level change that has already been applied (paper, reference) as
   * one undo step; `before` is the state to come back to.
   */
  recordChange(kind: StepKind, label: string, before: DocState) {
    this.dropFill();
    this.history.begin({ kind, label }, { ...this.currentMeta(), doc: before } satisfies StepMeta);
    this.notifyHistory();
  }

  /** The painting as it is now, ready to be saved. */
  snapshot(): DocumentSnapshot {
    const m = this.currentMeta();
    return {
      whole: this.captureWhole(),
      paper: { id: this.paperPreset.id, seed: this.paperSeed, origin: [...this.paperOrigin], scale: this.paperScale, strength: this.paperStrength },
      wet: { wetAgo: m.wetAgo, wetPeak: m.wetPeak, active: m.active, painted: m.painted },
      reference: m.doc.reference,
      view: { zoom: this.zoomLevel, pan: [...this.pan], fitted: this.fitMode },
    };
  }

  /** Replace the painting with a saved one. History starts afresh. */
  restore(s: DocumentSnapshot) {
    const [w, h] = clampDocSize(s.whole.w, s.whole.h, this.maxSide);
    if (w !== s.whole.w || h !== s.whole.h) throw new Error(`This sheet (${s.whole.w} × ${s.whole.h}) is too large for this GPU.`);
    this.stroke = null;
    this.dropFill();
    this.queue = [];
    if (this.ref) { this.gl.deleteTexture(this.ref.tex); this.ref = null; }
    this.g.disposeTargets();
    this.dw = w; this.dh = h;
    this.allocateTargets();
    this.allocateHistory();
    this.resetPaintState();

    this.paperPreset = PAPERS.find(p => p.id === s.paper.id) ?? DEFAULT_PAPER;
    this.paperSeed = s.paper.seed;
    this.paperScale = s.paper.scale || PAPER_UNITS / this.dh;
    this.paperOrigin = [...s.paper.origin];
    this.paperStrength = clamp(s.paper.strength, 0, 1);
    this.drawPaper(this.paper, this.paperOrigin, this.paperScale);

    this.uploadWhole(s.whole);
    const now = performance.now();
    this.lastWet = Number.isFinite(s.wet.wetAgo) ? now - s.wet.wetAgo : -Infinity;
    this.wetPeak = s.wet.wetPeak;
    this.active = s.wet.active ? { ...s.wet.active } : null;
    this.painted = s.wet.painted ? { ...s.wet.painted } : null;
    if (this.active) this.minAwakeUntil = now + 250;

    this.uploadReference(s.reference.image);
    this.refRect = { ...s.reference.rect };
    this.refOpacity = clamp(s.reference.opacity, 0, 1);
    this.refVisible = s.reference.visible;

    this.zoomLevel = clamp(s.view.zoom, MIN_ZOOM, MAX_ZOOM);
    this.pan = [...s.view.pan];
    this.fitMode = s.view.fitted;
    if (this.fitMode) this.fitZoom(); else this.updateView();
    this.notifyHistory();
    this.callbacks.onDocumentChange?.(this.docState());
    this.schedule();
  }

  /* ---------------------------------------------------------------- view */

  /** Current zoom: 1 shows one document texel per CSS pixel. */
  get zoom() { return this.zoomLevel; }

  /** True while the sheet is fitted to the window (it stays fitted as the window changes). */
  get fitted() { return this.fitMode; }

  /** While navigating (e.g. Space held) pointers on the paper pan instead of paint. */
  get navigating() { return this.nav; }
  set navigating(v: boolean) { this.nav = v; this.updateCursor(); }

  /** Zoom by `factor` keeping the document point under (clientX, clientY) in place. */
  zoomAt(clientX: number, clientY: number, factor: number) {
    const r = this.canvas.getBoundingClientRect();
    const [cw, ch] = this.canvasSize;
    const z = clamp(this.zoomLevel * factor, MIN_ZOOM, MAX_ZOOM);
    const k = z / this.zoomLevel;
    if (k === 1) return;
    const px = (clientX - r.left) * this.dpr, py = ch - (clientY - r.top) * this.dpr;
    // the sheet centre moves away from the fixed point by the zoom ratio
    const cx = cw / 2 + this.pan[0], cy = ch / 2 + this.pan[1];
    this.pan = [px - (px - cx) * k - cw / 2, py - (py - cy) * k - ch / 2];
    this.zoomLevel = z;
    this.fitMode = false;
    this.updateView();
    this.schedule();
  }

  /** Zoom to `z` about the middle of the window. */
  zoomTo(z: number) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, z / this.zoomLevel);
  }

  /** Show the whole sheet. */
  zoomToFit() { this.fitZoom(); this.schedule(); }

  /** Move the sheet by (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.pan = [this.pan[0] + dx * this.dpr, this.pan[1] - dy * this.dpr];
    this.fitMode = false;
    this.updateView();
    this.schedule();
  }

  /* ------------------------------------------------------------- public API */

  setParams(p: Partial<Params>) { Object.assign(this.params, p); }

  /** Document width / height. Document uv has y up; x spans `aspect` heights. */
  get aspect() { return this.dw / this.dh; }

  /** Client (CSS px) -> document uv. */
  clientToDoc(clientX: number, clientY: number): [number, number] { return this.toUv({ clientX, clientY }); }

  /** Document uv -> client (CSS px). */
  docToClient(x: number, y: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [r.left + (this.view.x + x * this.view.w) / this.dpr, r.top + (this.canvasSize[1] - this.view.y - y * this.view.h) / this.dpr];
  }

  /** Document size in texels. */
  get docSize(): [number, number] { return [this.dw, this.dh]; }

  /* ------------------------------------------------- paint-bucket fills (fill) */

  /** Is a bucket fill in progress? */
  get filling() { return this.fill !== null; }

  /** How far (px) past the farthest field distance a fill must run so its roughened front covers everything. */
  get fillMargin() { return FILL_WIDTH + FILL_JITTER + 1; }

  /**
   * The document as a flat image: pigment on plain paper with no relief, grain, edge
   * darkening or wet tint, so areas of one colour read as one colour. RGBA8, row 0 is
   * document y = 0 (uv is y-up, so no flip is needed to index it by texel).
   */
  readFlat(): Uint8Array { return this.readback(true); }

  /**
   * Start a bucket fill: `field` is RG per document texel (distance from the tap in
   * px, -1 outside the area; distance to the area's edge), `bbox` the half-open texel
   * rect around it. Opens one undo step for the whole wash. False while a stroke is
   * still on the paper.
   */
  fillBegin(field: Float32Array, bbox: Rect, label = 'Fill'): boolean {
    if (this.stroke) return false;
    if (field.length !== this.dw * this.dh * 2) throw new Error('fill field does not match the document');
    this.beginStep('fill', label);   // also drops any previous fill
    const tex = this.g.texture(this.dw, this.dh, FLOAT_RG, field, this.gl.NEAREST);
    this.fill = { tex, bbox: { ...bbox } };
    return true;
  }

  /**
   * Deposit the band `from < distance <= to` of the current fill: pigment (if `paint`)
   * and water, feathered over `soft` px at the area's edge. False once the fill is
   * gone (undo, clear, another action), in which case the caller should stop.
   */
  fillStep(from: number, to: number, o: { strength: number; water: number; soft: number; paint: boolean }): boolean {
    const f = this.fill;
    if (!f) return false;
    const { gl, g } = this;
    const P = this.params;
    this.touch(f.bbox);
    const p = this.programs.fill;
    p.bind();
    gl.uniform1i(p.u.uField, g.bindTex(0, f.tex));
    gl.uniform1i(p.u.uPaper, g.bindTex(1, this.paper.tex[0]));
    gl.uniform1f(p.u.uSoft, Math.max(0, o.soft));
    gl.uniform1f(p.u.uGrainThr, 0.5);
    gl.uniform1f(p.u.uJitter, FILL_JITTER);
    gl.uniform1f(p.u.uWidth, FILL_WIDTH);
    gl.enable(gl.BLEND);
    if (o.paint) {
      // a steady stroke's density (brush case of stamp(), full reservoir, medium pressure)
      const conc = 0.15 * Math.exp(P.load * 2.8) * 0.84;
      const amount = conc * o.strength;
      const c = this.pigment.coeffs;
      gl.uniform1i(p.u.uCumulative, 0);
      gl.uniform1f(p.u.uFrom, from);
      gl.uniform1f(p.u.uTo, to);
      gl.uniform1f(p.u.uGrain, 0.12);
      gl.uniform4f(p.u.uColor0, c[0] * amount, c[1] * amount, c[2] * amount, c[3] * amount);
      gl.uniform4f(p.u.uColor1, c[4] * amount, c[5] * amount, c[6] * amount, this.pigment.white * amount * 1.6);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      g.draw(this.ink.read, f.bbox);
    }
    // the water runs a little ahead of the pigment, as a real wash does
    const wetAmt = (0.25 + 0.75 * o.water) * 0.9;
    gl.uniform1i(p.u.uCumulative, 1);
    gl.uniform1f(p.u.uTo, to + FILL_WATER_LEAD);
    gl.uniform1f(p.u.uGrain, 0);
    gl.uniform4f(p.u.uColor0, wetAmt, 0, 0, 0);
    gl.uniform4f(p.u.uColor1, 0, 0, 0, 0);
    gl.blendEquation(gl.MAX);
    g.draw(this.wet.read, f.bbox);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    this.wetPeak = Math.max(this.wetPeak * this.wetDecay(), wetAmt);
    this.lastWet = performance.now();
    this.schedule();
    return true;
  }

  /** Finish (or stop) the current fill; what has been laid down stays. */
  fillEnd() { this.dropFill(); }

  private dropFill() {
    if (!this.fill) return;
    this.gl.deleteTexture(this.fill.tex);
    this.fill = null;
  }

  /* -------------------------------------------------- scripted strokes (text) */

  /** Is a code-driven stroke in progress? */
  get scripting() { return this.stroke?.pointerId === SCRIPT_POINTER; }

  /**
   * Start a stroke driven by code rather than a pointer; it runs through the same
   * pipeline (spacing, speed thinning, dwell, undo). Returns false while another
   * stroke is still on the paper. A string `step` opens an undo step with that label;
   * pass false to group several strokes (the letters of a word) into one.
   */
  scriptBegin(tool: Tool, x: number, y: number, pressure: number, step: string | false = 'Stroke'): boolean {
    if (this.stroke) return false;
    if (step !== false) this.beginStep('script', step);
    this.stroke = {
      pointerId: SCRIPT_POINTER, pointerType: 'pen', tool, started: false, ending: false,
      x: 0, y: 0, cx: 0, cy: 0, pr: 0, t: performance.now(), speed: 0, simPressure: 0.45, carry: 0, travelled: 0, moved: false,
      dx: this.lastDir[0], dy: this.lastDir[1], angle: this.lastAngle, azimuth: null,
    };
    this.queue.push({ x, y, p: clamp(pressure, 0.02, 1), t: performance.now(), tx: 0, ty: 0 });
    this.schedule();
    return true;
  }

  /** Feed the scripted stroke a sample; `t` is a performance.now() timestamp. False once the stroke is gone (undo, clear). */
  scriptMove(x: number, y: number, pressure: number, t: number): boolean {
    if (!this.scripting) return false;
    this.queue.push({ x, y, p: clamp(pressure, 0.02, 1), t, tx: 0, ty: 0 });
    this.schedule();
    return true;
  }

  scriptEnd() {
    if (!this.scripting) return;
    this.stroke!.ending = true;
    this.schedule();
  }

  setPigment(p: Pigment) { this.pigment = p; }

  /* ------------------------------------------------------------------ paper */

  get paperId() { return this.paperPreset.id; }

  /** How strongly the sheet's relief, fibres and flecks show (0: a flat tint, 1: full), on screen and in textured exports. */
  get paperTexture() { return this.paperStrength; }
  set paperTexture(v: number) {
    v = clamp(v, 0, 1);
    if (v === this.paperStrength) return;
    this.paperStrength = v;
    this.redraw();
  }

  /**
   * Swap the sheet under the painting. Only the paper changes: the paint stays, and
   * granulation and dry brush follow the new tooth from here on.
   */
  setPaper(p: PaperPreset) {
    if (p === this.paperPreset) return;
    this.paperPreset = p;
    this.drawPaper(this.paper, this.paperOrigin, this.paperScale);
    this.redraw();
  }

  /**
   * A preview of a paper at the scale it appears on screen: `w`×`h` device pixels of
   * the sheet with a granulating wash across one corner, as an sRGB canvas.
   */
  paperSwatch(p: PaperPreset, w: number, h: number): HTMLCanvasElement {
    const { gl, g } = this;
    const paper = g.target(w, h, [RGBA8], gl.LINEAR);
    const out = g.target(w, h, [RGBA8], gl.NEAREST);
    // one canvas pixel shows dh / view.h document texels
    this.drawPaper(paper, [w * 0.7, h * 1.3], this.paperScale * (this.dh / this.view.h), p);
    const s = this.programs.paperSwatch;
    s.bind();
    gl.uniform1i(s.u.uPaper, g.bindTex(0, paper.tex[0]));
    this.paperUniforms(s, p, 1);
    g.draw(out);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    g.disposeTarget(paper);
    g.disposeTarget(out);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Generate a paper into `t`: `offset` places it on the sheet (texels), `scale` is paper units per texel. */
  private drawPaper(t: Target, offset: [number, number], scale: number, preset = this.paperPreset) {
    const { gl, g } = this;
    const field = g.target(t.w, t.h, [HALF_FLOAT_RGBA], gl.NEAREST);
    const f = this.programs.paperField;
    f.bind();
    gl.uniform2f(f.u.uRes, t.w, t.h);
    gl.uniform2f(f.u.uOffset, offset[0], offset[1]);
    gl.uniform1f(f.u.uScale, scale);
    gl.uniform1f(f.u.uSeed, this.paperSeed);
    gl.uniform1i(f.u.uKind, preset.kind);
    g.draw(field);
    const l = this.programs.paperLight;
    l.bind();
    gl.uniform1i(l.u.uField, g.bindTex(0, field.tex[0]));
    gl.uniform2f(l.u.uTexel, 1 / t.w, 1 / t.h);
    // the relief is drawn in paper units, so its slope per texel shrinks as texels get smaller
    gl.uniform1f(l.u.uBump, (preset.bump * 1.4) / scale);
    g.draw(t);
    g.disposeTarget(field);
  }

  private paperUniforms(p: Program, preset: PaperPreset, texture: number) {
    const { gl } = this;
    gl.uniform3fv(p.u.uPaperTint, linearRGB(preset.tint));
    gl.uniform3fv(p.u.uFleckTint, linearRGB(preset.fleck));
    gl.uniform1f(p.u.uMottle, preset.mottle);
    gl.uniform1f(p.u.uTexture, texture);
  }

  setTool(t: Tool) { this.tool = t; this.updateCursor(); }

  setBrush(b: Brush) {
    this.brush = b;
    this.lastAngle = b.rotation === 'fixed' ? b.angle * DEG : b.rotation === 'follow' ? Math.atan2(this.lastDir[1], this.lastDir[0]) + b.angle * DEG : 0;
    this.updateCursor();
  }

  /* ------------------------------------------------------- reference image */

  get hasReference() { return this.ref !== null; }

  /** Width / height of the reference image, or 0 without one. */
  get referenceAspect() { return this.ref?.aspect ?? 0; }

  /**
   * Show `img` under the paint (or remove it with null), fitted to the paper, as one
   * undo step. It survives clearing the paper and is never part of an export.
   */
  setReference(img: ImageBitmap | HTMLCanvasElement | null) {
    const before = this.docState();
    let src: HTMLCanvasElement | null = null;
    if (img) {
      const max = Math.min(MAX_REF_SIDE, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number);
      // kept on the CPU as well, so the Fill tool can find areas on it (see readReferenceFlat)
      const s = Math.min(1, max / Math.max(img.width, img.height));
      src = document.createElement('canvas');
      src.width = Math.max(1, Math.round(img.width * s)); src.height = Math.max(1, Math.round(img.height * s));
      src.getContext('2d')!.drawImage(img, 0, 0, src.width, src.height);
    }
    this.uploadReference(src);
    if (src) this.fitReference();
    this.recordChange('reference', src ? 'Reference added' : 'Reference removed', before);
    this.redraw();
  }

  /** The reference image as the engine keeps it (downscaled), or null. */
  referenceImage(): HTMLCanvasElement | null { return this.ref?.src ?? null; }

  /** Put `src` on the GPU as the reference (or drop it with null); placement is left alone. */
  private uploadReference(src: HTMLCanvasElement | null) {
    const { gl } = this;
    if (this.ref?.src === src) return;
    if (this.ref) { gl.deleteTexture(this.ref.tex); this.ref = null; }
    if (!src) return;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.ref = { tex, aspect: src.width / src.height, src };
  }

  /** The reference placed as large as fits, centred on the paper. */
  fitReference() {
    if (!this.ref) return;
    const k = this.ref.aspect / this.aspect;   // the image's width / height in uv units
    const w = k > 1 ? 1 : k, h = k > 1 ? 1 / k : 1;
    this.referenceRect = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  /**
   * The reference as placed on the paper, at document resolution, over plain white
   * (where it does not cover the paper, and through any transparency). Same layout as
   * readFlat: RGBA8, opaque, row 0 is document y = 0. Null without a reference.
   */
  readReferenceFlat(): Uint8Array | null {
    if (!this.ref) return null;
    const { dw, dh } = this, r = this.refRect;
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dw, dh);
    // canvas rows run top-down, document uv runs bottom-up
    ctx.drawImage(this.ref.src, r.x * dw, (1 - r.y - r.h) * dh, r.w * dw, r.h * dh);
    const top = ctx.getImageData(0, 0, dw, dh).data;
    const out = new Uint8Array(dw * dh * 4), row = dw * 4;
    for (let y = 0; y < dh; y++) out.set(top.subarray((dh - 1 - y) * row, (dh - y) * row), y * row);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }

  get referenceRect(): RefRect { return { ...this.refRect }; }
  set referenceRect(r: RefRect) {
    const c = this.refRect;
    if (r.x === c.x && r.y === c.y && r.w === c.w && r.h === c.h) return;
    this.refRect = { ...r };
    this.redraw();
  }

  get referenceOpacity() { return this.refOpacity; }
  set referenceOpacity(v: number) {
    v = clamp(v, 0, 1);
    if (v === this.refOpacity) return;
    this.refOpacity = v;
    this.redraw();
  }

  /** Does the Fill tool find its areas on the reference (traced) rather than on the paint? */
  referenceForFill = false;

  get referenceVisible() { return this.refVisible; }
  set referenceVisible(v: boolean) { if (v !== this.refVisible) { this.refVisible = v; this.redraw(); } }

  private redraw() { this.dirtyAll = true; this.schedule(); }

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
    this.beginStep('dry', 'Dry');
    // the fixed layer only ever changes here, so it is only snapshotted here
    this.history.protect(1, this.painted, this.fixed.views);
    this.fixTimer = FIX_DURATION;
    // mobile pigment only exists where strokes have been, so only that needs settling
    this.touch(this.painted);
    this.schedule();
  }

  /** Wipe the paint as one undo step. The sheet (and its grain) stays. */
  clear() {
    this.stroke = null;
    this.queue = [];
    if (!this.everPainted && !this.fill) return;   // already blank
    this.beginStep('clear', 'Clear');
    if (this.everPainted) {
      this.history.protect(0, this.everPainted, this.snapshotLayers());
      this.history.protect(1, this.everPainted, this.fixed.views);
    }
    for (const t of this.docTargets()) if (t !== this.paper) this.g.clearTarget(t);
    this.resetPaintState();
    this.notifyHistory();
    this.schedule();
  }

  /** Take back the stroke in progress as if it never happened (a touch that became a pinch). */
  abortStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    this.queue = [];
    if (s.pointerId !== SCRIPT_POINTER) this.callbacks.onStrokeTool?.(null);
    if (this.history.canUndo) { this.travel('undo'); this.history.discardRedo(); this.notifyHistory(); }
  }

  undo() { if (this.history.canUndo) this.travel('undo'); }

  redo() { if (this.history.canRedo) this.travel('redo'); }

  /** Undo or redo until `index` steps are applied. */
  jumpTo(index: number) {
    const { index: now, list } = this.history.entries();
    index = clamp(Math.round(index), 0, list.length);
    for (let i = now; i > index && this.history.canUndo; i--) this.travel('undo', false);
    for (let i = now; i < index && this.history.canRedo; i++) this.travel('redo', false);
    this.notifyHistory();
  }

  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }

  /** Step through history in either direction. */
  private travel(dir: 'undo' | 'redo', notify = true) {
    this.stroke = null;
    this.dropFill();
    this.queue = [];
    this.fixTimer = 0;
    const next = dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    const metaNow: StepMeta = this.currentMeta();
    if (next?.boundary) { metaNow.whole = this.captureWhole(); metaNow.paperOrigin = [...this.paperOrigin]; }
    this.sleep();
    const ink = this.ink, wet = this.wet;
    const layers = [
      [[ink.read.views[0], ink.write.views[0]], [ink.read.views[1], ink.write.views[1]], [wet.read.views[0], wet.write.views[0]]],
      [[this.fixed.views[0]], [this.fixed.views[1]]],
    ];
    const res = dir === 'undo' ? this.history.undo(layers, metaNow) : this.history.redo(layers, metaNow);
    if (!res) return;
    const meta = res.meta as StepMeta;
    const now = performance.now();
    if (meta.whole) {
      this.applyWhole(meta.whole, meta.paperOrigin ?? [0, 0]);
      this.painted = meta.painted ? { ...meta.painted } : null;
    }
    if (res.info.kind !== 'paper' && res.info.kind !== 'reference') {
      // the restored water keeps drying from where it was when the step began
      this.lastWet = now - meta.wetAgo;
      this.wetPeak = meta.wetPeak;
      this.active = meta.active ? { ...meta.active } : null;
    }
    if (res.rect) {
      this.dirty = union(this.dirty, res.rect);
      this.painted = union(this.painted, res.rect);
      this.everPainted = union(this.everPainted, res.rect);
    }
    this.applyDocState(meta.doc);
    this.callbacks.onDocumentChange?.(this.docState());
    if (notify) this.notifyHistory();
    this.schedule();
  }

  private notifyHistory() {
    this.seenEvictions = this.history.evictions;
    const { list, index } = this.history.entries();
    this.callbacks.onHistoryChange?.(list, index);
  }

  private currentMeta(): StepMeta {
    return {
      wetAgo: performance.now() - this.lastWet, wetPeak: this.wetPeak,
      active: this.active ? { ...this.active } : null, painted: this.painted ? { ...this.painted } : null,
      doc: this.docState(),
    };
  }

  /**
   * Render the document at full resolution as an image file. The reference image is
   * never included. JPEG has no alpha, so a transparent JPEG is put on white.
   */
  async exportImage(o: ExportOptions): Promise<Blob> {
    const { dw, dh } = this;
    const bg = o.format === 'jpeg' && o.background === 'transparent' ? 'white' : o.background;
    const px = this.readback(false, MODE[bg], o.texture ?? true);
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(dw, dh);
    const row = dw * 4;
    for (let y = 0; y < dh; y++) img.data.set(px.subarray((dh - 1 - y) * row, (dh - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    const type = `image/${o.format}`;
    return new Promise((resolve, reject) => c.toBlob(b => {
      if (!b) reject(new Error('export failed'));
      else if (b.type !== type) reject(new Error(`This browser cannot save ${o.format.toUpperCase()}`));
      else resolve(b);
    }, type, o.quality));
  }

  /** The composited document at full resolution as RGBA8 bytes, bottom row first. */
  private readback(flat: boolean, mode: number = MODE.paper, texture = true): Uint8Array {
    const { gl, g, dw, dh } = this;
    const out = g.target(dw, dh, [RGBA8], gl.NEAREST);
    this.drawDisplay(out, { x: 0, y: 0, w: dw, h: dh }, null, flat, mode, texture);
    const px = new Uint8Array(dw * dh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    g.disposeTarget(out);
    return px;
  }

  resize() {
    this.fitCanvas();
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.dropFill();
    this.disposers.forEach(d => d());
    this.tipTextures.forEach(t => this.gl.deleteTexture(t));
    this.tipTextures.clear();
    if (this.ref) this.gl.deleteTexture(this.ref.tex);
    this.ref = null;
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
      if (!this.interactive || this.nav || e.button === 1) return;
      if (this.stroke) return;                       // one stroke at a time (palm rejection)
      if (e.pointerType === 'pen') this.pencilSeen = true;
      try { c.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      let tool = this.tool;
      if (e.pointerType === 'touch' && this.pencilSeen && this.fingerIsWater) tool = 'water';
      if (e.pointerType === 'pen' && e.buttons & 32) tool = 'lift';          // eraser end
      else if (e.pointerType === 'pen' && e.buttons & 2) tool = tool === 'water' ? 'brush' : 'water'; // barrel button
      this.stroke = {
        pointerId: e.pointerId, pointerType: e.pointerType, tool, started: false, ending: false,
        x: 0, y: 0, cx: 0, cy: 0, pr: 0, t: e.timeStamp, speed: 0, simPressure: 0.45, carry: 0, travelled: 0, moved: false,
        dx: this.lastDir[0], dy: this.lastDir[1], angle: this.lastAngle, azimuth: null,
      };
      if (tool !== this.tool) this.callbacks.onStrokeTool?.(tool);
      this.beginStep('stroke', STROKE_LABEL[tool]);
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
    if (!this.hover.inside || this.hover.type === 'touch' || !this.interactive || this.nav) { el.style.opacity = '0'; return; }
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
        s.x = s.cx = q.x; s.y = s.cy = q.y; s.t = q.t;
        s.pr = this.pressureOf(s, q.p);
        this.stamp(s, q.x, q.y, s.pr, 0, 0, 1);
        continue;
      }
      const sdt = Math.max(q.t - s.t, 1) / 1000;
      s.t = q.t;
      // light smoothing; mice get a little more than styluses
      const k = s.pointerType === 'mouse' ? 0.5 : 0.65;
      const nx = s.cx + (q.x - s.cx) * k, ny = s.cy + (q.y - s.cy) * k;
      const len = Math.hypot((nx - s.cx) * aspect, ny - s.cy);
      s.speed += (len / sdt - s.speed) * (1 - Math.exp(-sdt * 10));
      const target = clamp(1.18 - s.speed * 0.95, 0.12, 1);
      s.simPressure += (target - s.simPressure) * (1 - Math.exp(-sdt * 6));
      const pr = this.pressureOf(s, q.p);
      const vx = (nx - s.cx) / sdt, vy = (ny - s.cy) / sdt;
      if (s.pointerId === SCRIPT_POINTER) {
        // scripted glyphs keep their corners
        this.trace(s, nx, ny, nx, ny, pr, vx, vy);
      } else {
        // a fast mouse reports sparse samples (~8ms apart, often 50px+); curving through
        // their midpoints keeps the stroke round instead of a visible polyline
        this.trace(s, s.cx, s.cy, (s.cx + nx) / 2, (s.cy + ny) / 2, pr, vx, vy);
      }
      s.cx = nx; s.cy = ny;
      if (len > 0) s.moved = true;
    }
    this.queue = [];
    // the curve trails half a sample behind; catch up once the pointer rests or lifts
    if (s.started && (!s.moved || s.ending) && (s.x !== s.cx || s.y !== s.cy)) this.trace(s, s.cx, s.cy, s.cx, s.cy, s.pr, 0, 0);
    // resting in place: pigment keeps soaking in, water keeps pooling
    if (!s.moved && s.started && !s.ending) this.stamp(s, s.x, s.y, this.pressureOf(s, -1), 0, 0, 0, dt);
    if (s.ending) {
      this.stroke = null;
      if (s.pointerId !== SCRIPT_POINTER) this.callbacks.onStrokeTool?.(null);
    }
  }

  /**
   * Lay dabs along the quadratic from the stroke's end (s.x, s.y) through control (qx, qy)
   * to (ex, ey), every `spacing` of arc length so deposits don't depend on event rate.
   * Pressure ramps from s.pr to `pr`; direction follows the curve's tangent.
   */
  private trace(s: Stroke, qx: number, qy: number, ex: number, ey: number, pr: number, vx: number, vy: number) {
    const aspect = this.dw / this.dh;
    const x0 = s.x, y0 = s.y, pr0 = s.pr;
    const approx = Math.hypot((qx - x0) * aspect, qy - y0) + Math.hypot((ex - qx) * aspect, ey - qy);
    if (approx < 1e-7) return;
    const fine = this.radius(s.tool, Math.max(pr0, pr), s.speed) * this.spacingFrac(s.tool);
    const n = clamp(Math.ceil(approx / Math.max(fine, 1e-5)), 1, 48);
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const u = i / n, w = 1 - u;
      const cx = w * w * x0 + 2 * w * u * qx + u * u * ex;
      const cy = w * w * y0 + 2 * w * u * qy + u * u * ey;
      const dx = (cx - px) * aspect, dy = cy - py;
      const len = Math.hypot(dx, dy);
      const p = pr0 + (pr - pr0) * u;
      if (len > 1e-5) {
        // direction smoothing scaled by distance, so a jittery stylus doesn't spin a flat brush
        const kd = 1 - Math.exp(-len / (this.radius(s.tool, p, s.speed) * 1.5 + 1e-4));
        s.dx += (dx / len - s.dx) * kd; s.dy += (dy / len - s.dy) * kd;
        const m = Math.hypot(s.dx, s.dy) || 1;
        s.dx /= m; s.dy /= m;
        this.lastDir = [s.dx, s.dy];
      }
      const spacing = this.radius(s.tool, p, s.speed) * this.spacingFrac(s.tool);
      let pos = 0;
      while (len - pos >= spacing - s.carry) {
        pos += spacing - s.carry;
        s.carry = 0;
        const t = pos / len;
        this.stamp(s, px + (cx - px) * t, py + (cy - py) * t, p, vx, vy, 1);
      }
      s.carry += len - pos;
      s.travelled += len;
      px = cx; py = cy;
    }
    s.x = ex; s.y = ey; s.pr = pr;
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

  /**
   * Grow the simulated region. With `save`, the tiles around `rect` are saved for undo
   * first: a step restores what its own dabs and fills touched (plus a margin for what
   * spread from them), while the rest of the sheet simply keeps drying. That keeps a
   * step's cost proportional to the stroke, not to everything that happens to be wet.
   */
  private touch(rect: Rect, wake = true, save = true) {
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
    const next = union(this.active, rect);
    if (save) {
      const m = PROTECT_MARGIN;
      this.history.protect(0, { x0: Math.max(0, rect.x0 - m), y0: Math.max(0, rect.y0 - m), x1: Math.min(this.dw, rect.x1 + m), y1: Math.min(this.dh, rect.y1 + m) }, this.snapshotLayers());
    }
    this.active = next;
    this.painted = union(this.painted, rect);
    this.everPainted = union(this.everPainted, rect);
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

  private beginStep(kind: StepKind, label: string) {
    this.dropFill();   // a new action ends a running fill; its remaining bands never land in this step
    this.history.begin({ kind, label }, this.currentMeta());
    this.notifyHistory();
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

  /**
   * The active rect grows blindly each frame so the wet front can creep; left alone it
   * would cover the sheet in a minute, and every undo step would have to save all of
   * it. Now and then, find where there is actually water and cut the rect down to that.
   */
  private trimActive() {
    const a = this.active;
    if (!a) return;
    const { gl, g } = this;
    const m = this.wetMask;
    const p = this.programs.wetMask;
    p.bind();
    gl.uniform1i(p.u.uWet, g.bindTex(0, this.wet.read.tex[0]));
    gl.uniform2f(p.u.uBlock, 1 / m.w, 1 / m.h);
    gl.uniform1f(p.u.uThreshold, WET_THRESHOLD);
    g.draw(m);
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
    gl.readPixels(0, 0, m.w, m.h, gl.RGBA, gl.UNSIGNED_BYTE, this.maskPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
    const px = this.maskPixels;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!px[(y * m.w + x) * 4]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    let next: Rect | null = null;
    if (x1 >= 0) {
      const wet = {
        x0: Math.max(0, x0 * MASK_BLOCK - MASK_MARGIN), y0: Math.max(0, y0 * MASK_BLOCK - MASK_MARGIN),
        x1: Math.min(this.dw, (x1 + 1) * MASK_BLOCK + MASK_MARGIN), y1: Math.min(this.dh, (y1 + 1) * MASK_BLOCK + MASK_MARGIN),
      };
      const r = { x0: Math.max(a.x0, wet.x0), y0: Math.max(a.y0, wet.y0), x1: Math.min(a.x1, wet.x1), y1: Math.min(a.y1, wet.y1) };
      if (r.x1 > r.x0 && r.y1 > r.y0) next = r;
    }
    if (next && next.x0 === a.x0 && next.y0 === a.y0 && next.x1 === a.x1 && next.y1 === a.y1) return;
    // the part being dropped was updated into alternating halves: make them agree before it is left alone
    const w = a.x1 - a.x0, h = a.y1 - a.y0;
    for (const d of [this.ink, this.wet])
      d.read.views.forEach((v, i) => g.blit(v, a.x0, a.y0, d.write.views[i], a.x0, a.y0, w, h));
    if (next) this.active = next; else this.sleep();
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

  private drawDisplay(target: Target | null, view: { x: number; y: number; w: number; h: number }, scissor: Rect | null, flat = false, mode: number = MODE.screen, texture = true) {
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
    gl.uniform1f(p.u.uFlat, flat ? 1 : 0);
    gl.uniform3fv(p.u.uDesk, DESK);
    gl.uniform1i(p.u.uMode, mode);
    this.paperUniforms(p, this.paperPreset, texture ? this.paperStrength : 0);
    const ref = mode === MODE.screen && !flat && this.refVisible ? this.ref : null;
    gl.uniform1f(p.u.uRefOpacity, ref ? this.refOpacity : 0);
    // the sampler needs a texture bound either way; the paper stands in when there is none
    gl.uniform1i(p.u.uRef, g.bindTex(6, ref ? ref.tex : this.paper.tex[0]));
    const r = this.refRect;
    gl.uniform4f(p.u.uRefRect, r.x, r.y, r.w, r.h);
    // the shadow grows with the sheet on screen, within a range that always reads as paper on a desk
    const shadow = mode === MODE.screen && !target ? clamp(Math.min(view.w, view.h) / this.dpr * 0.05, 14, 48) * this.dpr : 0;
    gl.uniform1f(p.u.uShadow, shadow);
    gl.uniform1f(p.u.uDpr, this.dpr);
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
        this.touch({ x0: Math.max(0, a.x0 - grow), y0: Math.max(0, a.y0 - grow), x1: Math.min(this.dw, a.x1 + grow), y1: Math.min(this.dh, a.y1 + grow) }, false, false);
      }
      this.step(dt);
      if (this.fixTimer <= 0 && ++this.maskCounter >= MASK_EVERY) { this.maskCounter = 0; this.trimActive(); }
    }
    this.render();
    // a stroke that ran the undo memory dry dropped old steps: the list should say so
    if (this.history.evictions !== this.seenEvictions) this.notifyHistory();
    if (!awake && this.active) this.sleep();
    if (awake || this.stroke) this.schedule();
  };
}
