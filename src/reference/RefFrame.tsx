import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { resizeTick } from '../app/resize';

const MIN_PX = 24;   // smallest the reference can be scaled to, in CSS px

/** A rectangle in client (CSS) px. */
interface Box { l: number; t: number; w: number; h: number }

type Gesture =
  | { kind: 'move'; start: Box; x: number; y: number }
  | { kind: 'corner'; start: Box; ax: number; ay: number; sx: number; sy: number }
  | { kind: 'pinch'; start: Box; mx: number; my: number; dist: number };

/** Scale the box by `s` about the client point (cx, cy), keeping a sensible minimum. */
function scaleAbout(b: Box, s: number, cx: number, cy: number): Box {
  s = Math.max(s, MIN_PX / Math.min(b.w, b.h));
  return { l: cx + (b.l - cx) * s, t: cy + (b.t - cy) * s, w: b.w * s, h: b.h * s };
}

/** The reference image's move / scale frame: drag to move, corners / wheel / pinch to scale. */
export function RefFrame() {
  const app = useApp();
  const ref = app.reference;
  const { engine } = app;
  const el = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  const show = ref.adjusting.value && ref.has.value;
  resizeTick.value;   // re-place the frame after a resize
  const r = ref.rect.value;
  const [l, t] = engine.docToClient(r.x, r.y + r.h);
  const [rr, b] = engine.docToClient(r.x + r.w, r.y);
  const box = (): Box => ({ l, t, w: rr - l, h: b - t });

  function setBox(bx: Box) {
    const [x0, y0] = engine.clientToDoc(bx.l, bx.t + bx.h);
    const [x1, y1] = engine.clientToDoc(bx.l + bx.w, bx.t);
    ref.rect.value = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function beginGesture(corner?: string) {
    const start = box();
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, c] = pts;
      gesture.current = { kind: 'pinch', start, mx: (a.x + c.x) / 2, my: (a.y + c.y) / 2, dist: Math.max(1, Math.hypot(a.x - c.x, a.y - c.y)) };
    } else if (corner) {
      // the opposite corner stays put; sx / sy say which way the box grows from it
      const sx = corner.includes('e') ? 1 : -1, sy = corner.includes('s') ? 1 : -1;
      gesture.current = { kind: 'corner', start, ax: sx > 0 ? start.l : start.l + start.w, ay: sy > 0 ? start.t : start.t + start.h, sx, sy };
    } else {
      gesture.current = { kind: 'move', start, x: pts[0].x, y: pts[0].y };
    }
  }

  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    try { el.current!.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginGesture((e.target as HTMLElement).dataset.corner);
  };
  const onMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!pointers.current.has(e.pointerId) || !g) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.kind === 'move') {
      setBox({ ...g.start, l: g.start.l + e.clientX - g.x, t: g.start.t + e.clientY - g.y });
    } else if (g.kind === 'corner') {
      const s = Math.max((g.sx * (e.clientX - g.ax)) / g.start.w, (g.sy * (e.clientY - g.ay)) / g.start.h, MIN_PX / Math.min(g.start.w, g.start.h));
      const w = g.start.w * s, h = g.start.h * s;
      setBox({ l: g.sx > 0 ? g.ax : g.ax - w, t: g.sy > 0 ? g.ay : g.ay - h, w, h });
    } else {
      const [a, c] = [...pointers.current.values()];
      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      const s = Math.hypot(a.x - c.x, a.y - c.y) / g.dist;
      const scaled = scaleAbout(g.start, s, g.mx, g.my);
      setBox({ ...scaled, l: scaled.l + mx - g.mx, t: scaled.t + my - g.my });
    }
  };
  const release = (e: PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    // a pinch that loses a finger carries on as a move with the one left
    if (pointers.current.size) beginGesture(); else gesture.current = null;
  };

  // wheel must be non-passive to stop the page zooming; attach it by hand
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // trackpad pinches arrive as ctrl+wheel with small deltas
      const s = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setBox(scaleAbout(box(), s, e.clientX, e.clientY));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  });

  // leaving adjust mode drops any half-finished gesture
  useEffect(() => { if (!show) { pointers.current.clear(); gesture.current = null; } }, [show]);

  return (
    <div ref={el} class="ref-frame" hidden={!show} style={{ left: `${l}px`, top: `${t}px`, width: `${rr - l}px`, height: `${b - t}px` }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={release} onPointerCancel={release}>
      {['nw', 'ne', 'sw', 'se'].map(c => <i key={c} data-corner={c} />)}
    </div>
  );
}
