import { linemerge, linesort, linePoints, readSvg } from 'vpype-js';
import type { Polyline } from '../draw/StrokeWriter';

// Turns an SVG file into pen paths for the Shape tool. vpype-js does the heavy
// lifting (transforms, arcs, <use>, viewBox and units); we then merge touching
// lines, sort them to shorten pen-up hops, and normalise to a unit box.

export interface ImportedSvg {
  name: string;
  /** Content width / height. */
  aspect: number;
  /** Strokes with x and y in 0..1, y pointing up, fitted to the content bounds. */
  strokes: Polyline[];
  /** A thinned copy for the live ghost preview. */
  ghost: Polyline[];
  /** Number of strokes (pen-down runs). */
  count: number;
}

const GHOST_POINTS = 3000;

export const isSvgFile = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);

export async function importSvg(file: File): Promise<ImportedSvg> {
  const text = await file.text();
  let lines;
  try {
    // A coarse first pass just to learn the page size, then resample curves
    // finely relative to it (the writer resamples again at drawing time).
    const { width, height } = readSvg(text, 1000, { crop: false });
    const q = Math.max(0.05, Math.max(width, height) / 800);
    lines = readSvg(text, q, { crop: false }).lines;
    lines = linesort(linemerge(lines, { tolerance: q * 2, flip: true }), { flip: true });
  } catch (e) {
    throw new Error(e instanceof Error && /xml|parse|svg/i.test(e.message) ? 'That file is not a valid SVG' : 'Could not read that SVG');
  }

  const polys: Polyline[] = [];
  for (const line of lines) {
    const pts = linePoints(line).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) as Polyline;
    if (pts.length >= 2) polys.push(pts);
  }
  if (!polys.length) throw new Error('No paths found in that SVG (text and images are ignored)');

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of polys) for (const [x, y] of pl) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  const strokes = polys.map(pl => pl.map(([x, y]) => [(x - x0) / w, 1 - (y - y0) / h] as [number, number]));

  return {
    name: file.name.replace(/\.svg$/i, '') || 'SVG',
    aspect: w / h,
    strokes,
    ghost: thin(strokes, GHOST_POINTS),
    count: strokes.length,
  };
}

/** Keep roughly `budget` points in total, always keeping each stroke's end points. */
function thin(strokes: Polyline[], budget: number): Polyline[] {
  const total = strokes.reduce((n, pl) => n + pl.length, 0);
  if (total <= budget) return strokes;
  const keep = budget / total;
  return strokes.map(pl => {
    if (pl.length <= 2) return pl;
    const out: Polyline = [pl[0]];
    let acc = 0;
    for (let i = 1; i < pl.length - 1; i++) {
      acc += keep;
      if (acc >= 1) { acc -= 1; out.push(pl[i]); }
    }
    out.push(pl[pl.length - 1]);
    return out;
  });
}
