// Parses an SVG font document (Hershey-style single-stroke fonts: <font>,
// <font-face>, <glyph>) into pen paths. Ported from drawingbots' plotter-text
// fontLoader.ts, but instead of keeping SVG path strings the outlines are
// flattened to polylines in em units (1 = the em height), baseline at y = 0,
// y down, ready to be driven along by a brush.

import type { Polyline } from '../draw/StrokeWriter';
export type { Polyline };

export interface Glyph {
  strokes: Polyline[];
  /** Horizontal advance in em. */
  advance: number;
}

export interface Font {
  key: string;
  glyphs: Map<string, Glyph>;
  /** Cap height in em (for placing the ghost preview). */
  capHeight: number;
  xHeight: number;
}

const cache = new Map<string, Promise<Font>>();

export function loadFont(key: string, url: string): Promise<Font> {
  let p = cache.get(key);
  if (!p) {
    p = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`Could not load font (${r.status})`); return r.text(); })
      .then(text => parseFont(key, new DOMParser().parseFromString(text, 'image/svg+xml')));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export function parseFont(key: string, doc: Document): Font {
  const font = doc.getElementsByTagName('font')[0];
  const face = doc.getElementsByTagName('font-face')[0];
  if (!font || !face) throw new Error('Not an SVG font file');
  const upm = parseFloat(face.getAttribute('units-per-em') || '1000') || 1000;
  const defaultAdv = parseFloat(font.getAttribute('horiz-adv-x') || '') || upm / 3;
  const s = 1 / upm;
  const glyphs = new Map<string, Glyph>();
  for (const g of Array.from(doc.getElementsByTagName('glyph'))) {
    const unicode = g.getAttribute('unicode');
    if (unicode == null) continue;
    const adv = parseFloat(g.getAttribute('horiz-adv-x') || '') || defaultAdv;
    const d = g.getAttribute('d');
    const strokes = d ? flattenPath(d, upm / 700).map(pl => pl.map(([x, y]) => [x * s, -y * s] as [number, number])) : [];
    glyphs.set(unicode, { strokes: strokes.filter(pl => pl.length > 0), advance: adv * s });
  }
  // Some Hershey dumps have no space glyph; without one words would run together.
  if (!glyphs.has(' ')) glyphs.set(' ', { strokes: [], advance: defaultAdv * s });
  return {
    key, glyphs,
    capHeight: (parseFloat(face.getAttribute('cap-height') || '') || upm * 0.7) * s,
    xHeight: (parseFloat(face.getAttribute('x-height') || '') || upm * 0.5) * s,
  };
}

/* --------------------------------------------------------------- SVG paths */

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi;

/** Flatten an SVG path (M L H V C S Q T Z, absolute or relative) to polylines in path units. */
export function flattenPath(d: string, tolerance = 1.5): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline = [];
  let x = 0, y = 0, sx = 0, sy = 0;        // pen, subpath start
  let cx = 0, cy = 0;                      // last control point (for S / T)
  let prev = '';
  const start = () => { if (cur.length > 1) out.push(cur); cur = [[x, y]]; };
  const lineTo = (nx: number, ny: number) => { x = nx; y = ny; cur.push([x, y]); };
  const cubic = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
    const n = segments(Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(nx - x2, ny - y2), tolerance);
    const x0 = x, y0 = y;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      cur.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx,
                u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny]);
    }
    cx = x2; cy = y2; x = nx; y = ny;
  };
  const quad = (x1: number, y1: number, nx: number, ny: number) => {
    const n = segments(Math.hypot(x1 - x, y1 - y) + Math.hypot(nx - x1, ny - y1), tolerance);
    const x0 = x, y0 = y;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      cur.push([u * u * x0 + 2 * u * t * x1 + t * t * nx, u * u * y0 + 2 * u * t * y1 + t * t * ny]);
    }
    cx = x1; cy = y1; x = nx; y = ny;
  };

  for (const m of d.matchAll(/([MmLlHhVvCcSsQqTtZzAa])([^MmLlHhVvCcSsQqTtZzAa]*)/g)) {
    const nums = (m[2].match(NUM) ?? []).map(Number);
    const rel = m[1] === m[1].toLowerCase();
    let C = m[1].toUpperCase();
    let i = 0;
    if (C === 'Z') { if (cur.length && (x !== sx || y !== sy)) lineTo(sx, sy); x = sx; y = sy; prev = 'Z'; continue; }
    do {
      const rx = rel ? x : 0, ry = rel ? y : 0;
      switch (C) {
        case 'M':
          x = nums[i++] + rx; y = nums[i++] + ry;
          sx = x; sy = y; start();
          C = 'L';                          // further pairs are implicit line-tos
          break;
        case 'L': lineTo(nums[i++] + rx, nums[i++] + ry); break;
        case 'H': lineTo(nums[i++] + rx, y); break;
        case 'V': lineTo(x, nums[i++] + ry); break;
        case 'C': cubic(nums[i++] + rx, nums[i++] + ry, nums[i++] + rx, nums[i++] + ry, nums[i++] + rx, nums[i++] + ry); break;
        case 'S': {
          const x1 = prev === 'C' || prev === 'S' ? 2 * x - cx : x, y1 = prev === 'C' || prev === 'S' ? 2 * y - cy : y;
          cubic(x1, y1, nums[i++] + rx, nums[i++] + ry, nums[i++] + rx, nums[i++] + ry); break;
        }
        case 'Q': quad(nums[i++] + rx, nums[i++] + ry, nums[i++] + rx, nums[i++] + ry); break;
        case 'T': {
          const x1 = prev === 'Q' || prev === 'T' ? 2 * x - cx : x, y1 = prev === 'Q' || prev === 'T' ? 2 * y - cy : y;
          quad(x1, y1, nums[i++] + rx, nums[i++] + ry); break;
        }
        case 'A': i += 5; lineTo(nums[i++] + rx, nums[i++] + ry); break;   // arcs are not used by these fonts
      }
      prev = C;
    } while (i < nums.length && i + argc(C) <= nums.length);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function argc(c: string) { return c === 'H' || c === 'V' ? 1 : c === 'C' ? 6 : c === 'S' || c === 'Q' ? 4 : c === 'A' ? 7 : 2; }
function segments(len: number, tolerance: number) { return Math.max(2, Math.min(24, Math.ceil(len / (tolerance * 6)))); }
