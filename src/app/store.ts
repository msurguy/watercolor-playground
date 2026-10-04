import { computed, effect, signal } from '@preact/signals';
import { BRUSH_PRESETS, buildBrush, type Brush } from '../engine/brushes';
import { DEFAULT_PARAMS, WatercolorEngine, type Params, type Tool } from '../engine/Engine';
import { ExportStore } from '../export/ExportStore';
import { PALETTE, type PaletteEntry } from '../palette';
import { isRasterFile } from '../reference/decode';
import { ReferenceStore } from '../reference/ReferenceStore';
import type { ShapeStore } from '../shapes/ShapeStore';
import { isSvgFile } from '../shapes/svgImport';
import { loadCustomBrushes, makeCustomBrush, saveCustomBrushes, tipFromImage } from '../ui/customBrushes';
import { forgetTipImages } from '../ui/preview';
import { storedString } from './persisted';
import { ENGINE_TOOLS, PANEL_TOOLS } from './registry';
import { showToast } from './toast';
import type { PanelTool, PanelToolDef } from './tools';

/** An engine tool or the id of a panel tool from the registry. */
export type UiTool = Tool | string;
export type PopoverId = 'settings' | 'reference' | 'save';

const BRUSH_KEY = 'watercolor.brush';
const isEngineTool = (t: UiTool): t is Tool => ENGINE_TOOLS.some(e => e.id === t);

/**
 * All UI state as signals, plus the actions that change it. Owns the engine and the
 * tool stores. Components read signals and call actions; effects mirror state into
 * the engine so no component talks to it for state it also displays.
 */
export class AppStore {
  readonly engine: WatercolorEngine;

  readonly tool = signal<UiTool>('brush');
  /** A tool temporarily chosen by the stylus (barrel button, eraser) for the current stroke. */
  readonly strokeTool = signal<Tool | null>(null);
  /** The tool to highlight in the toolbar. */
  readonly shownTool = computed(() => this.strokeTool.value ?? this.tool.value);
  readonly params = signal<Params>({ ...DEFAULT_PARAMS });
  readonly current = signal<PaletteEntry>(PALETTE[5]);
  readonly previous = signal<PaletteEntry>(PALETTE[0]);
  readonly builtIn: Brush[] = BRUSH_PRESETS.map(p => buildBrush(p));
  readonly customs = signal<Brush[]>([]);
  readonly allBrushes = computed(() => [...this.builtIn, ...this.customs.value]);
  readonly brush = signal<Brush>(this.builtIn[0]);
  /** Colour used for brush previews: the current pigment, or ink for white gouache. */
  readonly previewHex = computed(() => (this.current.value.pigment.white ? '#3b4552' : this.current.value.hex));
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  /** Small panels that drop down under the action bar, one at a time. */
  readonly popover = signal<PopoverId | null>(null);
  readonly libraryOpen = signal(false);
  readonly confirmClear = signal(false);
  readonly hintGone = signal(false);
  /** A dropped image waiting for the user to say what it is for. */
  readonly dropped = signal<{ file: File; x: number; y: number } | null>(null);

  readonly panelTools = new Map<string, { def: PanelToolDef; tool: PanelTool }>();
  readonly reference: ReferenceStore;
  readonly exporter: ExportStore;
  /** The active panel tool, if the current tool is one. */
  readonly activePanelTool = computed(() => this.panelTools.get(this.tool.value)?.tool ?? null);

  private confirmTimer = 0;

  constructor(canvas: HTMLCanvasElement, cursor: HTMLElement) {
    this.engine = new WatercolorEngine(canvas, cursor, {
      onHistoryChange: (u, r) => { this.canUndo.value = u; this.canRedo.value = r; },
      onStrokeTool: t => { this.strokeTool.value = t; },
    });
    const ctx = { engine: this.engine };
    for (const def of PANEL_TOOLS) this.panelTools.set(def.id, { def, tool: def.create(ctx) });
    this.reference = new ReferenceStore(this.engine);
    this.exporter = new ExportStore(this.engine);

    // mirror state into the engine
    effect(() => this.engine.setParams(this.params.value));
    effect(() => this.engine.setPigment(this.current.value.pigment));
    effect(() => this.engine.setBrush(this.brush.value));
    effect(() => { const t = this.tool.value; if (isEngineTool(t)) this.engine.setTool(t); });
    effect(() => { this.engine.interactive = isEngineTool(this.tool.value) && !this.reference.adjusting.value; });
    effect(() => storedString.set(BRUSH_KEY, this.brush.value.id));

    void loadCustomBrushes().then(list => {
      this.customs.value = list;
      const wanted = storedString.get(BRUSH_KEY);
      const b = wanted && this.allBrushes.peek().find(x => x.id === wanted);
      if (b) this.brush.value = b;
    });
  }

  /** A panel tool's store by id, typed by the caller. */
  panelTool<T extends PanelTool>(id: string): T { return this.panelTools.get(id)!.tool as T; }
  isPanelTool(t: UiTool) { return this.panelTools.has(t); }

  /* -------------------------------------------------------------- actions */

  setTool(t: UiTool) {
    const prev = this.tool.peek();
    if (this.isPanelTool(t) && t !== prev) this.toggleLibrary(false);
    this.reference.stopAdjust();
    for (const [id, p] of this.panelTools) if (p.tool.active.peek() && id !== t) p.tool.deactivate();
    this.tool.value = t;
    if (this.isPanelTool(t)) this.panelTools.get(t)!.tool.activate();
  }

  setParams(p: Partial<Params>) { this.params.value = { ...this.params.value, ...p }; }

  choose(e: PaletteEntry) {
    const cur = this.current.peek();
    if (cur.hex !== e.hex) this.previous.value = cur;
    this.current.value = e;
    const t = this.tool.peek();
    if (t === 'water' || t === 'lift') this.setTool('brush');
  }

  chooseBrush(b: Brush) {
    this.brush.value = b;
    const t = this.tool.peek();
    if (t === 'pen' || t === 'lift') this.setTool('brush');
  }

  cycleBrush(dir: 1 | -1) {
    const list = this.allBrushes.peek();
    const i = list.findIndex(b => b.id === this.brush.peek().id);
    this.chooseBrush(list[(i + dir + list.length) % list.length]);
    showToast(this.brush.peek().name);
  }

  async importTexture(file: File) {
    try {
      const tip = await tipFromImage(file);
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 22) || 'Imported';
      const b = makeCustomBrush(`custom-${Date.now().toString(36)}`, name, tip);
      this.customs.value = [...this.customs.value, b];
      if (!saveCustomBrushes(this.customs.value)) showToast('Brush added, but could not be saved for next time');
      this.chooseBrush(b);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read that image');
    }
  }

  removeBrush(id: string) {
    if (!this.customs.peek().some(c => c.id === id)) return;
    this.customs.value = this.customs.value.filter(c => c.id !== id);
    saveCustomBrushes(this.customs.value);
    this.engine.forgetBrush(id);
    forgetTipImages(id);
    if (this.brush.peek().id === id) this.chooseBrush(this.builtIn[0]);
  }

  /** A file picked or dropped: SVGs become a shape to trace, rasters a brush tip. */
  importFile(file: File) {
    if (isSvgFile(file)) void this.panelTool<ShapeStore>('shape').loadSvg(file).then(ok => { if (ok) this.setTool('shape'); });
    else void this.importTexture(file);
  }

  /** A file dropped on the page: SVGs are traced, rasters ask whether they are a reference or a brush. */
  dropFile(file: File, x: number, y: number): boolean {
    if (isSvgFile(file)) { this.importFile(file); return true; }
    if (isRasterFile(file)) { this.dropped.value = { file, x, y }; return true; }
    return false;
  }

  resolveDrop(as: 'reference' | 'brush') {
    const d = this.dropped.peek();
    this.dropped.value = null;
    if (!d) return;
    if (as === 'reference') void this.reference.load(d.file);
    else void this.importTexture(d.file);
  }

  closeDrop() { this.dropped.value = null; }

  undo() { this.engine.undo(); }
  redo() { this.engine.redo(); }
  dry() { this.engine.fix(); }

  /** First press arms the button ("Sure?"), a second press within 2.5 s clears. */
  clear() {
    clearTimeout(this.confirmTimer);
    if (!this.confirmClear.peek()) {
      this.confirmClear.value = true;
      this.confirmTimer = window.setTimeout(() => { this.confirmClear.value = false; }, 2500);
      return;
    }
    this.engine.clear();
    this.reference.syncRect();
    this.confirmClear.value = false;
  }

  /** Open or close one popover (toggling when `force` is omitted); opening one closes the rest. */
  togglePopover(name: PopoverId, force?: boolean) {
    const open = force ?? this.popover.peek() !== name;
    this.popover.value = open ? name : null;
  }

  closePopovers() { this.popover.value = null; }

  toggleLibrary(force?: boolean) { this.libraryOpen.value = force ?? !this.libraryOpen.peek(); }

  /** Escape: the most transient thing goes first. */
  escape() {
    if (this.dropped.peek()) { this.closeDrop(); return; }
    if (this.reference.stopAdjust()) return;
    for (const p of this.panelTools.values()) if (p.tool.stop()) return;
    this.toggleLibrary(false);
    this.closePopovers();
  }

  resize() {
    this.engine.resize();
    this.reference.syncRect();
  }

  destroy() { this.engine.destroy(); }
}
