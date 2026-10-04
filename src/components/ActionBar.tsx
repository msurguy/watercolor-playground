import { useApp } from '../app/context';
import type { PopoverId } from '../app/store';
import { Icon } from '../ui/Icon';
import { Panel } from '../ui/Panel';

function Action({ icon, label, title, onClick, disabled, danger, popover }: {
  icon: string; label: string; title: string; onClick(): void; disabled?: boolean; danger?: boolean; popover?: PopoverId;
}) {
  const app = useApp();
  const on = popover !== undefined && app.popover.value === popover;
  return (
    <button class={`${on ? 'on' : ''}${danger ? ' danger' : ''}`} title={title} disabled={disabled} onClick={onClick}
      aria-expanded={popover !== undefined ? on : undefined}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );
}

export function ActionBar() {
  const app = useApp();
  const sure = app.confirmClear.value;
  return (
    <Panel class="actions">
      <Action icon="undo" label="Undo" title="Undo (⌘Z)" disabled={!app.canUndo.value} onClick={() => app.undo()} />
      <Action icon="redo" label="Redo" title="Redo (⇧⌘Z)" disabled={!app.canRedo.value} onClick={() => app.redo()} />
      <Action icon="dry" label="Dry" title="Dry and fix the painting into the paper (D)" onClick={() => app.dry()} />
      <Action icon="clear" label={sure ? 'Sure?' : 'Clear'} title="Clear the paper" danger={sure} onClick={() => app.clear()} />
      <Action icon="image" label="Ref" title="Reference image under the paint (R to show / hide)" popover="reference" onClick={() => app.togglePopover('reference')} />
      <Action icon="save" label="Save" title="Save image (S saves with the last settings)" popover="save" onClick={() => app.togglePopover('save')} />
      <Action icon="sliders" label="Settings" title="Brush & water settings" popover="settings" onClick={() => app.togglePopover('settings')} />
    </Panel>
  );
}
