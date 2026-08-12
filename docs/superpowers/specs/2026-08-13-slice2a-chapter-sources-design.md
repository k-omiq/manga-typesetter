# Slice 2a — chapter sources: cleaned pages, translations, PSD import

Date: 2026-08-13
Branch: to be created from `main`
Status: proposed

## Context

Slice 1 gave the app a project library on disk. A chapter is created from a folder of raw pages,
which are copied byte-for-byte into `<chapter>/raws/`, and `chapter.json` records one `Page` per
raw. That shipped, and `main` carries it.

A typeset manga page is normally not the raw. It is a *cleaned* page — the raw with its Japanese
text painted out — and the raw is kept alongside as a reference for what the original said. Slice 1
has no way to bring cleaned pages into a chapter. The editor still carries an "Import Cleaned"
button from before the library existed, but it writes to memory only: `saveOpenChapter`'s page
projection has no `cleaned` field, so the import is silently lost on reopen. Rather than ship a
button that appears to work and doesn't, slice 1 disabled it inside a chapter and recorded the
decision. This slice is the replacement.

The governing decision, from the user: **imports do not belong in the editor.** Source material is
chosen on the home screen, where chapters are created and managed. The editor is for typesetting.

### What already exists

`cleaned` is wired end-to-end *in memory* and has been since before the library:

- `src/lib/Editor.svelte:34` — `const baseSrc = $derived(p.cleaned ?? p.raw)`
- `src/lib/exporter.js:250` — `const base = p.cleaned ?? p.raw`
- `src/lib/psd.js:299` — the PSD Base group gets a Cleaned layer when the page has one
- `src/lib/importer.js:231` — the legacy importer sets `app.pages[i].cleaned`

So no rendering, export or PSD code needs to learn anything new. What is missing is persistence and
a way to get the files in. This slice is plumbing and UI.

## Goals

1. Chapter creation accepts raws, optional cleaned pages, and an optional translations JSON.
2. Cleaned pages persist — a chapter reopens showing what it was typeset on.
3. Cleaned pages can be changed after creation, individually and in bulk.
4. A chapter can be created from a PSD, from the home screen.
5. The editor loses its import controls entirely.

## Non-goals

- **Generating** cleaned pages. No inpainting, no text removal, no pixel synthesis. Cleaned pages
  are supplied by the user. The clean engine lives on the `ml-engine` branch and is out of scope.
- The editor restructure to the wireframe. That is slice 2b.
- Colour-space fidelity on export. Separately specified in
  `docs/superpowers/specs/2026-08-12-colorspace-fidelity-design.md`.
- Translation *generation*. A translations JSON is imported, not produced.

## Data model

`Page` gains one field:

```
Page  { id, file, cleaned, w, h, lines, detect, boxes }
```

- `file` — the raw's filename inside `raws/`, unchanged from slice 1.
- `cleaned` — the cleaned page's filename inside `cleaned/`, or `null` when the page has none.

Back-compatibility: a `chapter.json` written by slice 1 has no `cleaned` key. Absent reads as
`null`. No migration step, no schema bump — a slice 1 chapter opens unchanged and gains a `cleaned`
key the first time it is saved.

## Disk layout

```
<library>/<project-slug>/<chapter-slug>/
  chapter.json
  raws/        byte-for-byte copies of the imported raw pages
  cleaned/     byte-for-byte copies of the imported cleaned pages
```

`cleaned/` is created on demand — a chapter with no cleaned pages has no such directory. Files are
copied with the same discipline as raws: `readFile` → `writeFile`, no decode, no re-encode, bit
depth and ICC profile intact, filenames deduped by the existing `uniqueFileName` so two files named
`01.png` from different folders cannot overwrite each other.

The one exception is PSD import, below, where there is no original file to copy.

## Pairing cleaned pages to raws

The hard question in this slice. A user picks 20 raws and 20 cleaned files; which cleaned page
belongs to which raw?

**Rule: pair by position after natural sort** — the same `naturalSort` the raws already use, so
`page2.png` sorts before `page10.png`. The Nth cleaned file pairs with the Nth page.

This is the only rule that works without imposing a naming convention, and it matches how cleaners
actually deliver work: a folder of pages in reading order. It is also the rule the legacy importer
already used (`importer.js:227-235`).

Because it is positional, it is **fragile to a mismatched count**, and the UI must never let that
pass silently:

- Fewer cleaned than raws → the first N pages get cleaned, the rest keep none. State it: *"12 of 20
  pages will use a cleaned image; pages 13–20 keep their raw."*
- More cleaned than raws → the extras are ignored, never appended as new pages. State it.
- Equal counts → state the count plainly rather than saying nothing.

The dialog shows this **before** the user commits, computed from the two picked file lists, not
after the copy. A user who picked the wrong folder finds out while they can still change it.

## Screens

### New chapter dialog

Gains two optional pickers below the existing raws picker, in this order:

1. **Raw pages** — required, unchanged.
2. **Cleaned pages** — optional. *Choose files…* / *N selected — change* / *Clear*.
3. **Translations** — optional, a single `.json`. Parsed with the existing tolerant importer
   normalisation so the same files that work today keep working.

Below the pickers, a **pairing summary** that updates live as files are picked: how many pages the
chapter will have, how many will have a cleaned image, how many lines the JSON supplies and to how
many pages. When a count mismatches, the summary says so in `--warn`, but does not block — a
deliberate partial clean is legitimate.

Creation copies raws, then cleaned, then writes `chapter.json` with the lines applied. The existing
all-or-nothing rollback extends to cover the cleaned copies: a failure at any point removes the
whole chapter directory and leaves the catalogue untouched.

### Chapter sources sheet

New screen, reached from a chapter row on the project screen — a *Sources* control beside the
existing Delete. It is where a chapter's inputs are managed after creation.

Header: chapter name, page count, how many pages have a cleaned image.

Bulk actions:
- **Add or replace cleaned pages…** — picks N files, pairs them positionally onto pages 1..N,
  replacing whatever those pages had. Pages beyond N keep theirs. The pairing summary and its
  mismatch warning appear here too, and this action is behind the two-step inline confirm when it
  would replace existing cleaned pages, naming how many.
- **Remove all cleaned pages** — two-step inline confirm naming the count. Deletes the files and
  clears every `cleaned` field.
- **Add translations…** — picks a JSON and applies it under the same never-shrink rule slice 1
  established: pages the JSON covers take its lines, pages beyond it are untouched, extras ignored.

Per-page rows, one per page in order: index, a thumbnail, the raw filename in monospace, and the
cleaned filename in monospace or *none*. Each row carries **Set cleaned…** (picks one file, replaces
that page's cleaned image) and **Remove** (unlinks and deletes that page's cleaned file), the latter
immediate with a toast rather than a confirm — it affects one page and is undone by setting it again.

The sheet must refuse to operate on a chapter that is currently open in the editor, the same way
Settings refuses a library-root change while a chapter is open. Editing a chapter's files underneath
the open document is the class of bug slice 1 spent nine review cycles removing.

### Import chapter from PSD

A control beside **New chapter** on both the library and project screens.

A PSD exported by this app carries pages, boxes, styles and embedded project state; a foreign PSD
carries at least a flattened image and any layers it has. Either way it describes a whole chapter,
so it creates one rather than adding to an existing chapter. The existing `psd.js` reconstruction
paths do the work; this slice gives them a home-screen entry point and writes the result to disk.

**The one place raws are not byte-original.** A PSD does not contain the original image files, only
rasters. Pages reconstructed from a PSD are encoded to PNG and written to `raws/` (and `cleaned/`
where the PSD has a Cleaned layer). The dialog says so plainly before importing — the user should
not believe a PSD round-trip preserves their original bytes, because it cannot.

### Editor

The import controls are **deleted**, not disabled:

- `src/lib/TopBar.svelte` — the JSON, Cleaned, Raw and PSD buttons and the disabled-state tooltip
  workaround.
- `src/lib/Editor.svelte:160-175` — the empty-state offers.

With them go the last two known ways to damage an open chapter from inside the editor: the JSON
import's page-replacement door, and the image importer's phantom pages. The `IMPORT_TIP` constant
and the `inChapter` guard around them go too.

`src/lib/importer.js` keeps the functions the home screen uses — file picking and JSON
normalisation. `importImageFiles` loses its only callers and is removed.

## Persistence

Two changes, both small, both in `src/lib/library.svelte.js`:

- `openChapter` mints a blob URL for `cleaned` when the page has one, exactly as it does for `raw`,
  and both are revoked on close. The `cleaned: null` hardcode at `:527` goes away.
- `saveOpenChapter`'s page projection gains `cleaned: pg.cleanedFile ?? null`. As with `file`, the
  durable name must be carried on the store page rather than derived from position — slice 1's
  hardest-won lesson was that positional pairing between the in-memory document and the on-disk
  record loses data.

The store page therefore carries both `file` and `cleanedFile` as durable names, alongside the
runtime-only `raw` and `cleaned` blob URLs. Blob URLs never reach disk.

## Error handling

- **A cleaned copy fails part-way during creation** — the whole chapter directory is removed, as
  today. No half-chapter reaches the scan.
- **A cleaned copy fails during a bulk replace on an existing chapter** — pages already replaced
  keep their new image, the rest keep theirs, and the error names the page it stopped at. Do not
  attempt to roll back a partial replace: the previous files are already deleted, and a half-restored
  state is worse than a stated partial one.
- **A page's cleaned file is missing on open** — the page falls back to its raw and is flagged in
  the sources sheet. Typesetting is never discarded for a missing image.
- **The JSON has more pages than the chapter** — extras ignored, stated in the summary. Never
  appended; slice 1 established that appended pages persist unrenderable.
- **PSD import fails** — no chapter is created, and the partial directory is removed.

## Testing

Unit, against the existing `fsx` mock:

- positional pairing: equal, fewer, more; the resulting `chapter.json` has `cleaned` on exactly the
  pages it should and `null` on the rest
- filename dedup across `raws/` and `cleaned/` independently — a raw and a cleaned page may share a
  name without colliding
- round-trip: a chapter with cleaned pages saves and reopens with every pairing intact
- back-compat: a slice 1 `chapter.json` with no `cleaned` key opens, and gains one on save
- per-page set and remove; bulk replace of a subset leaves later pages untouched
- rollback on a failed cleaned copy during creation
- the never-shrink rule still holds for a JSON applied from the sources sheet

Manual, in a real build:

- create a chapter with 6 raws and 4 cleaned; confirm the summary states the mismatch before
  creating; confirm pages 1–4 typeset on the cleaned image and 5–6 on the raw
- `cmp` a file in `cleaned/` against its source — byte-identical
- swap one page's cleaned image from the sources sheet; reopen; the swap survived
- import a chapter from a PSD; confirm the warning about re-encoded rasters appeared

## Acceptance

1. A chapter can be created with raws, cleaned pages and translations in one dialog, and the pairing
   is stated before the user commits.
2. Cleaned pages survive a save and reopen.
3. A cleaned page can be replaced or removed individually, and replaced in bulk.
4. Files in `cleaned/` are byte-identical to their sources, except for PSD-derived pages, which say
   so.
5. A chapter can be created from a PSD from the home screen.
6. The editor has no import controls, and no way to alter an open chapter's page list.
7. A slice 1 chapter opens unchanged.
