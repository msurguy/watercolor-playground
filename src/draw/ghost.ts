import { signal } from '@preact/signals';

// A dashed outline over the paper showing where a scripted drawing will land.
// Tools write an SVG path (client-space coordinates); <Ghost/> draws it.

export const ghostPath = signal<string | null>(null);
export const setGhost = (d: string) => { ghostPath.value = d; };
export const hideGhost = () => { if (ghostPath.peek() !== null) ghostPath.value = null; };
