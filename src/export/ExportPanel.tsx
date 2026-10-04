import { useApp } from '../app/context';
import { Panel, PanelHead } from '../ui/Panel';
import { Seg } from '../ui/Seg';
import { Slider } from '../ui/Slider';
import { BACKGROUNDS, FORMATS } from './ExportStore';

export function ExportPanel() {
  const app = useApp();
  const ex = app.exporter;
  const s = ex.settings.value;
  return (
    <Panel class="popover export" open={app.popover.value === 'save'} role="dialog" label="Save image">
      <PanelHead title="Save image" sub="The reference image is never included." />
      <div class="field"><span>Background</span>
        <Seg value={s.background} onChange={background => ex.set({ background })}
          options={BACKGROUNDS.map(b => ({ ...b, disabled: b.id === 'transparent' && s.format === 'jpeg' }))} />
      </div>
      <div class="field"><span>Format</span><Seg options={FORMATS} value={s.format} onChange={format => ex.set({ format })} /></div>
      <Slider label="Quality" min={0.5} max={1} value={s.quality} hidden={s.format === 'png'} onInput={quality => ex.set({ quality })} />
      <button class="primary" onClick={() => void ex.save()}>Download</button>
    </Panel>
  );
}
