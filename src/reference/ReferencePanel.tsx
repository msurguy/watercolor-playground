import { useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { Icon } from '../ui/Icon';
import { Panel, PanelHead } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { IMAGE_ACCEPT } from './decode';

export function ReferencePanel() {
  const app = useApp();
  const ref = app.reference;
  const has = ref.has.value;
  const file = useRef<HTMLInputElement>(null);
  const seg = (label: string, title: string, on: boolean, click: () => void) =>
    <button class={on ? 'on' : ''} title={title} disabled={!has} onClick={click}>{label}</button>;
  return (
    <Panel class="popover reference" open={app.popover.value === 'reference'} role="dialog" label="Reference image">
      <PanelHead title="Reference" sub="Shown under the paint to work from. Never exported." />
      <button class="import" onClick={() => file.current?.click()}><Icon name="plus" size={16} /><span>{has ? 'Replace image…' : 'Import image…'}</span></button>
      <Slider label="Opacity" value={ref.opacity} disabled={!has} onInput={v => ref.setOpacity(v)} />
      <div class="seg">
        {seg('Show', 'Show or hide the reference (R)', has && ref.visible, () => ref.setVisible(!ref.visible))}
        {seg('Move', 'Drag to move, drag a corner or pinch to scale', ref.adjusting.value, () => ref.setAdjust(!ref.adjusting.value))}
        {seg('Fit', 'Fit to the paper', false, () => ref.fit())}
        {seg('Remove', 'Remove the reference', false, () => ref.remove())}
      </div>
      <input ref={file} type="file" accept={IMAGE_ACCEPT} hidden onChange={e => {
        const el = e.currentTarget as HTMLInputElement, f = el.files?.[0];
        el.value = '';
        if (f) void ref.load(f);
      }} />
    </Panel>
  );
}
