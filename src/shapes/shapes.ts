import type { Polyline } from '../draw/StrokeWriter';
import type { ImportedSvg } from './svgImport';

// Geometric outlines as pen paths, fitted to a dragged box. Coordinates are in
// document heights (y up); the box corners are the drag's start `a` and end `b`.

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'star' | 'svg';

export interface ShapeParams {
  /** Polygon sides / star points. */
  sides: number;
  /** Star inner radius as a fraction of the outer. */
  inner: number;
  /** Degrees, anticlockwise. */
  rotation: number;
  /** The imported file for the `svg` kind. */
  svg?: ImportedSvg | null;
}

/** `short` is the grid caption; `label` is used in prose. */
export const SHAPES: { id: ShapeKind; label: string; short?: string; hint: string }[] = [
  { id: 'line', label: 'Line', hint: 'A straight stroke from where you press to where you let go' },
  { id: 'arrow', label: 'Arrow', hint: 'A line with a head at the end' },
  { id: 'rect', label: 'Rectangle', short: 'Rect', hint: 'Four sides in one stroke' },
  { id: 'ellipse', label: 'Ellipse', short: 'Oval', hint: 'An oval fitted to the box' },
  { id: 'triangle', label: 'Triangle', short: 'Tri', hint: 'Apex up, fitted to the box' },
  { id: 'polygon', label: 'Polygon', short: 'Poly', hint: 'A regular shape with the chosen number of sides' },
  { id: 'star', label: 'Star', hint: 'Points and an inner radius of your choosing' },
  { id: 'svg', label: 'SVG', hint: 'Import an SVG file and trace its paths' },
];

const DEG = Math.PI / 180;
type Pt = [number, number];

/** Does the shape have a rotation / sides control? */
export const hasRotation = (k: ShapeKind) => k !== 'line' && k !== 'arrow';
export const hasSides = (k: ShapeKind) => k === 'polygon' || k === 'star';

/**
 * Snap the drag end so the box is square (or the line lies on a 45° step) when
 * the aspect lock is on. `aspect` is the document's width / height; `boxAspect`
 * is the width / height the box should keep (1 for presets, the file's for SVGs).
 */
export function constrain(kind: ShapeKind, a: Pt, b: Pt, aspect: number, boxAspect = 1): Pt {
  const dx = (b[0] - a[0]) * aspect, dy = b[1] - a[1];
  if (kind === 'line' || kind === 'arrow') {
    const len = Math.hypot(dx, dy), ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [a[0] + (Math.cos(ang) * len) / aspect, a[1] + Math.sin(ang) * len];
  }
  const m = Math.max(Math.abs(dx) / boxAspect, Math.abs(dy));
  return [a[0] + (Math.sign(dx) * m * boxAspect) / aspect, a[1] + Math.sign(dy) * m];
}

/**
 * Fit normalised SVG strokes (0..1, y up) into the signed box `w` × `h`, never
 * mirrored however the box was dragged, then rotated about the box centre.
 */
export function fitSvg(strokes: Polyline[], w: number, h: number, rotationDeg: number): Polyline[] {
  const ox = Math.min(0, w), oy = Math.min(0, h), sx = Math.abs(w), sy = Math.abs(h);
  const cx = w / 2, cy = h / 2, rot = rotationDeg * DEG, c = Math.cos(rot), s = Math.sin(rot);
  return strokes.map(pl => pl.map(([x, y]) => {
    const dx = ox + x * sx - cx, dy = oy + y * sy - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c] as Pt;
  }));
}

/**
 * Strokes of the shape, in document heights relative to `a`. `a` and `b` are in
 * document uv; the box is converted with `aspect` so circles stay round.
 */
export function shapeStrokes(kind: ShapeKind, a: Pt, b: Pt, p: ShapeParams, aspect: number): Polyline[] {
  const w = (b[0] - a[0]) * aspect, h = b[1] - a[1];      // box extents from a (signed)
  const cx = w / 2, cy = h / 2, rx = Math.abs(w) / 2, ry = Math.abs(h) / 2;
  const rot = p.rotation * DEG;
  const onEllipse = (ang: number, k = 1): Pt => [cx + Math.cos(ang + rot) * rx * k, cy + Math.sin(ang + rot) * ry * k];

  switch (kind) {
    case 'line': return [[[0, 0], [w, h]]];
    case 'arrow': {
      const len = Math.hypot(w, h);
      if (len < 1e-6) return [[[0, 0], [w, h]]];
      const ux = w / len, uy = h / len;
      const head = Math.min(len * 0.3, Math.max(0.012, len * 0.18));
      const c = Math.cos(28 * DEG) * head, s = Math.sin(28 * DEG) * head;
      const tip: Pt = [w, h];
      const l: Pt = [w - ux * c + uy * s, h - uy * c - ux * s];
      const r: Pt = [w - ux * c - uy * s, h - uy * c + ux * s];
      return [[[0, 0], tip], [l, tip, r]];
    }
    case 'rect': return [closed([[0, 0], [w, 0], [w, h], [0, h]])];
    case 'triangle': {
      // apex at the top of the box, then rotated about the centre
      const pts: Pt[] = [[cx, cy + ry], [cx + rx, cy - ry], [cx - rx, cy - ry]].map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        return [cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)];
      });
      return [closed(startNearOrigin(pts))];
    }
    case 'ellipse': {
      const n = Math.round(Math.min(160, Math.max(48, (Math.PI * (rx + ry)) / 0.004)));
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) pts.push(onEllipse((i / n) * Math.PI * 2));
      return [closed(startNearOrigin(pts))];
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(p.sides));
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) pts.push(onEllipse(Math.PI / 2 + (i / n) * Math.PI * 2));
      return [closed(startNearOrigin(pts))];
    }
    case 'star': {
      const n = Math.max(3, Math.round(p.sides)), k = Math.min(0.95, Math.max(0.1, p.inner));
      const pts: Pt[] = [];
      for (let i = 0; i < n * 2; i++) pts.push(onEllipse(Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, i % 2 ? k : 1));
      return [closed(startNearOrigin(pts))];
    }
    case 'svg': return p.svg ? fitSvg(p.svg.strokes, w, h, p.rotation) : [];
  }
}

const closed = (pts: Pt[]): Polyline => [...pts, pts[0]];

/** Rotate the vertex list so the pen starts at the vertex nearest the drag origin. */
function startNearOrigin(pts: Pt[]): Pt[] {
  let best = 0, d = Infinity;
  pts.forEach(([x, y], i) => { const m = x * x + y * y; if (m < d) { d = m; best = i; } });
  return [...pts.slice(best), ...pts.slice(0, best)];
}
