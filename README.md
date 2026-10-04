# Watercolor

A watercolour painting app in plain TypeScript and WebGL2, with almost no runtime dependencies.
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

Small runtime dependencies: vpype-js for SVG import, q-floodfill for the bucket fill, and heic-to for iPhone HEIC photos. heic-to is about 3 MB, so it is a separate chunk and only downloads when a browser can't decode HEIC itself. Vite and TypeScript are only used at build time; the UI is plain DOM,
and the simulation, colour science and rendering are TypeScript + GLSL.

## Text and shapes

The **Text** tool (T) writes a line of text with whatever brush and pigment are selected. The letters
come from single-stroke plotter fonts (Hershey, EMS, Cutlings, Relief, Shriinivas, Routed Gothic;
`public/fonts/single-line/`, from [drawingbots.net](https://drawingbots.net)) so every glyph is a pen
path rather than an outline. `src/text/TextWriter.ts` walks those paths in real time and feeds the engine
scripted samples, so the strokes get the same spacing, speed thinning, bleeding and drying as hand strokes,
and one word is one undo step. Options: font, size, speed, pressure, taper at stroke ends, letter spacing,
hand wobble, anchor (left / centre / right of the tap) and whether to draw with the brush, pen or water.

The **Shape** tool (G) draws lines, arrows, rectangles, ellipses, triangles, regular polygons and stars
the same way: drag a box on the paper (hold Shift, or turn on Lock, for squares, circles and 45° lines)
and the outline is drawn stroke by stroke when you let go (`src/shapes/`). The eighth shape, **SVG**,
traces a file of your own: pick it from the panel or drop an `.svg` anywhere on the page, then drag a
box to size it (Lock keeps the file's proportions; Rotate turns it). Paths, rects, circles, ellipses,
lines and polygons are read with [vpype-js](https://github.com/plottertools/vpype-js), merged and sorted
to shorten pen hops (`src/shapes/svgImport.ts`); text and images in the file are ignored. Undo removes
a whole word or shape; Redo (⇧⌘Z) brings it back. Undo and redo are symmetric tile swaps in `src/engine/history.ts`.

The **Fill** tool (K) is a paint bucket that behaves like a wash. Tap the paper and the area of similar
colour around the tap (found with [q-floodfill](https://github.com/pavelkukov/q-floodfill) on a flat
render of the sheet, without paper grain or wet tint; `src/fill/region.ts`) is covered by pigment and water
that spread out from the tap in real time rather than appearing at once. A distance field over the area
(how far the wash has travelled from the tap, and how far it is from the edge) goes to the GPU, and each
frame the engine lays down the next band of it into the live simulation (`fillStep` in `src/engine/Engine.ts`),
so the wash blooms, pools and leaves tide lines like a hand-painted one. Options: tolerance, speed, water,
amount, a soft edge, and whether to lay down paint or clear water. One fill is one undo step.

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
Drop an image anywhere on the page and choose **Make a brush** or **Use as reference**.

## Reference image and saving

**Ref** puts a photo or sketch (PNG, JPG, WebP, or an iPhone HEIC) under the paint to work from.
Paint glazes over it like a tracing. Opacity is adjustable, and **R** shows or hides it.
**Move** brings up a frame: drag it to move the image, drag a corner, scroll or pinch to scale it, and press Esc
when done (painting pauses while the frame is up). **Fit** puts it back. The reference lives only
on screen (`src/reference/`) and is never part of a saved image.

**Save** opens the export options:
- Background: **Transparent** (default; unpainted paper is see-through, with paint as colour + alpha that
  looks the same when laid over white), **Paper** (the textured paper, as on screen), or **White**.
- Format: PNG, JPEG or WebP. JPEG and WebP have a quality setting, and JPEG has no transparency.

**S** saves immediately with the last settings.

## Using it

| | |
|---|---|
| **, .** | previous / next brush |
| **B** Brush | wet paint: pigment and water |
| **W** Water | clear water: wets paper, pushes paint around |
| **P** Pen | ink line, feathers into wet areas |
| **L** Lift | blot with a tissue: lifts wet (unfixed) paint |
| **K** Fill | paint bucket: a wash spreads from the tap over the area of one colour |
| **D** Dry | flash-dry and fix paint into the paper, so you can glaze over it |
| **1–9, 0** | pigments; the last is white gouache |
| **[ ]** | size |
| **⌘Z** | undo |
| **R** | show / hide the reference image |
| **S** / **F** | save with the last export settings / fullscreen |

Stylus: pressure shapes the stroke. The barrel button switches to water and the eraser end
lifts. On iPad, once an Apple Pencil has been used, your finger becomes the water brush.
