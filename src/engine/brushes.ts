// Brushes: a tip texture (the footprint of one dab) plus the behaviour that turns
// dabs into a stroke. Tips are procedural, generated once at startup in tip space:
// a square from -1..1 where x is the brush's long axis and y its short axis; the
// engine maps that square onto a rotated ellipse of the brush's aspect ratio.

export type Rotation =
  | 'follow'   // long axis follows the stroke direction (+ angle)
  | 'fixed'    // held at a fixed angle, or at the pen's tilt azimuth when available
  | 'random';  // every dab lands at a random angle

export interface BrushPreset {
  id: string;
  name: string;
  hint: string;
  /** Generator in tip space, or raw 8-bit tip data (custom imported brushes). */
  tip: ((n: number, noise: Noise) => Float32Array) | Uint8Array;
  /** short axis / long axis of the footprint (1 = round). */
  aspect: number;
  rotation: Rotation;
  /** Degrees. For 'follow' this is an offset from the stroke direction. */
  angle: number;
  angleJitter: number;
  /** Footprint radius (half the long axis, in document heights) at pressure 0 and 1. */
  size: [number, number];
  /** Exponent on pressure for size: < 1 responds early, > 1 only when pressing hard. */
  pressureSize: number;
  /** How much a fast stroke thins the line. */
  speedThin: number;
  /** Distance between dabs as a fraction of the radius. */
  spacing: number;
  /** Random offset per dab as a fraction of the radius. */
  scatter: number;
  /** Dabs per stamp (spatter). */
  dabs: number;
  /** Random radius variation per dab, 0..1. */
  sizeJitter: number;
  /** Multipliers on the global sliders. */
  water: number;
  load: number;
  flow: number;
  /** How far the brush paints before it runs dry, relative to the round. */
  capacity: number;
  /** 0..1: how much the paper's tooth gates the deposit (dry brush skips the valleys). */
  grain: number;
  /** 0..1: how much the water footprint is a soft ellipse rather than the textured tip. */
  wetRound: number;
  custom?: boolean;
}

/** A preset with its tip baked to 8-bit data. */
export interface Brush extends Omit<BrushPreset, 'tip'> {
  tipSize: number;
  tipData: Uint8Array;
  /** Mean tip value over the tip square; used to normalise deposit between brushes. */
  tipMean: number;
}

export const TIP_SIZE = 192;
const DEG = Math.PI / 180;

/* ----------------------------------------------------------------- noise */

export class Noise {
  private state: number;
  constructor(private seed: number) { this.state = seed | 0 || 1; }

  /** mulberry32 */
  rnd(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  hash(ix: number, iy: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(this.seed, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  value(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = this.hash(ix, iy), b = this.hash(ix + 1, iy), c = this.hash(ix, iy + 1), d = this.hash(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  fbm(x: number, y: number, octaves = 4): number {
    let v = 0, amp = 0.5, sum = 0;
    for (let i = 0; i < octaves; i++) {
      v += amp * this.value(x, y); sum += amp;
      x = x * 2.03 + 17.1; y = y * 2.01 + 9.7; amp *= 0.5;
    }
    return v / sum;
  }

  /** Distances to the nearest and second-nearest jittered cell point. */
  worley(x: number, y: number): [number, number] {
    const ix = Math.floor(x), iy = Math.floor(y);
    let f1 = 9, f2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const px = cx + this.hash(cx, cy), py = cy + this.hash(cx + 71, cy + 13);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  }
}

/* ---------------------------------------------------------- tip helpers */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** 1 inside, fading to 0 between radius `hard` and 1. */
const soft = (r: number, hard: number) => 1 - smoothstep(hard, 1, r);

type TipFn = (u: number, v: number, r: number, ang: number) => number;

function tip(fn: TipFn): (n: number) => Float32Array {
  return n => {
    const out = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const v = ((j + 0.5) / n) * 2 - 1;
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n) * 2 - 1;
        out[j * n + i] = clamp01(fn(u, v, Math.hypot(u, v), Math.atan2(v, u)));
      }
    }
    return out;
  };
}

/** Sum of thin hairs (line segments) with a gaussian cross-section. */
function hairs(segments: [number, number, number, number][], width: number, u: number, v: number) {
  let sum = 0;
  for (const [ax, ay, bx, by] of segments) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = clamp01(((u - ax) * dx + (v - ay) * dy) / len2);
    const d = Math.hypot(u - ax - dx * t, v - ay - dy * t);
    sum += Math.exp(-(d * d) / (width * width));
  }
  return sum;
}

/* --------------------------------------------------------------- presets */

const BASE: Omit<BrushPreset, 'id' | 'name' | 'hint' | 'tip'> = {
  aspect: 1, rotation: 'fixed', angle: 0, angleJitter: 0,
  size: [0.011, 0.05], pressureSize: 1, speedThin: 0,
  spacing: 0.3, scatter: 0, dabs: 1, sizeJitter: 0,
  water: 1, load: 1, flow: 1, capacity: 1, grain: 0, wetRound: 0.6,
};

const define = (p: Partial<BrushPreset> & Pick<BrushPreset, 'id' | 'name' | 'hint' | 'tip'>): BrushPreset => ({ ...BASE, ...p });

export const BRUSH_PRESETS: BrushPreset[] = [
  define({
    id: 'round', name: 'Round', hint: 'A pointed round #8: the everyday brush',
    tip: (n, N) => tip((u, v, r, ang) => {
      const rr = r * (1 + 0.08 * (N.fbm(ang * 0.8 + 3, r * 2.5) * 2 - 1));
      return soft(rr, 0.3) * (1 - 0.12 * N.fbm(u * 5, v * 5));
    })(n),
  }),
  define({
    id: 'detail', name: 'Detail', hint: 'A small round #2 for fine work',
    size: [0.0025, 0.014], pressureSize: 0.9, water: 0.7, load: 1.15, capacity: 0.6, spacing: 0.28, wetRound: 0.8,
    tip: n => tip((_u, _v, r) => soft(r, 0.55))(n),
  }),
  define({
    id: 'rigger', name: 'Rigger', hint: 'Long thin liner: holds a lot of paint for continuous lines',
    size: [0.0015, 0.0065], pressureSize: 0.7, speedThin: 0.08, water: 0.55, load: 1.3, capacity: 1.8, spacing: 0.25, wetRound: 0.9,
    tip: n => tip((_u, _v, r) => soft(r, 0.65))(n),
  }),
  define({
    id: 'flat', name: 'Flat', hint: 'A ½" flat: thick or thin depending on direction; tilt the pen to turn it',
    aspect: 0.26, rotation: 'fixed', angle: 40, angleJitter: 1.5,
    size: [0.02, 0.038], pressureSize: 1.4, spacing: 0.14, water: 0.8, wetRound: 0.25,
    tip: (n, N) => tip((u, v) => {
      const chisel = 0.06 * (N.fbm(v * 3 + 9, 2, 3) * 2 - 1);
      const ex = 1 - smoothstep(0.8, 0.98, Math.abs(u) + chisel);
      const ey = 1 - smoothstep(0.8, 1, Math.abs(v));
      const bristles = 1 - 0.4 * smoothstep(0.4, 0.75, N.fbm(u * 10, v * 0.7, 3));
      return ex * ey * bristles;
    })(n),
  }),
  define({
    id: 'hake', name: 'Hake', hint: 'Wide soft goat-hair wash brush; streaky, carries lots of water',
    aspect: 0.2, rotation: 'follow', angle: 90, angleJitter: 2,
    size: [0.05, 0.08], pressureSize: 1.6, spacing: 0.1, water: 1.6, load: 0.75, flow: 1.2, capacity: 2.2, wetRound: 0.5,
    tip: (n, N) => tip((u, v) => {
      const ex = 1 - smoothstep(0.72, 1, Math.abs(u) + 0.1 * (N.fbm(v * 2 + 4, 1, 3) * 2 - 1));
      const ey = 1 - smoothstep(0.55, 1, Math.abs(v));
      const bristles = 1 - 0.65 * smoothstep(0.35, 0.7, N.fbm(u * 16, v * 0.9, 3));
      const gaps = smoothstep(0.25, 0.45, N.fbm(u * 7 + 20, v * 0.4, 2));
      return ex * ey * bristles * (0.4 + 0.6 * gaps);
    })(n),
  }),
  define({
    id: 'filbert', name: 'Filbert', hint: 'Oval tip: soft rounded marks that change with direction',
    aspect: 0.55, rotation: 'fixed', angle: 25, angleJitter: 2,
    size: [0.012, 0.036], spacing: 0.18, wetRound: 0.5,
    tip: (n, N) => tip((u, _v, r) => soft(r, 0.45) * (1 - 0.25 * N.fbm(u * 8, 0.7, 3)))(n),
  }),
  define({
    id: 'mop', name: 'Mop', hint: 'Big squirrel mop: floods the paper for washes',
    size: [0.03, 0.075], pressureSize: 0.8, spacing: 0.25, water: 1.8, load: 0.8, flow: 1.3, capacity: 2.6, wetRound: 0.7,
    tip: (n, N) => tip((u, v, r, ang) => {
      const rr = r * (1 + 0.22 * (N.fbm(ang * 1.2, 1.7, 3) * 2 - 1));
      return Math.pow(soft(rr, 0.1), 1.3) * (1 - 0.25 * N.fbm(u * 3, v * 3));
    })(n),
  }),
  define({
    id: 'dry', name: 'Dry Brush', hint: 'Scruffy bristles with little water: skips over the paper tooth',
    aspect: 0.75, rotation: 'follow', angle: 0, angleJitter: 8,
    size: [0.012, 0.036], spacing: 0.12, water: 0.2, load: 1.1, capacity: 0.6, grain: 0.9, wetRound: 0,
    tip: (n, N) => tip((u, v, r) => {
      const holes = smoothstep(0.42, 0.62, N.fbm(u * 5.5, v * 5.5, 5));
      const streaks = 1 - 0.3 * N.fbm(u * 14, v * 1.2, 3);
      return soft(r, 0.2) * holes * streaks;
    })(n),
  }),
  define({
    id: 'fan', name: 'Fan', hint: 'Splayed hairs: grass, fur and fine parallel texture',
    aspect: 0.5, rotation: 'follow', angle: 90, angleJitter: 3,
    size: [0.02, 0.045], pressureSize: 1.2, spacing: 0.1, water: 0.3, load: 1.0, capacity: 0.8, grain: 0.5, wetRound: 0,
    tip: (n, N) => {
      const segs: [number, number, number, number][] = [];
      for (let i = 0; i < 13; i++) {
        const x = -0.95 + (1.9 * i) / 12 + (N.rnd() - 0.5) * 0.08;
        segs.push([x * 0.25, -1.3, x, 0.75 + N.rnd() * 0.25]);
      }
      return tip((u, v) => Math.min(1, hairs(segs, 0.045, u, v)) * (1 - smoothstep(0.85, 1, Math.abs(v))))(n);
    },
  }),
  define({
    id: 'sponge', name: 'Sponge', hint: 'Natural sponge: dabbed cellular texture for foliage and stone',
    rotation: 'random', size: [0.025, 0.05], pressureSize: 0.7, spacing: 0.55, scatter: 0.3, sizeJitter: 0.3,
    water: 0.5, load: 0.9, capacity: 1.2, grain: 0.45, wetRound: 0.1,
    tip: (n, N) => tip((u, v, r) => {
      const [f1, f2] = N.worley(u * 4.5, v * 4.5);
      return soft(r, 0.55) * smoothstep(0.03, 0.14, f2 - f1) * (0.55 + 0.45 * N.fbm(u * 7, v * 7, 3));
    })(n),
  }),
  define({
    id: 'spatter', name: 'Spatter', hint: 'Flicked droplets: sparse at a light touch, dense when pressing',
    rotation: 'random', size: [0.003, 0.008], pressureSize: 0.8, spacing: 4.5, scatter: 10, dabs: 5, sizeJitter: 0.75,
    water: 1.3, load: 1.1, capacity: 1.5, wetRound: 0,
    tip: n => tip((_u, _v, r) => soft(r, 0.72))(n),
  }),
  define({
    id: 'sumi', name: 'Sumi', hint: 'Oriental brush: hairline to broad with pressure, fibrous edges',
    size: [0.002, 0.052], pressureSize: 1.3, speedThin: 0.12, spacing: 0.22, water: 0.8, load: 1.3, capacity: 1.2, wetRound: 0.75,
    tip: (n, N) => tip((_u, _v, r, ang) => {
      const rr = r * (1 + 0.35 * (N.fbm(ang * 2.5 + r * 2, 1, 3) * 2 - 1));
      return Math.pow(soft(rr, 0.25), 1.5) * (1 - 0.3 * N.fbm(r * 8, ang * 3, 3));
    })(n),
  }),
  define({
    id: 'dagger', name: 'Dagger', hint: 'Sword liner: calligraphic strokes from a tapered blade',
    aspect: 0.38, rotation: 'fixed', angle: 55, angleJitter: 1,
    size: [0.006, 0.03], pressureSize: 1.1, speedThin: 0.06, spacing: 0.15, load: 1.1, capacity: 1.4, wetRound: 0.3,
    tip: n => tip((u, v) => {
      const t = (u + 1) / 2;
      const w = Math.sqrt(Math.max(0, 4 * t * (1 - t))) * (1 - 0.5 * t);
      return 1 - smoothstep(w * 0.8, w, Math.abs(v));
    })(n),
  }),
  define({
    id: 'stipple', name: 'Stipple', hint: 'A cluster of hard dots: pointillist texture',
    rotation: 'random', size: [0.015, 0.035], pressureSize: 0.8, spacing: 0.7, scatter: 0.2, sizeJitter: 0.2,
    water: 0.35, load: 1.1, grain: 0.3, wetRound: 0,
    tip: (n, N) => {
      const dots: [number, number, number][] = [];
      while (dots.length < 46) {
        const x = N.rnd() * 2 - 1, y = N.rnd() * 2 - 1;
        if (Math.hypot(x, y) < 0.86) dots.push([x, y, 0.06 + N.rnd() * 0.08]);
      }
      return tip((u, v) => {
        let m = 0;
        for (const [x, y, rd] of dots) m = Math.max(m, soft(Math.hypot(u - x, v - y) / rd, 0.6));
        return m;
      })(n);
    },
  }),
];

/** Behaviour for an imported texture: a textured round that follows the stroke. */
export const CUSTOM_BASE: Omit<BrushPreset, 'id' | 'name' | 'hint' | 'tip'> = {
  ...BASE, rotation: 'follow', angleJitter: 4, spacing: 0.2, wetRound: 0.4,
};

/* ------------------------------------------------------------- building */

export function buildBrush(preset: BrushPreset, seed = 7): Brush {
  const { tip: source, ...rest } = preset;
  let tipData: Uint8Array, tipSize: number;
  if (source instanceof Uint8Array) {
    tipData = source;
    tipSize = Math.round(Math.sqrt(source.length));
  } else {
    tipSize = TIP_SIZE;
    const f = source(tipSize, new Noise(seed + hashString(preset.id)));
    tipData = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) tipData[i] = Math.round(clamp01(f[i]) * 255);
  }
  let sum = 0;
  for (let i = 0; i < tipData.length; i++) sum += tipData[i];
  return { ...rest, tipSize, tipData, tipMean: Math.max(0.01, sum / (255 * tipData.length)) };
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export { DEG as DEGREES };
