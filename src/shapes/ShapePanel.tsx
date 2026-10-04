import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import type { Tool } from '../engine/Engine';
import { Icon } from '../ui/Icon';
import { Seg } from '../ui/Seg';
import { Row, SliderRows, type SliderSpec } from '../ui/Slider';
import { ToolPanel } from '../ui/ToolPanel';
import { hasRotation, hasSides, SHAPES, type ShapeKind } from './shapes';
import type { ShapeSettings, ShapeStore } from './ShapeStore';

const SLIDERS: SliderSpec<ShapeSettings>[] = [
  { key: 'speed', label: 'Speed', hint: 'How fast the brush travels' },
  { key: 'pressure', label: 'Pressure', min: 0.05, hint: 'How hard the brush presses' },
  { key: 'taper', label: 'Taper', hint: 'Lighter touch at the ends of each stroke' },
  { key: 'wobble', label: 'Wobble', hint: 'Hand tremor' },
  { key: 'sides', label: 'Sides', min: 3, max: 12, step: 1, hint: 'Polygon sides / star points', show: s => hasSides(s.kind) },
  { key: 'inner', label: 'Inner', min: 0.2, max: 0.9, hint: 'Star inner radius', show: s => s.kind === 'star' },
  { key: 'rotation', label: 'Rotate', min: 0, max: 360, step: 1, hint: 'Rotation in degrees', show: s => hasRotation(s.kind) },
];

const TOOLS: { id: Tool; label: string }[] = [{ id: 'brush', label: 'Brush' }, { id: 'pen', label: 'Pen' }, { id: 'water', label: 'Water' }];
const LOCKS = [{ id: false, label: 'Free' }, { id: true, label: '1 : 1' }];

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

export function ShapePanel({ tool }: { tool: ShapeStore }) {
  const app = useApp();
  const s = tool.settings.value;
  const svg = tool.svg.value;
  const file = useRef<HTMLInputElement>(null);

  const pickRequest = tool.pickRequest.value;
  useEffect(() => { if (pickRequest) file.current?.click(); }, [pickRequest]);

  const pick = (kind: ShapeKind) => {
    tool.set({ kind });
    if (kind === 'svg' && !svg) file.current?.click();
  };

  return (
    <ToolPanel title="Shapes" class="shape" open={tool.active.value} status={tool.status.value} busy={tool.drawing.value}
      sub="Drag a box on the paper; when you let go the outline is drawn stroke by stroke with the current brush and pigment."
      onStop={() => tool.stop()} onClose={() => app.setTool('brush')}>
      <div class="shapes" role="radiogroup" aria-label="Shape">
        {SHAPES.map(k => (
          <button key={k.id} role="radio" class={k.id === s.kind ? 'on' : ''} aria-checked={k.id === s.kind} title={k.hint} onClick={() => pick(k.id)}>
            <Icon d={GLYPHS[k.id]} size={22} /><span>{k.short ?? k.label}</span>
          </button>
        ))}
      </div>
      <div class="tool-rows">
        {s.kind === 'svg' && (
          <div class="slider"><span>File</span>
            <div class="svg-file">
              <span class="svg-name" title={svg?.name ?? ''}>{svg ? `${svg.name} · ${svg.count} ${svg.count === 1 ? 'stroke' : 'strokes'}` : 'No file yet'}</span>
              <button class="svg-pick" onClick={() => file.current?.click()}>{svg ? 'Replace…' : 'Choose…'}</button>
            </div>
          </div>
        )}
        <Row label="Draw with"><Seg options={TOOLS} value={s.tool} onChange={t => tool.set({ tool: t })} /></Row>
        <Row label="Lock" title="Keep squares square, circles round, lines on 45° steps and SVGs in their own proportions (or hold Shift)">
          <Seg options={LOCKS} value={s.lock} onChange={lock => tool.set({ lock })} />
        </Row>
        <SliderRows spec={SLIDERS} settings={s} onChange={p => tool.set(p)} />
      </div>
      <input ref={file} type="file" accept=".svg,image/svg+xml" hidden onChange={e => {
        const el = e.currentTarget as HTMLInputElement, f = el.files?.[0];
        el.value = '';
        if (f) void tool.loadSvg(f);
      }} />
    </ToolPanel>
  );
}
