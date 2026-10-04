import FloodFill from 'q-floodfill';
import type { Rect } from '../engine/gl';

// Region picking for the Fill tool: q-floodfill finds the connected run of similar
// colour around the tap, then two chamfer-distance passes turn that mask into the
// field the engine animates: distance travelled from the tap (the spreading front)
// and distance to the region's edge (for feathering).

/** A flat RGBA8 image as q-floodfill expects it (row 0 = document y 0). */
export interface FlatImage { width: number; height: number; data: Uint8ClampedArray }

export interface FillRegion {
  w: number;
  h: number;
  /** Half-open texel rect around the region. */
  bbox: Rect;
  /** Region pixels. */
  count: number;
  /** Farthest (wobbled) distance from the seed (px). */
  maxDist: number;
  /** RG per pixel: r = distance from the seed (px, -1 outside the region), g = distance to the edge (px). */
  field: Float32Array;
}

/**
 * The connected area of similar colour around (x, y). `tolerance` is a per-channel
 * difference in 0..255. Mutates `img` (it is a throwaway readback). Null if empty.
 */
export function pickRegion(img: FlatImage, x: number, y: number, tolerance: number): Uint8Array | null {
  const { width, height, data } = img;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  // The flat render is opaque everywhere, so alpha 0 is a sentinel no real pixel matches
  // (for any tolerance below 255); afterwards the region is simply "alpha == 0".
  const ff = new FloodFill(img as unknown as ImageData);
  ff.fill('rgba(0,0,0,0)', x, y, Math.min(254, Math.max(0, Math.round(tolerance))));
  if (!ff.modifiedPixelsCount) return null;
  const mask = new Uint8Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) mask[i] = data[i * 4 + 3] === 0 ? 1 : 0;
  return mask;
}

const AX = 5, DI = 7, KN = 11;   // chamfer weights (axial / diagonal / knight's move): near-circular fronts

/**
 * Chamfer distance over the mask from a set of sources, as integer fifths of a pixel.
 * Pixels outside the mask or beyond `cap` stay at -1.
 */
function chamfer(mask: Uint8Array, w: number, h: number, sources: Int32Array, cap: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  // Dial's algorithm: one bucket per integer distance, so no priority queue is needed.
  const buckets: (Int32Array | undefined)[] = [];
  const counts: number[] = [];
  const push = (d: number, i: number) => {
    let b = buckets[d];
    if (!b) { b = buckets[d] = new Int32Array(64); counts[d] = 0; }
    if (counts[d] === b.length) { const n = new Int32Array(b.length * 2); n.set(b); b = buckets[d] = n; }
    b[counts[d]++] = i;
  };
  const relax = (j: number, nd: number) => {
    if (!mask[j]) return;
    const cur = dist[j];
    if (cur !== -1 && cur <= nd) return;
    dist[j] = nd;
    push(nd, j);
  };
  for (let k = 0; k < sources.length; k++) { dist[sources[k]] = 0; push(0, sources[k]); }
  const limit = cap * AX;
  for (let d = 0; d < buckets.length && d <= limit; d++) {
    const b = buckets[d];
    if (!b) continue;
    for (let k = 0, n = counts[d]; k < n; k++) {
      const i = b[k];
      if (dist[i] !== d) continue;   // a shorter path got here first
      const x = i % w, y = (i - x) / w;
      const l = x > 0, r = x < w - 1, u = y > 0, dn = y < h - 1;
      const l2 = x > 1, r2 = x < w - 2, u2 = y > 1, dn2 = y < h - 2;
      if (l) relax(i - 1, d + AX);
      if (r) relax(i + 1, d + AX);
      if (u) relax(i - w, d + AX);
      if (dn) relax(i + w, d + AX);
      if (l && u) relax(i - w - 1, d + DI);
      if (r && u) relax(i - w + 1, d + DI);
      if (l && dn) relax(i + w - 1, d + DI);
      if (r && dn) relax(i + w + 1, d + DI);
      // knight's moves (2, 1): they round off the octagon a plain 5-7 chamfer gives
      if (u2 && l) relax(i - 2 * w - 1, d + KN);
      if (u2 && r) relax(i - 2 * w + 1, d + KN);
      if (dn2 && l) relax(i + 2 * w - 1, d + KN);
      if (dn2 && r) relax(i + 2 * w + 1, d + KN);
      if (l2 && u) relax(i - w - 2, d + KN);
      if (l2 && dn) relax(i + w - 2, d + KN);
      if (r2 && u) relax(i - w + 2, d + KN);
      if (r2 && dn) relax(i + w + 2, d + KN);
    }
    buckets[d] = undefined;   // free as we go
  }
  return dist;
}

/**
 * Distance from the seed through the region, and distance to the region's edge
 * (capped at `edgeCap` px; the paper's border does not count as an edge).
 */
export function distanceField(mask: Uint8Array, w: number, h: number, sx: number, sy: number, edgeCap = 64, wobble = 8): FillRegion {
  const seed = sy * w + sx;
  if (!mask[seed]) throw new Error('seed is outside the region');
  const fromSeed = chamfer(mask, w, h, Int32Array.of(seed), Number.MAX_SAFE_INTEGER / AX);

  // edge pixels: inside the mask with a 4-neighbour outside it (but inside the image)
  const edges: number[] = [];
  let count = 0;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || fromSeed[i] < 0) { mask[i] = 0; continue; }   // drop disconnected bits
      count++;
      if (x < x0) x0 = x; if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
      if ((x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) || (y > 0 && !mask[i - w]) || (y < h - 1 && !mask[i + w])) edges.push(i);
    }
  }
  const fromEdge = chamfer(mask, w, h, Int32Array.from(edges), edgeCap);

  // a little low-frequency wobble so the front is organic rather than geometric
  const noise = valueNoise(w, h, 48, 2);
  const field = new Float32Array(w * h * 2);
  let maxDist = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    const d = fromSeed[i];
    if (d < 0) { field[i * 2] = -1; field[i * 2 + 1] = 0; continue; }
    const r = Math.max(0, d / AX + (noise[i] - 0.5) * 2 * wobble);
    if (r > maxDist) maxDist = r;
    field[i * 2] = r;
    const e = fromEdge[i];
    field[i * 2 + 1] = e < 0 ? edgeCap : e / AX;
  }
  return { w, h, bbox: { x0, y0, x1, y1 }, count, maxDist, field };
}

/** Smooth random values in 0..1 with features about `cell` px across (`octaves` of bilinear value noise). */
function valueNoise(w: number, h: number, cell: number, octaves: number): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 0.5, total = 0;
  for (let o = 0; o < octaves; o++, cell /= 2, amp /= 2) {
    const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    for (let y = 0; y < h; y++) {
      const fy = y / cell, gy = Math.floor(fy), ty = smooth(fy - gy);
      for (let x = 0; x < w; x++) {
        const fx = x / cell, gx = Math.floor(fx), tx = smooth(fx - gx);
        const a = grid[gy * gw + gx], b = grid[gy * gw + gx + 1], c = grid[(gy + 1) * gw + gx], d = grid[(gy + 1) * gw + gx + 1];
        out[y * w + x] += amp * ((a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty);
      }
    }
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
