const PATHS: Record<string, string> = {
  brush: 'M19 3c-3 1.5-7.5 6-9.5 9l2.5 2.5c3-2 7.5-6.5 9-9.5L19 3ZM9 13.5c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-2.5 3 3 1.5 8 1 8.5-3.5L9 13.5Z',
  water: 'M12 3.5c-3 4-6 7.2-6 10.5a6 6 0 0 0 12 0c0-3.3-3-6.5-6-10.5Z M9 14.5a3 3 0 0 0 3 3',
  pen: 'M14.5 4.5l5 5L9 20H4v-5L14.5 4.5Z M12.5 6.5l5 5 M4 20l5.5-5.5',
  text: 'M5 7.5V5h14v2.5 M12 5v14 M9.5 19h5',
  lift: 'M5 8.5c2-1.5 4-1.5 6 0s4 1.5 6 0l2 9c-2 1.5-4 1.5-6 0s-4-1.5-6 0l-2-9Z M8 3.5c1 .8 2 .8 3 0',
  undo: 'M9 5.5 4 10.5l5 5 M4 10.5h10a4.75 4.75 0 0 1 0 9.5h-3',
  redo: 'M15 5.5 20 10.5l-5 5 M20 10.5H10a4.75 4.75 0 0 0 0 9.5h3',
  shape: 'M4 4.5h8v8H4Z M15.5 11.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z',
  fill: 'M10 3.5 4.5 9l7 7 5.5-5.5Z M4.5 9c2 .5 4 .5 6-1 M10 3.5 7.5 1.5 M19 13c1.3 1.8 2 3 2 3.9a2 2 0 0 1-4 0c0-.9.7-2.1 2-3.9Z',
  dry: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2.5 M12 19.5V22 M2 12h2.5 M19.5 12H22 M4.9 4.9l1.8 1.8 M17.3 17.3l1.8 1.8 M4.9 19.1l1.8-1.8 M17.3 6.7l1.8-1.8',
  clear: 'M5 7h14 M10 7V4.5h4V7 M7 7l1 13h8l1-13',
  image: 'M4 5h16v14H4Z M4 16l5-5 4 4 2.5-2.5L20 17 M15.5 7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  save: 'M12 4v11 M7.5 10.5 12 15l4.5-4.5 M5 19.5h14',
  sliders: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5v4 M9 15v4',
  library: 'M4 5.5h6v6H4Z M14 5.5h6v6h-6Z M4 14.5h6v6H4Z M14 14.5h6v6h-6Z',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
};

/** A stroke icon from the table above, or any 24×24 path via `d`. */
export function Icon({ name, d, size = 20 }: { name?: string; d?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={d ?? PATHS[name!]} />
    </svg>
  );
}
