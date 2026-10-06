import type { WatercolorEngine } from '../engine/Engine';

const LINE_PX = 16;           // a wheel "line" in pixels
const WHEEL_ZOOM = 0.01;      // zoom per pixel of ⌘ / pinch scroll
const WHEEL_STEP_MAX = 25;    // a mouse wheel notch zooms by at most e^(25 * 0.01)

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && t.type !== 'range'));

type Point = { x: number; y: number };
/** Safari's trackpad pinch (not in the DOM typings). */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/**
 * Figma-style navigation of the sheet: scrolling pans, pinching or ⌘/Ctrl-scrolling
 * zooms about the pointer, Space-drag or middle-drag pans, and two fingers pan and
 * pinch on touch screens. Pointer listeners run in the capture phase so a pan never
 * reaches the engine or the panel tools as a stroke.
 */
export class Navigation {
  private disposers: (() => void)[] = [];
  private space = false;
  private drag: { id: number; x: number; y: number } | null = null;
  private touches = new Map<number, Point>();
  private touchNav: { x: number; y: number; d: number } | null = null;
  private gestureScale = 1;

  constructor(private engine: WatercolorEngine, private canvas: HTMLCanvasElement) {
    const on = (el: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'wheel', this.onWheel, { passive: false });
    on(window, 'keydown', this.onKeyDown);
    on(window, 'keyup', this.onKeyUp);
    on(window, 'blur', this.reset);
    on(window, 'pointerdown', this.onDown, { capture: true });
    on(window, 'pointermove', this.onMove, { capture: true });
    on(window, 'pointerup', this.onUp, { capture: true });
    on(window, 'pointercancel', this.onUp, { capture: true });
    // Safari reports trackpad pinches as gestures rather than ctrl + wheel
    on(window, 'gesturestart', this.onGestureStart, { passive: false });
    on(window, 'gesturechange', this.onGestureChange, { passive: false });
    on(window, 'gestureend', (e: Event) => e.preventDefault(), { passive: false });
  }

  destroy() { this.reset(); this.disposers.forEach(d => d()); }

  /** True while Space is held or a pan / pinch is under way. */
  private sync() {
    const panning = this.drag !== null || this.touchNav !== null;
    this.engine.navigating = this.space || panning;
    document.body.classList.toggle('space-pan', this.space);
    document.body.classList.toggle('panning', panning);
  }

  private reset = () => {
    this.space = false;
    this.drag = null;
    this.touches.clear();
    this.touchNav = null;
    this.sync();
  };

  private onWheel = (e: WheelEvent) => {
    const zoom = e.ctrlKey || e.metaKey;
    if (e.target !== this.canvas) {
      if (zoom) e.preventDefault();   // never zoom the page itself
      return;
    }
    e.preventDefault();
    const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1;
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (zoom) {
      const d = Math.max(-WHEEL_STEP_MAX, Math.min(WHEEL_STEP_MAX, dy));
      this.engine.zoomAt(e.clientX, e.clientY, Math.exp(-d * WHEEL_ZOOM));
    } else {
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      this.engine.panBy(-dx, -dy);
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || isEditable(e.target)) return;
    e.preventDefault();   // no page scroll, no button press
    if (this.space) return;
    this.space = true;
    this.sync();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || !this.space) return;
    e.preventDefault();
    this.space = false;
    this.sync();
  };

  private onDown = (e: PointerEvent) => {
    if (e.target !== this.canvas) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        // a second finger: the first one's dab is taken back and both fingers navigate
        e.stopPropagation();
        if (!this.touchNav) this.engine.abortStroke();
        this.touchNav = this.measure();
        this.sync();
        return;
      }
    }
    if (e.button === 1 || this.space) {
      e.preventDefault();   // no middle-click autoscroll
      e.stopPropagation();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      this.sync();
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (d && e.pointerId === d.id) {
      e.stopPropagation();
      this.engine.panBy(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX; d.y = e.clientY;
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    const prev = this.touchNav;
    if (!prev) return;
    e.stopPropagation();
    const m = this.measure();
    this.engine.panBy(m.x - prev.x, m.y - prev.y);
    if (prev.d > 0 && m.d > 0) this.engine.zoomAt(m.x, m.y, m.d / prev.d);
    this.touchNav = m;
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) {
      e.stopPropagation();
      this.drag = null;
      this.sync();
      return;
    }
    if (!this.touches.delete(e.pointerId) || !this.touchNav) return;
    e.stopPropagation();
    // the fingers left keep panning from where they are, until the last one lifts
    this.touchNav = this.touches.size ? this.measure() : null;
    this.sync();
  };

  /** Midpoint and spread of the fingers down (spread 0 for one finger). */
  private measure() {
    const pts = [...this.touches.values()];
    const [a, b] = pts;
    if (!b) return { x: a.x, y: a.y, d: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private onGestureStart = (e: GestureEvent) => {
    e.preventDefault();
    this.gestureScale = 1;
  };

  private onGestureChange = (e: GestureEvent) => {
    e.preventDefault();
    // on touch screens the pointer pinch above already handles it
    if (this.touches.size || e.target !== this.canvas) return;
    this.engine.zoomAt(e.clientX, e.clientY, e.scale / this.gestureScale);
    this.gestureScale = e.scale;
  };
}
