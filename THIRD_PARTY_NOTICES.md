# Third-party notices

Watercolor Playground's own code is released under the MIT License (see [LICENSE](LICENSE)).
It builds on the work below, which keeps its own license.

## Code and data

### WebGL Fluid Simulation (MIT)

The Navier–Stokes passes in `src/engine/shaders.ts` (divergence, pressure, gradient subtract,
curl and vorticity confinement) follow the standard GPU fluid solver from
[WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation).

```
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### spectral.js (MIT)

The reflectance data in `src/engine/spectral.ts` and `src/engine/spectralData.ts` comes from
[spectral.js](https://github.com/rvanwijnen/spectral.js), Copyright (c) Ronald van Wijnen,
released under the MIT License (same terms as above).

### water-brush (MIT)

The first version of this app grew out of [water-brush](https://github.com/1000ship/water-brush),
Copyright 2021 Chun Seonghyeok, released under the MIT License (same terms as above).

### inkwash (MIT)

The way water is handled in `src/engine/shaders.ts` and `src/engine/Engine.ts` (a wetness field
that confines flow to wet paper, pigment that only moves where wet, and pigment that "fixes" into
the paper) is adapted from [inkwash](https://github.com/johnowhitaker/inkwash).

```
Copyright 2026 Jonathan Whitaker

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Fonts

The single-line fonts in `public/fonts/single-line/` were collected from
[drawingbots.net](https://drawingbots.net). They are **not** covered by the MIT License.

| Fonts | Source | License |
|---|---|---|
| EMS family (`EMS/`) | [Evil Mad Scientist SVG fonts](https://gitlab.com/oskay/svg-fonts) | SIL Open Font License 1.1 |
| Cutlings family, EMS Allure/Elfin Smooth (`Cutlings/`) | [Ellen Wasbo, Cutlings](http://cutlings.wasbo.net/products-fonts/) | SIL Open Font License 1.1 |
| Custom Script, Square Normal/Italic (`Shriinivas/`) | [inkscapestrokefont](https://github.com/Shriinivas/inkscapestrokefont), derived from Pinyon Script and Square Grotesk | SIL Open Font License 1.1 |
| Relief SingleLine (`Relief/`) | [Relief SingleLine](https://github.com/isdat-type/Relief-SingleLine), Copyright 2021 The Relief SingleLine Project Authors | SIL Open Font License 1.1 |
| Routed Gothic | [Routed Gothic](https://github.com/dse/routed-gothic) by Darren Embry | SIL Open Font License 1.1 |
| Hershey family (`Hershey/`, `Cutlings/HersheyScript1smooth.svg`) | [Evil Mad Scientist SVG fonts](https://gitlab.com/oskay/svg-fonts), [inkscapestrokefont](https://github.com/Shriinivas/inkscapestrokefont), Cutlings | Hershey Fonts license (below) |

The full text of the SIL Open Font License 1.1 is in
[`public/fonts/single-line/EMS/OFL.txt`](public/fonts/single-line/EMS/OFL.txt) and at
<https://openfontlicense.org>. `font-atlas.png` is a rendering of these fonts.

### Hershey Fonts

```
USE RESTRICTION:
    This distribution of the Hershey Fonts may be used by anyone for
    any purpose, commercial or otherwise, providing that:
        1. The following acknowledgements must be distributed with
            the font data:
            - The Hershey Fonts were originally created by Dr.
                A. V. Hershey while working at the U. S.
                National Bureau of Standards.
            - The format of the Font data in this distribution
                was originally created by
                    James Hurt
                    Cognition, Inc.
                    900 Technology Park Drive
                    Billerica, MA 01821
                    (mit-eddie!ci-dandelion!hurt)
        2. The font data in this distribution may be converted into
            any other format *EXCEPT* the format distributed by
            the U.S. NTIS where each point is described
            in eight bytes as "xxx yyy:", where xxx and yyy are
            the coordinate values as ASCII numbers.
```

## npm dependencies

These are bundled into the built site. Each keeps its own license, shipped in its package.

| Package | License |
|---|---|
| [preact](https://github.com/preactjs/preact), [@preact/signals](https://github.com/preactjs/signals) | MIT |
| [vpype-js](https://github.com/plottertools/vpype-js) | MIT |
| [q-floodfill](https://github.com/pavelkukov/q-floodfill) | MIT |
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | Apache-2.0 |
| [heic-to](https://github.com/hoppergee/heic-to) | LGPL-3.0 (loaded unmodified as a separate, lazily imported chunk) |
