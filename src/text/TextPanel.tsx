import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import type { Tool } from '../engine/Engine';
import { Seg } from '../ui/Seg';
import { Row, SliderRows, type SliderSpec } from '../ui/Slider';
import { ToolPanel } from '../ui/ToolPanel';
import { ATLAS, FONTS, fontGroups, fontLabel } from './fonts';
import type { Align } from './layout';
import type { TextSettings, TextStore } from './TextStore';

const SLIDERS: SliderSpec<TextSettings>[] = [
  { key: 'size', label: 'Size', hint: 'Letter height' },
  { key: 'speed', label: 'Speed', hint: 'How fast the brush travels' },
  { key: 'pressure', label: 'Pressure', min: 0.05, hint: 'How hard the brush presses' },
  { key: 'taper', label: 'Taper', hint: 'Lighter touch at the ends of each stroke' },
  { key: 'spacing', label: 'Spacing', min: -0.1, max: 0.4, hint: 'Extra space between letters' },
  { key: 'wobble', label: 'Wobble', hint: 'Hand tremor' },
];

const TOOLS: { id: Tool; label: string }[] = [{ id: 'brush', label: 'Brush' }, { id: 'pen', label: 'Pen' }, { id: 'water', label: 'Water' }];
const ALIGNS: { id: Align; label: string }[] = [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Right' }];
const GROUPS = fontGroups();

export function TextPanel({ tool }: { tool: TextStore }) {
  const app = useApp();
  const s = tool.settings.value;
  const open = tool.active.value;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // focus the field when the tool asks (opened with nothing to write, or tapped with no text)
  const focusRequest = tool.focusRequest.value;
  useEffect(() => { if (focusRequest) input.current?.focus(); }, [focusRequest]);
  // keep the chosen font in view
  useEffect(() => {
    if (open) list.current?.querySelector('.fontrow.on')?.scrollIntoView({ block: open ? 'center' : 'nearest' });
  }, [open, s.font]);

  const stopKeys = (e: KeyboardEvent) => { if (e.key === 'Enter') input.current?.blur(); e.stopPropagation(); };

  return (
    <ToolPanel title="Text" open={open} status={tool.status.value} busy={tool.writing.value}
      sub="Tap the paper to write there. Each letter is drawn stroke by stroke with the current brush and pigment."
      onStop={() => tool.stop()} onClose={() => app.setTool('brush')}
      foot={<a class="credit" target="_blank" rel="noopener" href={FONTS[s.font].source} title="Font source">{fontLabel(s.font)} ↗</a>}>
      <input ref={input} class="text-input" type="text" placeholder="Write something…" maxLength={160} spellcheck={false}
        autocomplete="off" aria-label="Text to write" value={s.text}
        onInput={e => tool.set({ text: (e.currentTarget as HTMLInputElement).value })} onKeyDown={stopKeys} />
      <div ref={list} class="fontlist" role="listbox" aria-label="Font" style={{ '--atlas': `url("${ATLAS.url}")` }}>
        {GROUPS.map(g => <>
          <div class="fontgroup">{g.label}</div>
          {g.keys.map(k => {
            const row = ATLAS.row(k), on = k === s.font;
            return (
              <div key={k} class={`fontrow${on ? ' on' : ''}`} role="option" aria-selected={on} tabIndex={0} title={fontLabel(k)}
                onClick={() => tool.set({ font: k })}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tool.set({ font: k }); } }}>
                {row >= 0 ? <i style={{ backgroundPosition: `0 ${-row * ATLAS.rowHeight}px` }} /> : <span>{fontLabel(k)}</span>}
              </div>
            );
          })}
        </>)}
      </div>
      <div class="tool-rows">
        <Row label="Draw with"><Seg options={TOOLS} value={s.tool} onChange={t => tool.set({ tool: t })} /></Row>
        <Row label="Anchor"><Seg options={ALIGNS} value={s.align} onChange={align => tool.set({ align })} /></Row>
        <SliderRows spec={SLIDERS} settings={s} onChange={p => tool.set(p)} />
      </div>
    </ToolPanel>
  );
}
