import type { ComponentChildren } from 'preact';

/** A labelled row: caption on the left, a control on the right. */
export function Row({ label, title, children, hidden }: { label: string; title?: string; children: ComponentChildren; hidden?: boolean }) {
  return <label class="slider" title={title} hidden={hidden}><span>{label}</span>{children}</label>;
}

export function Slider({ label, value, min = 0, max = 1, step = 0.01, title, disabled, hidden, onInput, onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; title?: string; disabled?: boolean; hidden?: boolean;
  onInput(v: number): void;
  /** The thumb was let go (once per drag), for things that record one undo step per adjustment. */
  onChange?(v: number): void;
}) {
  return (
    <Row label={label} title={title} hidden={hidden}>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onInput={e => onInput(Number((e.currentTarget as HTMLInputElement).value))}
        onChange={onChange ? e => onChange(Number((e.currentTarget as HTMLInputElement).value)) : undefined} />
    </Row>
  );
}

/** Declarative description of one numeric setting. */
export interface SliderSpec<S> {
  key: keyof S & string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** Hide the slider for some settings (e.g. star-only controls). */
  show?(settings: S): boolean;
}

/** One <Slider/> per spec, bound to the matching numeric field of `settings`. */
export function SliderRows<S extends object>({ spec, settings, onChange }: {
  spec: SliderSpec<S>[]; settings: S; onChange(patch: Partial<S>): void;
}) {
  return <>{spec.map(s => (
    <Slider key={s.key} label={s.label} min={s.min} max={s.max} step={s.step} title={s.hint}
      hidden={s.show ? !s.show(settings) : false}
      value={settings[s.key] as unknown as number}
      onInput={v => onChange({ [s.key]: v } as unknown as Partial<S>)} />
  ))}</>;
}
