# TODO

Known gaps, in the order they are worth doing. An item stays here until it is
either fixed or decided against; a fixed one moves to **Done**, with the note on
how it was verified, because the verification is the part that is expensive to
rediscover.

## Photoshop compatibility

The export writes a live Photoshop type layer per text box wherever it can, and
a plain image layer wherever Photoshop's text engine cannot reproduce what the
app draws (see `isRasterOnly` in `src/lib/psd.js`). What follows is what is
still unresolved about the live half.

### Open

- **The live type layers are unverified against a real Photoshop.** Everything
  below the line in *Done* was checked by compositing a written PSD with
  `psd-tools` and diffing it against `renderPageCanvas`. That proves the file's
  stored pixels, which is what every reader shows on open. It cannot prove what
  Photoshop draws when it *re-renders* a type layer from its own engine data - a
  font substitution, or the user touching the layer with the type tool - because
  psd-tools composites stored pixels and does not lay out text. Someone with
  Photoshop should open an export, force a re-render, and diff it against the
  app.

- **The first line may sit about a pixel high.** The type layer's origin is now
  the text block's top (`blockYFor`), and the app draws the first line's em-box
  top half a line's leading below that: `(lineHeight - 1) * size / 2`, which is
  1.1px at the default 22px/1.1. Whether that term belongs in the origin depends
  on whether Photoshop treats the top of `boxBounds` as the first line's em-box
  top or as its baseline minus the ascent, and that is the same question as the
  item above. Left out rather than guessed at: it is a sub-2px error either way,
  and adding it blind could make it a sub-2px error in the other direction.

- **Vertical alignment survives only one way through a foreign re-import.** A
  PSD whose embedded project JSON Photoshop has rewritten comes back through
  `reconstructForeign`, which now reads a box as its text block plus padding and
  sets `valign: 'top'`. The words land where the file showed them, but the
  original box frame and its alignment are gone - the box hugs its text. That is
  the best available answer without the JSON, not a good one.

- **A radial or per-line gradient costs the box its editability.** Both are
  rasterised because Photoshop's `gradientOverlay` cannot state either one (see
  `gradientOverlayable`). A radial ramp *could* be approximated with Photoshop's
  own radial overlay - its offset and scale against its own reference, rather
  than our centre and farthest-corner radius - if someone works out the mapping
  and can check it against Photoshop. Per-line has no answer at all: one overlay
  covers one layer.

- **Vector shape layers, if editability matters more than text.** Converting
  glyph outlines to Photoshop vector paths would make the curved, circular,
  path-laid and masked boxes native editable *shapes* instead of flat pixels.
  Roughening, motion blur and the pattern fill still could not go. Large job, and
  the text stops being text - only worth it if scanlators actually ask.

### Done

- **Vertical alignment was ignored by the type layers.** *(fixed)* The layer's
  transform origin was `box.y + BOX_PAD` - the top of the frame - while the app
  anchors the block by `valign`, which defaults to `middle`. The cached pixels
  were right, so the file looked right until Photoshop re-rendered the layer and
  the words jumped up by half the box's slack. The rule now lives in one place,
  `blockYFor` in `src/lib/measure.js`, and the raster exporter and the PSD writer
  both read it. `boxBounds` is the block's own rect to match.

- **The page art was stacked on top of every text layer.** *(fixed)* `children[0]`
  in ag-psd is the *bottom* layer, and this file was building `[Text, Base]` while
  describing it as top-first. Every export opened as bare, untypeset artwork.
  Nothing noticed because re-import reads the embedded JSON and never composites
  the layers it wrote. `Raw`/`Cleaned` were the wrong way up inside `Base` for the
  same reason, and `reconstructForeign` was taking a foreign file's *topmost*
  raster as the page art. `psdSelfTest` now pins the order.

- **Eight effects were written as live type layers Photoshop renders wrong.**
  *(fixed)* `isRasterOnly` covered the arc, roughening and the mirrors, but not
  the bezier path, the closed circle, the visibility mask, the whole-text blur,
  the motion smear, the pattern fill, or a per-line or radial gradient. The first
  three are laid out glyph by glyph, so Photoshop re-rendered them as straight
  paragraphs; the rest were silently dropped, because Photoshop discards a type
  layer's cached pixels and paints from its own engine data.

**How the three above were verified.** Run the vite dev server, then from the
page: import `/src/lib/psd.js` and `/src/lib/exporter.js`, build a synthetic page
with one box per effect, and POST both `renderPageCanvas()`'s PNG and
`buildPagePsd()`'s bytes to a scratch HTTP sink. Composite the PSD with
`python3` + `psd-tools` (`PSDImage.composite(ignore_preview=True)`) and diff it
against the canvas PNG with numpy. Before: max channel difference 244 over 42,674
pixels. After: max channel difference 2 - antialiasing - and no pixel off by more
than 2. Load the box's font (`document.fonts.load`) before rendering either side,
or the canvas draws a fallback face and the diff is all font, no geometry.
