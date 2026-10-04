import type { Tool, WatercolorEngine } from '../engine/Engine';
import { icon } from '../ui/icons';
import { ATLAS, DEFAULT_FONT, FONTS, fontGroups, fontLabel, fontUrl } from './fonts';
import { loadFont, type Font } from './fontLoader';
import { layoutText, type Align, type TextLayout } from './layout';
import { penSpeed, StrokeWriter } from '../draw/StrokeWriter';
import { createGhost } from '../draw/ghost';

// The Text tool: a panel to compose one line of text in a single-stroke font,
// a ghost of it under the pointer, and on tap the TextWriter draws it on the
// paper, slowly, with the current brush and pigment.

export interface TextSettings {
  text: string;
  font: string;
  tool: Tool;
  align: Align;
  size: number;      // 0..1 slider
  speed: number;     // 0..1 slider
  pressure: number;  // 0.05..1
  taper: number;     // 0..1
  spacing: number;   // em, -0.1..0.4
  wobble: number;    // 0..1
}

const KEY = 'watercolor.text';
const DEFAULTS: TextSettings = {
  text: 'hello', font: DEFAULT_FONT, tool: 'brush', align: 'left',
  size: 0.4, speed: 0.5, pressure: 0.6, taper: 0.5, spacing: 0, wobble: 0.2,
};

const SLIDERS: { key: keyof TextSettings; label: string; min: number; max: number; hint: string }[] = [
  { key: 'size', label: 'Size', min: 0, max: 1, hint: 'Letter height' },
  { key: 'speed', label: 'Speed', min: 0, max: 1, hint: 'How fast the brush travels' },
  { key: 'pressure', label: 'Pressure', min: 0.05, max: 1, hint: 'How hard the brush presses' },
  { key: 'taper', label: 'Taper', min: 0, max: 1, hint: 'Lighter touch at the ends of each stroke' },
  { key: 'spacing', label: 'Spacing', min: -0.1, max: 0.4, hint: 'Extra space between letters' },
  { key: 'wobble', label: 'Wobble', min: 0, max: 1, hint: 'Hand tremor' },
];

const TOOLS: { id: Tool; label: string }[] = [{ id: 'brush', label: 'Brush' }, { id: 'pen', label: 'Pen' }, { id: 'water', label: 'Water' }];
const ALIGNS: { id: Align; label: string }[] = [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Right' }];

/** Em height in document heights. */
export const emSize = (v: number) => 0.03 * Math.pow(12, v);

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface TextToolHandle {
  panel: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** Stop writing, if writing. Returns whether anything was stopped. */
  stop(): boolean;
  readonly writing: boolean;
  readonly active: boolean;
}

export function createTextTool(engine: WatercolorEngine, root: HTMLElement, canvas: HTMLCanvasElement, toast: (s: string) => void): TextToolHandle {
  let settings: TextSettings = { ...DEFAULTS, ...load() };
  if (!FONTS[settings.font]) settings.font = DEFAULT_FONT;
  let font: Font | null = null;
  let layout: TextLayout | null = null;
  let active = false;
  let hover: [number, number] | null = null;     // document uv under the pointer
  const writer = new StrokeWriter(engine);

  /* ---------------------------------------------------------------- markup */

  const panel = document.createElement('div');
  panel.className = 'panel text';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Text');
  const seg = (name: string, items: { id: string; label: string }[]) =>
    `<div class="seg" data-opt="${name}" role="radiogroup">${items.map(i => `<button role="radio" data-value="${i.id}">${i.label}</button>`).join('')}</div>`;
  panel.innerHTML = `
    <div class="library-head">
      <span>Text</span>
      <span class="sub">Tap the paper to write there. Each letter is drawn stroke by stroke with the current brush and pigment.</span>
      <button class="icon" data-action="text-close" title="Close">${icon('close', 16)}</button>
    </div>
    <div class="text-body">
      <input class="text-input" type="text" placeholder="Write something…" maxlength="160" spellcheck="false" autocomplete="off" aria-label="Text to write">
      <div class="fontlist" role="listbox" aria-label="Font">
        ${fontGroups().map(g => `<div class="fontgroup">${esc(g.label)}</div>${g.keys.map(k => {
          const row = ATLAS.row(k);
          return `<div class="fontrow" role="option" data-font="${esc(k)}" title="${esc(fontLabel(k))}" tabindex="0" aria-selected="false">${
            row >= 0 ? `<i style="background-position:0 ${-row * ATLAS.rowHeight}px"></i>` : `<span>${esc(fontLabel(k))}</span>`}</div>`;
        }).join('')}`).join('')}
      </div>
      <div class="text-rows">
        <label class="slider"><span>Draw with</span>${seg('tool', TOOLS)}</label>
        <label class="slider"><span>Anchor</span>${seg('align', ALIGNS)}</label>
        ${SLIDERS.map(s => `<label class="slider" title="${s.hint}"><span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="0.01" data-opt="${s.key}"></label>`).join('')}
      </div>
      <div class="text-foot">
        <span class="status"></span>
        <button class="stop" data-action="text-stop" hidden>${icon('close', 14)}<span>Stop</span></button>
        <a class="credit" target="_blank" rel="noopener"></a>
      </div>
    </div>`;
  root.appendChild(panel);

  const ghost = createGhost(root);   // the text under the pointer

  const input = panel.querySelector<HTMLInputElement>('.text-input')!;
  const fontList = panel.querySelector<HTMLElement>('.fontlist')!;
  const status = panel.querySelector<HTMLElement>('.status')!;
  const stopBtn = panel.querySelector<HTMLButtonElement>('.stop')!;
  const credit = panel.querySelector<HTMLAnchorElement>('.credit')!;
  const sliders = [...panel.querySelectorAll<HTMLInputElement>('input[type="range"][data-opt]')];
  const style = document.createElement('style');
  style.textContent = `.fontrow i { background-image: url("${ATLAS.url}"); }`;
  document.head.appendChild(style);

  /* ------------------------------------------------------------- rendering */

  function render() {
    input.value = settings.text;
    for (const s of sliders) s.value = String(settings[s.dataset.opt as keyof TextSettings]);
    for (const el of panel.querySelectorAll<HTMLElement>('.seg')) {
      const v = settings[el.dataset.opt as 'tool' | 'align'];
      for (const b of el.querySelectorAll<HTMLElement>('button')) {
        b.classList.toggle('on', b.dataset.value === v);
        b.setAttribute('aria-checked', String(b.dataset.value === v));
      }
    }
    for (const el of fontList.querySelectorAll<HTMLElement>('.fontrow')) {
      const on = el.dataset.font === settings.font;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    }
    credit.textContent = `${fontLabel(settings.font)} ↗`;
    credit.href = FONTS[settings.font].source;
    credit.title = 'Font source';
    renderStatus();
  }

  function renderStatus(progress?: [number, number]) {
    stopBtn.hidden = !writer.busy;
    if (writer.busy) status.textContent = progress ? `Writing… ${progress[0]} / ${progress[1]} strokes` : 'Writing…';
    else if (!font) status.textContent = 'Loading font…';
    else if (!settings.text.trim()) status.textContent = 'Type something to write';
    else if (!layout?.strokes.length) status.textContent = 'This font has none of those characters';
    else status.textContent = active ? 'Tap the paper to write' : '';
  }

  /** Client-space path of the ghost at the hovered anchor. */
  function renderGhost() {
    if (!active || !layout || !hover || writer.busy) { ghost.hide(); return; }
    const em = emSize(settings.size), a = engine.aspect;
    const [ax, ay] = hover;
    let d = '';
    for (const pl of layout.strokes) {
      pl.forEach(([x, y], i) => {
        const [cx, cy] = engine.docToClient(ax + (x * em) / a, ay - y * em);
        d += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`;
      });
    }
    // baseline tick at the anchor
    const [bx, by] = engine.docToClient(ax, ay);
    d += `M${(bx - 6).toFixed(1)} ${by.toFixed(1)}h12M${bx.toFixed(1)} ${(by - 6).toFixed(1)}v12`;
    ghost.set(d);
  }

  /* --------------------------------------------------------------- actions */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  }

  function relayout() {
    layout = font ? layoutText(settings.text, font, settings.spacing, settings.align) : null;
    renderStatus();
    renderGhost();
  }

  let fontGen = 0;
  function useFont(key: string) {
    const gen = ++fontGen;
    font = null;
    relayout();
    loadFont(key, fontUrl(key)).then(f => {
      if (gen !== fontGen) return;
      font = f;
      relayout();
    }).catch(e => {
      if (gen !== fontGen) return;
      toast(e instanceof Error ? e.message : 'Could not load that font');
    });
  }

  function set(p: Partial<TextSettings>) {
    const fontChanged = p.font !== undefined && p.font !== settings.font;
    settings = { ...settings, ...p };
    save();
    render();
    if (fontChanged) {
      useFont(settings.font);
      fontList.querySelector<HTMLElement>('.fontrow.on')?.scrollIntoView({ block: 'nearest' });
    } else relayout();
  }

  function writeAt(anchor: [number, number]) {
    if (!layout?.strokes.length || writer.busy) return;
    const em = emSize(settings.size);
    const opts = {
      tool: settings.tool, ref: em, speed: penSpeed(settings.speed),
      pressure: settings.pressure, taper: settings.taper, wobble: settings.wobble,
    };
    // em units (y down) -> document heights relative to the anchor (y up)
    const strokes = layout.strokes.map(pl => pl.map(([x, y]) => [x * em, -y * em] as [number, number]));
    writer.write(strokes, anchor, opts, {
      onProgress: (done, total) => renderStatus([done, total]),
      onDone: () => { renderStatus(); renderGhost(); },
    });
    renderStatus([0, layout.strokes.length]);
    renderGhost();
  }

  /* ---------------------------------------------------------------- wiring */

  input.addEventListener('input', () => set({ text: input.value }));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });

  panel.addEventListener('input', e => {
    const s = e.target as HTMLInputElement;
    if (s.type === 'range' && s.dataset.opt) set({ [s.dataset.opt]: Number(s.value) } as Partial<TextSettings>);
  });

  panel.addEventListener('click', e => {
    const el = (e.target as Element).closest<HTMLElement>('[data-font], .seg button, [data-action]');
    if (!el) return;
    if (el.dataset.font) set({ font: el.dataset.font });
    else if (el.dataset.value) set({ [el.parentElement!.dataset.opt!]: el.dataset.value } as Partial<TextSettings>);
    else if (el.dataset.action === 'text-stop') writer.cancel();
  });

  fontList.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as Element).closest<HTMLElement>('[data-font]');
    if (el?.dataset.font) { e.preventDefault(); set({ font: el.dataset.font }); }
  });

  // the ghost follows the pointer over the paper and goes when it moves onto a panel
  root.addEventListener('pointermove', e => {
    if (!active) return;
    hover = e.target === canvas ? engine.clientToDoc(e.clientX, e.clientY) : null;
    renderGhost();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; renderGhost(); });
  canvas.addEventListener('pointerdown', e => {
    if (!active) return;
    if (writer.busy) { toast('Still writing… press Stop or Esc'); return; }
    if (!font) { toast('Loading font…'); return; }
    if (!layout?.strokes.length) { input.focus(); toast('Type something first'); return; }
    hover = engine.clientToDoc(e.clientX, e.clientY);
    writeAt(hover);
  });
  window.addEventListener('resize', renderGhost);

  render();
  useFont(settings.font);

  return {
    panel,
    get writing() { return writer.busy; },
    get active() { return active; },
    activate() {
      active = true;
      panel.hidden = false;
      canvas.classList.add('placing');
      renderStatus();
      fontList.querySelector<HTMLElement>('.fontrow.on')?.scrollIntoView({ block: 'center' });
      if (!settings.text.trim()) input.focus();
    },
    deactivate() {
      active = false;
      writer.cancel();
      panel.hidden = true;
      canvas.classList.remove('placing');
      hover = null;
      renderGhost();
    },
    stop() {
      if (!writer.busy) return false;
      writer.cancel();
      return true;
    },
  };
}

function load(): Partial<TextSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<TextSettings>;
    return typeof v === 'object' && v ? v : {};
  } catch { return {}; }
}
