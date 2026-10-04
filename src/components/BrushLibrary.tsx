import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { resizeTick } from '../app/resize';
import type { Brush } from '../engine/brushes';
import { Icon } from '../ui/Icon';
import { Panel, PanelHead } from '../ui/Panel';
import { drawStroke } from '../ui/preview';

function BrushCard({ brush, hex, selected, visible, onPick, onRemove }: {
  brush: Brush; hex: string; selected: boolean; visible: boolean; onPick(): void; onRemove(): void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tick = resizeTick.value;
  useEffect(() => { drawStroke(canvas.current!, brush, hex); }, [brush, hex, tick]);
  useEffect(() => { if (selected && visible) el.current?.scrollIntoView({ block: 'nearest' }); }, [selected, visible]);
  return (
    <div ref={el} class={`brush${brush.custom ? ' custom' : ''}${selected ? ' on' : ''}`} role="option" aria-selected={selected} tabIndex={0}
      title={brush.hint} onClick={onPick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}>
      <canvas ref={canvas} class="stroke" width={150} height={44} />
      <span class="label">{brush.name}</span>
      {brush.custom && <button class="icon remove" title="Remove this brush" onClick={e => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={14} /></button>}
    </div>
  );
}

export function BrushLibrary() {
  const app = useApp();
  const open = app.libraryOpen.value;
  const hex = app.previewHex.value;
  const selected = app.brush.value.id;
  const file = useRef<HTMLInputElement>(null);
  return (
    <Panel class="library" open={open} role="dialog" label="Brushes">
      <PanelHead title="Brushes" sub="Shape follows the stroke, pen tilt or a set angle. Dry brushes skip the paper tooth." onClose={() => app.toggleLibrary(false)} />
      <div class="brushes" role="listbox" aria-label="Brush library">
        {app.allBrushes.value.map(b => (
          <BrushCard key={b.id} brush={b} hex={hex} selected={b.id === selected} visible={open}
            onPick={() => app.chooseBrush(b)} onRemove={() => app.removeBrush(b.id)} />
        ))}
      </div>
      <div class="library-foot">
        <button class="import" title="Use an image as a brush tip: dark marks on white, or white on transparent" onClick={() => file.current?.click()}>
          <Icon name="plus" size={16} /><span>Import texture…</span>
        </button>
        <span class="note">PNG or JPG. Light background is inverted automatically.</span>
      </div>
      <input ref={file} type="file" accept="image/*,.heic,.heif" hidden onChange={e => {
        const el = e.currentTarget as HTMLInputElement, f = el.files?.[0];
        el.value = '';
        if (f) app.importFile(f);
      }} />
    </Panel>
  );
}
