/** A segmented radio group: one button per option, the chosen one marked `on`. */
export function Seg<V extends string | boolean | number>({ options, value, onChange, title, label }: {
  options: { id: V; label: string; title?: string; disabled?: boolean }[];
  value: V;
  onChange(v: V): void;
  title?: string;
  label?: string;
}) {
  return (
    <div class="seg" role="radiogroup" title={title} aria-label={label}>
      {options.map(o => (
        <button key={String(o.id)} role="radio" class={o.id === value ? 'on' : ''} aria-checked={o.id === value}
          title={o.title} disabled={o.disabled} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}
