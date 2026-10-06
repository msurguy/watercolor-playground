import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type { Tool, WatercolorEngine } from '../engine/Engine';
import type { PanelTool, PaperGesture } from '../app/tools';
import { persisted } from '../app/persisted';
import { resizeTick, viewTick } from '../app/resize';
import { showToast } from '../app/toast';
import { hideGhost, setGhost } from '../draw/ghost';
import { penSpeed, StrokeWriter } from '../draw/StrokeWriter';
import { DEFAULT_FONT, FONTS, fontUrl } from './fonts';
import { loadFont, type Font } from './fontLoader';
import { layoutText, type Align, type TextLayout } from './layout';

// The Text tool: compose one line of text in a single-stroke font, see a ghost of it
// under the pointer, and on tap the StrokeWriter draws it on the paper, slowly, with
// the current brush and pigment.

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

/** Widest brush footprint radius for text, in em: thinner than a letter's counters. */
const MAX_RADIUS_EM = 0.06;

/** Em height in document heights. */
export const emSize = (v: number) => 0.03 * Math.pow(12, v);

export class TextStore implements PanelTool {
  readonly id = 'text';
  readonly settings = persisted<TextSettings>(KEY, DEFAULTS, s => (FONTS[s.font] ? s : { ...s, font: DEFAULT_FONT }));
  readonly active = signal(false);
  readonly font = signal<Font | null>(null);
  readonly layout = signal<TextLayout | null>(null);
  readonly writing = signal(false);
  readonly progress = signal<[number, number] | null>(null);
  /** Bumped when the panel should focus the text field. */
  readonly focusRequest = signal(0);
  readonly busy: ReadonlySignal<boolean> = this.writing;
  readonly status = computed(() => {
    if (this.writing.value) { const p = this.progress.value; return p ? `Writing… ${p[0]} / ${p[1]} strokes` : 'Writing…'; }
    if (!this.font.value) return 'Loading font…';
    if (!this.settings.value.text.trim()) return 'Type something to write';
    if (!this.layout.value?.strokes.length) return 'This font has none of those characters';
    return this.active.value ? 'Tap the paper to write' : '';
  });

  private hover = signal<[number, number] | null>(null);   // document uv under the pointer
  private writer: StrokeWriter;
  private fontGen = 0;

  constructor(private engine: WatercolorEngine) {
    this.writer = new StrokeWriter(engine);
    const fontKey = computed(() => this.settings.value.font);
    effect(() => this.useFont(fontKey.value));
    effect(() => {
      const { text, spacing, align } = this.settings.value;
      const f = this.font.value;
      this.layout.value = f ? layoutText(text, f, spacing, align) : null;
    });
    effect(() => this.renderGhost());
  }

  set(p: Partial<TextSettings>) { this.settings.value = { ...this.settings.value, ...p }; }

  private useFont(key: string) {
    const gen = ++this.fontGen;
    this.font.value = null;
    loadFont(key, fontUrl(key)).then(f => { if (gen === this.fontGen) this.font.value = f; })
      .catch(e => { if (gen === this.fontGen) showToast(e instanceof Error ? e.message : 'Could not load that font'); });
  }

  /** Client-space path of the ghost at the hovered anchor. */
  private renderGhost() {
    resizeTick.value; viewTick.value;   // re-run after a resize, zoom or pan
    const layout = this.layout.value, hover = this.hover.value;
    if (!this.active.value || !layout || !hover || this.writing.value) { hideGhost(); return; }
    const em = emSize(this.settings.value.size), a = this.engine.aspect;
    const [ax, ay] = hover;
    let d = '';
    for (const pl of layout.strokes) {
      pl.forEach(([x, y], i) => {
        const [cx, cy] = this.engine.docToClient(ax + (x * em) / a, ay - y * em);
        d += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`;
      });
    }
    // baseline tick at the anchor
    const [bx, by] = this.engine.docToClient(ax, ay);
    d += `M${(bx - 6).toFixed(1)} ${by.toFixed(1)}h12M${bx.toFixed(1)} ${(by - 6).toFixed(1)}v12`;
    setGhost(d);
  }

  private writeAt(anchor: [number, number]) {
    const layout = this.layout.value;
    if (!layout?.strokes.length || this.writing.value) return;
    const s = this.settings.value;
    const em = emSize(s.size);
    // em units (y down) -> document heights relative to the anchor (y up)
    const strokes = layout.strokes.map(pl => pl.map(([x, y]) => [x * em, -y * em] as [number, number]));
    this.writing.value = true;
    this.progress.value = [0, strokes.length];
    const text = s.text.trim();
    this.writer.write(strokes, anchor, {
      tool: s.tool, ref: em, maxRadius: em * MAX_RADIUS_EM, speed: penSpeed(s.speed), pressure: s.pressure, taper: s.taper, wobble: s.wobble,
      label: `Text “${text.length > 18 ? `${text.slice(0, 18)}…` : text}”`,
    }, {
      onProgress: (done, total) => { this.progress.value = [done, total]; },
      onDone: () => { this.writing.value = false; this.progress.value = null; },
    });
  }

  readonly gesture: PaperGesture = {
    move: (_e, uv) => { this.hover.value = uv; },
    leave: () => { this.hover.value = null; },
    down: (_e, uv) => {
      if (this.writing.value) { showToast('Still writing… press Stop or Esc'); return; }
      if (!this.font.value) { showToast('Loading font…'); return; }
      if (!this.layout.value?.strokes.length) { this.focusRequest.value++; showToast('Type something first'); return; }
      this.hover.value = uv;
      this.writeAt(uv);
    },
  };

  activate() {
    this.active.value = true;
    if (!this.settings.value.text.trim()) this.focusRequest.value++;
  }

  deactivate() {
    this.active.value = false;
    this.writer.cancel();
    this.hover.value = null;
  }

  stop() {
    if (!this.writing.value) return false;
    this.writer.cancel();
    return true;
  }
}
