import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type { Tool, WatercolorEngine } from '../engine/Engine';
import type { PanelTool, PaperGesture } from '../app/tools';
import { persisted } from '../app/persisted';
import { resizeTick, viewTick } from '../app/resize';
import { showToast } from '../app/toast';
import { hideGhost, setGhost } from '../draw/ghost';
import { penSpeed, StrokeWriter } from '../draw/StrokeWriter';
import { constrain, fitSvg, SHAPES, shapeStrokes, type ShapeKind } from './shapes';
import { importSvg, type ImportedSvg } from './svgImport';

// The Shape tool: pick a shape, drag a box on the paper (a dashed ghost follows),
// and on release the StrokeWriter draws the outline slowly with the current brush.

export interface ShapeSettings {
  kind: ShapeKind;
  tool: Tool;
  lock: boolean;      // keep squares square / circles round / lines on 45° steps
  speed: number;      // 0..1 slider
  pressure: number;   // 0.05..1
  taper: number;      // 0..1
  wobble: number;     // 0..1
  sides: number;      // 3..12
  inner: number;      // 0.2..0.9
  rotation: number;   // 0..360
}

const KEY = 'watercolor.shape';
const DEFAULTS: ShapeSettings = {
  kind: 'rect', tool: 'brush', lock: false,
  speed: 0.5, pressure: 0.6, taper: 0.4, wobble: 0.2, sides: 5, inner: 0.45, rotation: 0,
};

type Pt = [number, number];
interface Drag { id: number; a: Pt; b: Pt; shift: boolean }

export class ShapeStore implements PanelTool {
  readonly id = 'shape';
  // the imported file lives for the session only, so a saved `svg` kind starts as the default
  readonly settings = persisted<ShapeSettings>(KEY, DEFAULTS,
    s => (SHAPES.some(k => k.id === s.kind) && s.kind !== 'svg' ? s : { ...s, kind: DEFAULTS.kind }));
  readonly active = signal(false);
  readonly svg = signal<ImportedSvg | null>(null);
  readonly drawing = signal(false);
  readonly progress = signal<[number, number] | null>(null);
  readonly drag = signal<Drag | null>(null);
  /** Bumped when the panel should open its SVG file picker. */
  readonly pickRequest = signal(0);
  readonly busy: ReadonlySignal<boolean> = this.drawing;
  readonly status = computed(() => {
    const s = this.settings.value, svg = this.svg.value;
    if (this.drawing.value) { const p = this.progress.value; return p && p[1] > 1 ? `Drawing… ${p[0]} / ${p[1]} strokes` : 'Drawing…'; }
    if (this.drag.value) return 'Let go to draw';
    if (!this.active.value) return '';
    if (s.kind === 'svg') return svg ? `Drag on the paper to place ${svg.name}` : 'Choose an SVG file, or drop one on the paper';
    return `Drag on the paper to draw a ${SHAPES.find(k => k.id === s.kind)!.label.toLowerCase()}`;
  });

  private writer: StrokeWriter;

  constructor(private engine: WatercolorEngine) {
    this.writer = new StrokeWriter(engine);
    effect(() => this.renderGhost());
  }

  set(p: Partial<ShapeSettings>) { this.settings.value = { ...this.settings.value, ...p }; }

  /** Shape parameters including the imported file. */
  private params() { return { ...this.settings.peek(), svg: this.svg.peek() }; }

  /** The drag end, constrained if the lock (or Shift) is on. */
  private endPoint(d: Drag): Pt {
    const s = this.settings.peek(), svg = this.svg.peek();
    const boxAspect = s.kind === 'svg' && svg ? svg.aspect : 1;
    return s.lock !== d.shift ? constrain(s.kind, d.a, d.b, this.engine.aspect, boxAspect) : d.b;
  }

  /** Strokes for the ghost: the thinned copy for SVGs, the real thing otherwise. */
  private ghostStrokes(a: Pt, b: Pt, aspect: number) {
    const s = this.settings.value, svg = this.svg.value;
    if (s.kind !== 'svg') return shapeStrokes(s.kind, a, b, this.params(), aspect);
    return svg ? fitSvg(svg.ghost, (b[0] - a[0]) * aspect, b[1] - a[1], s.rotation) : [];
  }

  private renderGhost() {
    resizeTick.value; viewTick.value;
    const drag = this.drag.value;
    if (!this.active.value || !drag || this.drawing.value) { hideGhost(); return; }
    const a = this.engine.aspect;
    const [ax, ay] = drag.a;
    let d = '';
    for (const pl of this.ghostStrokes(drag.a, this.endPoint(drag), a)) {
      pl.forEach(([x, y], i) => {
        const [cx, cy] = this.engine.docToClient(ax + x / a, ay + y);
        d += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`;
      });
    }
    setGhost(d);
  }

  private draw(d: Drag) {
    const s = this.settings.peek();
    const b = this.endPoint(d);
    const aspect = this.engine.aspect;
    const w = Math.abs(b[0] - d.a[0]) * aspect, h = Math.abs(b[1] - d.a[1]);
    const strokes = shapeStrokes(s.kind, d.a, b, this.params(), aspect);
    if (!strokes.length) return;
    const ref = s.kind === 'line' || s.kind === 'arrow' ? Math.hypot(w, h) * 0.5 : Math.max(0.01, Math.min(w, h));
    this.drawing.value = true;
    this.progress.value = [0, strokes.length];
    this.writer.write(strokes, d.a, {
      tool: s.tool, ref, speed: penSpeed(s.speed), pressure: s.pressure, taper: s.taper, wobble: s.wobble,
      label: s.kind === 'svg' ? `SVG: ${this.svg.peek()?.name ?? 'shape'}` : `Shape: ${SHAPES.find(k => k.id === s.kind)!.label}`,
    }, {
      onProgress: (done, total) => { this.progress.value = [done, total]; },
      onDone: () => { this.drawing.value = false; this.progress.value = null; },
    });
  }

  /** Load an SVG file as the `svg` shape. Resolves false (after a toast) if it could not be read. */
  async loadSvg(file: File): Promise<boolean> {
    try {
      this.svg.value = await importSvg(file);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read that SVG');
      return false;
    }
    this.set({ kind: 'svg' });
    return true;
  }

  private cancelDrag(canvas?: Element) {
    const d = this.drag.peek();
    if (!d) return false;
    try { canvas?.releasePointerCapture(d.id); } catch { /* already released */ }
    this.drag.value = null;
    return true;
  }

  readonly gesture: PaperGesture = {
    down: (e, uv) => {
      if (this.drag.peek()) return;
      if (this.drawing.peek()) { showToast('Still drawing… press Stop or Esc'); return; }
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      this.drag.value = { id: e.pointerId, a: uv, b: uv, shift: e.shiftKey };
    },
    move: (e, uv) => {
      const d = this.drag.peek();
      if (!d || e.pointerId !== d.id) return;
      this.drag.value = { ...d, b: uv, shift: e.shiftKey };
    },
    up: (e, uv) => {
      const d = this.drag.peek();
      if (!d || e.pointerId !== d.id) return;
      const done = { ...d, b: uv, shift: e.shiftKey };
      this.cancelDrag(e.currentTarget as Element);
      const [x0, y0] = this.engine.docToClient(...done.a), [x1, y1] = this.engine.docToClient(...done.b);
      if (this.settings.peek().kind === 'svg' && !this.svg.peek()) { this.pickRequest.value++; return; }
      if (Math.hypot(x1 - x0, y1 - y0) < 6) { showToast('Drag to size the shape'); return; }
      this.draw(done);
    },
    cancel: e => { const d = this.drag.peek(); if (d && e.pointerId === d.id) this.cancelDrag(e.currentTarget as Element); },
  };

  activate() { this.active.value = true; }

  deactivate() {
    this.active.value = false;
    this.cancelDrag();
    this.writer.cancel();
  }

  stop() {
    if (this.cancelDrag()) return true;
    if (!this.drawing.peek()) return false;
    this.writer.cancel();
    return true;
  }
}
