import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../app/context';
import { resizeTick } from '../app/resize';
import { clampDocSize, MIN_DOC_SIDE } from '../engine/Engine';
import { PAPER_SIZES, PAPERS, type PaperPreset } from '../engine/papers';
import { Panel, PanelHead } from '../ui/Panel';
import { Seg } from '../ui/Seg';
import { Slider } from '../ui/Slider';

const SWATCH_W = 112, SWATCH_H = 64;

function PaperCard({ paper, selected, onPick }: { paper: PaperPreset; selected: boolean; onPick(): void }) {
  const app = useApp();
  const canvas = useRef<HTMLCanvasElement>(null);
  const open = app.popover.value === 'paper';
  const tick = resizeTick.value;
  // drawn at the scale the sheet has on screen, once the panel is first opened
  useEffect(() => {
    const c = canvas.current;
    if (!open || !c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const src = app.engine.paperSwatch(paper, Math.round(SWATCH_W * dpr), Math.round(SWATCH_H * dpr));
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
  }, [open, paper, tick]);
  return (
    <div class={`paper-card${selected ? ' on' : ''}`} role="option" aria-selected={selected} tabIndex={0} title={paper.hint}
      onClick={onPick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}>
      <canvas ref={canvas} class="sheet" style={{ width: `${SWATCH_W}px`, height: `${SWATCH_H}px` }} />
      <span class="label">{paper.name}</span>
    </div>
  );
}

const turn = (w: number, h: number, portrait: boolean): [number, number] => (portrait === h > w ? [w, h] : [h, w]);

/** Sheet size: presets or custom pixels, and the orientation. The painting is kept when it changes. */
function SizeSection() {
  const app = useApp();
  const open = app.popover.value === 'paper';
  const [dw, dh] = app.docSize.value;
  resizeTick.value;   // "Screen" follows the window
  const [preset, setPreset] = useState(app.paperSize.peek().preset);
  const [portrait, setPortrait] = useState(dh > dw);
  const [custom, setCustom] = useState<[number, number]>([dw, dh]);
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);

  // each time the panel opens, start from the sheet as it is
  useEffect(() => {
    if (!open) return;
    setPreset(app.paperSize.peek().preset);
    setPortrait(dh > dw);
    setCustom([dw, dh]);
    setArmed(false);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const def = PAPER_SIZES.find(p => p.id === preset) ?? PAPER_SIZES[0];
  const want: [number, number] = preset === 'screen' ? app.engine.screenSize
    : preset === 'custom' ? custom : turn(def.w, def.h, portrait);
  const [w, h] = clampDocSize(want[0], want[1], app.engine.maxSide);
  const clamped = preset === 'custom' && (w !== Math.round(want[0]) || h !== Math.round(want[1]));
  const same = w === dw && h === dh;
  const crops = w < dw || h < dh;
  const square = preset === 'screen' || (preset !== 'custom' && def.w === def.h);

  const pick = (id: string) => {
    if (id === 'custom' && preset !== 'custom') setCustom([w, h]);
    setPreset(id);
    setArmed(false);
  };
  const orient = (p: boolean) => {
    setPortrait(p);
    if (preset === 'custom') setCustom(turn(custom[0], custom[1], p));
    setArmed(false);
  };
  const apply = () => {
    clearTimeout(timer.current);
    // shrinking crops the painting: the first press asks
    if (crops && !armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 2500);
      return;
    }
    setArmed(false);
    setCustom([w, h]);   // show what was applied, after any clamping
    app.setPaperSize({ preset, w, h });
  };
  const setSide = (i: 0 | 1, v: string) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return;
    const next: [number, number] = [...custom];
    next[i] = n;
    setCustom(next);
    setArmed(false);
  };

  return (
    <div class="field paper-size">
      <span>Size · {dw} × {dh} px</span>
      <div class="sizes" role="radiogroup" aria-label="Paper size">
        {PAPER_SIZES.map(p => {
          const [pw, ph] = p.id === 'screen' ? app.engine.screenSize : turn(p.w, p.h, portrait);
          return (
            <button key={p.id} role="radio" aria-checked={p.id === preset} class={p.id === preset ? 'on' : ''} title={p.hint} onClick={() => pick(p.id)}>
              <b>{p.name}</b><i>{p.id === 'custom' ? 'W × H' : `${pw} × ${ph}`}</i>
            </button>
          );
        })}
      </div>
      {preset === 'custom' && (
        <div class="custom-size">
          <input class="text-input" type="number" min={MIN_DOC_SIDE} max={app.engine.maxSide} step={1} aria-label="Width in pixels"
            value={custom[0]} onChange={e => setSide(0, e.currentTarget.value)} />
          <em>×</em>
          <input class="text-input" type="number" min={MIN_DOC_SIDE} max={app.engine.maxSide} step={1} aria-label="Height in pixels"
            value={custom[1]} onChange={e => setSide(1, e.currentTarget.value)} />
          <em>px</em>
        </div>
      )}
      {clamped && <p class="note">Sheets are limited to about 4 megapixels ({app.engine.maxSide} px on the long side): this one will be {w} × {h} px.</p>}
      <Seg label="Orientation" value={portrait} onChange={orient}
        options={[{ id: false, label: 'Landscape', disabled: square }, { id: true, label: 'Portrait', disabled: square }]} />
      <button class="primary" disabled={same} onClick={apply}>
        {same ? 'Current size' : armed ? `Crop to ${w} × ${h}?` : `Apply ${w} × ${h}`}
      </button>
      <p class="note">The painting keeps its size, centred on the new sheet; a smaller sheet crops it. Undo brings the old sheet back; the steps before the change are forgotten.</p>
    </div>
  );
}

export function PaperPanel() {
  const app = useApp();
  const current = app.paper.value;
  return (
    <Panel class="popover paper-panel" open={app.popover.value === 'paper'} role="dialog" label="Paper">
      <PanelHead title="Paper" sub={current.hint} />
      <SizeSection />
      <Slider label="Texture" title="How strongly the paper's tooth, fibres and flecks show. Saved images use the same strength."
        value={app.paperLook.value.texture} onInput={v => app.setPaperTexture(v)} onChange={v => app.setPaperTexture(v, 'commit')} />
      <div class="papers" role="listbox" aria-label="Paper">
        {PAPERS.map(p => <PaperCard key={p.id} paper={p} selected={p.id === current.id} onPick={() => app.choosePaper(p)} />)}
      </div>
    </Panel>
  );
}
