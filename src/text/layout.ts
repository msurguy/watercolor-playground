import type { Font, Polyline } from './fontLoader';

// Lays a single line of text out along a baseline, in em units with the anchor
// at the origin: the left, middle or right end of the baseline depending on the
// alignment. Strokes come out in writing order, one glyph after the next.

export type Align = 'left' | 'center' | 'right';

export interface TextLayout {
  strokes: Polyline[];
  /** Advance width of the line, in em. */
  width: number;
  /** Bounding box of the pen paths, in em (may be empty for blank text). */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export function layoutText(text: string, font: Font, spacing = 0, align: Align = 'left'): TextLayout {
  const chars = Array.from(text);
  const glyphs = chars.map(c => font.glyphs.get(c) ?? font.glyphs.get(fallback(c)) ?? null);
  let width = 0;
  for (const g of glyphs) if (g) width += g.advance + spacing;
  if (width > 0) width -= spacing;
  const x0 = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  const strokes: Polyline[] = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let x = x0;
  for (const g of glyphs) {
    if (!g) continue;
    for (const pl of g.strokes) {
      const moved: Polyline = pl.map(([px, py]) => {
        const X = px + x;
        if (X < box.x0) box.x0 = X; if (X > box.x1) box.x1 = X;
        if (py < box.y0) box.y0 = py; if (py > box.y1) box.y1 = py;
        return [X, py];
      });
      strokes.push(moved);
    }
    x += g.advance + spacing;
  }
  if (!strokes.length) Object.assign(box, { x0: x0, y0: -font.capHeight, x1: x0 + width, y1: 0 });
  return { strokes, width, box };
}

/** A near enough glyph for characters the font lacks. */
function fallback(c: string): string {
  const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (base && base !== c) return base;
  if (c === '’' || c === '‘') return "'";
  if (c === '“' || c === '”') return '"';
  if (c === '–' || c === '—') return '-';
  if (c === ' ') return ' ';
  return c;
}
