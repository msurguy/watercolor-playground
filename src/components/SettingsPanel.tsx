import { useApp } from '../app/context';
import { DEFAULT_PARAMS, type Params } from '../engine/Engine';
import { Panel } from '../ui/Panel';
import { SliderRows, type SliderSpec } from '../ui/Slider';

const SLIDERS: SliderSpec<Params>[] = [
  { key: 'size', label: 'Size' },
  { key: 'water', label: 'Water' },
  { key: 'load', label: 'Pigment' },
  { key: 'flow', label: 'Flow' },
  { key: 'bleed', label: 'Bleed' },
  { key: 'edge', label: 'Edges' },
  { key: 'granulation', label: 'Grain' },
  { key: 'dry', label: 'Dry speed' },
];

export function SettingsPanel() {
  const app = useApp();
  return (
    <Panel class="settings" open={app.popover.value === 'settings'}>
      <SliderRows spec={SLIDERS} settings={app.params.value} onChange={p => app.setParams(p)} />
      <button class="reset" onClick={() => app.setParams(DEFAULT_PARAMS)}>Reset</button>
    </Panel>
  );
}
