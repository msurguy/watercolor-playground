import { useApp } from '../app/context';
import { mixToHex } from '../engine/spectral';
import { customEntry, PALETTE, type PaletteEntry } from '../palette';
import { Panel } from '../ui/Panel';

/** Dab-like swatch: masstone at the centre, diluted towards the rim. */
function swatchBackground(e: PaletteEntry): string {
  if (e.pigment.white) return `radial-gradient(circle at 40% 38%, #fff, ${e.hex} 70%)`;
  const at = (c: number) => mixToHex([{ pigment: e.pigment, amount: c }]);
  return `radial-gradient(circle at 42% 40%, ${at(0.55)}, ${at(1)} 55%, ${at(1.25)} 72%, ${at(0.7)} 100%)`;
}

const BACKGROUNDS = PALETTE.map(swatchBackground);
const shortcut = (i: number) => (i < 9 ? ` (${i + 1})` : i === PALETTE.length - 1 ? ' (0)' : '');

export function Palette() {
  const app = useApp();
  const current = app.current.value, previous = app.previous.value;
  const custom = current.name === 'Custom';
  const mixable = !current.pigment.white && !previous.pigment.white;
  const wet = mixable ? mixToHex([{ pigment: previous.pigment, amount: 0.5 }, { pigment: current.pigment, amount: 0.5 }]) : '';
  return (
    <Panel class="palette">
      <div class="swatches" role="listbox" aria-label="Pigments">
        {PALETTE.map((e, i) => {
          const on = e.name === current.name;
          return <button key={e.name} class={`swatch${on ? ' on' : ''}`} role="option" aria-selected={on} title={e.name + shortcut(i)}
            style={{ background: BACKGROUNDS[i] }} onClick={() => app.choose(e)} />;
        })}
        <label class={`swatch custom${custom ? ' on' : ''}`} title="Custom pigment" style={custom ? { background: swatchBackground(current) } : undefined}>
          <input type="color" value={custom ? current.hex : '#7a3b8f'} onInput={e => app.choose(customEntry((e.currentTarget as HTMLInputElement).value))} />
        </label>
      </div>
      <div class="well" title="Spectral mix of your last two pigments">
        <span class="name">{current.name}</span>
        <span class="mix">{mixable && <><i style={{ background: previous.hex }} />+<i style={{ background: current.hex }} />=<i style={{ background: wet }} /></>}</span>
      </div>
    </Panel>
  );
}
