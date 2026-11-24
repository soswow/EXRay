# EXRay

Explore the full dynamic range of HDR OpenEXR images — entirely in the browser. Nothing is uploaded; files are decoded locally in a Web Worker and displayed with WebGL2 from full 32-bit float data.

**Open it: https://soswow.github.io/EXRay/** (or [try the demo image](https://soswow.github.io/EXRay/?demo))

## Features

- **Zoomable log₂ histogram.** On its default log₂ axis (labelled with linear values) it spans the whole float32 range, denormals included, at 1/64-stop resolution. It pans and zooms like a timeline, and an overview strip shows the full data extent. The count axis can be linear, sqrt or log, with Y (luminance) and R/G/B curves.
- **X axis: Log₂, Lin or Sqrt.** Log₂ gives every stop the same width, which suits HDR data. Lin gives every value (for RAW, every DN) the same width and shows values at or below zero, e.g. RAW photosites below black. Sqrt sits between the two; for RAW it makes photon shot noise look about equally wide at every level. The X axis only changes the histogram; the image keeps its own Log₂ / Linear / False color display mode.
- **Display window.** Drag the edges, drag the bar to move it, or shift-drag to select a new one. It stays within the image's smallest and largest positive values. The window maps to the screen as:
  - **Log₂**: log2 of the value spread linearly across the window, so every stop gets the same width (a plain log2, not a camera log curve)
  - **Linear**: exposure plus black point, then a selectable display encoding: sRGB, BT.1886 (γ 2.4), γ 2.2 or none
  - **False color**: Turbo, Viridis, Inferno or Gray, optionally in one band per stop
- **Two-way linking.** Hovering the histogram highlights those pixels in the image. Hovering the image marks the pixel's R/G/B/Y on the histogram.
- **Clipping and special values.** Under-window, over-window, NaN/Inf and negative values are marked in distinct colors. *Isolate* dims everything outside the window.
- **Pixel probe.** Shows the raw float values under the cursor.
- **Stats.** Dynamic range (full, 0.1–99.9 %, 1–99 %), per-channel min/max, and counts of zero, negative, NaN and Inf values.
- **Multi-part files and layers/AOVs.** For example `diffuse.RGB`, `Z`, or `disparityL.x`.
- **Color-accurate luminance.** Relative luminance Y uses the Y row of RGB → XYZ from the file's `chromaticities` (Rec.709 when absent). The info panel says which.
- **Header viewer.** Lists every header attribute.
- **Camera RAW files** (CR2/CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, X3F, …), unpacked by [LibRaw](https://www.libraw.org/) compiled to WebAssembly and loaded only when a RAW file is opened.
  - Values are normalized as (DN − black) ÷ (white − black), so 1.0 is the white level and the histogram shows the headroom below it.
  - **Every level shows its source.** Black levels per CFA channel from the camera's makernote (Canon `ChannelBlackLevel`), from LibRaw, and measured as the mean of the masked border; white levels from LibRaw's `maximum`, the makernote (Canon specular and normal white levels), and the data maximum with its count. Pick which black and white are applied.
  - **Sensor area.** The camera's default crop (Canon makernote), its active area, LibRaw's visible area, or the full readout including the masked border. The camera's crop is the default, so the resolution matches the camera's.
  - Zoom in (or press `M`) to see the **mosaic**: every photosite in its own color with its true value, no interpolation. Zoomed out, a bilinear demosaic is shown.
  - The pixel probe shows the 3×3 photosites around the cursor as raw integers, the formula applied to the one under it, and the demosaiced values labelled as photosite, interpolated or mixed. Interpolated values are never shown as DN.
  - R/G/B histograms are **exact**: one value per raw integer per photosite, so clipped photosites sit at exactly the white level and the tooltip counts photosites at and above the cursor. Y comes from the demosaiced image in 1/64-stop bins.
  - Three ways to turn sensor values into RGB: camera RGB, white-balanced camera RGB, or linear Rec.709 primaries through LibRaw's camera matrix (`rgb_cam`).
  - The histogram marks the white level in use, the other white-level candidates, 1 DN above black (where values become coarse integers) and the read-noise floor.
  - Read noise is measured from the sensor's masked (optical black) border, using the camera's own optical-black areas when the makernote gives them, for the engineering dynamic range: (white − black) ÷ read noise, in stops.
  - Any CFA pattern works (Bayer, X-Trans, …), including per-position black levels. Images are rotated per the file's orientation. Linear DNG, sRAW and Foveon files are shown as three-channel data, and unusual layouts such as Fuji SuperCCD fall back to LibRaw's own demosaic.

## Usage

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (host anywhere)
```

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/pages.yml`.

Open a file with the button or drag and drop. `?url=<exr url>` loads a file on startup (the server must allow CORS), and `?demo` loads a synthetic test image with known values.

For local testing, symlink a folder of EXRs as `samples/` in the project root (it's git-ignored). For example, symlink a checkout of [openexr-images](https://github.com/AcademySoftwareFoundation/openexr-images), then open `/?url=samples/ScanLines/Desk.exr`.

### Shortcuts

| Key | Action |
| --- | --- |
| `1` `2` `3` | Log₂ / Linear / False color |
| `C` / `I` / `B` | Clipping / Isolate / Stop bands |
| `A` | Auto window (0.5–99.9 % luminance; RAW: exactly 0.001–99.999 %) |
| `[` `]` | Shift window by ½ stop |
| `F` / `0` | Fit image / 1:1 pixels |
| `H` | Fit histogram (press again to show everything) |
| `O` | Open file |
| `M` | RAW: mosaic when zoomed in / always / never |

In the image, the wheel zooms, dragging pans, and double-clicking fits. In the histogram, the wheel zooms, dragging pans, and double-clicking fits.

## How it works

- **Decoding** runs in a worker.
  - NONE, RLE, ZIPS and ZIP files use EXRay's own decoder. It handles any channel names, mixed HALF/FLOAT/UINT channels, and tiled files including mip/ripmaps (top level only). ZIP chunks are inflated by the browser's native `DecompressionStream`.
  - PIZ, PXR24, B44/B44A and DWAA/DWAB use three.js `EXRLoader`. EXRLoader only understands R/G/B/A/Y channel names, so to view other layers EXRay rewrites the channel list in a copy of the header and shifts the chunk offset tables.
- **Histogram**: built from float bit patterns. The exponent gives the stop, and a mantissa lookup table gives the fraction, so no `log2` is needed per pixel. Prefix sums make any zoom level O(1) per screen column.
- **Display**: a single fragment shader reads the RGBA32F texture with `texelFetch`, so values are exact and unfiltered.

## Known limitations / roadmap

- Not decoded yet:
  - deep images (partially)
  - HTJ2K compression
  - subsampled chroma outside B44
  - with PIZ, PXR24, B44 or DWA compression: RIPMAP tiles, and channels of mixed pixel types

  The next step is likely a WASM build of the OpenEXR core library.
- RAW: the demosaic is plain bilinear, there is no highlight reconstruction, and the decoded image takes 16 bytes per pixel (about 400 MB for 24 MP).
- RAW: makernote levels and sensor areas are read for Canon only. Other makers and DNG crop tags show LibRaw's values. The Canon sensor areas are read from LibRaw's struct at fixed offsets, because `@colorhythm/libraw-wasm` 1.1.1 decodes those fields wrongly; they are only used when the sensor size stored with them matches the raw buffer.
- No gamut conversion: non-Rec.709 primaries are shown as raw RGB. OCIO-style display transforms are planned.
- Images larger than the GPU's max texture size (often 16384 px) aren't tiled yet.
- When zoomed out, display uses nearest sampling (no min/max-preserving mipmaps yet).

## License

[GPL-3.0](LICENSE). The bundled three.js `EXRLoader` is MIT-licensed and includes code derived from OpenEXR (BSD-3-Clause). RAW support uses [LibRaw](https://www.libraw.org/) (LGPL-2.1 / CDDL-1.0) via the MIT-licensed [`@colorhythm/libraw-wasm`](https://github.com/colorhythm/libraw-wasm) bindings.
