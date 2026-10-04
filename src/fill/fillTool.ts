import type { WatercolorEngine } from '../engine/Engine';
import { icon } from '../ui/icons';
import { distanceField, pickRegion } from './region';

// The Fill tool (paint bucket): tap an area of the paper and a wash of the current
// pigment spreads out from the tap across every connected pixel of similar colour.
// q-floodfill picks the region on a flat readback of the paper; the engine then
// deposits pigment and water band by band along a distance field, so the fill is
// animated and the live wet simulation bleeds it like any other wash.

export interface FillSettings {
  mode: 'paint' | 'water';
  tolerance: number;   // 0..1 -> colour difference
  water: number;       // 0..1 wetness of the wash
  strength: number;    // 0..1.5 pigment amount
  speed: number;       // 0..1 -> px / s
  soft: number;        // 0..1 -> feathered edge width
}

const KEY = 'watercolor.fill';
const DEFAULTS: FillSettings = { mode: 'paint', tolerance: 0.25, water: 0.6, strength: 1, speed: 0.5, soft: 0.3 };

const SLIDERS: { key: keyof FillSettings; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: 'tolerance', label: 'Tolerance', min: 0, max: 1, step: 0.01, hint: 'How different a colour may be and still count as the same area' },
  { key: 'speed', label: 'Speed', min: 0, max: 1, step: 0.01, hint: 'How fast the wash spreads' },
  { key: 'water', label: 'Water', min: 0, max: 1, step: 0.01, hint: 'How wet the wash is' },
  { key: 'strength', label: 'Amount', min: 0, max: 1.5, step: 0.01, hint: 'Pigment laid down (on top of the Pigment setting)' },
  { key: 'soft', label: 'Soft edge', min: 0, max: 1, step: 0.01, hint: 'Feather the wash at the edge of the area' },
];

const MODES: { id: FillSettings['mode']; label: string }[] = [{ id: 'paint', label: 'Paint' }, { id: 'water', label: 'Water' }];

/** Slider 0..1 -> px/s of front travel (about 120 .. 3000). */
const fillSpeed = (v: number) => 120 * Math.pow(25, v);
const EDGE_CAP = 48;

export interface FillToolHandle {
  panel: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** Stop a running fill (the paint laid so far stays). Returns whether anything was stopped. */
  stop(): boolean;
  readonly active: boolean;
  readonly busy: boolean;
}

export function createFillTool(engine: WatercolorEngine, root: HTMLElement, canvas: HTMLCanvasElement, toast: (s: string) => void): FillToolHandle {
  let settings: FillSettings = { ...DEFAULTS, ...load() };
  if (!MODES.some(m => m.id === settings.mode)) settings.mode = DEFAULTS.mode;
  let active = false;
  let press: { id: number; x: number; y: number } | null = null;
  let run: { raf: number; from: number; maxDist: number; last: number } | null = null;
  let picking = false;

  /* ---------------------------------------------------------------- markup */

  const panel = document.createElement('div');
  panel.className = 'panel text fill';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Fill');
  panel.innerHTML = `
    <div class="library-head">
      <span>Fill</span>
      <span class="sub">Tap an area of the paper; a wash of the current pigment spreads out from the tap until it meets a different colour.</span>
      <button class="icon" data-action="fill-close" title="Close">${icon('close', 16)}</button>
    </div>
    <div class="text-body">
      <div class="text-rows">
        <label class="slider"><span>Fill with</span><div class="seg" data-opt="mode" role="radiogroup">${MODES.map(m => `<button role="radio" data-value="${m.id}">${m.label}</button>`).join('')}</div></label>
        ${SLIDERS.map(s => `<label class="slider" data-slider="${s.key}" title="${s.hint}"><span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-opt="${s.key}"></label>`).join('')}
      </div>
      <div class="text-foot">
        <span class="status"></span>
        <button class="stop" data-action="fill-stop" hidden>${icon('close', 14)}<span>Stop</span></button>
      </div>
    </div>`;
  root.appendChild(panel);

  const status = panel.querySelector<HTMLElement>('.status')!;
  const stopBtn = panel.querySelector<HTMLButtonElement>('.stop')!;
  const sliders = [...panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-opt]')];

  /* ------------------------------------------------------------- rendering */

  function render() {
    for (const s of sliders) s.value = String(settings[s.dataset.opt as keyof FillSettings]);
    panel.querySelector<HTMLElement>('[data-slider="strength"]')!.hidden = settings.mode === 'water';
    for (const b of panel.querySelectorAll<HTMLElement>('.seg button')) {
      const on = b.dataset.value === settings.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    renderStatus();
  }

  function renderStatus() {
    stopBtn.hidden = !run;
    if (run) status.textContent = `Filling… ${Math.round(Math.min(1, Math.max(0, run.from) / Math.max(run.maxDist, 1e-6)) * 100)}%`;
    else if (picking) status.textContent = 'Finding the area…';
    else if (!active) status.textContent = '';
    else status.textContent = settings.mode === 'water' ? 'Tap an area to wet it' : 'Tap an area to fill it';
  }

  /* --------------------------------------------------------------- actions */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  }

  function set(p: Partial<FillSettings>) {
    settings = { ...settings, ...p };
    save();
    render();
  }

  const busy = () => !!run || picking;

  function fillAt(clientX: number, clientY: number) {
    const [u, v] = engine.clientToDoc(clientX, clientY);
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const [dw, dh] = engine.docSize;
    const px = Math.min(dw - 1, Math.floor(u * dw)), py = Math.min(dh - 1, Math.floor(v * dh));
    picking = true;
    renderStatus();
    // let the status paint before the synchronous region search
    requestAnimationFrame(() => {
      picking = false;
      if (!active) { renderStatus(); return; }
      const flat = engine.readFlat();
      const tol = Math.round(settings.tolerance * settings.tolerance * 255);   // 0.25 -> 16 of 255 per channel
      const mask = pickRegion({ width: dw, height: dh, data: new Uint8ClampedArray(flat.buffer) }, px, py, tol);
      if (!mask) { toast('Nothing to fill here'); renderStatus(); return; }
      const region = distanceField(mask, dw, dh, px, py, EDGE_CAP);
      if (region.count < 4) { toast('That area is too small to fill'); renderStatus(); return; }
      if (!engine.fillBegin(region.field, region.bbox)) { toast('Wait for the stroke to finish'); renderStatus(); return; }
      run = { raf: 0, from: -0.5, maxDist: region.maxDist + engine.fillMargin, last: performance.now() };
      run.raf = requestAnimationFrame(frame);
      renderStatus();
    });
  }

  function frame(now: number) {
    if (!run) return;
    const dt = Math.min(0.1, Math.max(0, (now - run.last) / 1000));
    run.last = now;
    const to = Math.min(run.maxDist, run.from + fillSpeed(settings.speed) * dt);
    const ok = engine.fillStep(run.from, to, {
      strength: settings.strength, water: settings.water, soft: settings.soft * 40, paint: settings.mode === 'paint',
    });
    if (!ok) { finish(); return; }   // undone, cleared or interrupted by another action
    run.from = to;
    if (to >= run.maxDist) { engine.fillEnd(); finish(); return; }
    run.raf = requestAnimationFrame(frame);
    renderStatus();
  }

  function finish() {
    if (run) cancelAnimationFrame(run.raf);
    run = null;
    renderStatus();
  }

  function cancel(): boolean {
    if (!run) return false;
    engine.fillEnd();
    finish();
    return true;
  }

  /* ---------------------------------------------------------------- wiring */

  panel.addEventListener('input', e => {
    const s = e.target as HTMLInputElement;
    if (s.type === 'range' && s.dataset.opt) set({ [s.dataset.opt]: Number(s.value) } as Partial<FillSettings>);
  });

  panel.addEventListener('click', e => {
    const el = (e.target as Element).closest<HTMLElement>('.seg button, [data-action]');
    if (!el) return;
    if (el.dataset.value !== undefined) set({ mode: el.dataset.value as FillSettings['mode'] });
    else if (el.dataset.action === 'fill-stop') cancel();
  });

  canvas.addEventListener('pointerdown', e => {
    if (!active || press) return;
    if (busy()) { toast('Still filling… press Stop or Esc'); return; }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  const up = (e: PointerEvent) => {
    if (!active || !press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    try { canvas.releasePointerCapture(p.id); } catch { /* already released */ }
    if (e.type === 'pointercancel') return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) { toast('Tap, rather than drag, to fill an area'); return; }
    fillAt(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  render();

  return {
    panel,
    get active() { return active; },
    get busy() { return busy(); },
    activate() {
      active = true;
      panel.hidden = false;
      canvas.classList.add('placing');
      renderStatus();
    },
    deactivate() {
      active = false;
      press = null;
      cancel();
      panel.hidden = true;
      canvas.classList.remove('placing');
    },
    stop: () => cancel(),
  };
}

function load(): Partial<FillSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<FillSettings>) : {};
  } catch {
    return {};
  }
}
