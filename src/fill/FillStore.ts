import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { WatercolorEngine } from '../engine/Engine';
import type { PanelTool, PaperGesture } from '../app/tools';
import { persisted } from '../app/persisted';
import { showToast } from '../app/toast';
import { distanceField, pickRegion } from './region';

// The Fill tool (paint bucket): tap an area of the paper and a wash of the current
// pigment spreads out from the tap across every connected pixel of similar colour.
// q-floodfill picks the region on a flat readback of the paper; the engine then
// deposits pigment and water band by band along a distance field, so the fill is
// animated and the live wet simulation bleeds it like any other wash.

export interface FillSettings {
  mode: 'paint' | 'water';
  tolerance: number;   // 0..1 -> colour difference
  water: number;       // 0..1 wetness of the wash
  strength: number;    // 0..1.5 pigment amount
  speed: number;       // 0..1 -> px / s
  soft: number;        // 0..1 -> feathered edge width
}

const KEY = 'watercolor.fill';
const DEFAULTS: FillSettings = { mode: 'paint', tolerance: 0.25, water: 0.6, strength: 1, speed: 0.5, soft: 0.3 };

/** Slider 0..1 -> px/s of front travel (about 120 .. 3000). */
const fillSpeed = (v: number) => 120 * Math.pow(25, v);
const EDGE_CAP = 48;

interface Run { raf: number; from: number; maxDist: number; last: number }

export class FillStore implements PanelTool {
  readonly id = 'fill';
  readonly settings = persisted<FillSettings>(KEY, DEFAULTS, s => (s.mode === 'paint' || s.mode === 'water' ? s : { ...s, mode: DEFAULTS.mode }));
  readonly active = signal(false);
  /** 0..1 while a fill is spreading, else null. */
  readonly progress = signal<number | null>(null);
  readonly picking = signal(false);
  readonly busy: ReadonlySignal<boolean> = computed(() => this.progress.value !== null || this.picking.value);
  readonly status = computed(() => {
    const p = this.progress.value;
    if (p !== null) return `Filling… ${Math.round(p * 100)}%`;
    if (this.picking.value) return 'Finding the area…';
    if (!this.active.value) return '';
    return this.settings.value.mode === 'water' ? 'Tap an area to wet it' : 'Tap an area to fill it';
  });

  private press: { id: number; x: number; y: number } | null = null;
  private run: Run | null = null;

  constructor(private engine: WatercolorEngine) {}

  set(p: Partial<FillSettings>) { this.settings.value = { ...this.settings.value, ...p }; }

  private fillAt(clientX: number, clientY: number) {
    const engine = this.engine;
    const [u, v] = engine.clientToDoc(clientX, clientY);
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const [dw, dh] = engine.docSize;
    const px = Math.min(dw - 1, Math.floor(u * dw)), py = Math.min(dh - 1, Math.floor(v * dh));
    this.picking.value = true;
    // let the status paint before the synchronous region search
    requestAnimationFrame(() => {
      this.picking.value = false;
      if (!this.active.peek()) return;
      const s = this.settings.peek();
      const flat = engine.readFlat();
      const tol = Math.round(s.tolerance * s.tolerance * 255);   // 0.25 -> 16 of 255 per channel
      const mask = pickRegion({ width: dw, height: dh, data: new Uint8ClampedArray(flat.buffer) }, px, py, tol);
      if (!mask) { showToast('Nothing to fill here'); return; }
      const region = distanceField(mask, dw, dh, px, py, EDGE_CAP);
      if (region.count < 4) { showToast('That area is too small to fill'); return; }
      if (!engine.fillBegin(region.field, region.bbox)) { showToast('Wait for the stroke to finish'); return; }
      this.run = { raf: 0, from: -0.5, maxDist: region.maxDist + engine.fillMargin, last: performance.now() };
      this.run.raf = requestAnimationFrame(this.frame);
      this.progress.value = 0;
    });
  }

  private frame = (now: number) => {
    const run = this.run;
    if (!run) return;
    const s = this.settings.peek();
    const dt = Math.min(0.1, Math.max(0, (now - run.last) / 1000));
    run.last = now;
    const to = Math.min(run.maxDist, run.from + fillSpeed(s.speed) * dt);
    const ok = this.engine.fillStep(run.from, to, { strength: s.strength, water: s.water, soft: s.soft * 40, paint: s.mode === 'paint' });
    if (!ok) { this.finish(); return; }   // undone, cleared or interrupted by another action
    run.from = to;
    if (to >= run.maxDist) { this.engine.fillEnd(); this.finish(); return; }
    run.raf = requestAnimationFrame(this.frame);
    this.progress.value = Math.min(1, Math.max(0, run.from) / Math.max(run.maxDist, 1e-6));
  };

  private finish() {
    if (this.run) cancelAnimationFrame(this.run.raf);
    this.run = null;
    this.progress.value = null;
  }

  private cancel(): boolean {
    if (!this.run) return false;
    this.engine.fillEnd();
    this.finish();
    return true;
  }

  readonly gesture: PaperGesture = {
    down: e => {
      if (this.press) return;
      if (this.busy.peek()) { showToast('Still filling… press Stop or Esc'); return; }
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      this.press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    },
    up: e => {
      const p = this.press;
      if (!p || e.pointerId !== p.id) return;
      this.press = null;
      try { (e.currentTarget as Element).releasePointerCapture(p.id); } catch { /* already released */ }
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) { showToast('Tap, rather than drag, to fill an area'); return; }
      this.fillAt(e.clientX, e.clientY);
    },
    cancel: e => { if (this.press && e.pointerId === this.press.id) this.press = null; },
  };

  activate() { this.active.value = true; }

  deactivate() {
    this.active.value = false;
    this.press = null;
    this.cancel();
  }

  stop() { return this.cancel(); }
}
