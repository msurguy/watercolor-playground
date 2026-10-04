import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { ENGINE_TOOLS, PANEL_TOOLS } from '../app/registry';
import { resizeTick } from '../app/resize';
import { Icon } from '../ui/Icon';
import { Panel } from '../ui/Panel';
import { drawThumb } from '../ui/preview';

const TOOLS = [...ENGINE_TOOLS.map(t => ({ ...t, icon: t.id as string })), ...PANEL_TOOLS];

export function Toolbar() {
  const app = useApp();
  const brush = app.brush.value, hex = app.previewHex.value, tick = resizeTick.value;
  const shown = app.shownTool.value, tool = app.tool.value;
  const open = app.libraryOpen.value;
  const thumb = useRef<HTMLCanvasElement>(null);
  useEffect(() => { drawThumb(thumb.current!, brush, hex); }, [brush, hex, tick]);

  return (
    <Panel class="tools" role="navigation" label="Tools">
      <button class={`tool pick${open ? ' open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        title={`${brush.name}: ${brush.hint}. Open the brush library (, and . to cycle)`} onClick={() => app.toggleLibrary()}>
        <canvas ref={thumb} class="thumb" width={28} height={28} /><span class="brushname">{brush.name}</span>
      </button>
      <hr />
      {TOOLS.map(t => (
        <button key={t.id} class={`tool${shown === t.id ? ' on' : ''}`} aria-pressed={tool === t.id}
          title={`${t.label} (${t.key}): ${t.hint}`} onClick={() => app.setTool(t.id)}>
          <Icon name={t.icon} /><span>{t.label}</span>
        </button>
      ))}
    </Panel>
  );
}
