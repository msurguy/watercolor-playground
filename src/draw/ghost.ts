// A dashed outline over the paper showing where a scripted drawing will land.

export interface Ghost {
  /** Show the given SVG path (client-space coordinates). */
  set(d: string): void;
  hide(): void;
}

export function createGhost(root: HTMLElement): Ghost {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ghost');
  svg.innerHTML = '<path/>';
  svg.style.display = 'none';
  root.appendChild(svg);
  const path = svg.querySelector('path')!;
  return {
    set(d) { path.setAttribute('d', d); svg.style.display = ''; },
    hide() { svg.style.display = 'none'; },
  };
}
