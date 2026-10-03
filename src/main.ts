import { BRUSH_PRESETS, buildBrush, type Brush } from './engine/brushes';
import { DEFAULT_PARAMS, WatercolorEngine, type Params, type Tool } from './engine/Engine';
import { mixToHex } from './engine/spectral';
import { PALETTE, customEntry, type PaletteEntry } from './palette';
import { loadCustomBrushes, makeCustomBrush, saveCustomBrushes, tipFromImage } from './ui/customBrushes';
import { icon } from './ui/icons';
import { drawStroke, drawThumb, forgetTipImages } from './ui/preview';
import './styles.css';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B', hint: 'Wet paint: pigment and water' },
  { id: 'water', label: 'Water', key: 'W', hint: 'Clear water: wets paper, moves paint' },
  { id: 'pen', label: 'Pen', key: 'P', hint: 'Ink line in the current colour' },
  { id: 'lift', label: 'Lift', key: 'L', hint: 'Blot with a tissue: lifts wet paint' },
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
    <input type="file" accept="image/*" hidden>
  </div>
  <div class="panel actions">
    ${button('undo', 'undo', 'Undo', 'Undo (⌘Z)')}
    ${button('dry', 'dry', 'Dry', 'Dry and fix the painting into the paper (D)')}
    ${button('clear', 'clear', 'Clear', 'Clear the paper')}
    ${button('save', 'save', 'Save', 'Save PNG (S)')}
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
const clearBtn = $('[data-action="clear"]');
const settingsBtn = $('[data-action="settings"]');
const customSwatch = $('.swatch.custom');
const customInput = $<HTMLInputElement>('.swatch.custom input');
const toast = $('.toast');
const sliders = $$<HTMLInputElement>('[data-param]');
const swatchButtons = $$('.swatch[data-index]');
swatchButtons.forEach((b, i) => { b.style.background = swatchBackground(PALETTE[i]); });

/* ---------------------------------------------------------------- state */

let engine: WatercolorEngine;
let tool: Tool = 'brush';
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
    onHistoryChange: can => { undoBtn.disabled = !can; },
    onStrokeTool: t => { strokeTool = t; renderTools(); },
  });
} catch (e) {
  root.innerHTML = `<div class="error"><p>${e instanceof Error ? e.message : String(e)}</p><p class="sub">A browser with WebGL2 is required.</p></div>`;
  throw e;
}
if (import.meta.env.DEV) (window as unknown as { engine: WatercolorEngine }).engine = engine;

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

function setTool(t: Tool) {
  tool = t;
  engine.setTool(t);
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

async function save() {
  const blob = await engine.exportPNG();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `watercolor-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
  setConfirmClear(false);
}

function toggleSettings(force?: boolean) {
  settings.hidden = force === undefined ? !settings.hidden : !force;
  settingsBtn.classList.toggle('on', !settings.hidden);
  settingsBtn.setAttribute('aria-expanded', String(!settings.hidden));
}

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
  if (el.dataset.tool) setTool(el.dataset.tool as Tool);
  else if (el.dataset.brush) { const b = allBrushes().find(x => x.id === el.dataset.brush); if (b) chooseBrush(b); }
  else if (el.dataset.index) choose(PALETTE[Number(el.dataset.index)]);
  else switch (el.dataset.action) {
    case 'undo': engine.undo(); break;
    case 'dry': engine.fix(); break;
    case 'clear': clear(); break;
    case 'save': void save(); break;
    case 'settings': toggleSettings(); break;
    case 'library': toggleLibrary(); break;
    case 'import': fileInput.click(); break;
    case 'reset': setParams(DEFAULT_PARAMS); break;
  }
});

brushList.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = (e.target as Element).closest<HTMLElement>('[data-brush]');
  const b = el && allBrushes().find(x => x.id === el.dataset.brush);
  if (b) { e.preventDefault(); chooseBrush(b); }
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) void importTexture(f);
});

// drop an image anywhere to make a brush from it
root.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
root.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) { e.preventDefault(); void importTexture(f); }
});

settings.addEventListener('input', e => {
  const s = e.target as HTMLInputElement;
  if (s.dataset.param) setParams({ [s.dataset.param]: Number(s.value) });
});

customInput.addEventListener('input', () => choose(customEntry(customInput.value)));

canvas.addEventListener('pointerdown', () => $('.hint').classList.add('gone'), { once: true });
// painting dismisses the library so it never covers the work for long
canvas.addEventListener('pointerdown', () => { if (!library.hidden) toggleLibrary(false); });

window.addEventListener('resize', () => { engine.resize(); renderPreviews(); });

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); engine.undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === 'escape') { toggleLibrary(false); toggleSettings(false); return; }
  const t = TOOLS.find(x => x.key.toLowerCase() === k);
  if (t) setTool(t.id);
  else if (k === '[' || k === ']') setParams({ size: Math.min(1, Math.max(0, params.size + (k === ']' ? 0.05 : -0.05))) });
  else if (k === ',' || k === '<') cycleBrush(-1);
  else if (k === '.' || k === '>') cycleBrush(1);
  else if (k === 'd') engine.fix();
  else if (k === 's') void save();
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
