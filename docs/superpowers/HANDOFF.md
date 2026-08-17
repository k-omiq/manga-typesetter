# Handoff — manga-typesetter UI remake

Date: 2026-08-12
Worktree: `/Users/caved/dev/manga-typesetter/.claude/worktrees/strip-clean`, branch `strip-clean`
State at handoff: working tree clean, `npm test` 89 passing, `npm run build` and `cargo check` clean.

Branch topology, settled 2026-08-13: `ml-engine` preserves the pre-strip state — the full
`python/flux_sidecar` package, FLUX inpainting, BYOK translation and Clean mode — for reuse in
another application. `strip-clean` is the typesetter-only line and is what `main` should carry.
The clean features were removed in `4960252`, which exists only on `strip-clean`.

Work all of this **in the worktree above**. Do not `cd` to the parent repo.

**Update, 2026-08-16.** The sessions since then have run in the parent repo,
`/Users/caved/dev/manga-typesetter`, on `main` — not in the `strip-clean` worktree named
above. Everything in sections 5 and 6 was done there. State at this handoff: `cargo test
--lib` 17 passing, `npx vitest run` 720 passing, `npm run build` and `npm run tauri build`
clean, a DMG produced. Check which of the two locations you are in before starting.

---

## Where things stand

The UI remake was split into slices. Slice 1 is built and reviewed; slices 2a, 2b and the colour-fidelity work are specified or scoped but not started. That sentence is from 2026-08-12 and the section headings below now govern it — 2a and 2b were subsequently built. Sections 5 and 6 cover work that is not part of the UI remake at all: the ONNX migration that removes the Python sidecar, which is the live piece of work, and a set of fixes landed alongside it.

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

## 5. Sidecar removal — ONNX in Rust — COMPLETE, ALL FOUR SLICES

Spec: `docs/superpowers/specs/2026-08-16-onnx-sidecar-removal-design.md`. The migration is
done: all three models run from Rust via `ort`, the Python tree and `sidecar.rs` are deleted,
and the frontend calls the Rust engine. Completed 2026-08-17.

**The verification bar, met everywhere.** Every stage was golden-tested against the real
Python sidecar's output on real Tsukimichi chapter-1 pages before the Python path was
removed, and the final gate is end-to-end: `detect::analyze::tests::
analyze_matches_the_python_sidecar_on_every_golden_page` asserts the exact `/analyze`
response — line order, boxes, `jp` strings, types, panels — byte-for-byte against
`src-tauri/testdata/analyze-golden/e2e-golden.json` on three pages (34 lines). All fixtures
live under `src-tauri/testdata/`; tests skip with an eprintln on machines missing the models
(`~/.mangatypesetter/models`) or the fixture pages (absolute paths under
`/Users/caved/Documents/MangaTypesetter/`).

**What exists now, all under `src-tauri/src/detect/`:**

- `geometry.rs`, `panels.rs` — manga109 panel YOLO (slice 1). Ultralytics-exact after a
  late fix: predict mode letterboxes to a stride-32 *rectangle* (a 1080×1535 page enters at
  640×480, not 640×640), resize is OpenCV fixed-point INTER_LINEAR (`cvops::
  resize_linear_u8`, not `image`'s Triangle), NMS IoU is 0.7, and `scale_boxes` is ported
  verbatim. Panel coordinates now match ultralytics with **zero** delta on all 15 fixture
  panels. The panel session runs **CPU-only, deliberately**: CoreML's reduced precision
  moved boxes ~0.03 px — enough to flip an int and swap two reading-order lines on page 10
  — and CPU was also faster (287 vs 361 ms). Rationale recorded at the `load_session` call.
- `ocr.rs` — manga-ocr (slice 2), encoder + decoder ONNX (fp32, from
  onnx-community/manga-ocr-base-ONNX) with a faithful transformers **beam search** port:
  num_beams 4, no_repeat_ngram_size 3, length_penalty 2.0 (rewards *longer* — easy to
  invert), early_stopping, `BeamHypotheses.add` ported literally. Preprocessing is
  bit-exact Pillow: `pil_luma` is the L24 fixed-point formula, `pil_bilinear_resize`
  hand-ports Pillow's 8-bit two-pass resample — the `image` crate's Triangle filter is NOT
  a substitute. Golden: 34/34 crops exact-match. Encoder takes CoreML; the decoder cannot
  (its sequence length grows each step and CoreML compiles per shape).
- `textdetector.rs`, `textblock.rs`, `dbnet.rs`, `cvops.rs`, `minrect.rs` — the
  comic_text_detector port (slice 3): rect letterbox (pad bottom/right, black), BGR input,
  pre-decoded YOLOv5 head, DBNet shrink-map → Suzuki–Abe contours → minAreaRect →
  ClipperOffset JT_ROUND unclip (the analytical grow-by-d shortcut was tried and measurably
  wrong — Clipper's integer truncation bulges results ~0.5 px and changed block splits) →
  full `group_output` grouping with the original's quirks preserved (its `union_area` is
  really intersection; NaN density gates; sort-index mismatches). Golden: all 34 blocks at
  IoU exactly 1.0.
- `crops.rs` — `_block_crop` and the per-line fallback (slice 3.5): exact
  `get_transformed_region` (4-point DLT homography + OpenCV fixed-point warpPerspective,
  byte-identical on all 40 line crops) and `_split_into_chunks` (scipy gaussian window,
  numpy off-centre `same` convolve). The raw `seg` mask stands in for Python's refined mask
  in the density-valley split; on the fixture nothing splits, so the seam is pinned by unit
  tests only — see residuals.
- `sorting.rs` — `sort_bubbles_by_reading_order` (rtl) + `_assign_types` (median font-size
  SFX heuristic), golden-tested.
- `analyze.rs` — the pipeline: decode → text blocks → panels → crops → OCR → sort → the
  exact `/analyze` response shape.
- `engine.rs` — `DetectEngine` Tauri state, lazy streaming model downloads (`.part` +
  rename, 300 s deadline, `MT_DOWNLOAD_DEADLINE` override) from HF/GitHub, and the
  commands: `detect_analyze`, `detect_models_cache`, `detect_models_cache_clear`,
  `detect_health`. `cache_clear` canonicalises and requires the path to end in
  `.mangatypesetter/models` before deleting anything.

**The cutover (slice 4).** `src/lib/sidecar.js` now invokes the `detect_*` commands;
restart-sidecar UI removed (nothing to restart); Settings model-cache panel unchanged in
shape; `src-tauri/src/sidecar.rs` and the tracked `python/` tree deleted; the
`bundle.resources` sidecar entry left `tauri.conf.json`; the CI python job is gone; reqwest
trimmed to `default-features = false, features = ["rustls-tls"]` (model downloads are the
only outbound traffic); `getrandom` and `tokio` dropped as direct deps.

**Suites:** `cargo test --lib` 134 green (~60 s — the OCR beam-search goldens dominate);
`npx vitest run` 720 green; `npm run build` clean.

**Residuals, none blocking:**

- `cvops::resize_linear_u8` is not perfectly bit-exact vs cv2 on two fixture pages
  (≤1 count on ~1k bytes near the right edge, 9 columns) despite its module doc's claim.
  It changes nothing observable — panel boxes still match ultralytics exactly on those
  pages — and is filed as a task chip rather than touched, since `textdetector.rs` also
  depends on it.
- The per-line chunk splitter uses the raw seg mask where Python used the refined mask,
  and the fixture never exercises a split (nothing on these pages exceeds the ratio
  guard). If a future page splits long lines at odd places, capture a golden for it first.
- The text detector still offers CoreML; its DBNet scores drift ~0.005 near the 0.6
  box_thresh under CoreML, stable on the fixture but worth remembering if a line ever
  flickers in and out of detection between machines.
- ~5.4 GB of untracked leftovers remain on disk: `python/models/` (5.1 GB, the old HF
  cache), `python/build-sidecar/` (298 MB PyInstaller output), `python/sidecar/__pycache__`,
  `src-tauri/binaries/mt-sidecar/`. Deleting them is irreversible and was left to the user:
  `rm -rf python/models python/build-sidecar python/sidecar src-tauri/binaries` reclaims it
  and keeps `python/flux_sidecar/` (the FLUX inpainting server — separate live work,
  untouched by this migration).
- INT8 OCR models are downloaded (`*_quantized.onnx`) but unused; adopting them needs the
  accuracy comparison the spec calls for.

---

## 6. Assorted fixes, 2026-08-16

All verified, all in the parent repo on `main`.

- **Bulk style panel** could not scroll or be resized. The scroll region is now a single
  `.bulk-scroll` wrapping the tag block, the hint and the property list, with `min-height:0`
  so it can actually shrink; a corner grip resizes the panel; and both the width and height
  caps now track the panel's dragged position rather than assuming it sits at the top left.
- **Exported outlines were twice the canvas weight.** Both painters centre the stroke on the
  glyph and then fill over the inner half, so the visible outline is half the requested width.
  The PNG exporter and the PSD writer already compensated; the editor preview did not.
  `TextBox.svelte` now doubles too, so all three renderers agree.
- **The hand tool only worked when scrollbars existed**, which meant it did nothing at Fit.
  `Canvas.svelte` now spends scroll room first and turns the remainder into a clamped
  `translate` on `.page-frame`, keeping at least 96px of page on screen. Fit and page turns
  reset it; zoom re-clamps it.
- **Page images are windowed** to the current page ±2 (`src/lib/page-images.js`). `openChapter`
  used to mint a blob URL for every raw and every cleaned page before showing the first one —
  about 600 MB held for a 200-page chapter, for the whole session. Export, PSD export and
  batch detect borrow pages through `withPageImages`, which pins them so a page turn cannot
  revoke an image mid-draw.
- **Settings → Memory** reports the app's real footprint (`src-tauri/src/memory.rs`). It
  counts the WebKit content process, which is where the page images live and which is not a
  child of this process — it is matched by macOS responsible-process, with a launch-session
  fallback for terminal-started dev builds that the panel labels as such.
- **The reference sidebar image** is vertically centred instead of pinned to the top.

---

## Working agreements to carry forward

- **Caveman mode is active** (`full`). Terse, no filler, technical substance intact. It does not apply to anything persisted outside chat — commits, docs, specs and memory files are written in normal prose.
- **Do not use `haiku`.** The user's instruction: `sonnet` for easy and mild tasks, `opus` for difficult ones. Reviews of subtle or data-touching diffs get `opus`.
- The user asked for **cavecrew subagents** (`caveman:cavecrew-investigator` / `-builder` / `-reviewer`) where they fit — their output is compressed, which matters over a long session.
- **Verify against this worktree's own build.** A packaged build of this app used to exist on the machine and could be launched by mistake; it has been uninstalled, but prove the window under test is this worktree's build (a temporary distinctive wordmark or window title, confirmed on screen, then reverted) before trusting any observation.
- **The app is unsigned**, so macOS prompts for folder access after each reinstall and that prompt can sit unanswered for a while. That is expected — it is not a hang. One agent misdiagnosed it as one and added a 30-second filesystem deadline; that was reverted.
- `npm run tauri dev` works (the script was added during slice 1). `npm test` is Vitest, `node` environment, 78 tests.

## Verification commands

```
cd src-tauri && cargo test --lib     # 17 tests
npx vitest run                       # 720 tests
npm run build                        # vite
npm run tauri build                  # DMG at src-tauri/target/release/bundle/dmg/
```

## Traps found the hard way, 2026-08-16

- **The DMG step can fail and leave a disk image mounted** at `/Volumes/dmg.*`, which then
  blocks every retry. Eject it and delete `src-tauri/target/release/bundle/macos/rw.*.dmg`
  before building again. Note also that a successful DMG step *moves* the `.app` into the
  image, so `bundle/macos/` is empty afterwards — that is not a failed build.
- **Tauri's resource copier follows symlinks.** PyInstaller ships 121 symlinked dylibs, so the
  bundler duplicates 361 MB of them — `libtorch_cpu.dylib` alone appears twice at 236 MB. That
  is the whole difference between the 1.3 GB staged sidecar and the 1.7 GB app. It compresses
  away in the DMG, so it costs installed size and not download size, and it becomes moot once
  the sidecar is gone. There is no Tauri setting for it; fixing it would mean building the
  `.app`, deduping, and producing the DMG by hand.
- **The in-app Browser pane got wedged on "Policy check in progress"** twice, on two separate
  attempts hours apart. Headless Chrome is a working fallback for checking real layout:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --virtual-time-budget=4000 --dump-dom http://localhost:PORT/page.html`, having the page
  write its measurements into an element the DOM dump will contain. Read the port from
  `preview_logs` — vite's actual port differs from the one the preview tool reports.
- **Antigravity subagents can return an empty response** with `"status":"SUCCESS"` when a
  shell command they chose hits the permission allowlist. It is a failed run, not an empty
  answer. Re-dispatch with a prompt that only reads files and supply any measurements in the
  prompt yourself.

## Deferred items, all recorded in the slice 1 ledger

None are blocking; several deserve a look during slice 2:
- `importJsonFile` can still append pages that persist with an empty `file` when the imported JSON is longer than the chapter. The JSON button is still enabled inside a chapter, so it is user-reachable.
- `freeDir` has a TOCTOU window between `exists()` and `mkdir({recursive:true})`; closing it needs a non-recursive `mkdir` through the `fsx` facade.
- A library root persisted from before the `$HOME/**` scope narrowing is never re-validated, so an upgrading user with a library on an external volume gets a generic error with no pointer to the cause.
- Duplicate-entry stubs reuse `unreadable: true` and carry `number: 0`, so they sort above chapter 1.
- Quitting via the Dock, a quit Apple Event, logout or force-quit still bypasses the save flush; closing that needs `applicationShouldTerminate` and a new objc dependency.
