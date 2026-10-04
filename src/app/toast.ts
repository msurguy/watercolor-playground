import { signal } from '@preact/signals';

/** The short confirmation shown at the top of the screen, or null. */
export const toast = signal<string | null>(null);
let timer = 0;

export function showToast(text: string) {
  clearTimeout(timer);
  toast.value = text;
  timer = window.setTimeout(() => { toast.value = null; }, 1200);
}
