# Watercolor

A watercolour painting app in plain TypeScript and WebGL2, with no runtime dependencies.
It combines ideas from two projects:

- **[inkwash](https://github.com/johnowhitaker/inkwash)**: the GPU fluid simulation (velocity /
  pressure / vorticity grid), a wetness field that confines flow to wet paper, pigment that only
  moves where wet, and "fixing" pigment into the paper. Reference copy in `../_reference/inkwash-main`.
- **water-brush** (the parent folder): the spectral Kubelka-Munk data from spectral.js
  (`src/filters/ColorAdder.js`) and the watercolour look (blotchy edges, tide lines, granulation).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

No runtime dependencies. Vite and TypeScript are only used at build time; the UI is plain DOM,
and the simulation, colour science and rendering are TypeScript + GLSL.

## Text

The **Text** tool (T) writes a line of text with whatever brush and pigment are selected. The letters
come from single-stroke plotter fonts (Hershey, EMS, Cutlings, Relief, Shriinivas, Routed Gothic;
`public/fonts/single-line/`, from [drawingbots.net](https://drawingbots.net)) so every glyph is a pen
path rather than an outline. `src/text/TextWriter.ts` walks those paths in real time and feeds the engine
scripted samples, so the strokes get the same spacing, speed thinning, bleeding and drying as hand strokes,
and one word is one undo step. Options: font, size, speed, pressure, taper at stroke ends, letter spacing,
hand wobble, anchor (left / centre / right of the tap) and whether to draw with the brush, pen or water.

## Colour mixing

Pigment is stored as a **spectrum** rather than RGB, so mixes behave like paint:
yellow + blue gives green, rose + ultramarine gives violet, and sienna + ultramarine gives a neutral grey.

1. A picked colour is upsampled to a 38-band reflectance curve (spectral.js method) and converted
   to spectral absorbance `A(λ) = −ln R(λ)`.
2. `A(λ)` is projected onto a 7-vector basis (uncentred SVD of absorbance over the sRGB gamut,
   fitted offline, see `src/engine/spectralData.ts`). Absorbance is linear in concentration, so
   these coefficients can be added, advected and diffused by the fluid sim and the mix stays
   physically subtractive (Beer–Lambert, the transparent-glaze model that suits watercolour).
3. The display shader rebuilds the spectrum at 16 wavelengths, applies `exp(−A)`, and integrates
   to sRGB with a fitted quadrature.

Accuracy against the full 38-band model: mean ΔE_OK ≈ 0.1–0.2 (×100 scale) for single colours,
dilutions, mixes and glazes, well below the visible threshold (~2). The coefficients are signed:
never clamp them.

Seven coefficients + white-gouache coverage fit exactly in two RGBA16F textures.

## Simulation

| layer | format | |
|---|---|---|
| velocity, pressure | RG16F / R16F, 256 px short side | water flow (from inkwash) |
| wet | R16F, document res | standing water; dries exponentially |
| ink | 2× RGBA16F (MRT), ping-pong | mobile pigment coefficients + white |
| fixed | 2× RGBA16F | pigment settled into the paper ("Dry") |
| paper | RGBA8 | procedural cold-press relief, generated once |

Pigment transport (`advectInkFS`) moves pigment with the water flow and exchanges it between
neighbouring texels through *fluxes gated by the wetness of both sides*. That conserves pigment
and keeps it from seeping onto dry paper, so wet-on-dry strokes get hard edges and wet-in-wet
strokes bloom as far as the water reaches. A capillary term pushes pigment down the wetness
gradient toward the drying edge, where it gets stranded: the dark tide line of a dried wash.

## Performance

- **Dirty-rect simulation.** Every document-resolution pass is scissored to the region that is
  actually wet. The region grows only as fast as the wet front can move.
- **Sleeps when dry.** Once the water has evaporated below the threshold where anything can
  move, the sim stops and so does `requestAnimationFrame`. An idle canvas uses no GPU time.
- **Partial redraws.** Only the changed region of the canvas is re-composited.
- **Undo through copy-on-write tiles.** Before a 128 px tile is first modified in a step it is
  copied into an atlas. Undo blits the tiles back. The fixed layer is snapshotted only when
  fixing. Memory is bounded and the oldest steps are evicted.
- Document capped at 2048 × 1536. Coalesced pointer events, with distance-based stamp
  spacing so deposits don't depend on the input event rate.

## Brushes

The Brush and Water tools paint with the selected brush from the library (the dab thumbnail at the
top of the tool bar, or `,` / `.` to cycle). Every brush is a **tip texture** plus behaviour, all in
`src/engine/brushes.ts`:

| | |
|---|---|
| Round, Detail, Rigger | pointed rounds from a #8 down to a liner that holds a lot of paint |
| Flat, Filbert, Dagger | shaped tips held at a fixed angle; an Apple Pencil's tilt turns them, so strokes go thick and thin with direction |
| Hake, Fan, Dry Brush | tips that follow the stroke; bristle gaps become streaks along the mark |
| Mop | floods the paper for washes |
| Sponge, Stipple, Spatter | dabbed and scattered marks: cells, dots, flicked droplets |
| Sumi | hairline to broad with pressure, fibrous edge |

Tips are generated procedurally (noise, Worley cells, hair segments) into a 192² texture in *tip
space*, which the stamp shader maps onto a rotated ellipse of the brush's aspect ratio. Each
preset sets spacing, scatter, dabs per stamp, size-vs-pressure, speed thinning, water capacity
and `grain`: how much the paper's tooth gates the deposit. A dry brush (or any brush that has
run out of water) only touches the peaks of the paper, so the stroke breaks up; pressing harder
reaches into the valleys.

**Import texture…** in the library turns any PNG/JPG into a brush tip (dark marks on white are
inverted automatically; alpha is respected). Imported brushes are kept in `localStorage`.
Drop an image anywhere on the page to import it.

## Using it

| | |
|---|---|
| **, .** | previous / next brush |
| **B** Brush | wet paint: pigment and water |
| **W** Water | clear water: wets paper, pushes paint around |
| **P** Pen | ink line, feathers into wet areas |
| **L** Lift | blot with a tissue: lifts wet (unfixed) paint |
| **D** Dry | flash-dry and fix paint into the paper, so you can glaze over it |
| **1–9, 0** | pigments; the last is white gouache |
| **[ ]** | size |
| **⌘Z** | undo |
| **S** / **F** | save PNG / fullscreen |

Stylus: pressure shapes the stroke. The barrel button switches to water and the eraser end
lifts. On iPad, once an Apple Pencil has been used, your finger becomes the water brush.
