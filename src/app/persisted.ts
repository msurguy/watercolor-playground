import { effect, signal, type Signal } from '@preact/signals';

/**
 * A signal backed by localStorage. Reads once (merged over `defaults`, then passed through
 * `sanitize`) and writes on every change. Storage that is full or blocked fails quietly.
 */
export function persisted<T extends object>(key: string, defaults: T, sanitize: (v: T) => T = v => v): Signal<T> {
  let value: T = { ...defaults };
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object') value = { ...value, ...(parsed as Partial<T>) };
  } catch { /* storage blocked or corrupt */ }
  const s = signal(sanitize(value));
  let first = true;
  effect(() => {
    const v = s.value;
    if (first) { first = false; return; }
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
  });
  return s;
}

/** A single string remembered in localStorage (no JSON). */
export const storedString = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* storage blocked */ } },
};
