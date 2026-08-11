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
2. A page with typeset boxes keeps its source's colour type and bit depth, and every pixel the text
   does not cover stays bit-exact.
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

### 3. Off-canvas compositing for pages that carry text

The text has to be drawn on a canvas — that is what canvas is for, and matching the editor's
rendering exactly is a hard requirement. The **page pixels** do not. Routing them through canvas is
what destroys colour type and bit depth, and it is avoidable.

```
raw bytes ──fast-png decode──> native buffer (e.g. 16-bit, 1 channel, ICC held aside)
text boxes ──canvas─────────-> RGBA8 transparent overlay, text only
                    │
            composite in typed arrays at the source's native depth
                    │
        fast-png encode(depth, channels) + splice ancillary chunks
```

Steps:

1. **Decode the page at native fidelity.** PNG sources decode with `fast-png`, which returns the
   original depth (8 or 16) and channel count (1–4). Browser canvas decoding truncates 16-bit to
   8-bit, which is precisely why the decode cannot happen there.
2. **Render text only.** A transparent canvas sized to the page, carrying the box layers and nothing
   else — no white base fill, no page image. Output is RGBA8.
3. **Scan the overlay for chromacity.** Any pixel where `R !== G || G !== B` at non-zero alpha marks
   the overlay chromatic (early exit on first hit). This catches coloured text and coloured shadows
   without trying to infer them from style fields.
4. **Composite in typed arrays** at the source's depth: `out = src·(1−α) + text·α`, with α from the
   overlay and `text` taken as luma when the destination is single-channel. Where α is 0 the source
   value is copied, not recomputed — so every pixel the text does not touch is bit-exact.
5. **Encode** with `fast-png` at the source's depth and channel count. Promote to RGB only when the
   source was chromatic or the overlay is.
6. **Splice** the captured `iCCP` / `sRGB` / `gAMA` / `cHRM` chunks back in after IHDR. `fast-png`
   writes no ICC, and PNG chunks are length + type + data + CRC32, so this is a small self-contained
   helper — no dependency for it.

Consequences worth stating explicitly:

- 16-bit greyscale survives typesetting, not just passthrough.
- The `#ffffff` `fillRect` at `src/lib/exporter.js:245` is removed from the PNG path. It is a second,
  independent cause of RGB output — an opaque white RGB base behind every page. JPG keeps it, having
  no alpha.
- Only pixels actually under a glyph differ from the source at all.

`fast-png` is the only new runtime dependency.

**Accepted limitation:** JPG and WebP composited output stays RGB, and greyscale JPEG sources decode
through canvas rather than natively. JPEG is 8-bit regardless, and a greyscale JPEG decodes to
exactly `R === G === B`, so nothing is lost that the chromacity scan does not already catch. Both are
lossy delivery formats; PNG is the archival path.

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

PNG export preserves 16-bit in both paths: untouched pages by passthrough (§2), typeset pages by the
off-canvas compositor (§3). The text overlay is 8-bit, which only bounds the blend precision inside
glyph coverage; untouched pixels keep their full 16-bit values.

PSD export remains 8-bit. `ag-psd`'s data model is 8-bit `ImageData` from end to end, so 16-bit there
is a rewrite of the library rather than the four-site patch in §4. Exporting a 16-bit page to PSD
warns once per export run, naming the loss and pointing at PNG.

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
- Compositor: with an all-zero-alpha overlay the output buffer equals the input buffer exactly, at
  both 8-bit and 16-bit; with full-alpha coverage the output equals the overlay luma; 16-bit values
  outside glyph coverage are unchanged, not rounded through 8-bit.

Manual acceptance:

- Export an untouched greyscale page → `cmp` against the source reports identical.
- Typeset the same page, export PNG → `identify -verbose` reports `Type: Grayscale`, ICC intact.
- Typeset a 16-bit greyscale page, export PNG → still `16-bit Grayscale`; pixels outside the text
  match the source exactly.
- Typeset with red text → falls back to RGB, no crash, no silently wrong grey.
- PSD export of a greyscale page → opens in Photoshop as Grayscale, type layers still editable, our
  own importer round-trips it.
- 16-bit greyscale page exported to PSD → warns once, exports 8-bit.

## Acceptance

1. Untouched pages export byte-identical to source in their native format.
2. Typeset greyscale pages export as greyscale PNG at the source's bit depth, ICC preserved.
3. On a typeset page, every pixel outside glyph coverage is bit-identical to the source.
4. Greyscale PSD export opens as a Grayscale document with editable type layers.
5. Any chromatic content falls back to RGB automatically, with no user action.
6. No change to sidecar or Rust behaviour.
