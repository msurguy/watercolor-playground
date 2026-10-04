import { BRUSH_PRESETS, buildBrush, type Brush } from './engine/brushes';
import { DEFAULT_PARAMS, WatercolorEngine, type Params, type Tool } from './engine/Engine';
import { mixToHex } from './engine/spectral';
import { PALETTE, customEntry, type PaletteEntry } from './palette';
import { loadCustomBrushes, makeCustomBrush, saveCustomBrushes, tipFromImage } from './ui/customBrushes';
import { icon } from './ui/icons';
import { drawStroke, drawThumb, forgetTipImages } from './ui/preview';
import { createTextTool } from './text/textTool';
import { createShapeTool } from './shapes/shapeTool';
import { createFillTool } from './fill/fillTool';
import { isSvgFile } from './shapes/svgImport';
import { createReference } from './reference/referenceTool';
import { isRasterFile } from './reference/decode';
import { createExportPanel } from './export/exportPanel';
import './styles.css';

/** Engine tools plus the text, shape and fill tools, which drive the engine themselves. */
type UiTool = Tool | 'text' | 'shape' | 'fill';
type PanelTool = Exclude<UiTool, Tool>;

const TOOLS: { id: UiTool; label: string; key: string; hint: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B', hint: 'Wet paint: pigment and water' },
  { id: 'water', label: 'Water', key: 'W', hint: 'Clear water: wets paper, moves paint' },
  { id: 'pen', label: 'Pen', key: 'P', hint: 'Ink line in the current colour' },
  { id: 'lift', label: 'Lift', key: 'L', hint: 'Blot with a tissue: lifts wet paint' },
  { id: 'text', label: 'Text', key: 'T', hint: 'Write a line of text, drawn slowly with the current brush' },
  { id: 'shape', label: 'Shape', key: 'G', hint: 'Drag a line, arrow, rectangle, ellipse, polygon or star, drawn slowly with the current brush' },
  { id: 'fill', label: 'Fill', key: 'K', hint: 'Tap an area to flood it with a wash of the current pigment' },
];

const SLIDERS: { key: keyof Params; label: string }[] = [
  { key: 'size', label: 'Size' },
  { key: 'water', label: 'Water' },
  { key: 'load', label: 'Pigment' },
  { key: 'flow', label: 'Flow' },
  { key: 'bleed', label: 'Bleed' },
  { key: 'edge', label: 'Edges' },
  { key: 'granulation', label: 'Grain' },
  { key: 'dry', label: 'Dry speed' },
];

const BRUSH_KEY = 'watercolor.brush';

/** Dab-like swatch: masstone at the centre, diluted towards the rim. */
function swatchBackground(e: PaletteEntry): string {
  if (e.pigment.white) return `radial-gradient(circle at 40% 38%, #fff, ${e.hex} 70%)`;
  const at = (c: number) => mixToHex([{ pigment: e.pigment, amount: c }]);
  return `radial-gradient(circle at 42% 40%, ${at(0.55)}, ${at(1)} 55%, ${at(1.25)} 72%, ${at(0.7)} 100%)`;
}

const button = (action: string, iconName: string, label: string, title: string) =>
  `<button data-action="${action}" title="${title}">${icon(iconName)}<span>${label}</span></button>`;

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const root = document.getElementById('root')!;
root.innerHTML = `
  <canvas class="paper"></canvas>
  <div class="cursor"></div>
  <div class="hint">Pick a brush and a pigment, then paint.<br>Water moves paint only where the paper is wet.</div>
  <nav class="panel tools" aria-label="Tools">
    <button class="tool pick" data-action="library" title="Brushes (, and . to cycle)" aria-haspopup="listbox">
      <canvas class="thumb" width="28" height="28"></canvas><span class="brushname"></span>
    </button>
    <hr>
    ${TOOLS.map(t => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key}): ${t.hint}">${icon(t.id)}<span>${t.label}</span></button>`).join('')}
  </nav>
  <div class="panel library" hidden role="dialog" aria-label="Brushes">
    <div class="library-head">
      <span>Brushes</span>
      <span class="sub">Shape follows the stroke, pen tilt or a set angle. Dry brushes skip the paper tooth.</span>
      <button class="icon" data-action="library" title="Close">${icon('close', 16)}</button>
    </div>
    <div class="brushes" role="listbox" aria-label="Brush library"></div>
    <div class="library-foot">
      <button class="import" data-action="import" title="Use an image as a brush tip: dark marks on white, or white on transparent">${icon('plus', 16)}<span>Import texture…</span></button>
      <span class="note">PNG or JPG. Light background is inverted automatically.</span>
    </div>
    <input type="file" accept="image/*,.heic,.heif" hidden>
  </div>
  <div class="panel actions">
    ${button('undo', 'undo', 'Undo', 'Undo (⌘Z)')}
    ${button('redo', 'redo', 'Redo', 'Redo (⇧⌘Z)')}
    ${button('dry', 'dry', 'Dry', 'Dry and fix the painting into the paper (D)')}
    ${button('clear', 'clear', 'Clear', 'Clear the paper')}
    ${button('reference', 'image', 'Ref', 'Reference image under the paint (R to show / hide)')}
    ${button('save', 'save', 'Save', 'Save image (S saves with the last settings)')}
    ${button('settings', 'sliders', 'Settings', 'Brush &amp; water settings')}
  </div>
  <div class="panel settings" hidden>
    ${SLIDERS.map(s => `<label class="slider"><span>${s.label}</span><input type="range" min="0" max="1" step="0.01" data-param="${s.key}"></label>`).join('')}
    <button class="reset" data-action="reset">Reset</button>
  </div>
  <div class="panel palette">
    <div class="swatches" role="listbox" aria-label="Pigments">
      ${PALETTE.map((e, i) => `<button class="swatch" role="option" data-index="${i}" title="${e.name}${i < 9 ? ` (${i + 1})` : i === PALETTE.length - 1 ? ' (0)' : ''}"></button>`).join('')}
      <label class="swatch custom" title="Custom pigment"><input type="color" value="#7a3b8f"></label>
    </div>
    <div class="well" title="Spectral mix of your last two pigments"><span class="name"></span><span class="mix"></span></div>
  </div>
  <div class="panel drop-choice" hidden role="dialog" aria-label="Use the dropped image">
    <button data-drop="reference">${icon('image', 16)}<span>Use as reference</span></button>
    <button data-drop="brush">${icon('brush', 16)}<span>Make a brush</span></button>
  </div>
  <div class="toast" hidden></div>`;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];

const canvas = $<HTMLCanvasElement>('canvas.paper');
const settings = $('.settings');
const library = $('.library');
const brushList = $('.brushes');
const pickBtn = $('.tool.pick');
const pickThumb = $<HTMLCanvasElement>('.tool.pick .thumb');
const fileInput = $<HTMLInputElement>('.library input[type="file"]');
const undoBtn = $<HTMLButtonElement>('[data-action="undo"]');
const redoBtn = $<HTMLButtonElement>('[data-action="redo"]');
const clearBtn = $('[data-action="clear"]');
const dropChoice = $('.drop-choice');
const customSwatch = $('.swatch.custom');
const customInput = $<HTMLInputElement>('.swatch.custom input');
const toast = $('.toast');
const sliders = $$<HTMLInputElement>('[data-param]');
const swatchButtons = $$('.swatch[data-index]');
swatchButtons.forEach((b, i) => { b.style.background = swatchBackground(PALETTE[i]); });

/* ---------------------------------------------------------------- state */

let engine: WatercolorEngine;
let tool: UiTool = 'brush';
let strokeTool: Tool | null = null;
let params: Params = { ...DEFAULT_PARAMS };
let current: PaletteEntry = PALETTE[5];
let previous: PaletteEntry = PALETTE[0];
let confirmTimer = 0;
let toastTimer = 0;

const builtIn: Brush[] = BRUSH_PRESETS.map(p => buildBrush(p));
let customs: Brush[] = [];
const allBrushes = () => [...builtIn, ...customs];
let brush: Brush = builtIn[0];

try {
  engine = new WatercolorEngine(canvas, $('.cursor'), {
    onHistoryChange: (canUndo, canRedo) => { undoBtn.disabled = !canUndo; redoBtn.disabled = !canRedo; },
    onStrokeTool: t => { strokeTool = t; renderTools(); },
  });
} catch (e) {
  root.innerHTML = `<div class="error"><p>${e instanceof Error ? e.message : String(e)}</p><p class="sub">A browser with WebGL2 is required.</p></div>`;
  throw e;
}
if (import.meta.env.DEV) (window as unknown as { engine: WatercolorEngine }).engine = engine;

const textTool = createTextTool(engine, root, canvas, showToast);
const shapeTool = createShapeTool(engine, root, canvas, showToast);
const fillTool = createFillTool(engine, root, canvas, showToast);
const reference = createReference(engine, root, showToast, on => { engine.interactive = !on && !isPanelTool(tool); });
const exporter = createExportPanel(engine, root, showToast);
/** Small panels that drop down under the action bar, one at a time, keyed by their button's action. */
const popovers: Record<string, HTMLElement> = { settings, reference: reference.panel, save: exporter.panel };
/** Tools with their own panel that drive the engine themselves. */
const panelTools: Record<PanelTool, { active: boolean; activate(): void; deactivate(): void; stop(): boolean }> = { text: textTool, shape: shapeTool, fill: fillTool };
const isPanelTool = (t: UiTool): t is PanelTool => t in panelTools;

/* ------------------------------------------------------------ rendering */

function renderTools() {
  const shown = strokeTool ?? tool;
  for (const b of $$('[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === shown);
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
}

function renderParams() {
  for (const s of sliders) s.value = String(params[s.dataset.param as keyof Params]);
}

function renderPalette() {
  swatchButtons.forEach((b, i) => {
    const on = PALETTE[i].name === current.name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const custom = current.name === 'Custom';
  customSwatch.classList.toggle('on', custom);
  customSwatch.style.background = custom ? swatchBackground(current) : '';
  $('.well .name').textContent = current.name;
  const mix = $('.well .mix');
  if (current.pigment.white || previous.pigment.white) { mix.innerHTML = ''; return; }
  const wet = mixToHex([{ pigment: previous.pigment, amount: 0.5 }, { pigment: current.pigment, amount: 0.5 }]);
  mix.innerHTML = `<i style="background:${previous.hex}"></i>+<i style="background:${current.hex}"></i>=<i style="background:${wet}"></i>`;
}

/** Colour used for brush previews: the current pigment, or ink for white gouache. */
const previewHex = () => (current.pigment.white ? '#3b4552' : current.hex);

/** Rebuild the library's cards (on load, and when custom brushes change). */
function buildLibrary() {
  brushList.innerHTML = allBrushes().map(b => `
    <div class="brush${b.custom ? ' custom' : ''}" role="option" data-brush="${esc(b.id)}" aria-selected="false" tabindex="0" title="${esc(b.hint)}">
      <canvas class="stroke" width="150" height="44"></canvas>
      <span class="label">${esc(b.name)}</span>
      ${b.custom ? `<button class="icon remove" data-remove="${esc(b.id)}" title="Remove this brush">${icon('close', 14)}</button>` : ''}
    </div>`).join('');
  renderPreviews();
  renderBrush();
}

function renderPreviews() {
  const hex = previewHex();
  const byId = new Map(allBrushes().map(b => [b.id, b]));
  for (const el of $$('.brush[data-brush]')) {
    const b = byId.get(el.dataset.brush!);
    if (b) drawStroke(el.querySelector('canvas')!, b, hex);
  }
  drawThumb(pickThumb, brush, hex);
}

function renderBrush() {
  for (const el of $$('.brush[data-brush]')) {
    const on = el.dataset.brush === brush.id;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', String(on));
  }
  $('.tool.pick .brushname').textContent = brush.name;
  pickBtn.title = `${brush.name}: ${brush.hint}. Open the brush library (, and . to cycle)`;
  drawThumb(pickThumb, brush, previewHex());
}

/* -------------------------------------------------------------- actions */

function setTool(t: UiTool) {
  if (isPanelTool(t) && t !== tool) toggleLibrary(false);
  reference.stopAdjust();
  tool = t;
  for (const [id, p] of Object.entries(panelTools)) if (p.active && id !== t) p.deactivate();
  if (isPanelTool(t)) {
    engine.interactive = false;
    panelTools[t].activate();
  } else {
    engine.interactive = true;
    engine.setTool(t);
  }
  renderTools();
}

function setParams(p: Partial<Params>) {
  params = { ...params, ...p };
  engine.setParams(params);
  renderParams();
}

function choose(e: PaletteEntry) {
  if (current.hex !== e.hex) previous = current;
  current = e;
  engine.setPigment(e.pigment);
  if (tool === 'water' || tool === 'lift') setTool('brush');
  renderPalette();
  renderPreviews();
}

function chooseBrush(b: Brush, scroll = false) {
  brush = b;
  engine.setBrush(b);
  if (tool === 'pen' || tool === 'lift') setTool('brush');
  renderBrush();
  try { localStorage.setItem(BRUSH_KEY, b.id); } catch { /* storage blocked */ }
  if (scroll) brushList.querySelector(`[data-brush="${CSS.escape(b.id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function cycleBrush(dir: 1 | -1) {
  const list = allBrushes();
  const i = list.findIndex(b => b.id === brush.id);
  chooseBrush(list[(i + dir + list.length) % list.length], true);
  showToast(brush.name);
}

function showToast(text: string) {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1200);
}

async function importTexture(file: File) {
  try {
    const tip = await tipFromImage(file);
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 22) || 'Imported';
    const b = makeCustomBrush(`custom-${Date.now().toString(36)}`, name, tip);
    customs.push(b);
    if (!saveCustomBrushes(customs)) showToast('Brush added, but could not be saved for next time');
    buildLibrary();
    chooseBrush(b, true);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Could not read that image');
  }
}

function removeBrush(id: string) {
  const b = customs.find(c => c.id === id);
  if (!b) return;
  customs = customs.filter(c => c.id !== id);
  saveCustomBrushes(customs);
  engine.forgetBrush(id);
  forgetTipImages(id);
  if (brush.id === id) chooseBrush(builtIn[0]);
  buildLibrary();
}

function setConfirmClear(on: boolean) {
  clearTimeout(confirmTimer);
  clearBtn.classList.toggle('danger', on);
  clearBtn.querySelector('span')!.textContent = on ? 'Sure?' : 'Clear';
  if (on) confirmTimer = window.setTimeout(() => setConfirmClear(false), 2500);
}

function clear() {
  if (!clearBtn.classList.contains('danger')) { setConfirmClear(true); return; }
  engine.clear();
  reference.layout();
  setConfirmClear(false);
}

/** Open or close one popover (toggling when `force` is omitted); opening one closes the rest. */
function togglePopover(name: string, force?: boolean) {
  const open = force ?? popovers[name].hidden;
  for (const [n, el] of Object.entries(popovers)) {
    el.hidden = !(open && n === name);
    const b = $(`.actions [data-action="${n}"]`);
    b.classList.toggle('on', !el.hidden);
    b.setAttribute('aria-expanded', String(!el.hidden));
  }
}

const closePopovers = () => { for (const n of Object.keys(popovers)) togglePopover(n, false); };

/* ------------------------------------------------- dropping an image file */

let dropped: File | null = null;

function offerDrop(f: File, x: number, y: number) {
  dropped = f;
  dropChoice.hidden = false;
  const r = dropChoice.getBoundingClientRect();
  dropChoice.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
  dropChoice.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, y - r.height / 2))}px`;
}

function closeDrop() { dropped = null; dropChoice.hidden = true; }

function toggleLibrary(force?: boolean) {
  library.hidden = force === undefined ? !library.hidden : !force;
  pickBtn.classList.toggle('open', !library.hidden);
  pickBtn.setAttribute('aria-expanded', String(!library.hidden));
  if (!library.hidden) brushList.querySelector<HTMLElement>('.brush.on')?.scrollIntoView({ block: 'nearest' });
}

/* --------------------------------------------------------------- wiring */

root.addEventListener('click', e => {
  const el = (e.target as Element).closest<HTMLElement>('[data-tool], [data-action], [data-index], [data-brush], [data-remove]');
  if (!el) return;
  if (el.dataset.remove) { removeBrush(el.dataset.remove); return; }
  if (el.dataset.tool) setTool(el.dataset.tool as UiTool);
  else if (el.dataset.brush) { const b = allBrushes().find(x => x.id === el.dataset.brush); if (b) chooseBrush(b); }
  else if (el.dataset.index) choose(PALETTE[Number(el.dataset.index)]);
  else switch (el.dataset.action) {
    case 'undo': engine.undo(); break;
    case 'redo': engine.redo(); break;
    case 'dry': engine.fix(); break;
    case 'clear': clear(); break;
    case 'save': togglePopover('save'); break;
    case 'reference': togglePopover('reference'); break;
    case 'settings': togglePopover('settings'); break;
    case 'library': toggleLibrary(); break;
    case 'import': fileInput.click(); break;
    case 'reset': setParams(DEFAULT_PARAMS); break;
    case 'text-close': case 'shape-close': case 'fill-close': setTool('brush'); break;
  }
});

brushList.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = (e.target as Element).closest<HTMLElement>('[data-brush]');
  const b = el && allBrushes().find(x => x.id === el.dataset.brush);
  if (b) { e.preventDefault(); chooseBrush(b); }
});

dropChoice.addEventListener('click', e => {
  const k = (e.target as Element).closest<HTMLElement>('[data-drop]')?.dataset.drop;
  const f = dropped;
  if (!k || !f) return;
  closeDrop();
  if (k === 'reference') void reference.load(f);
  else void importTexture(f);
});
window.addEventListener('pointerdown', e => { if (!dropChoice.hidden && !dropChoice.contains(e.target as Node)) closeDrop(); });

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  if (isSvgFile(f)) void shapeTool.loadSvg(f).then(ok => { if (ok) setTool('shape'); });
  else void importTexture(f);
});

// drop an image anywhere to use it as the reference or make a brush from it
root.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
root.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (isSvgFile(f)) {
    // an SVG's paths become a shape to trace, not a brush tip
    e.preventDefault();
    void shapeTool.loadSvg(f).then(ok => { if (ok) setTool('shape'); });
  } else if (isRasterFile(f)) { e.preventDefault(); offerDrop(f, e.clientX, e.clientY); }
});

settings.addEventListener('input', e => {
  const s = e.target as HTMLInputElement;
  if (s.dataset.param) setParams({ [s.dataset.param]: Number(s.value) });
});

customInput.addEventListener('input', () => choose(customEntry(customInput.value)));

canvas.addEventListener('pointerdown', () => $('.hint').classList.add('gone'), { once: true });
// painting dismisses the library so it never covers the work for long
canvas.addEventListener('pointerdown', () => { if (!library.hidden) toggleLibrary(false); });

window.addEventListener('resize', () => { engine.resize(); reference.layout(); renderPreviews(); });

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) engine.redo(); else engine.undo(); return; }
  if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); engine.redo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === 'escape') {
    if (!dropChoice.hidden) closeDrop();
    else if (reference.stopAdjust()) { /* done moving the reference */ }
    else if (!Object.values(panelTools).some(p => p.stop())) { toggleLibrary(false); closePopovers(); }
    return;
  }
  const t = TOOLS.find(x => x.key.toLowerCase() === k);
  if (t) setTool(t.id);
  else if (k === '[' || k === ']') setParams({ size: Math.min(1, Math.max(0, params.size + (k === ']' ? 0.05 : -0.05))) });
  else if (k === ',' || k === '<') cycleBrush(-1);
  else if (k === '.' || k === '>') cycleBrush(1);
  else if (k === 'd') engine.fix();
  else if (k === 's') void exporter.save();
  else if (k === 'r') reference.toggleVisible();
  else if (k === 'f') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  } else if (/^[1-9]$/.test(k)) choose(PALETTE[Number(k) - 1]);
  else if (k === '0') choose(PALETTE[PALETTE.length - 1]);
});

/* ----------------------------------------------------------------- init */

engine.setPigment(current.pigment);
engine.setBrush(brush);
undoBtn.disabled = true;
redoBtn.disabled = true;
renderTools();
renderParams();
renderPalette();
buildLibrary();

void loadCustomBrushes().then(list => {
  customs = list;
  let wanted: string | null = null;
  try { wanted = localStorage.getItem(BRUSH_KEY); } catch { /* storage blocked */ }
  buildLibrary();
  const b = wanted && allBrushes().find(x => x.id === wanted);
  if (b) chooseBrush(b);
});
