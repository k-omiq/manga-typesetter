# Colour fidelity — stop converting raws to sRGB RGB

Date: 2026-08-12
Branch: `strip-clean`
Status: proposed

## Problem

Manga raws are frequently 8-bit greyscale PNGs, sometimes 16-bit, sometimes carrying an ICC
profile. The app converts all of them to 8-bit sRGB RGB. A page that was never touched comes back
from export as a different file than it went in.

## Evidence

Every path from a raw's bytes to an output file passes through a 2D canvas.

- `renderPageCanvas` — `src/lib/exporter.js:236`. Creates a canvas (`:239`), fills an RGB white
  base (`:245`), `drawImage`s the raw or cleaned page (`:254`).
- `renderPageBlob` — `src/lib/exporter.js:435`. `canvas.toBlob(…)` at `:437` re-encodes.
- `imageDataFromSrc` — `src/lib/psd.js:46`. `drawImage` + `getImageData` for the PSD Base group's
  Cleaned (`:301`) and Raw (`:309`) layers.
- `canvasToObjectUrl` — `src/lib/psd.js:57`. PSD **import** re-encodes every page to sRGB PNG, so
  a PSD round-trip loses the original encoding before export is even reached.
- `buildPagePsd` — `src/lib/psd.js:324`. `colorMode: 3` is written literally.

A canvas 2D context is RGBA and sRGB by construction. It has no option, flag, or context attribute
that changes this — `colorSpace` selects between sRGB and Display P3, never greyscale, and never
carries an ICC profile. The pixels have to leave canvas for a fix to exist at all.

**Not the cause:** the Python sidecar. `cv2.imdecode(arr, cv2.IMREAD_COLOR)` at `python/main.py:97`
does force 3-channel BGR, but that array only ever feeds detection in memory; the sidecar returns
JSON geometry and never writes an image back. `src-tauri/src/sidecar.rs:272` passes bytes through
untouched. No change is required there for this defect.

## Goals

1. A page with no typeset boxes exports byte-for-byte identical to its source.
2. A page with typeset boxes exports greyscale when its source was greyscale.
3. PSD export produces a greyscale document for greyscale sources, keeping editable type layers.
4. ICC profiles survive PNG export.

## Non-goals

- Colour management of the on-screen preview. The editor keeps rendering through the browser.
- CMYK, LAB, indexed, or duotone sources.
- Changing detection or OCR behaviour.

## Design

### 1. Source fidelity record

On import, the raw's leading bytes are sniffed and the result stored on the page as `page.src`:

```
{ file, mime, colorType, bitDepth, hasAlpha, iccChunk }
```

- **PNG** — IHDR at a fixed offset gives bit depth (byte 24) and colour type (byte 25:
  0 grey, 2 RGB, 3 indexed, 4 grey+alpha, 6 RGBA). The `iCCP`, `sRGB`, `gAMA`, and `cHRM` chunks are
  captured verbatim for later re-attachment.
- **JPEG** — the SOFn marker's component count gives 1 (greyscale) or 3 (YCbCr); `APP2/ICC_PROFILE`
  segments are captured.
- **Anything else** (WebP, TIFF, BMP) — recorded as opaque. Passthrough still applies; grey-aware
  re-encoding does not.

Sniffing is bytes-only — no decode — so it is cheap and cannot itself alter anything. Because slice 1
copies raws into the library byte-for-byte, passthrough reads from that copy and no image bytes are
held in memory.

### 2. Passthrough for untouched pages

In `renderPageBlob`, before any canvas exists:

> If the page has no boxes, the requested format equals the source format, and scale is 1 — copy the
> source file's bytes to the destination and return.

This is the common case for a raws-only chapter, and it is exact by construction rather than by
careful re-encoding.

### 3. Grey-aware PNG encoding for composited pages

When a page does have boxes, compositing on canvas is unavoidable — that is where the text is drawn.
The change is at the encode step, replacing `canvas.toBlob` for PNG:

1. Read the composite as `ImageData`.
2. Scan for chromacity: any pixel where `R !== G || G !== B` marks the page chromatic (early exit on
   the first hit). This catches coloured text, coloured shadows, and chromatic source pixels in one
   pass, rather than trying to infer them from style fields.
3. If the source was greyscale **and** the composite is achromatic, encode 1-channel (or 2-channel
   with alpha) 8-bit PNG via `fast-png`. Otherwise encode RGB/RGBA as today.
4. Splice the captured `iCCP` / `sRGB` / `gAMA` / `cHRM` chunks back in after IHDR. PNG chunks are
   length + type + data + CRC32, so this is a small self-contained helper — no dependency for it.

`fast-png` is the only new runtime dependency, and only because canvas cannot emit 1-channel PNG.

**Accepted limitation:** JPG and WebP composited output stays RGB. Canvas cannot emit greyscale JPEG,
and both are lossy delivery formats rather than archival ones. Passthrough still makes untouched
pages exact in those formats. PNG is the archival path.

### 4. Greyscale PSD export

`ag-psd@31.0.2` hardcodes RGB: its README states it "Does not support writing any color modes other
than RGB" and "Does not support 16 bits per channel", and `WriteOptions` exposes nothing relevant.
The writer itself is nonetheless close — four localized sites:

| Site | Current | Greyscale |
| --- | --- | --- |
| header colour mode | literal `ColorMode.RGB` | `psd.colorMode` |
| header channel count | `globalAlpha ? 4 : 3` | `alpha ? 2 : 1` |
| `getLayerChannels` ids | `[Color0, Color1, Color2]` | `[Color0]` |
| composite offsets | `[0,1,2,3]` / `[0,1,2]` | `[0,3]` / `[0]` |

Image data stays RGBA in memory; writing offset 0 alone emits the grey channel, which is correct
exactly while `R === G === B` — the same chromacity scan from §3 gates it. Applied with
`patch-package` against an exact pinned version, so an upgrade fails loudly instead of silently
reverting to RGB. Editable type layers, groups, and the embedded XMP project state are untouched.

`buildPagePsd` sets `colorMode: 1` when the page qualifies, `3` otherwise.

Rejected alternatives: moving PSD export to the sidecar's `psd-tools` gives native greyscale and
16-bit but only creates raster layers, losing the editable type layers that are the point of the PSD
handoff; vendoring a fork means owning a PSD library indefinitely.

### 5. PSD import

`canvasToObjectUrl` (`src/lib/psd.js:57`) routes through the §3 encoder instead of `canvas.toBlob`,
so importing a greyscale PSD no longer inflates its pages to RGB.

**Known limit, documented in the UI:** a PSD does not contain the original raw file, so PSD import
can never restore source bytes exactly — only the colour mode. The library copy made at chapter
creation is the archival original.

### 6. 16-bit sources

Canvas is 8-bit, so any composited page is 8-bit whatever we do. Passthrough (§2) preserves 16-bit
exactly. When a 16-bit page carries boxes, export proceeds at 8-bit and a toast names the loss, once
per export run rather than per page. PSD export is likewise 8-bit — `ag-psd` cannot do otherwise, and
the patch does not change that.

## Error handling

- Source file missing at passthrough time — fall back to compositing and warn; export never fails
  outright over a fidelity optimisation.
- Sniffing fails or the format is unrecognised — treat as opaque RGB. Unknown input degrades to
  today's behaviour, never to a crash.
- `fast-png` encode throws — fall back to `canvas.toBlob` and warn. Producing an RGB file beats
  producing none.
- The `patch-package` patch fails to apply — the postinstall step fails the build. Silent reversion
  to RGB PSDs is the one outcome worth breaking a build over.

## Testing

Unit (Vitest, introduced in the slice 1 spec):

- PNG IHDR and JPEG SOF sniffers against fixtures: 8-bit grey, 16-bit grey, RGB with `iCCP`,
  grey+alpha, indexed.
- Chunk splicer: `iCCP` survives a round-trip and CRCs validate.
- Chromacity scan: all-grey, single chromatic pixel, chromatic only in the alpha-zero region.

Manual acceptance:

- Export an untouched greyscale page → `cmp` against the source reports identical.
- Typeset the same page, export PNG → `identify -verbose` reports `Type: Grayscale`, ICC intact.
- Typeset with red text → falls back to RGB, no crash, no silently wrong grey.
- PSD export of a greyscale page → opens in Photoshop as Grayscale, type layers still editable, our
  own importer round-trips it.
- 16-bit greyscale page with boxes → warns once, exports 8-bit.

## Acceptance

1. Untouched pages export byte-identical to source in their native format.
2. Typeset greyscale pages export as greyscale PNG with ICC preserved.
3. Greyscale PSD export opens as a Grayscale document with editable type layers.
4. Any chromatic content falls back to RGB automatically, with no user action.
5. No change to sidecar or Rust behaviour.
