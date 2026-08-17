# Annotated UI feedback (source: `fixes.jpg`)

Transcription and expansion of the hand-written annotations on the editor screenshot,
plus the follow-up items raised in the same review.
Documentation only — no code changes were made for this pass.

Sections 1–5 keep the annotation colour as their marker so items can be matched back to
the screenshot. Sections 6–11 are the follow-up items, which have no marking on the image.

---

## 1. Blue — export / chrome buttons (top centre)

The circular icon button and the **Export** button currently sit in the middle of the top
chrome band.

**Wanted:** move both of them to the top-right of the chrome band, next to the existing
text (`T`) and settings (gear) buttons.

---

## 2. Pink — left toolbar button, and the bulk editor

Two separate asks, written as one block.

### 2a. Toolbar button relocation

The third button in the floating left toolbar (the layers/stack icon, which opens the
bulk editor) should be **moved into the top-right menu**. Its slot in the left toolbar
should be **replaced with a hand icon** — a pan tool for moving around the canvas.

So the left toolbar becomes: select arrow, text tool, hand/pan tool.

### 2b. Bulk editor upgrade

The bulk editor needs to be reworked. Problems and requirements:

- **Not every property should be edited at once.** Today a bulk edit applies everything.
  Sometimes the user only wants to change colour; sometimes only the font.
- **Add tick boxes next to every item/property** in the bulk editor so the user chooses
  which properties participate in that bulk edit. Unticked properties are left untouched.
- **No way to bulk-edit by tag today.** Add a tag-scoped edit mode:
  - Put it at the **top** of the bulk editor.
  - It lists **all tags currently used in the project**.
  - The user selects one tag and hits **Enter**; the edit then applies to every text box
    carrying that tag, without having to click each text individually.
  - Provide a **scope selector for tag-wise edits: whole chapter, or current page only.**
    (This scope option applies only to the tag-driven edits.)

### 2c. Full property coverage in the bulk editor

The bulk editor currently exposes only a subset of the Inspector's controls
([BulkStylePanel.svelte](src/lib/BulkStylePanel.svelte)):
font family, size, style, align, rotation, text colour, outline.

**Wanted:** every text edit option available in the Inspector should also be available in
the bulk editor — vertical writing, line/letter spacing, opacity, the full shadow group
(offset X/Y, blur, opacity, colour), curve/arc, grain (amount, grain, seed) and mirror,
alongside the ones already there.

**But:** this must not turn the panel into a wall of controls. Format it properly and
minimally:

- Group related properties (typography · alignment · colour · outline · shadow · effects ·
  transform) and keep the less-used groups **collapsed by default**.
- Each property row carries its participation tick box (see 2b), so an untouched group
  contributes nothing to the edit and can stay folded away.
- Only the tick box and the property's own control belong on a row — no extra chrome.

Position and size (X/Y/W/H) are Inspector-only and are deliberately **not** part of the
bulk editor.

---

## 3. Red — inline editing in the text queue

The expanded editor row that appears under a selected queue item (the one with the
Japanese source line, the English textarea and the tag swatches) **should be removed**.

**Wanted behaviour:** clicking a queued item should turn that item's own row into the
editable form, i.e. the row **becomes** the editor in place, matching the look of the
compact rows below it. Having the collapsed row and a separate expanded editor showing the
same content twice is redundant.

---

## 4. Green — tag system for queued items

The four coloured swatches shown next to the queue item are the intended **tag picker**.

**Current state:** tags such as `NARRATION`, `SFX`, etc. already exist, but they can only
be set by editing the JSON.

**Wanted:** a full user-facing tag system where the user can choose, set and create tags.

### Tag picker layout (4 slots, left to right)

1. **Most recently used tag** — one-click apply.
2. **Second most recently used tag** — one-click apply.
3. **Create tag** — a pen icon that opens tag creation.
4. **Dropdown** — select from the full history of previously used tags.

Note: the annotation numbers slot 3 and slot 4 both as "third"; the intent from the
described order is create-tag in the third position and the history dropdown in the
fourth.

### Editing an existing tag from the history dropdown

Each entry in the 4th-slot history dropdown carries a **small settings icon**. It opens
that tag's settings (its default font, outline, etc.) so an already-created tag can be
changed without recreating it.

**Important semantics:** editing a tag this way only affects **future** applications of
that tag. Text boxes that already carry the tag keep the style they were given at the time
— the change is not retroactive and must not rewrite existing items.

### Rules

- Tags are optional — the user may choose not to use tags at all.
- **When creating a tag, there is a tools icon** that lets the user set that tag's
  **default font and outline**.
- If a tag's font/outline defaults are **unset**, text with that tag falls back to the
  existing behaviour (the current style options), exactly as it works today.

---

## 5. Yellow — bottom canvas bar

- **Fix the undo/redo button icons.** The current arrow icons are wrong/unclear.
- **Fix zoom.** The zoom measurements and percentage are wrong:
  - The reported percentage does not match what is actually rendered.
  - At **50%** the page is **clipped off the edges of the viewport** instead of being
    displayed at half size within the canvas area. The user wants to know why 50% clips
    through the screen.

---

---

## 6. Field-level text undo

⌘Z no longer reverts typing inside an inline text box edit, or inside the Inspector's
textarea. Cause: freeing ⌘Z for the editor's own history meant removing the Edit menu's
predefined Undo/Redo roles, which is what drove the native field-level undo.

**Wanted:** ⌘Z is context-sensitive.

- While a text field has focus (inline box edit, or the Inspector textarea), ⌘Z undoes the
  **typing in that field**.
- Outside a field — focus on the canvas — ⌘Z drives the **editor/canvas history** as it
  does now.

---

## 7. Dark mode

- The bulk editor's text is unreadable in dark mode: the dropdown menus render on a
  hard-coded white surface, so dark-mode text sits on white. All bulk-editor surfaces must
  use the theme tokens.
- **Theme should follow the system theme.** Today [theme.svelte.js](src/lib/theme.svelte.js)
  deliberately has no `prefers-color-scheme` fallback and defaults to light with an
  explicit persisted preference. That decision is reversed: the app should track the
  system appearance.

---

## 8. Minimised panel icons

The Text Queue and Text Box Options floating panels minimise today, but:

- The minimised state should be a proper **icon**, and those minimised icons should be
  **draggable**.
- The transition between window and icon (both directions) is instant and jarring.
  **Animate it, and slow it down** — the intended feel is everything in the panel being
  dragged inward, gathering into one place, and collapsing into the icon; restoring plays
  it in reverse.

---

## 9. Remove the textarea resize handle

The English text edit box in the Text Queue has a native resize grip in its bottom-right
corner. It is unnecessary — remove it.

---

## 10. Smaller issues carried over

| Item | Detail |
|------|--------|
| `resetPanels` is dead | [panels.svelte.js:176](src/lib/editor/panels.svelte.js:176) is exported and covered by tests but wired to nothing. The spec named it a **Settings action** — it should be reachable from Settings. |
| Store hook seams are single-slot | The four store hook seams hold one subscriber each, so a second panel wanting to coalesce edits would **silently displace the Inspector** rather than coexist or fail loudly. |
| `gotoPage` doesn't end an inline edit | Pre-existing. Turning the page mid-edit **drops that edit's history record**. |
| Undo-step loss around gestures | A page switch mid-gesture forfeits one undo step. A placement that ends a free-typed edit records the two entries **in reverse order**. |
| Persistence debounces disagree | panels 200 ms, history 800 ms, chapter 800 ms, sidebar unbuffered. They should be reconciled into a deliberate, documented set. |
| Unused theme tokens | `--sb` and `--art2` are declared in both themes in [styles.css](src/styles.css) and consumed nowhere — either use them or drop them. |

---

## 11. PSD export file size

PSD exports are unnaturally large — **60–70 MB each**. A single full-page raster accounts
for roughly a quarter of that, and the file currently carries **four** of them.

### What's in the file today

[buildPagePsd](src/lib/psd.js:270) writes, at `scale = 2` (so every raster is 4× the page's
pixel count):

1. **`Flattened preview`** — hidden layer, full-page composite ([psd.js:287](src/lib/psd.js:287))
2. **`Text`** group — one editable type layer per box, each with baked pixels
3. **`Base`** group — `Cleaned` and `Raw`, each a full-page raster
4. **`psd.imageData`** — the merged/composite image, the same composite again
   ([psd.js:336](src/lib/psd.js:336))

Items 1, 3 (×2) and 4 are four full-page rasters of identical dimensions, stored as raw
channel data. That is the 60–70 MB.

### Wanted

- **Keep only:** `Raw`, `Cleaned`, and the text box layers.
- **Remove the `Flattened preview` layer.**
- **Remove the merged image data** (`psd.imageData`).
- **`Raw` must not exceed the size of the original raw file.** Right now it is re-encoded
  as an uncompressed full-page raster at 2× scale, which is why it alone is ~25% of a
  70 MB export while the source file is a fraction of that.
- Get the resulting file size to something sensible.

### Levers to consider

- The `scale = 2` supersample multiplies every raster by 4×. Text needs the extra
  resolution to stay sharp; `Raw` and `Cleaned` are being **upscaled from their native
  size for no gain** — store them at native resolution, or stop supersampling the base
  art.
- Channel data is written uncompressed; check whether the writer can emit RLE/ZIP-compressed
  channels instead.
- Text layers bake full-page-positioned pixels — they should be trimmed to the box bounds.

### Knock-on effects to handle

Dropping the composite is not free; these depend on it today:

- `psdSelfTest` step 2 compares `psd.imageData` against the app render and asserts
  byte-identical visual parity ([psd.js:635](src/lib/psd.js:635)). With no merged image it
  will report `maxDiff = 255`. The check needs rewriting or removing.
- `reconstructForeign` falls back to the last flat pixel layer or the composite when no
  `Base` group is found ([psd.js:407](src/lib/psd.js:407)). Re-importing our own exports is
  unaffected (they still have `Base`), but the fallback path loses one option.
- The composite is what Photoshop/Preview shows before layers render, and it is what made
  the file's appearance match the app even where Photoshop can't reproduce roughen/curve.
  Without it those effects will render as Photoshop interprets them. Confirm that trade is
  acceptable — the thumbnail (`generateThumbnail`) is small and can stay.

---

## Summary checklist

| # | Area | Item |
|---|------|------|
| 1 | Chrome | Move the icon button + Export to the top-right |
| 2 | Left toolbar | Move the bulk-editor (layers) button into the top-right menu |
| 3 | Left toolbar | Add a hand/pan tool in its place |
| 4 | Bulk editor | Per-property tick boxes to select what a bulk edit changes |
| 5 | Bulk editor | Expose every Inspector text option, grouped and collapsed by default |
| 6 | Bulk editor | Tag-wise editing at the top: list project tags, select + Enter |
| 7 | Bulk editor | Chapter-wide vs current-page scope, for tag-wise edits only |
| 8 | Text queue | Remove the separate expanded editor; edit in place in the clicked row |
| 9 | Text queue | Remove the resize grip on the English text edit box |
| 10 | Tags | 4-slot tag picker: recent, 2nd recent, create (pen), history dropdown |
| 11 | Tags | User-creatable tags; tags optional |
| 12 | Tags | Per-tag default font + outline via a tools icon; unset falls back to current behaviour |
| 13 | Tags | Settings icon per history entry; edits apply to future uses only, not retroactively |
| 14 | Canvas bar | Fix undo/redo icons |
| 15 | Canvas bar | Fix zoom percentage accuracy and the clipping at 50% |
| 16 | Undo | ⌘Z acts on the focused text field while editing, on canvas history otherwise |
| 17 | Theme | Fix white dropdown surfaces in the bulk editor under dark mode |
| 18 | Theme | Follow the system theme |
| 19 | Panels | Iconise minimised panels, make the icons draggable |
| 20 | Panels | Slow, gathering animation between window and icon, both directions |
| 21 | Cleanup | Wire `resetPanels` to a Settings action |
| 22 | Cleanup | Make the store hook seams multi-subscriber instead of single-slot |
| 23 | Cleanup | `gotoPage` should end an inline edit before turning the page |
| 24 | Cleanup | Fix the forfeited undo step on mid-gesture page switch and the reversed placement pair |
| 25 | Cleanup | Reconcile the four persistence debounce intervals |
| 26 | Cleanup | Use or remove `--sb` and `--art2` |
| 27 | PSD export | Drop the `Flattened preview` layer |
| 28 | PSD export | Drop the merged image data (`psd.imageData`) |
| 29 | PSD export | Keep only Raw + text layers + Cleaned |
| 30 | PSD export | `Raw` must not exceed the original raw file's size (stop upscaling / compress it) |
| 31 | PSD export | Rework `psdSelfTest`'s composite parity check, which depends on the merged image |
