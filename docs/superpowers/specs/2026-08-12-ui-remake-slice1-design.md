# UI remake, slice 1 — design system, app shell, project library

Date: 2026-08-12
Branch: `strip-clean`
Status: proposed

## Context

The app currently boots straight into the editor with demo pages baked into `src/lib/data.js`.
There is no concept of a project, nothing is persisted except export preferences in
`localStorage`, and the only lossless round-trip is PSD import/export. The visual style is a
dark VS-Code-like theme with an indigo accent, driven by 17 CSS custom properties in
`src/styles.css` (~190 `var()` usages across 24 files).

The requested change is a full UI remake in a warm-neutral greyscale direction, plus an entry
home screen for managing projects. A reference design (`Manga Cleaner Studio.dc.html`, a
separate application) supplies the visual language and the home-screen layout. Only the design
language and the home screen are taken from it; its editor is explicitly not a model for ours.

The work is split into two slices. This document specifies **slice 1**. Slice 2 (the editor
restructure to the supplied wireframe: full-bleed canvas, floating chrome, drag/hide/resize
panels) gets its own spec after slice 1 ships.

## Goals

1. Replace the dark indigo theme with the paper-toned greyscale design system, in light and dark.
2. Add a home screen: a project library, and a chapter list per project.
3. Persist projects and chapters to disk in a managed library folder, self-contained and portable.
4. Route between home and editor without disturbing how the editor works today.

## Non-goals

- Any change to editor layout, tools, or interaction. The editor is re-tokenized only.
- Cleaning, translation, or export pipeline changes.
- Cloud sync, sharing, multi-user, or project templates.
- A plain-browser (`vite dev`) code path. The app is Tauri-only; iteration uses `npm run tauri dev`.

## Decisions taken

| Question | Decision |
| --- | --- |
| Where projects live | Managed library folder owned by the app |
| Hierarchy | Projects → Chapters → Pages |
| Raw images | Copied into the library on chapter creation |
| "New chapter" from the library root | Dialog: pick/create project, chapter number and title, pick raws |
| Themes | Light and dark, light default, manual toggle persisted |
| Runtime | Tauri only |
| Routing | Tagged-union route module, no dependency |
| State ownership | New `library.svelte.js`; `app` demoted to "the open chapter" |
| Tokens | Renamed to the design's vocabulary, one mechanical sweep |

## Design system

### Tokens

`src/styles.css` `:root` is replaced wholesale with the reference palette. Values are taken
verbatim from the design so light and dark stay in step.

```css
:root{
  --bg:#e8e7e3; --sb:#e2e1dc; --panel:#f6f5f2; --panel2:#efeeea;
  --card:#fbfaf8; --surface:#fcfbf9; --paper:#fefdfb;
  --art:#e4e2dd; --art2:#dbd9d3;
  --line:rgba(42,38,32,.08); --line2:rgba(42,38,32,.15);
  --text:#22211e; --t2:rgba(34,33,30,.66); --t3:rgba(34,33,30,.55);
  --accent:#2c2b28; --accent-fg:#f8f7f4; --accent-soft:rgba(42,38,32,.075);
  --tint:rgba(34,33,30,.20); --tintline:rgba(34,33,30,.48); --warn:#8a3f2a;
  --edge:0 1px 1px rgba(42,38,32,.05), 0 5px 14px rgba(42,38,32,.07);
  --edge-soft:0 1px 2px rgba(42,38,32,.05);
}
:root[data-theme="dark"]{
  --bg:#121313; --sb:#0d0e0e; --panel:#1a1b1c; --panel2:#202122;
  --card:#1a1b1c; --surface:#212223; --paper:#f6f5f2;
  --art:#e4e3df; --art2:#dbdad5;
  --line:rgba(255,255,255,.07); --line2:rgba(255,255,255,.13);
  --text:#e9e8e5; --t2:rgba(233,232,229,.64); --t3:rgba(233,232,229,.48);
  --accent:#e9e8e5; --accent-fg:#141514; --accent-soft:rgba(233,232,229,.10);
  --tint:rgba(246,245,242,.32); --tintline:rgba(255,255,255,.72); --warn:#d98b6a;
  --edge:0 0 0 1px rgba(255,255,255,.05), 0 6px 20px rgba(0,0,0,.42);
  --edge-soft:0 0 0 1px rgba(255,255,255,.05);
}
```

Layout tokens `--topbar-h`, `--status-h`, `--radius` are kept as they are.

Typography: `system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN",
"Yu Gothic", "Noto Sans JP", "Microsoft YaHei", sans-serif` at `12.5px`, antialiased, with
`font-variant-numeric: tabular-nums` on `body` and on `button, input, select`. Monospace is
reserved for filenames and file-ish labels. The `'Inter'` reference and the `13px` base size go away.

### Old → new token mapping

The sweep is mechanical. Every `var()` in `src/styles.css` and the 24 component files is rewritten:

| Old | New | Note |
| --- | --- | --- |
| `--panel` `#1e1e1e` | `--panel` | value only |
| `--surface` `#252525` | `--surface` | value only |
| `--surface-2` `#2c2c2c` | `--panel2` | |
| `--border` `#333` | `--line` | |
| `--border-light` `#3d3d3d` | `--line2` | |
| `--text` | `--text` | value only |
| `--muted` `#888` | `--t2` | 36 uses, the largest group |
| `--muted-2` `#666` | `--t3` | |
| `--accent` `#6366f1` | `--accent` | indigo → monochrome |
| `--accent-hi` | removed | hover becomes `--accent-soft` background |
| `--accent-dim` | `--accent-soft` | |
| `--backdrop` `#3a3a3a` | `--art` | canvas backdrop behind a page |
| `--danger` `#ef4444` | `--warn` | |
| `--ok` `#22c55e` | removed | success states carry no colour; use `--text` weight |

Hard-coded values also removed: `body{background:#161616}`, the `.brand .logo` indigo→violet
gradient and its glow shadow, `.pagenav .indicator b{color:#fff}`, and the scrollbar's
`#3a3a3a`/`#4a4a4a` (they become `--line2` / `--t3`).

Artwork is the only colour on screen. No chrome element introduces a hue.

### Theme switching

`document.documentElement.dataset.theme` is set to `light` or `dark` from a single
`theme.svelte.js` module, persisted under `mt.theme` in `localStorage`, defaulting to `light`.
The Settings modal gets a two-option control. No `prefers-color-scheme` media query — the
preference is explicit, so behaviour never changes underfoot.

**Assumption to confirm:** the brief names `#ececea` as the accent. The reference design uses
`--accent:#2c2b28` in light (near-black chip on paper) and `--accent:#e9e8e5` in dark. `#ececea`
sits in the dark-theme range, so this spec takes it as the dark accent and keeps the design's
values for both. Correcting this later is a two-line change.

## Data model

```
Project  { id, name, createdAt, updatedAt, coverChapterId, coverPageId }
Chapter  { id, projectId, number, title, createdAt, updatedAt, pages: [Page] }
Page     { id, file, w, h, lines, detect, boxes }
```

`Page` is exactly what the editor already holds in `app.pages`, with the blob URL replaced by
`file` — the raw's filename inside the chapter's `raws/` directory. Blob URLs are minted on open
and revoked on close; they never reach disk.

## Disk layout

Library root defaults to `~/Documents/MangaTypesetter`, changeable in Settings, persisted under
`mt.libraryRoot`.

```
<library>/
  <project-slug>/
    project.json          Project, minus chapters
    thumb.png             cover, derived, regenerable
    <chapter-slug>/
      chapter.json        Chapter, including pages
      raws/               byte-for-byte copies of the imported originals
```

Rules:

- The library is discovered by scanning directories for `project.json` / `chapter.json`. There is
  no central index file to fall out of sync with the folders.
- Slugs are derived from the name for human legibility; identity is the `id` inside the JSON, so
  renaming a folder by hand does not orphan a project.
- Files in `raws/` are copied with `readFile` → `writeFile`, byte-for-byte, keeping their original
  filenames. Nothing decodes or re-encodes them. `thumb.png` is a derived asset generated from
  the first raw and is never written back over a raw.

## Modules

### `src/lib/library.svelte.js` — the catalogue

Owns the library root, the scan, and all disk mutations. Exports reactive `library` state
(`{ root, projects, loading, error }`) plus:

```
scanLibrary()
createProject(name) -> Project
renameProject(id, name)
deleteProject(id)
createChapter({ projectId, number, title, files }) -> Chapter
deleteChapter(projectId, chapterId)
openChapter(projectId, chapterId)     // hydrates the `app` store
saveOpenChapter()                     // flushes `app` back to chapter.json
setLibraryRoot(path)
```

It is the only module that touches `@tauri-apps/plugin-fs` for library paths.

### `src/lib/route.svelte.js` — where we are

```js
export const route = $state({ name: 'library' })
// { name:'library' }
// { name:'project', projectId }
// { name:'editor', projectId, chapterId }
```

Plus `goLibrary()`, `goProject(id)`, `goEditor(projectId, chapterId)`, and `goBack()` backed by a
small history array. `App.svelte` switches on `route.name`. No router dependency, no URLs.

Leaving `editor` always calls `saveOpenChapter()` first.

### `src/lib/store.svelte.js` — the open chapter

Keeps its current responsibilities and loses nothing the editor uses. Changes:

- The demo `PAGES` seed is dropped; `app.pages` starts empty and is filled by `openChapter`.
- `loadProjectPages` is reused as the hydration path.
- `markUnsaved()` additionally schedules a debounced (800 ms) `saveOpenChapter()`; `markSaved()`
  is called by the flush. The existing saved indicator becomes truthful.
- New field `app.chapterRef = { projectId, chapterId } | null`.

## Screens

Shared frame: `padding: 26px 34px 64px`, header row with the wordmark at `12.5px/600/.3em`
letter-spacing on the left and a Settings button on the right.

### Library (`route.name === 'library'`)

- Centred button pair, `padding: 168px 0 152px`, both `212×40`: **New chapter** (accent fill) and
  **New project** (`--accent-soft` fill).
- `PROJECTS` section label at `10.5px`, `.22em` letter-spacing, `--t3`.
- Grid, `repeat(auto-fill, minmax(168px, 1fr))`, `gap: 32px 20px`. Each card is a `2/3`
  aspect-ratio cover on `--card` with `--edge` and a 3px radius, showing `thumb.png`, then below:
  name (`13px/500`), chapter line (`11px --t3`), and `pages · relative time` (`10.5px --t3`).
- Cards carry a status chip and, when a chapter was left mid-work, a **Continue** button pinned to
  the cover's lower edge that jumps straight into that chapter.
- Empty library: the two buttons plus a two-line prompt at `--t3`, no illustration.

### Project (`route.name === 'project'`)

- `← Projects` back link, project name at `27px/500`, meta line beneath, **New chapter** on the right.
- `CHAPTERS` label, then a bordered table: status mark, number (72px), title + subtitle, status chip
  (120px, right), pages count (130px, right), relative time (104px, right). Row click opens the editor.

### Editor (`route.name === 'editor'`)

Unchanged layout. Two additions only: a Home control that returns to the project screen, and the
project/chapter name shown in the existing top bar in place of `· Untitled`. Everything else in
this slice is the token sweep.

### New chapter dialog

Reachable from both the library root and a project screen. Fields: project (dropdown of existing
projects plus *New project…*, which reveals a name field), chapter number, chapter title
(optional), and a raws picker using the existing `pickFilesTauri`. Files are sorted with the
existing natural sort. Confirm creates the folders, copies the raws with a progress line, writes
`chapter.json`, generates `thumb.png` if the project has no cover, and routes into the editor.

## Error handling

- **Library root missing** — created on first use. If creation fails, the home screen shows the
  path and the OS error with a *Choose another folder…* action; nothing else is attempted.
- **Unreadable `project.json` / `chapter.json`** — the scan skips it and records it in
  `library.error`. The card renders in a disabled "Unreadable" state instead of failing the scan.
  One bad folder never blanks the library.
- **Raw copy fails part-way** — the partially written chapter directory is removed and the error
  surfaces in the dialog. No half-chapter is left in the library.
- **Delete** — always behind a confirm naming what is being removed and how many pages it holds.
  Deletion removes the directory tree; there is no undo, and the confirm says so.
- **Save fails** — a toast plus the unsaved indicator stays lit. Editing continues; the next
  debounce retries.
- **Chapter opened while its raws are gone** — pages render as missing placeholders and the
  chapter is flagged; typesetting data is not discarded.

## Testing

There is no test infrastructure in the repo today. Vitest is added — Vite is already a dependency,
so the cost is one dev dependency and a script — covering the pure logic where regressions are
silent and cheap to catch:

- slug derivation, including collisions and non-ASCII project names
- `route` transitions and history, especially that leaving the editor flushes
- `chapter.json` read/write round-trip, including a file written by an older schema
- the scan's behaviour against a fixture tree containing one corrupt `project.json`

Filesystem and UI behaviour are verified by a manual acceptance pass in `npm run tauri dev`:
create project → create chapter from real raws → confirm `raws/` matches the sources byte-for-byte
→ typeset → leave → reopen → state intact → delete → folder gone. Both themes checked on the
library, project, and editor screens.

## Acceptance

1. Launching the app lands on the library, not the editor.
2. A project and a chapter can be created, reopened with typesetting intact, and deleted.
3. Files under `raws/` are byte-identical to the imported originals.
4. No indigo, no `#161616`, no `'Inter'`, and no `--muted`/`--border`/`--ok`/`--danger` remain in
   the source.
5. Light and dark both render every screen with no unthemed element.
6. The editor behaves exactly as it did before, aside from its colours and the Home control.

## Out of scope, tracked for slice 2

Full-bleed canvas, floating chrome pills, draggable/hideable/resizable text-box and queue panels,
the click-mode rail, floating zoom/undo/redo bar, and the `<n/N>` pager, per the supplied wireframe.
