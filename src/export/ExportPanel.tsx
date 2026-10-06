import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { PROJECT_EXT } from '../project/format';
import { Icon } from '../ui/Icon';
import { Panel, PanelHead } from '../ui/Panel';
import { Seg } from '../ui/Seg';
import { Slider } from '../ui/Slider';
import { BACKGROUNDS, FORMATS } from './ExportStore';

export function ExportPanel() {
  const app = useApp();
  const ex = app.exporter;
  const s = ex.settings.value;
  const [w, h] = app.docSize.value;
  const project = app.project;
  const busy = project.busy.value;
  const file = useRef<HTMLInputElement>(null);
  // ⌘O asks for the picker; the input lives here
  const request = project.openRequest.value;
  useEffect(() => { if (request) file.current?.click(); }, [request]);
  return (
    <Panel class="popover export" open={app.popover.value === 'save'} role="dialog" label="Save image">
      <PanelHead title="Save image" sub={`${w} × ${h} px, the size of the sheet. The reference image is never included.`} />
      <div class="field"><span>Background</span>
        <Seg value={s.background} onChange={background => ex.set({ background })}
          options={BACKGROUNDS.map(b => ({ ...b, disabled: b.id === 'transparent' && s.format === 'jpeg' }))} />
      </div>
      <div class="field"><span>Paper texture</span>
        <Seg value={s.texture} onChange={texture => ex.set({ texture })} title={`Relief and fibres of the ${app.paper.value.name} paper`}
          options={[{ id: true, label: 'Textured', disabled: s.background === 'transparent' }, { id: false, label: 'Flat', disabled: s.background === 'transparent' }]} />
      </div>
      <div class="field"><span>Format</span><Seg options={FORMATS} value={s.format} onChange={format => ex.set({ format })} /></div>
      <Slider label="Quality" min={0.5} max={1} value={s.quality} hidden={s.format === 'png'} onInput={quality => ex.set({ quality })} />
      <button class="primary" onClick={() => void ex.save()}>Download</button>
      <div class="field project"><span>Project</span>
        <div class="project-buttons">
          <button class="primary" disabled={busy !== null} onClick={() => void project.save()}>
            {busy === 'saving' ? 'Saving…' : `Save project (.${PROJECT_EXT})`}
          </button>
          <button class="import" disabled={busy !== null} onClick={() => file.current?.click()}>
            <Icon name="folder" size={16} /><span>{busy === 'opening' ? 'Opening…' : 'Open project…'}</span>
          </button>
        </div>
        <p class="note">A project file keeps the wet paint, paper and reference so you can carry on later (⌘S / ⌘O). Undo history is not saved.</p>
      </div>
      <input ref={file} type="file" accept={`.${PROJECT_EXT}`} hidden onChange={e => {
        const el = e.currentTarget as HTMLInputElement, f = el.files?.[0];
        el.value = '';
        if (f) void project.open(f);
      }} />
    </Panel>
  );
}
