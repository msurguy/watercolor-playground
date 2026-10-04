import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';
import { Panel, PanelHead } from './Panel';

/**
 * The layout shared by the text, shape and fill tools: a head, a scrolling body of
 * controls, and a foot with a status line and a Stop button while the tool is busy.
 */
export function ToolPanel({ title, sub, open, status, busy, onStop, onClose, class: cls = '', children, foot }: {
  title: string; sub: string; open: boolean; status: string; busy: boolean;
  onStop(): void; onClose(): void; class?: string; children: ComponentChildren; foot?: ComponentChildren;
}) {
  return (
    <Panel class={`tool-panel ${cls}`} open={open} role="dialog" label={title}>
      <PanelHead title={title} sub={sub} onClose={onClose} />
      <div class="tool-body">
        {children}
        <div class="tool-foot">
          <span class="status">{status}</span>
          {busy && <button class="stop" onClick={onStop}><Icon name="close" size={14} /><span>Stop</span></button>}
          {foot}
        </div>
      </div>
    </Panel>
  );
}
