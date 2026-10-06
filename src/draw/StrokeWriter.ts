import type { Tool, WatercolorEngine } from '../engine/Engine';

// Draws pen paths (text, shapes) onto the paper stroke by stroke, in real time, by
// feeding the engine scripted samples: the brush actually travels the paths, so the
// marks get the same spacing, speed thinning, bleeding and drying as hand strokes.

/** A pen-down ... pen-up run of points. */
export type Polyline = [number, number][];

/** Pen speed in document heights per second from a 0..1 slider. */
export const penSpeed = (v: number) => 0.05 * Math.pow(40, v);

export interface WriteOptions {
  tool: Tool;
  /** Reference length (em height, shape size) that wobble and jitter scale with, in document heights. */
  ref: number;
  /** Pen speed along the path, in document heights per second. */
  speed: number;
  /** Base pen pressure 0..1. */
  pressure: number;
  /** 0..1: how much the pressure eases in and out at the ends of each stroke. */
  taper: number;
  /** 0..1: hand tremor along the path. */
  wobble: number;
  /** Name of the undo step the whole write becomes. */
  label: string;
  /** Widest footprint radius allowed, in document heights (the tool's own size when unset). */
  maxRadius?: number;
}

export interface WriteCallbacks {
  onProgress?(done: number, total: number): void;
  onDone?(cancelled: boolean): void;
}

/** A stroke in document-height units relative to the anchor, with cumulative lengths. */
interface Run { pts: [number, number][]; cum: number[]; len: number; ph: [number, number]; jx: number; jy: number }

const STEP = 0.0015;          // sample spacing along the path (doc heights)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class StrokeWriter {
  private raf = 0;
  private runs: Run[] = [];
  private index = 0;
  private dist = 0;
  private phase: 'begin' | 'draw' | 'pause' = 'begin';
  private pauseUntil = 0;
  private last = 0;
  private anchor: [number, number] = [0, 0];
  private opts!: WriteOptions;
  private cb: WriteCallbacks = {};
  private first = true;

  constructor(private engine: WatercolorEngine) {}

  get busy() { return this.raf !== 0; }

  /**
   * Start drawing `strokes`, given in document heights relative to `anchor` (document uv,
   * y up), in order. Cancels any drawing in progress.
   */
  write(strokes: Polyline[], anchor: [number, number], opts: WriteOptions, cb: WriteCallbacks = {}) {
    this.cancel();
    const { ref, wobble } = opts;
    this.runs = [];
    for (const pl of strokes) {
      const pts = pl.map(([x, y]) => [x, y] as [number, number]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const len = cum[cum.length - 1];
      const j = wobble * ref * 0.015;
      this.runs.push({ pts, cum, len, ph: [Math.random() * 7, Math.random() * 7], jx: (Math.random() - 0.5) * j, jy: (Math.random() - 0.5) * j });
    }
    if (!this.runs.length) { cb.onDone?.(false); return; }
    this.anchor = anchor;
    this.opts = opts;
    this.cb = cb;
    this.index = 0;
    this.dist = 0;
    this.first = true;
    this.phase = 'begin';
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  cancel() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.engine.scriptEnd();
    this.cb.onDone?.(true);
  }

  private finish(cancelled: boolean) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cb.onProgress?.(this.runs.length, this.runs.length);
    this.cb.onDone?.(cancelled);
  }

  /** Pen position on run `r` at arc length `d`, with tremor, in document uv. */
  private at(r: Run, d: number): [number, number] {
    const { pts, cum } = r;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = clamp((d - cum[i - 1]) / seg, 0, 1);
    let x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
    let y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    const { wobble, ref } = this.opts;
    if (wobble > 0) {
      // perpendicular tremor: a slow sway plus a faster shiver, in proportion to the reference size
      const tx = (pts[i][0] - pts[i - 1][0]) / seg, ty = (pts[i][1] - pts[i - 1][1]) / seg;
      const w = wobble * ref * 0.035 * (0.6 * Math.sin((d / (ref * 0.3)) * Math.PI * 2 + r.ph[0]) + 0.4 * Math.sin((d / (ref * 0.08)) * Math.PI * 2 + r.ph[1]));
      x += -ty * w; y += tx * w;
    }
    const a = this.engine.aspect;
    return [this.anchor[0] + (x + r.jx) / a, this.anchor[1] + y + r.jy];
  }

  private pressureAt(r: Run, d: number) {
    const { pressure, taper } = this.opts;
    if (taper <= 0 || r.len <= 0) return pressure;
    const f = Math.max(0.03, 0.5 * taper);
    const u = d / r.len;
    const ramp = smooth(0, f, u) * smooth(0, f, 1 - u);
    return pressure * (0.12 + 0.88 * ramp);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = clamp((now - this.last) / 1000, 0, 0.1);
    const run = this.runs[this.index];
    const { tool, speed } = this.opts;

    if (this.phase === 'pause') {
      if (now >= this.pauseUntil) this.phase = 'begin';
    }
    if (this.phase === 'begin') {
      const [x, y] = this.at(run, 0);
      if (this.engine.scriptBegin(tool, x, y, this.pressureAt(run, 0), this.first ? this.opts.label : false, this.opts.maxRadius)) {
        this.first = false;
        this.phase = 'draw';
        this.dist = 0;
      }
      // else: the previous stroke is still lifting; try again next frame
    } else if (this.phase === 'draw') {
      const target = Math.min(run.len, this.dist + speed * dt);
      const t0 = this.last, span = now - t0;
      const from = this.dist;
      let d = this.dist;
      let alive = true;
      while (d < target && alive) {
        d = Math.min(target, d + STEP);
        const [x, y] = this.at(run, d);
        const t = span > 0 ? t0 + ((d - from) / Math.max(target - from, 1e-9)) * span : now;
        alive = this.engine.scriptMove(x, y, this.pressureAt(run, d), t);
      }
      this.dist = d;
      if (!alive) { this.finish(true); return; }     // undone or cleared under us
      if (this.dist >= run.len) {
        this.engine.scriptEnd();
        this.cb.onProgress?.(this.index + 1, this.runs.length);
        this.index++;
        if (this.index >= this.runs.length) { this.finish(false); return; }
        // pen up: travel to the next stroke in the air, faster than on the paper
        const next = this.runs[this.index];
        const [ax, ay] = run.pts[run.pts.length - 1], [bx, by] = next.pts[0];
        const hop = Math.hypot(bx - ax, by - ay);
        this.pauseUntil = now + 1000 * clamp(0.05 + hop / (speed * 2.5), 0.05, 0.7);
        this.phase = 'pause';
      }
    }
    this.last = now;
    this.raf = requestAnimationFrame(this.frame);
  };
}
