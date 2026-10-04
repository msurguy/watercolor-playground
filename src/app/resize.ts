import { signal } from '@preact/signals';

/** Bumped on every window resize so layout-dependent effects (ghosts, frames, thumbnails) re-run. */
export const resizeTick = signal(0);
export const bumpResize = () => { resizeTick.value++; };
