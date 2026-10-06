import { useApp } from '../app/context';
import type { StepKind } from '../engine/history';
import { Icon } from '../ui/Icon';
import { Panel, PanelHead } from '../ui/Panel';

const ICONS: Record<StepKind, string> = {
  stroke: 'brush', fill: 'fill', script: 'shape', dry: 'dry', clear: 'clear', resize: 'resize', paper: 'paper', reference: 'image',
};

/** A stroke's icon follows the tool it was made with. */
function iconFor(kind: StepKind, label: string) {
  if (kind === 'stroke') return label === 'Water' ? 'water' : label === 'Pen' ? 'pen' : label === 'Lift' ? 'lift' : 'brush';
  if (kind === 'script') return label.startsWith('Text') ? 'text' : 'shape';
  if (kind === 'fill') return label.startsWith('Water') ? 'water' : 'fill';
  return ICONS[kind];
}

/** Every undo step, newest first; click one to go back (or forward) to it. */
export function HistoryPanel() {
  const app = useApp();
  const { list, index } = app.history.value;
  const baseline = app.project.baseline.value;
  const rows = list.map((s, i) => ({ s, i: i + 1 })).reverse();
  return (
    <Panel class="popover history-panel" open={app.popover.value === 'history'} role="dialog" label="History">
      <PanelHead title="History" sub={list.length ? `${index} of ${list.length} steps applied. Click a step to go back or forward to it.` : 'Each stroke, fill, paper or reference change becomes a step here.'} />
      <div class="history-list" role="listbox" aria-label="History">
        {rows.map(({ s, i }) => (
          <button key={i} role="option" aria-selected={i === index} class={i === index ? 'on' : i > index ? 'undone' : ''}
            title={i > index ? 'Redo up to here' : i === index ? 'Current state' : 'Undo back to here'} onClick={() => app.jumpTo(i)}>
            <Icon name={iconFor(s.kind, s.label)} size={16} /><span>{s.label}</span>
          </button>
        ))}
        <button role="option" aria-selected={index === 0} class={index === 0 ? 'on' : ''} title="Before the first step" onClick={() => app.jumpTo(0)}>
          <Icon name={baseline === 'Opened project' ? 'folder' : 'paper'} size={16} /><span>{baseline}</span>
        </button>
      </div>
    </Panel>
  );
}
