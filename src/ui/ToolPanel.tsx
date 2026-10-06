import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Panel, PanelHead } from './Panel';

const phone = () => window.matchMedia('(max-width: 640px)').matches;

/**
 * The layout shared by the text, shape and fill tools: a head, a scrolling body of
 * controls, and a foot with a status line and a Stop button while the tool is busy.
 * On phones the body folds away (by hand, or when the tool starts drawing) so the
 * paper underneath stays in view.
 */
export function ToolPanel({ title, sub, open, status, busy, onStop, onClose, class: cls = '', children, foot }: {
  title: string; sub: string; open: boolean; status: string; busy: boolean;
  onStop(): void; onClose(): void; class?: string; children: ComponentChildren; foot?: ComponentChildren;
}) {
  const [folded, setFolded] = useState(false);
  useEffect(() => { if (busy && phone()) setFolded(true); }, [busy]);
  useEffect(() => { if (!open) setFolded(false); }, [open]);

  const fold = (
    <button class={`icon fold${folded ? ' folded' : ''}`} title={folded ? 'Show settings' : 'Hide settings'}
      aria-expanded={!folded} onClick={() => setFolded(!folded)}><Icon name="chevron" size={16} /></button>
  );
  return (
    <Panel class={`tool-panel ${cls}${folded ? ' folded' : ''}`} open={open} role="dialog" label={title}>
      <PanelHead title={title} sub={sub} onClose={onClose} actions={fold} />
      <div class="tool-body">{children}</div>
      <div class="tool-foot">
        <span class="status">{status}</span>
        {busy && <button class="stop" onClick={onStop}><Icon name="close" size={14} /><span>Stop</span></button>}
        {foot}
      </div>
    </Panel>
  );
}
