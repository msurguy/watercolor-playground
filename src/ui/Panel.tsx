import type { AriaRole, ComponentChildren } from "preact";
import { Icon } from './Icon';

/** A floating glass panel. `open` false renders it with the `hidden` attribute (so it keeps its state). */
export function Panel({ class: cls, open = true, role, label, children, ...rest }: {
  class: string; open?: boolean; role?: AriaRole; label?: string; children: ComponentChildren;
  style?: string | Record<string, string | number>; onClick?: (e: MouseEvent) => void;
}) {
  return <div class={`panel ${cls}`} hidden={!open} role={role} aria-label={label} {...rest}>{children}</div>;
}

/** Title, optional one-line explanation and an optional close button. */
export function PanelHead({ title, sub, onClose }: { title: string; sub?: string; onClose?: () => void }) {
  return (
    <div class="panel-head">
      <span>{title}</span>
      {sub && <span class="sub">{sub}</span>}
      {onClose && <button class="icon" title="Close" onClick={onClose}><Icon name="close" size={16} /></button>}
    </div>
  );
}
