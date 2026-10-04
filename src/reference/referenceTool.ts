import type { WatercolorEngine } from '../engine/Engine';
import { icon } from '../ui/icons';
import { decodeImage, IMAGE_ACCEPT } from './decode';

const KEY = 'watercolor.reference';
const MIN_PX = 24;   // smallest the reference can be scaled to, in CSS px

interface Stored { opacity: number; visible: boolean }

/** A rectangle in client (CSS) px. */
interface Box { l: number; t: number; w: number; h: number }

export interface ReferenceController {
  panel: HTMLElement;
  /** Is the move / scale frame up? */
  readonly adjusting: boolean;
  load(file: File): Promise<boolean>;
  toggleVisible(): void;
  /** Leave move / scale mode; true if it was on. */
  stopAdjust(): boolean;
  /** Re-place the frame after the window or document changed. */
  layout(): void;
}

/**
 * A photo or sketch shown under the paint to work from. It lives only on screen: the
 * engine never draws it into an export. While adjusting, a frame over it moves (drag),
 * scales (corners, wheel, pinch) and painting is paused.
 */
export function createReference(
  engine: WatercolorEngine, root: HTMLElement, showToast: (s: string) => void,
  onAdjust: (on: boolean) => void,
): ReferenceController {
  let stored: Stored = { opacity: 0.5, visible: true };
  try { stored = { ...stored, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { /* storage blocked */ }
  engine.referenceOpacity = stored.opacity;
  engine.referenceVisible = stored.visible;
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ opacity: engine.referenceOpacity, visible: engine.referenceVisible })); } catch { /* storage blocked */ }
  };

  const panel = document.createElement('div');
  panel.className = 'panel popover reference';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Reference image');
  panel.innerHTML = `
    <div class="pop-head"><span>Reference</span><span class="sub">Shown under the paint to work from. Never exported.</span></div>
    <button class="import" data-ref="import">${icon('plus', 16)}<span>Import image…</span></button>
    <label class="slider"><span>Opacity</span><input type="range" min="0" max="1" step="0.01" data-ref="opacity"></label>
    <div class="seg">
      <button data-ref="show" title="Show or hide the reference (R)">Show</button>
      <button data-ref="adjust" title="Drag to move, drag a corner or pinch to scale">Move</button>
      <button data-ref="fit" title="Fit to the paper">Fit</button>
      <button data-ref="remove" title="Remove the reference">Remove</button>
    </div>
    <input type="file" accept="${IMAGE_ACCEPT}" hidden>`;
  root.appendChild(panel);

  const fileInput = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
  const opacity = panel.querySelector<HTMLInputElement>('[data-ref="opacity"]')!;
  const btn = (k: string) => panel.querySelector<HTMLButtonElement>(`[data-ref="${k}"]`)!;

  const frame = document.createElement('div');
  frame.className = 'ref-frame';
  frame.hidden = true;
  frame.innerHTML = ['nw', 'ne', 'sw', 'se'].map(c => `<i data-corner="${c}"></i>`).join('');
  root.appendChild(frame);

  let adjusting = false;

  function render() {
    const has = engine.hasReference;
    opacity.value = String(engine.referenceOpacity);
    opacity.disabled = !has;
    for (const k of ['show', 'adjust', 'fit', 'remove']) btn(k).disabled = !has;
    btn('show').classList.toggle('on', has && engine.referenceVisible);
    btn('adjust').classList.toggle('on', adjusting);
    btn('import').querySelector('span')!.textContent = has ? 'Replace image…' : 'Import image…';
    layout();
  }

  /* ------------------------------------------------- doc uv <-> client box */

  function box(): Box {
    const r = engine.referenceRect;
    const [l, t] = engine.docToClient(r.x, r.y + r.h);
    const [rr, b] = engine.docToClient(r.x + r.w, r.y);
    return { l, t, w: rr - l, h: b - t };
  }

  function setBox(b: Box) {
    const [x0, y0] = engine.clientToDoc(b.l, b.t + b.h);
    const [x1, y1] = engine.clientToDoc(b.l + b.w, b.t);
    engine.referenceRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    layout();
  }

  function layout() {
    frame.hidden = !adjusting || !engine.hasReference;
    if (frame.hidden) return;
    const b = box();
    Object.assign(frame.style, { left: `${b.l}px`, top: `${b.t}px`, width: `${b.w}px`, height: `${b.h}px` });
  }

  /** Scale the box by `s` about the client point (cx, cy), keeping a sensible minimum. */
  function scaleAbout(b: Box, s: number, cx: number, cy: number): Box {
    s = Math.max(s, MIN_PX / Math.min(b.w, b.h));
    return { l: cx + (b.l - cx) * s, t: cy + (b.t - cy) * s, w: b.w * s, h: b.h * s };
  }

  /* ------------------------------------------------------------- gestures */

  const pointers = new Map<number, { x: number; y: number }>();
  let gesture:
    | { kind: 'move'; start: Box; x: number; y: number }
    | { kind: 'corner'; start: Box; ax: number; ay: number; sx: number; sy: number }
    | { kind: 'pinch'; start: Box; mx: number; my: number; dist: number }
    | null = null;

  function beginGesture(corner?: string) {
    const start = box();
    const pts = [...pointers.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      gesture = { kind: 'pinch', start, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    } else if (corner) {
      // the opposite corner stays put; sx / sy say which way the box grows from it
      const sx = corner.includes('e') ? 1 : -1, sy = corner.includes('s') ? 1 : -1;
      gesture = { kind: 'corner', start, ax: sx > 0 ? start.l : start.l + start.w, ay: sy > 0 ? start.t : start.t + start.h, sx, sy };
    } else {
      gesture = { kind: 'move', start, x: pts[0].x, y: pts[0].y };
    }
  }

  frame.addEventListener('pointerdown', e => {
    e.preventDefault();
    frame.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginGesture((e.target as HTMLElement).dataset.corner);
  });

  frame.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture;
    if (g.kind === 'move') {
      setBox({ ...g.start, l: g.start.l + e.clientX - g.x, t: g.start.t + e.clientY - g.y });
    } else if (g.kind === 'corner') {
      const s = Math.max((g.sx * (e.clientX - g.ax)) / g.start.w, (g.sy * (e.clientY - g.ay)) / g.start.h, MIN_PX / Math.min(g.start.w, g.start.h));
      const w = g.start.w * s, h = g.start.h * s;
      setBox({ l: g.sx > 0 ? g.ax : g.ax - w, t: g.sy > 0 ? g.ay : g.ay - h, w, h });
    } else {
      const [a, b] = [...pointers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = Math.hypot(a.x - b.x, a.y - b.y) / g.dist;
      const scaled = scaleAbout(g.start, s, g.mx, g.my);
      setBox({ ...scaled, l: scaled.l + mx - g.mx, t: scaled.t + my - g.my });
    }
  });

  const release = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    // a pinch that loses a finger carries on as a move with the one left
    if (pointers.size) beginGesture(); else gesture = null;
  };
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);

  frame.addEventListener('wheel', e => {
    e.preventDefault();
    // trackpad pinches arrive as ctrl+wheel with small deltas
    const s = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setBox(scaleAbout(box(), s, e.clientX, e.clientY));
  }, { passive: false });

  /* ------------------------------------------------------------ actions */

  function setAdjust(on: boolean) {
    on &&= engine.hasReference;
    if (on === adjusting) return;
    adjusting = on;
    pointers.clear();
    gesture = null;
    if (on && !engine.referenceVisible) { engine.referenceVisible = true; persist(); }
    onAdjust(on);
    render();
  }

  async function load(file: File): Promise<boolean> {
    try {
      const bmp = await decodeImage(file);
      engine.setReference(bmp);
      bmp.close();
      if (!engine.referenceVisible) { engine.referenceVisible = true; persist(); }
      render();
      showToast('Reference added');
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read that image');
      return false;
    }
  }

  panel.addEventListener('click', e => {
    const k = (e.target as Element).closest<HTMLElement>('[data-ref]')?.dataset.ref;
    switch (k) {
      case 'import': fileInput.click(); break;
      case 'show': engine.referenceVisible = !engine.referenceVisible; persist(); render(); break;
      case 'adjust': setAdjust(!adjusting); break;
      case 'fit': engine.fitReference(); render(); break;
      case 'remove': setAdjust(false); engine.setReference(null); render(); break;
    }
  });

  opacity.addEventListener('input', () => {
    engine.referenceOpacity = Number(opacity.value);
    if (!engine.referenceVisible) engine.referenceVisible = true;
    persist();
    render();
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void load(f);
  });

  render();

  return {
    panel,
    get adjusting() { return adjusting; },
    load,
    toggleVisible() {
      if (!engine.hasReference) return;
      engine.referenceVisible = !engine.referenceVisible;
      if (!engine.referenceVisible) setAdjust(false);
      persist();
      render();
      showToast(engine.referenceVisible ? 'Reference shown' : 'Reference hidden');
    },
    stopAdjust() { const was = adjusting; setAdjust(false); return was; },
    layout,
  };
}
