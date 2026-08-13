# Handoff — manga-typesetter UI remake

Date: 2026-08-12
Worktree: `/Users/caved/dev/manga-typesetter/.claude/worktrees/strip-clean`, branch `strip-clean`
State at handoff: working tree clean, `npm test` 89 passing, `npm run build` and `cargo check` clean.

Branch topology, settled 2026-08-13: `ml-engine` preserves the pre-strip state — the full
`python/flux_sidecar` package, FLUX inpainting, BYOK translation and Clean mode — for reuse in
another application. `strip-clean` is the typesetter-only line and is what `main` should carry.
The clean features were removed in `4960252`, which exists only on `strip-clean`.

Work all of this **in the worktree above**. Do not `cd` to the parent repo.

---

## Where things stand

The UI remake was split into slices. Slice 1 is built and reviewed; slices 2a, 2b and the colour-fidelity work are specified or scoped but not started.

**Slice 1 — design system, app shell, project library — BUILT.**
Spec: `docs/superpowers/specs/2026-08-12-ui-remake-slice1-design.md` (carries an "Amendments made during implementation" section that governs where it disagrees with the body).
Plan: `docs/superpowers/plans/2026-08-12-ui-remake-slice1.md`.
Ledger with every finding, fix and deferral: `.superpowers/sdd/2026-08-12-ui-remake-slice1/progress.md`.

What it delivers: the app boots to a project library instead of the editor; projects and chapters persist to `~/Documents/MangaTypesetter` with raws copied byte-for-byte; a paper-toned greyscale design system in light and dark; the editor is re-tokenized but structurally unchanged.

Nine tasks, each individually reviewed, plus a whole-branch review that returned "fix before merge" and a fix wave that closed all of it. Real bugs caught and fixed along the way, worth knowing about because they shape the code: the app used to adopt pre-existing directories and could then recursively delete a user's own files; PSD import into an open chapter orphaned every raw; dark mode made every on-page selection handle invisible; autosave could write one chapter's state over another.

---

## 1. Slice 1 — done, pending the branch move

The re-review ran and produced `b3f55a8` (single-flighting the quit flush, gating the menu work to
macOS). An independent audit then closed the outstanding menu question — **the Edit menu is
intact**: the code rebuilds the menu from Tauri's own `Menu::default()` builder and swaps only the
Quit item, and Cmd+C / Cmd+V / Cmd+A were exercised inside an inline text box on the canvas.

That audit found three more Important issues, all since fixed (`3c3cf1e`, `d560667`, `59cb747`,
report at `docs/superpowers/data-safety-fix-report.md`):
- `scanLibrary` had no in-flight guard, so a stale scan could wipe a newer one's results and print
  an error naming the new root against the old path's failure.
- A JSON import shorter than the open chapter deleted the trailing pages and every box on them,
  one click away, with no confirm. It now never shrinks the document.
- `chapter.json` was written non-atomically every 800 ms; a crash mid-write cost a whole chapter.
  Writes now go through a temp file and a rename.

Not fixed, deliberately: the library card's status chip and Continue button, which the spec asks
for and were never built. They belong to slice 2a, where the card is reworked anyway.

Remaining step, which must run in the parent checkout because `main` is checked out there:
`git reset --hard strip-clean` from `/Users/caved/dev/manga-typesetter`, with a clean working tree.

---

## 2. Slice 2a — chapter sources — BUILT, NOT YET VERIFIED IN THE APP

**Specified and implemented.** `docs/superpowers/specs/2026-08-13-slice2a-chapter-sources-design.md`.
`npm test` is 120 passing and `npm run build` and the release `cargo` build are clean.

**The disk half of the acceptance pass has been run — against a real filesystem, not the mock.**
`src/lib/library.realfs.test.js` swaps the `fsx` seam for `node:fs` and drives the real catalogue
over real PNGs in a temp directory, including a 16-bit greyscale one. It proves, on actual files:
six raws and four cleaned pair as specified; every copy is byte-identical to its source and page 1
comes out of `raws/` still 16-bit greyscale; a chapter reopens with pages 1–4 on their cleaned
image and 5–6 on their raw; a per-page swap replaces the file, deletes the one it replaced and
survives a reopen; a same-named file lands beside rather than over the one already there; a bulk
subset leaves the later pages alone; a missing cleaned file is flagged and its name is not dropped
by the next save; a shorter translations file never shortens the chapter; and a slice 1
`chapter.json` opens unchanged and gains its `cleaned` key on save.

**The visual half has NOT been run, and cannot be claimed.** App-control access was refused, so no
agent has seen this app's window. Still needing a human at the keyboard:

- the pairing summary's wording, and that it appears **before** the user commits
- import a chapter from a PSD end to end; confirm the warning about re-encoded rasters appeared
  (the PSD path needs a canvas and cannot be exercised outside the app at all)
- both themes on the sources sheet and the extended new-chapter dialog
- that the sources sheet's per-page rows render their thumbnails through the asset protocol

Two adversarial review passes ran, the second independent of the first; every finding either fixed
or answered. The second pass found four things worth remembering because they are the shapes this
codebase keeps producing: a stale async read painting one chapter's rows under another chapter's id
(page ids are per-chapter integers, so a click then landed on the wrong chapter — fixed with the
same ticket `scanLibrary` uses); a picker that dropped unreadable files silently, which positional
pairing cannot survive; a free-name check that consulted only the disk, so a page whose cleaned
file had gone missing could have its name handed to another page's new copy; and `canvas.toBlob`
returning null, which hung an import behind a busy state with no way out.

What it added, all reviewed:

- `Page` gains `cleaned`; a `cleaned/` directory sits beside `raws/`, created only when a page
  actually has one, copied byte-for-byte with the same discipline
- the new-chapter dialog takes raws + optional cleaned pages + an optional translations JSON, and
  states the positional pairing before the user commits
- a chapter sources sheet (`src/lib/home/ChapterSourcesSheet.svelte`), reached from a chapter row,
  for per-page and bulk changes to cleaned pages and for applying translations later
- "Import chapter from PSD" on both home screens, sharing the new-chapter dialog via a `mode` prop
- the editor's JSON / Cleaned / Raw / PSD buttons and the empty state's offers are gone, along with
  `importImageFiles`, `importJsonFile`, `pickImages`, `pickJson` and `importPsdFiles`

Two judgement calls worth knowing about, both stated in the UI rather than hidden:

- a PSD page whose Base group has only a Cleaned layer is written to `raws/` as its own raw; the
  import summary counts those pages, because detection on them will find nothing
- applying a translations file whose line numbering differs orphans the boxes placed from the old
  numbering; they are counted and named in the toast, and nothing is deleted

The governing decision: **imports do not belong in the editor.** Source material is chosen when a chapter is created, on the home screen. That resolves a bug currently worked around by disabling buttons — the editor's "Cleaned" import sets `pages[i].cleaned`, which `saveOpenChapter`'s page projection discards, so it silently loses its result on reopen.

Scope:
- The new-chapter dialog takes raws **plus optional cleaned pages plus an optional translations JSON**.
- `chapter.json`'s `Page` gains a `cleaned` field; a `cleaned/` directory sits beside `raws/`, copied byte-for-byte the same way.
- A chapter-sources sheet reachable from a chapter row on the project screen: add translations later, and **swap individual cleaned pages** — the user explicitly asked for per-page control and left the exact affordance to judgement. Suggested shape: a list of pages showing raw filename and cleaned filename or "none", with per-row *Set cleaned…* and *Remove*, plus bulk actions at the top.
- **"Import chapter from PSD"** beside New chapter on the library and project screens. A PSD restores a whole typeset chapter, so it creates one rather than adding to one. PSD *export* stays in the editor.
- Once this lands, the editor's import buttons are deleted rather than disabled (see `src/lib/TopBar.svelte` and `Editor.svelte`'s empty state).

Data-safety note: this slice touches the schema and the copy path, which is where every serious bug in slice 1 lived. Budget for adversarial review.

Deferred out of this slice: the library card's status chip and Continue button, which slice 1 also
left unbuilt. The card was not reworked here after all — nothing in this slice changed what a
project card knows.

---

## 3. Slice 2b — the editor wireframe — BUILT AND DRIVEN IN THE APP

The wireframe at `docs/wireframe-editor.png` was the authority and the editor now matches it.
Spec: `docs/superpowers/specs/2026-08-13-slice2b-editor-wireframe-design.md`.
Plan: `docs/superpowers/plans/2026-08-13-slice2b-editor-wireframe.md`.
Ledger, with every review finding, fix round and ruling: `.superpowers/sdd/2026-08-13-slice2b-editor-wireframe/progress.md` (git-ignored, on disk).

Forty-two commits. `npm test` 226 passing, `npm run build` and `cargo check` clean.

What it delivers: a full-bleed canvas; the top bar, status bar, column resizers and old right panel
deleted; Home and project pills carrying the save indicator, detect and export pills, settings and
fonts; a hideable raw-reference sidebar with its own zoom; a tool rail carrying place / text / bulk
style that doubles as the sidebar's resizer; a floating zoom + undo/redo dock and a typeable pager;
two draggable, resizable, hideable panels whose geometry persists per user; a translation field on
the active queue line; per-page detection and a *Save detection JSON…* action; and undo/redo, which
did not exist in this codebase before — five steps, per page, plain-data command records with
inverses, spilled to `<chapter>/logs/history.json` and replayed after a relaunch.

Verified in a debug bundle built from this worktree and proven with a temporary marker on the
project pill: every panel dragged, resized, hidden into its button and restored; the layout, the
theme and the history all surviving a quit and a relaunch (`logs/history.json` came back with three
undo and two redo entries and replayed correctly); the five-step cap; both themes on every piece of
chrome; the transform handles staying dark over the near-white page in dark mode.

Two defects the app pass found, both since fixed and re-verified on screen:
- the rail's restore caret sat underneath the fixed Home pill once the sidebar was hidden, so the
  sidebar could not be brought back;
- ⌘Z did nothing right after the Text tool's gesture. The cause was not in the web app at all:
  Tauri's `Menu::default()` installs an Edit submenu whose **predefined** Undo/Redo own ⌘Z and
  ⇧⌘Z at the macOS responder level, ahead of the web view. They are now removed in the same pass
  that already swaps Quit.

**Known trade-off from that second fix, worth a decision:** removing those menu items also removed
the field-level text undo. ⌘Z inside an inline box edit no longer reverts the typing, and neither
does it in the Inspector's textarea. The alternative — ordinary menu items delegating to
`document.execCommand('undo')` when a field has focus — is unproven in WKWebView and was not taken.

---

## 4. Colour fidelity — specified, unimplemented

Spec is written and committed: `docs/superpowers/specs/2026-08-12-colorspace-fidelity-design.md`. No plan yet.

The defect: the app converts every raw to 8-bit sRGB RGB on export. Manga raws are frequently greyscale, sometimes 16-bit, sometimes carrying an ICC profile. A page that was never touched comes back from export as a different file.

The approved design (revised once, after the first version conceded too much):
- Untouched pages export as a byte-for-byte copy of the source.
- Pages carrying text composite **off-canvas**: decode with `fast-png` at native depth and channel count, render the text alone to a transparent RGBA canvas, blend in typed arrays, encode back at the source's depth, splice the ICC chunk back in. Only pixels under a glyph change at all; 16-bit greyscale survives typesetting.
- Greyscale PSD export via a `patch-package` patch to `ag-psd` — four localized sites, since it hardcodes `ColorMode.RGB`. Gated by a chromacity scan so any coloured text falls back to RGB.
- Accepted limits: PSD stays 8-bit (ag-psd's data model is 8-bit end to end); JPG/WebP composited output stays RGB.

`fast-png` is the only new runtime dependency.

---

## Working agreements to carry forward

- **Caveman mode is active** (`full`). Terse, no filler, technical substance intact. It does not apply to anything persisted outside chat — commits, docs, specs and memory files are written in normal prose.
- **Do not use `haiku`.** The user's instruction: `sonnet` for easy and mild tasks, `opus` for difficult ones. Reviews of subtle or data-touching diffs get `opus`.
- The user asked for **cavecrew subagents** (`caveman:cavecrew-investigator` / `-builder` / `-reviewer`) where they fit — their output is compressed, which matters over a long session.
- **Verify against this worktree's own build.** A packaged build of this app used to exist on the machine and could be launched by mistake; it has been uninstalled, but prove the window under test is this worktree's build (a temporary distinctive wordmark or window title, confirmed on screen, then reverted) before trusting any observation.
- **The app is unsigned**, so macOS prompts for folder access after each reinstall and that prompt can sit unanswered for a while. That is expected — it is not a hang. One agent misdiagnosed it as one and added a 30-second filesystem deadline; that was reverted.
- `npm run tauri dev` works (the script was added during slice 1). `npm test` is Vitest, `node` environment, 78 tests.

## Deferred items, all recorded in the slice 1 ledger

None are blocking; several deserve a look during slice 2:
- `importJsonFile` can still append pages that persist with an empty `file` when the imported JSON is longer than the chapter. The JSON button is still enabled inside a chapter, so it is user-reachable.
- `freeDir` has a TOCTOU window between `exists()` and `mkdir({recursive:true})`; closing it needs a non-recursive `mkdir` through the `fsx` facade.
- A library root persisted from before the `$HOME/**` scope narrowing is never re-validated, so an upgrading user with a library on an external volume gets a generic error with no pointer to the cause.
- Duplicate-entry stubs reuse `unreadable: true` and carry `number: 0`, so they sort above chapter 1.
- Quitting via the Dock, a quit Apple Event, logout or force-quit still bypasses the save flush; closing that needs `applicationShouldTerminate` and a new objc dependency.
