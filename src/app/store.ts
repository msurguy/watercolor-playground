import { computed, effect, signal } from '@preact/signals';
import { BRUSH_PRESETS, buildBrush, type Brush } from '../engine/brushes';
import { clampDocSize, DEFAULT_PARAMS, MAX_ZOOM, MIN_ZOOM, WatercolorEngine, type DocState, type DocumentSnapshot, type Params, type Tool } from '../engine/Engine';
import type { StepInfo } from '../engine/history';
import { DEFAULT_PAPER, PAPER_SIZES, PAPERS, type PaperPreset } from '../engine/papers';
import { ExportStore } from '../export/ExportStore';
import type { HandMode } from '../hand/HandMode';
import { HAND_IDLE, type HandCursor, type HandStatus } from '../hand/types';
import { customEntry, PALETTE, type PaletteEntry } from '../palette';
import { isProjectFile, type ProjectData } from '../project/format';
import { ProjectStore } from '../project/ProjectStore';
import { decodeImage, isRasterFile } from '../reference/decode';
import { ReferenceStore } from '../reference/ReferenceStore';
import type { ShapeStore } from '../shapes/ShapeStore';
import { isSvgFile } from '../shapes/svgImport';
import { brushFromStored, loadCustomBrushes, makeCustomBrush, saveCustomBrushes, tipFromImage } from '../ui/customBrushes';
import { forgetTipImages } from '../ui/preview';
import { Navigation } from './navigation';
import { persisted, storedString } from './persisted';
import { ENGINE_TOOLS, PANEL_TOOLS } from './registry';
import { bumpView } from './resize';
import { showToast } from './toast';
import type { PanelTool, PanelToolDef } from './tools';

/** An engine tool or the id of a panel tool from the registry. */
export type UiTool = Tool | string;
export type PopoverId = 'settings' | 'reference' | 'save' | 'paper' | 'history';

const BRUSH_KEY = 'watercolor.brush';
const PAPER_KEY = 'watercolor.paper';
const PAPER_LOOK_KEY = 'watercolor.paperLook';
const PAPER_SIZE_KEY = 'watercolor.paperSize';
/** Zoom stops for the zoom buttons and keys (Figma-like). */
const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** The chosen sheet: a preset id from PAPER_SIZES and, for fixed sizes, the size in pixels. */
export interface PaperSizeChoice { preset: string; w: number; h: number }
const sanitizeSize = (v: PaperSizeChoice): PaperSizeChoice => {
  const preset = PAPER_SIZES.some(p => p.id === v.preset) ? v.preset : 'screen';
  const [w, h] = clampDocSize(Number(v.w) || 0, Number(v.h) || 0);
  return { preset, w, h };
};
const isEngineTool = (t: UiTool): t is Tool => ENGINE_TOOLS.some(e => e.id === t);
const handErrorText = (e: unknown) => {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found';
  return 'Could not start hand tracking';
};

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
  /** Texture strength of the paper, 0..1. */
  readonly paperLook = persisted(PAPER_LOOK_KEY, { texture: 1 }, v => ({ texture: Math.min(1, Math.max(0, Number(v.texture) || 0)) }));
  readonly paper = signal<PaperPreset>(PAPERS.find(p => p.id === storedString.get(PAPER_KEY)) ?? DEFAULT_PAPER);
  /** Colour used for brush previews: the current pigment, or ink for white gouache. */
  readonly previewHex = computed(() => (this.current.value.pigment.white ? '#3b4552' : this.current.value.hex));
  /** Every undo step, oldest first, and how many are applied. */
  readonly history = signal<{ list: StepInfo[]; index: number }>({ list: [], index: 0 });
  readonly canUndo = computed(() => this.history.value.index > 0);
  readonly canRedo = computed(() => this.history.value.index < this.history.value.list.length);
  /** Small panels that drop down under the action bar, one at a time. */
  readonly popover = signal<PopoverId | null>(null);
  readonly libraryOpen = signal(false);
  readonly confirmClear = signal(false);
  readonly hintGone = signal(false);
  /** The sheet as chosen in the Paper panel (remembered for next time). */
  readonly paperSize = persisted<PaperSizeChoice>(PAPER_SIZE_KEY, { preset: 'screen', w: 0, h: 0 }, sanitizeSize);
  /** The sheet as it is, in pixels. */
  readonly docSize = signal<[number, number]>([1, 1]);
  /** 1 = one sheet pixel per CSS pixel. */
  readonly zoom = signal(1);
  /** A dropped image waiting for the user to say what it is for. */
  readonly dropped = signal<{ file: File; x: number; y: number } | null>(null);
  /** Hand painting (camera + MediaPipe): the switch, where it is in loading, and what the hand is doing. Not remembered: it needs the camera. */
  readonly handEnabled = signal(false);
  readonly handStatus = signal<HandStatus>('off');
  readonly hand = signal<HandCursor>(HAND_IDLE);
  readonly handStream = signal<MediaStream | null>(null);

  readonly panelTools = new Map<string, { def: PanelToolDef; tool: PanelTool }>();
  readonly reference: ReferenceStore;
  readonly exporter: ExportStore;
  readonly project: ProjectStore;
  /** The active panel tool, if the current tool is one. */
  readonly activePanelTool = computed(() => this.panelTools.get(this.tool.value)?.tool ?? null);

  private confirmTimer = 0;
  private handMode: HandMode | null = null;
  private handStarting: Promise<void> | null = null;
  private textureBefore: DocState | null = null;
  private readonly navigation: Navigation;

  constructor(canvas: HTMLCanvasElement, cursor: HTMLElement) {
    const size = this.paperSize.peek();
    this.engine = new WatercolorEngine(canvas, cursor, {
      onHistoryChange: (list, index) => { this.history.value = { list, index }; },
      onDocumentChange: d => this.syncDocument(d),
      onStrokeTool: t => { this.strokeTool.value = t; },
      onViewChange: (z, d) => {
        this.zoom.value = z;
        const cur = this.docSize.peek();
        if (cur[0] !== d[0] || cur[1] !== d[1]) this.docSize.value = d;
        bumpView();
      },
    }, size.preset === 'screen' ? null : [size.w, size.h]);
    this.navigation = new Navigation(this.engine, canvas);
    const ctx = { engine: this.engine };
    for (const def of PANEL_TOOLS) this.panelTools.set(def.id, { def, tool: def.create(ctx) });
    this.reference = new ReferenceStore(this.engine);
    this.exporter = new ExportStore(this.engine, () => this.paper.peek().name);
    this.project = new ProjectStore(this);

    // mirror state into the engine (paper and reference changes are recorded as undo steps by the actions below)
    effect(() => this.engine.setParams(this.params.value));
    effect(() => this.engine.setPigment(this.current.value.pigment));
    effect(() => this.engine.setBrush(this.brush.value));
    effect(() => { this.engine.setPaper(this.paper.value); storedString.set(PAPER_KEY, this.paper.value.id); });
    effect(() => { this.engine.paperTexture = this.paperLook.value.texture; });
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

  /** Swap the paper under the painting; the paint stays. One undo step. */
  choosePaper(p: PaperPreset) {
    if (p.id === this.paper.peek().id) return;
    const before = this.engine.documentState;
    this.paper.value = p;   // the effect pushes it into the engine
    this.engine.recordChange('paper', `Paper: ${p.name}`, before);
  }

  /** Texture slider: `input` while dragging, `commit` when let go (one undo step per drag). */
  setPaperTexture(v: number, phase: 'input' | 'commit' = 'input') {
    this.textureBefore ??= this.engine.documentState;
    this.paperLook.value = { texture: v };
    if (phase !== 'commit') return;
    const before = this.textureBefore;
    this.textureBefore = null;
    if (before.paperStrength !== v) this.engine.recordChange('paper', `Paper texture ${Math.round(v * 100)}%`, before);
  }

  /** Paper / reference state changed inside the engine (undo, redo, project opened): follow it. */
  private syncDocument(d: DocState) {
    const p = PAPERS.find(x => x.id === d.paperId) ?? DEFAULT_PAPER;
    if (p.id !== this.paper.peek().id) this.paper.value = p;
    if (this.paperLook.peek().texture !== d.paperStrength) this.paperLook.value = { texture: d.paperStrength };
    this.reference.syncFrom(d.reference);
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

  /** A file dropped on the page: projects open, SVGs are traced, rasters ask whether they are a reference or a brush. */
  dropFile(file: File, x: number, y: number): boolean {
    if (isProjectFile(file)) { void this.project.open(file); return true; }
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
  /** Go to the state after `index` steps (0 = before the first). */
  jumpTo(index: number) { this.engine.jumpTo(index); }
  dry() { this.engine.fix(); }

  /** Replace the painting with a saved project. */
  async openProject(data: ProjectData): Promise<void> {
    for (const p of this.panelTools.values()) p.tool.stop();
    this.reference.stopAdjust();
    const h = data.header;
    let image: HTMLCanvasElement | null = null;
    if (data.reference) {
      const bmp = await decodeImage(data.reference);
      image = document.createElement('canvas');
      image.width = bmp.width; image.height = bmp.height;
      image.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
    }
    const [w, h2] = clampDocSize(h.doc.w, h.doc.h, this.engine.maxSide);
    const snapshot: DocumentSnapshot = {
      whole: { w: h.doc.w, h: h.doc.h, rect: h.paint.rect, layers: data.layers },
      paper: h.paper,
      wet: { wetAgo: h.paint.wetAgo, wetPeak: h.paint.wetPeak, active: h.paint.active, painted: h.paint.painted },
      reference: image && h.reference
        ? { image, rect: h.reference.rect, opacity: h.reference.opacity, visible: h.reference.visible }
        : { image: null, rect: { x: 0, y: 0, w: 1, h: 1 }, opacity: this.reference.opacity, visible: this.reference.visible },
      view: h.view ?? { zoom: 1, pan: [0, 0], fitted: true },
    };
    this.engine.restore(snapshot);   // throws if the sheet does not fit this GPU
    this.paperSize.value = sanitizeSize({ preset: h.doc.sizePreset, w, h: h2 });
    this.params.value = { ...DEFAULT_PARAMS, ...h.tool.params };
    this.choose(PALETTE.find(e => e.hex.toLowerCase() === h.tool.hex.toLowerCase()) ?? customEntry(h.tool.hex));
    this.reference.forFill.value = !!(h.reference?.forFill && image);
    this.reference.askFill.value = false;
    let brush = this.allBrushes.peek().find(b => b.id === h.tool.brushId);
    if (!brush) {
      const stored = h.brushes.find(b => b.id === h.tool.brushId);
      if (stored) {
        try {
          brush = await brushFromStored(stored);
          this.customs.value = [...this.customs.value, brush];
          saveCustomBrushes(this.customs.value);
        } catch { /* a corrupt tip: fall back to the first brush */ }
      }
    }
    this.chooseBrush(brush ?? this.builtIn[0]);
    this.confirmClear.value = false;
    this.closePopovers();
  }

  /**
   * Switch hand painting on or off. Switching on pulls in MediaPipe (its own chunk), asks for the
   * camera and loads the model; a failure shows a toast and flips the switch back.
   */
  async setHandMode(on: boolean) {
    this.handEnabled.value = on;
    if (on) {
      if (this.handMode || this.handStarting) return;
      this.handStatus.value = 'loading';
      this.handStarting = (async () => {
        const { HandMode } = await import('../hand');
        const mode = new HandMode({
          engine: this.engine,
          paintTool: () => { const t = this.tool.peek(); return isEngineTool(t) && this.engine.interactive ? t : null; },
          setCursor: c => { this.hand.value = c; },
          setStream: s => { this.handStream.value = s; },
        });
        await mode.start();
        if (!this.handEnabled.peek()) { mode.stop(); return; }   // switched off while loading
        this.handMode = mode;
        this.handStatus.value = 'on';
        if (import.meta.env.DEV) (window as unknown as { hand: HandMode }).hand = mode;
      })().catch((e: unknown) => {
        this.handStatus.value = 'error';
        this.handEnabled.value = false;
        this.hand.value = HAND_IDLE;
        this.handStream.value = null;
        showToast(handErrorText(e));
      }).finally(() => { this.handStarting = null; });
    } else {
      // a start still under way sees the switch off and stops itself when it finishes
      this.handMode?.stop();
      this.handMode = null;
      this.handStatus.value = 'off';
      this.hand.value = HAND_IDLE;
      this.handStream.value = null;
    }
  }

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

  /**
   * Change the sheet. The painting keeps its size and stays centred: a bigger sheet adds
   * paper around it, a smaller one crops it. The change is one undo step.
   */
  setPaperSize(choice: PaperSizeChoice) {
    const [w, h] = choice.preset === 'screen' ? this.engine.screenSize : clampDocSize(choice.w, choice.h, this.engine.maxSide);
    for (const p of this.panelTools.values()) p.tool.stop();
    this.engine.resizeDocument(w, h);
    this.reference.syncRect();
    this.paperSize.value = { preset: choice.preset, w, h };
  }

  zoomIn() { this.engine.zoomTo(ZOOM_STEPS.find(z => z > this.zoom.peek() * 1.01) ?? MAX_ZOOM); }
  zoomOut() { this.engine.zoomTo([...ZOOM_STEPS].reverse().find(z => z < this.zoom.peek() / 1.01) ?? MIN_ZOOM); }
  zoomTo(z: number) { this.engine.zoomTo(z); }
  zoomToFit() { this.engine.zoomToFit(); }

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
    if (this.reference.askFill.peek()) { this.reference.useForFill(false); return; }
    if (this.reference.stopAdjust()) return;
    for (const p of this.panelTools.values()) if (p.tool.stop()) return;
    this.toggleLibrary(false);
    this.closePopovers();
  }

  resize() {
    this.engine.resize();
    this.reference.syncRect();
  }

  destroy() { void this.setHandMode(false); this.navigation.destroy(); this.engine.destroy(); }
}
