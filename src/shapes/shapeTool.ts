import type { Tool, WatercolorEngine } from '../engine/Engine';
import { icon } from '../ui/icons';
import { penSpeed, StrokeWriter } from '../draw/StrokeWriter';
import { createGhost } from '../draw/ghost';
import { constrain, fitSvg, hasRotation, hasSides, SHAPES, shapeStrokes, type ShapeKind } from './shapes';
import { importSvg, type ImportedSvg } from './svgImport';

// The Shape tool: pick a shape, drag a box on the paper (a dashed ghost follows),
// and on release the StrokeWriter draws the outline slowly with the current brush.

export interface ShapeSettings {
  kind: ShapeKind;
  tool: Tool;
  lock: boolean;      // keep squares square / circles round / lines on 45° steps
  speed: number;      // 0..1 slider
  pressure: number;   // 0.05..1
  taper: number;      // 0..1
  wobble: number;     // 0..1
  sides: number;      // 3..12
  inner: number;      // 0.2..0.9
  rotation: number;   // 0..360
}

const KEY = 'watercolor.shape';
const DEFAULTS: ShapeSettings = {
  kind: 'rect', tool: 'brush', lock: false,
  speed: 0.5, pressure: 0.6, taper: 0.4, wobble: 0.2, sides: 5, inner: 0.45, rotation: 0,
};

const SLIDERS: { key: keyof ShapeSettings; label: string; min: number; max: number; step: number; hint: string; show?: (k: ShapeKind) => boolean }[] = [
  { key: 'speed', label: 'Speed', min: 0, max: 1, step: 0.01, hint: 'How fast the brush travels' },
  { key: 'pressure', label: 'Pressure', min: 0.05, max: 1, step: 0.01, hint: 'How hard the brush presses' },
  { key: 'taper', label: 'Taper', min: 0, max: 1, step: 0.01, hint: 'Lighter touch at the ends of each stroke' },
  { key: 'wobble', label: 'Wobble', min: 0, max: 1, step: 0.01, hint: 'Hand tremor' },
  { key: 'sides', label: 'Sides', min: 3, max: 12, step: 1, hint: 'Polygon sides / star points', show: hasSides },
  { key: 'inner', label: 'Inner', min: 0.2, max: 0.9, step: 0.01, hint: 'Star inner radius', show: k => k === 'star' },
  { key: 'rotation', label: 'Rotate', min: 0, max: 360, step: 1, hint: 'Rotation in degrees', show: hasRotation },
];

const TOOLS: { id: Tool; label: string }[] = [{ id: 'brush', label: 'Brush' }, { id: 'pen', label: 'Pen' }, { id: 'water', label: 'Water' }];

/** Small outline glyphs for the shape grid (24×24 viewBox). */
const GLYPHS: Record<ShapeKind, string> = {
  line: 'M5 19 19 5',
  arrow: 'M5 19 19 5 M11 5h8v8',
  rect: 'M4.5 6.5h15v11h-15Z',
  ellipse: 'M12 5.5c4.4 0 8 2.9 8 6.5s-3.6 6.5-8 6.5-8-2.9-8-6.5 3.6-6.5 8-6.5Z',
  triangle: 'M12 5 20 19H4Z',
  polygon: 'M12 4.5 19.5 10l-2.9 9H7.4L4.5 10Z',
  star: 'M12 4.5l2.2 5 5.3.5-4 3.6 1.2 5.3L12 16.1l-4.7 2.8 1.2-5.3-4-3.6 5.3-.5Z',
  svg: 'M7 3.5h7l4 4V20.5H7Z M14 3.5v4h4 M9.5 16.5c1.5-4 3.5-4 5 0',
};

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
type Pt = [number, number];

export interface ShapeToolHandle {
  panel: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** Cancel a drag or stop drawing. Returns whether anything was stopped. */
  stop(): boolean;
  /** Load an SVG file as the `svg` shape. Resolves false (after a toast) if it could not be read. */
  loadSvg(file: File): Promise<boolean>;
  readonly active: boolean;
}

export function createShapeTool(engine: WatercolorEngine, root: HTMLElement, canvas: HTMLCanvasElement, toast: (s: string) => void): ShapeToolHandle {
  let settings: ShapeSettings = { ...DEFAULTS, ...load() };
  // the imported file lives for the session only, so a saved `svg` kind starts empty
  if (!SHAPES.some(s => s.id === settings.kind) || settings.kind === 'svg') settings.kind = DEFAULTS.kind;
  let svg: ImportedSvg | null = null;
  let active = false;
  let drag: { id: number; a: Pt; b: Pt; shift: boolean } | null = null;
  const writer = new StrokeWriter(engine);
  const ghost = createGhost(root);

  /* ---------------------------------------------------------------- markup */

  const panel = document.createElement('div');
  panel.className = 'panel text shape';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Shapes');
  panel.innerHTML = `
    <div class="library-head">
      <span>Shapes</span>
      <span class="sub">Drag a box on the paper; when you let go the outline is drawn stroke by stroke with the current brush and pigment.</span>
      <button class="icon" data-action="shape-close" title="Close">${icon('close', 16)}</button>
    </div>
    <div class="text-body">
      <div class="shapes" role="radiogroup" aria-label="Shape">
        ${SHAPES.map(s => `<button role="radio" data-kind="${s.id}" title="${esc(s.hint)}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${GLYPHS[s.id]}"/></svg><span>${s.short ?? s.label}</span></button>`).join('')}
      </div>
      <div class="text-rows">
        <div class="slider svg-row" hidden><span>File</span><div class="svg-file"><span class="svg-name"></span><button class="svg-pick" data-action="svg-pick">Choose…</button></div></div>
        <label class="slider"><span>Draw with</span><div class="seg" data-opt="tool" role="radiogroup">${TOOLS.map(t => `<button role="radio" data-value="${t.id}">${t.label}</button>`).join('')}</div></label>
        <label class="slider"><span>Lock</span><div class="seg" data-opt="lock" role="radiogroup" title="Keep squares square, circles round, lines on 45° steps and SVGs in their own proportions (or hold Shift)"><button role="radio" data-value="false">Free</button><button role="radio" data-value="true">1 : 1</button></div></label>
        ${SLIDERS.map(s => `<label class="slider" data-slider="${s.key}" title="${s.hint}"><span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-opt="${s.key}"></label>`).join('')}
      </div>
      <div class="text-foot">
        <span class="status"></span>
        <button class="stop" data-action="shape-stop" hidden>${icon('close', 14)}<span>Stop</span></button>
      </div>
    </div>
    <input type="file" accept=".svg,image/svg+xml" hidden>`;
  root.appendChild(panel);

  const status = panel.querySelector<HTMLElement>('.status')!;
  const stopBtn = panel.querySelector<HTMLButtonElement>('.stop')!;
  const sliders = [...panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-opt]')];
  const svgRow = panel.querySelector<HTMLElement>('.svg-row')!;
  const svgName = panel.querySelector<HTMLElement>('.svg-name')!;
  const svgPick = panel.querySelector<HTMLButtonElement>('.svg-pick')!;
  const fileInput = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
  /** Shape parameters including the imported file. */
  const params = () => ({ ...settings, svg });

  /* ------------------------------------------------------------- rendering */

  function render() {
    for (const s of sliders) s.value = String(settings[s.dataset.opt as keyof ShapeSettings]);
    for (const s of SLIDERS) panel.querySelector<HTMLElement>(`[data-slider="${s.key}"]`)!.hidden = s.show ? !s.show(settings.kind) : false;
    svgRow.hidden = settings.kind !== 'svg';
    svgName.textContent = svg ? `${svg.name} · ${svg.count} ${svg.count === 1 ? 'stroke' : 'strokes'}` : 'No file yet';
    svgName.title = svg ? svg.name : '';
    svgPick.textContent = svg ? 'Replace…' : 'Choose…';
    for (const b of panel.querySelectorAll<HTMLElement>('.shapes button')) {
      const on = b.dataset.kind === settings.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const el of panel.querySelectorAll<HTMLElement>('.seg')) {
      const v = String(settings[el.dataset.opt as 'tool' | 'lock']);
      for (const b of el.querySelectorAll<HTMLElement>('button')) {
        b.classList.toggle('on', b.dataset.value === v);
        b.setAttribute('aria-checked', String(b.dataset.value === v));
      }
    }
    renderStatus();
  }

  function renderStatus(progress?: [number, number]) {
    stopBtn.hidden = !writer.busy;
    const name = SHAPES.find(s => s.id === settings.kind)!.label.toLowerCase();
    if (writer.busy) status.textContent = progress && progress[1] > 1 ? `Drawing… ${progress[0]} / ${progress[1]} strokes` : 'Drawing…';
    else if (drag) status.textContent = 'Let go to draw';
    else if (!active) status.textContent = '';
    else if (settings.kind === 'svg') status.textContent = svg ? `Drag on the paper to place ${svg.name}` : 'Choose an SVG file, or drop one on the paper';
    else status.textContent = `Drag on the paper to draw a ${name}`;
  }

  /** The drag end, constrained if the lock (or Shift) is on. */
  function endPoint(d: { a: Pt; b: Pt; shift: boolean }): Pt {
    const boxAspect = settings.kind === 'svg' && svg ? svg.aspect : 1;
    return settings.lock !== d.shift ? constrain(settings.kind, d.a, d.b, engine.aspect, boxAspect) : d.b;
  }

  /** Strokes for the ghost: the thinned copy for SVGs, the real thing otherwise. */
  function ghostStrokes(a: Pt, b: Pt, aspect: number) {
    if (settings.kind !== 'svg') return shapeStrokes(settings.kind, a, b, params(), aspect);
    return svg ? fitSvg(svg.ghost, (b[0] - a[0]) * aspect, b[1] - a[1], settings.rotation) : [];
  }

  function renderGhost() {
    if (!active || !drag || writer.busy) { ghost.hide(); return; }
    const a = engine.aspect;
    const [ax, ay] = drag.a;
    let d = '';
    for (const pl of ghostStrokes(drag.a, endPoint(drag), a)) {
      pl.forEach(([x, y], i) => {
        const [cx, cy] = engine.docToClient(ax + x / a, ay + y);
        d += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`;
      });
    }
    ghost.set(d);
  }

  /* --------------------------------------------------------------- actions */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  }

  function set(p: Partial<ShapeSettings>) {
    settings = { ...settings, ...p };
    save();
    render();
    renderGhost();
  }

  function draw(d: { a: Pt; b: Pt; shift: boolean }) {
    const b = endPoint(d);
    const aspect = engine.aspect;
    const w = Math.abs(b[0] - d.a[0]) * aspect, h = Math.abs(b[1] - d.a[1]);
    const strokes = shapeStrokes(settings.kind, d.a, b, params(), aspect);
    if (!strokes.length) return;
    const ref = settings.kind === 'line' || settings.kind === 'arrow' ? Math.hypot(w, h) * 0.5 : Math.max(0.01, Math.min(w, h));
    writer.write(strokes, d.a, {
      tool: settings.tool, ref, speed: penSpeed(settings.speed),
      pressure: settings.pressure, taper: settings.taper, wobble: settings.wobble,
    }, {
      onProgress: (done, total) => renderStatus([done, total]),
      onDone: () => { renderStatus(); renderGhost(); },
    });
    renderStatus([0, strokes.length]);
    renderGhost();
  }

  async function loadSvg(file: File): Promise<boolean> {
    try {
      svg = await importSvg(file);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read that SVG');
      return false;
    }
    set({ kind: 'svg' });
    return true;
  }

  function cancelDrag() {
    if (!drag) return false;
    try { canvas.releasePointerCapture(drag.id); } catch { /* already released */ }
    drag = null;
    renderGhost();
    renderStatus();
    return true;
  }

  /* ---------------------------------------------------------------- wiring */

  panel.addEventListener('input', e => {
    const s = e.target as HTMLInputElement;
    if (s.type === 'range' && s.dataset.opt) set({ [s.dataset.opt]: Number(s.value) } as Partial<ShapeSettings>);
  });

  panel.addEventListener('click', e => {
    const el = (e.target as Element).closest<HTMLElement>('[data-kind], .seg button, [data-action]');
    if (!el) return;
    if (el.dataset.kind) {
      const kind = el.dataset.kind as ShapeKind;
      set({ kind });
      if (kind === 'svg' && !svg) fileInput.click();
    } else if (el.dataset.value !== undefined) {
      const opt = el.parentElement!.dataset.opt!;
      set({ [opt]: opt === 'lock' ? el.dataset.value === 'true' : el.dataset.value } as Partial<ShapeSettings>);
    } else if (el.dataset.action === 'shape-stop') writer.cancel();
    else if (el.dataset.action === 'svg-pick') fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void loadSvg(f);
  });

  canvas.addEventListener('pointerdown', e => {
    if (!active || drag) return;
    if (writer.busy) { toast('Still drawing… press Stop or Esc'); return; }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const a = engine.clientToDoc(e.clientX, e.clientY);
    drag = { id: e.pointerId, a, b: a, shift: e.shiftKey };
    renderStatus();
  });
  canvas.addEventListener('pointermove', e => {
    if (!active || !drag || e.pointerId !== drag.id) return;
    drag.b = engine.clientToDoc(e.clientX, e.clientY);
    drag.shift = e.shiftKey;
    renderGhost();
  });
  const up = (e: PointerEvent) => {
    if (!active || !drag || e.pointerId !== drag.id) return;
    const d = drag;
    d.b = engine.clientToDoc(e.clientX, e.clientY);
    d.shift = e.shiftKey;
    cancelDrag();
    if (e.type === 'pointercancel') return;
    const [x0, y0] = engine.docToClient(...d.a), [x1, y1] = engine.docToClient(...d.b);
    if (settings.kind === 'svg' && !svg) { fileInput.click(); return; }
    if (Math.hypot(x1 - x0, y1 - y0) < 6) { toast('Drag to size the shape'); return; }
    draw(d);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  window.addEventListener('resize', renderGhost);

  render();

  return {
    panel,
    get active() { return active; },
    activate() {
      active = true;
      panel.hidden = false;
      canvas.classList.add('placing');
      renderStatus();
    },
    deactivate() {
      active = false;
      cancelDrag();
      writer.cancel();
      panel.hidden = true;
      canvas.classList.remove('placing');
      ghost.hide();
    },
    stop() {
      if (cancelDrag()) return true;
      if (!writer.busy) return false;
      writer.cancel();
      return true;
    },
    loadSvg,
  };
}

function load(): Partial<ShapeSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<ShapeSettings>;
    return typeof v === 'object' && v ? v : {};
  } catch { return {}; }
}
