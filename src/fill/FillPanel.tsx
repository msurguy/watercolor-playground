import { useApp } from '../app/context';
import { Seg } from '../ui/Seg';
import { Row, SliderRows, type SliderSpec } from '../ui/Slider';
import { ToolPanel } from '../ui/ToolPanel';
import type { FillSettings, FillStore } from './FillStore';

const SLIDERS: SliderSpec<FillSettings>[] = [
  { key: 'tolerance', label: 'Tolerance', hint: 'How different a colour may be and still count as the same area' },
  { key: 'speed', label: 'Speed', hint: 'How fast the wash spreads' },
  { key: 'water', label: 'Water', hint: 'How wet the wash is' },
  { key: 'strength', label: 'Amount', max: 1.5, hint: 'Pigment laid down (on top of the Pigment setting)', show: s => s.mode === 'paint' },
  { key: 'soft', label: 'Soft edge', hint: 'Feather the wash at the edge of the area' },
];

const MODES: { id: FillSettings['mode']; label: string }[] = [{ id: 'paint', label: 'Paint' }, { id: 'water', label: 'Water' }];

export function FillPanel({ tool }: { tool: FillStore }) {
  const app = useApp();
  const s = tool.settings.value;
  return (
    <ToolPanel title="Fill" class="fill" open={tool.active.value} status={tool.status.value} busy={tool.progress.value !== null}
      sub="Tap an area of the paper; a wash of the current pigment spreads out from the tap until it meets a different colour."
      onStop={() => tool.stop()} onClose={() => app.setTool('brush')}>
      <div class="tool-rows">
        <Row label="Fill with"><Seg options={MODES} value={s.mode} onChange={mode => tool.set({ mode })} /></Row>
        <SliderRows spec={SLIDERS} settings={s} onChange={p => tool.set(p)} />
      </div>
    </ToolPanel>
  );
}
