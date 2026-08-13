# UI remake, slice 2b — the editor wireframe

Date: 2026-08-13
Branch: `main`
Status: specified, not implemented.

## Context

Slice 1 delivered the design system, the app shell and the project library, and re-tokenized the
editor without changing its structure. Slice 2a moved every import out of the editor and onto the
home screen. The editor's chrome is therefore the last part of the app still wearing the original
layout: a top bar, a status bar, and three fixed columns separated by drag handles.

This slice rebuilds that chrome to `docs/wireframe-editor.png`. **The wireframe is the authority.**
Where this document and the wireframe disagree, the wireframe wins; where the wireframe is silent,
this document decides.

It is a chrome rebuild, not a rewrite. Placing, moving, resizing, rotating, inline editing, bulk
style, the queue, detection and export all keep working exactly as they do today.

## Goals

1. A full-bleed canvas with floating chrome, per the wireframe.
2. The right-hand panels become floating windows: draggable, resizable, hideable, and remembered
   across relaunches.
3. Undo/redo, which does not exist anywhere in the codebase today: bounded, five steps, per page,
   spilled to disk rather than held in memory.
4. Two small capabilities the wireframe implies and the app cannot do yet: typing a translation
   directly into a queue line, and running detection on the current page alone.

## Non-goals

- Any change to how typesetting itself behaves.
- Any change to the export renderers, the detection pipeline or the sidecar.
- Colour-space fidelity (`docs/superpowers/specs/2026-08-12-colorspace-fidelity-design.md`).
- New dependencies. There are none in this slice.

## Decisions taken

| Question | Decision |
| --- | --- |
| Canvas vs floating panels | Canvas ignores them. Fit-to-window uses the whole canvas viewport; a panel dragged over the page covers it. |
| Canvas viewport | Everything right of the rail, top to bottom. The sidebar and rail are structure; only the two right-hand panels float. |
| Restoring a hidden panel | It shrinks in place into a labelled floating button. Clicking it grows it back to its last size and position. |
| Undo scope | Per page, five steps. The live page's stack is in memory; every other page's is on disk. |
| History storage | `<chapter>/logs/history.json`, page-keyed, kept across relaunches. |
| Stale history | Replay and fail loudly: an entry that cannot apply is reported and dropped at the moment it is used. |
| Bulk style | Gains a third rail button. The double-click gesture on the text tool stays. |
| Status-bar readouts | Cursor coordinates, font name and export format are all dropped. |
| Detect | An icon opening a menu: this page / whole chapter, plus *Save detection JSON…*. |
| Queue lines | The active row expands to a translation input. |
| Pager | Arrows plus a typeable page number. |
| Panel geometry persistence | `localStorage`, per user, one layout shared by every chapter. |

## Prerequisite: stable box ids

`chapter.json` already persists `boxes[].id`, but `loadProjectPages` discards it and mints
`b1, b2, …` from a module-global counter on every open (`src/lib/store.svelte.js`). Box ids are
therefore *not* stable across sessions today, and a persisted history that names boxes by id would
silently address the wrong box after a relaunch.

This must land before the history does:

- `loadProjectPages` keeps `b.id` when the incoming page carries one.
- It mints a fresh id when the id is absent, is not a string, or collides with one already taken by
  an earlier box in the same load.
- `boxSeq` is seeded past the highest `b<n>` seen across the whole document, so a later mint can
  never collide with a kept id.

This is a behaviour fix in its own right — two boxes with the same id would already have confused
selection — and it is testable without any UI.

## Layout

One editor root, `position: fixed; inset: 0`, no scrolling of its own. Five layers, back to front:

```
.ed-root
  .ed-canvas        left: <sidebar+rail>; right/top/bottom: 0   — scrolls, holds the page
  .ed-sidebar       left: 0; top: var(--chrome-top); bottom: 0  — raw reference, hideable
  .ed-rail          left: <sidebar width>; top: 0; bottom: 0    — tools + sidebar resizer
  .ed-chrome        pointer-events: none, children re-enable it — pills, docks, pager
  .ed-panels        the two floating panels and their hidden buttons
```

`--chrome-top: 52px` is the height of the top-left pill row; the sidebar starts below it, the rail
does not. `--panel-col: 320px` is the default width of the right-hand panel column, and is what the
detect and export pills are anchored against. They are anchored to that constant rather than to the
panels themselves, because the panels move and chrome that chases them would never sit still.

### Floating chrome inventory

| Element | Anchor | Contents |
| --- | --- | --- |
| Home pill | top-left | House glyph, returns to the project screen. Keeps today's single-flight guard. |
| Project pill | left of the Home pill | `Project · Chapter`, plus the save indicator. |
| Detect pill | canvas top-right, at `right: calc(var(--panel-col) + 24px)` | Icon; opens the detect menu. Shows `n/N` while a batch runs. |
| Export pill | beside the detect pill | Opens the export dialog. |
| Settings + fonts | window far top-right | Two icon buttons in one cluster. |
| Zoom + undo dock | canvas bottom, centred | `Fit · − · zoom% · + | undo · redo` |
| Pager | beside the zoom dock | `‹ n / N ›`, the `n` typeable. |
| Sidebar zoom | sidebar bottom | `− · label · +`, driving the existing `rawZoom`. |

The save indicator lives on the project pill: a dot plus a title. Three states — saved, unsaved
(pending debounce), and **failed**. There is no manual save in this app, so a failed autosave is the
only signal the user gets that work is not reaching disk; the failed state uses `--warn`, persists
until a write lands, and is the only warn-coloured thing in the editor's chrome.

### The rail

Width 30px, full height, between sidebar and canvas. It carries the three tool buttons — place,
text, bulk style — and, at its top, a caret that hides and shows the sidebar. Dragging anywhere else
on the rail resizes the sidebar, clamped to 200–460px as today, using the same 4px threshold the
canvas pan uses so a click on a tool button is never mistaken for a drag. With the sidebar hidden the
rail sits at `left: 0` and dragging it does nothing; the caret restores.

Bulk style becomes a real tool button that calls `openBulk()`. The existing double-click on the text
tool keeps working. Escape still closes bulk mode.

### What is deleted

- `src/lib/TopBar.svelte`, `src/lib/StatusBar.svelte`, `src/lib/Resizer.svelte`, and
  `src/lib/RightPanel.svelte` (its two collapsible sections are replaced by the two floating panels).
- `.topbar`, `.statusbar`, `.resizer`, `.col*`, `.rpanel`, `.section*` and `.panel-head` rules in
  `src/styles.css`, along with the `--topbar-h` and `--status-h` tokens.
- `app.collapsed` and `app.rightWidth` in the store. `app.leftWidth` survives as the sidebar width
  and gains `localStorage` persistence. `app.cursor` goes, with the `mousemove` handler that fed it.
- The format `<select>` moves off the deleted top bar and into the export dialog, above the file
  name field. `app.fmt` and `saveExportPrefs` are unchanged.

## Modules

### `src/lib/editor/panels.svelte.js` — floating panel geometry

Owns geometry for a fixed set of panel ids (`options`, `queue`), nothing else:

```js
export const panels = $state({ options: {...}, queue: {...} });
// each: { x, y, w, h, hidden }
export function movePanel(id, x, y)
export function resizePanel(id, w, h)
export function setHidden(id, hidden)
export function clampAll(vw, vh)     // called on window resize and on load
export function resetPanels()        // Settings action; also the recovery path
```

Reads `mt.panels` from `localStorage` on load, writes it debounced. Corrupt or partial stored JSON
falls back to the defaults per panel, never throws, and never leaves a panel off-screen: `clampAll`
guarantees at least 120×32px of every panel — visible or hidden-as-a-button — stays inside the
viewport, so a window that shrinks between sessions cannot strand one.

Clamping and the storage round-trip are pure functions over `{x,y,w,h,hidden}` and a viewport size.
They are unit-tested without a DOM.

### `src/lib/editor/FloatingPanel.svelte` — the window

Props: `id`, `title`, `children` (snippet). Owns the header drag, the bottom-right resize grip
(minimum 220×160), the hide button, and the shrink-to-button morph. Pointer handling uses
`setPointerCapture` and `pointermove`/`pointerup` on `document`, the idiom already in `TextBox.svelte`
and `Resizer.svelte`.

Hiding animates the panel down to its button over ~180ms (`transform` and `opacity` only, so it
composites); showing reverses it. `prefers-reduced-motion: reduce` drops the transition to none.

The two panels are z-ordered by last interaction, so clicking one brings it to the front.

### `src/lib/editor/history.svelte.js` — undo/redo

Command records are plain data, never closures, because they have to serialize:

```js
{ t:'place',  pageId, box }                                  // box: the full box record
{ t:'delete', pageId, box, index }                           // index restores stacking order
{ t:'move',   pageId, boxId, before:{x,y},      after:{x,y} }
{ t:'resize', pageId, boxId, before:{x,y,w,h,size}, after:{...} }
{ t:'style',  pageId, boxId, before:<style>,    after:<style> }
{ t:'text',   pageId, boxId, before:<string|null>, after:<string|null> }
{ t:'bulk',   pageId, items:[{ boxId, before:<style>, after:<style> }] }
```

A registry maps `t` to `{ undo(entry), redo(entry) }`. The public surface is:

```js
export const history = $state({ canUndo:false, canRedo:false });
export function record(entry)      // push; clears the redo stack; caps at 5
export function undo()
export function redo()
export function beginPageSwitch(fromPageId, toPageId)   // spill + load
export function resetHistory()                          // chapter close
```

**Capacity.** Five entries per page. A sixth drops the oldest. The redo stack is bounded by the same
five and is cleared by any new record.

**Coalescing.** One drag is one entry: a `move` or `resize` is recorded on pointer-up with the
before-state captured on pointer-down, not per pointermove. Inline text editing records one entry per
edit session, on commit. A bulk apply is one entry however many boxes it touches.

**Memory.** Only the current page's stack is live. On a page switch the leaving page's entries are
written into the in-memory image of `logs/history.json` and dropped; the entering page's are read
back. The file is a small page-keyed object (five entries per page, tens of bytes each) written
debounced at 800ms through the same temp-file-and-rename `writeJson` that `chapter.json` uses. A
failed history write is reported once and never blocks editing — history is a convenience, and it
must not be able to take the document down with it.

**Staleness.** Per the decision above, an entry is replayed optimistically. If the box it names is
gone, or the page it names is gone, the undo is refused with a toast naming what it was
(`Could not undo that move — the text box is gone`), the entry is dropped, and the stack moves on to
the next one. Nothing is validated eagerly at load: a chapter edited elsewhere simply loses the steps
that no longer make sense, at the moment they are asked for.

**Shortcuts.** `Cmd/Ctrl+Z` undo, `Cmd/Ctrl+Shift+Z` and `Ctrl+Y` redo, added to the existing
`onKeydown` in `App.svelte`, ignored while a text input or an inline box edit has focus (the existing
guard already covers this, and the browser's own text undo stays intact inside a field).

### Editor components

```
src/lib/editor/EditorRoot.svelte      the five layers, the keyboard host
src/lib/editor/Canvas.svelte          today's Editor.svelte, minus its dock and tool dock
src/lib/editor/RailTools.svelte       tools, sidebar caret, resize drag
src/lib/editor/RefSidebar.svelte      today's RawPanel.svelte, minus the panel head
src/lib/editor/ChromePills.svelte     home, project, detect, export, settings, fonts
src/lib/editor/ZoomDock.svelte        zoom + undo/redo
src/lib/editor/Pager.svelte           ‹ n / N ›
src/lib/editor/DetectMenu.svelte      this page / whole chapter / save detection JSON…
```

`Inspector.svelte` and `Queue.svelte` keep their jobs and move into the two floating panels
unchanged, apart from the queue's new input.

## The two new capabilities

**Queue line translation.** The active queue row expands to show the Japanese and a textarea for the
English, bound to `line.en`. Committing marks the document unsaved through the existing path. Boxes
placed from a line carry `text: null` and resolve through `lineText`, so an edited line updates its
placed box with no extra wiring. Queue edits are deliberately **outside** the undo history — the
history covers the canvas.

**Detect on one page.** `detectCurrentPage` already exists in `src/lib/sidecar.js` and has no UI. The
detect menu exposes it as *This page*, alongside today's *Whole chapter* (`detectAllPages`). Both are
disabled when the sidecar is not ready or a detection is already running.

*Save detection JSON…* writes the same document `buildTextJson` already produces for the export
dialog's JSON format — one writer, two entry points. It is disabled until at least one page in scope
carries detection data.

## Persistence

| Key | Owner | Shape |
| --- | --- | --- |
| `mt.panels` | `panels.svelte.js` | `{ options:{x,y,w,h,hidden}, queue:{…} }` |
| `mt.sidebar` | the editor | `{ width, hidden }` |
| `logs/history.json` | `history.svelte.js` | `{ version:1, pages:{ "<pageId>": [entry…] } }` |

`mt.export` and `mt.theme` are untouched. The history file is the only new thing on disk; it lives
beside `chapter.json` in the chapter directory, and deleting it by hand costs nothing but undo.

## Theming

Every colour comes from a token. `--warn` appears exactly once in this slice: the failed-save state
on the project pill.

The floating chrome is drawn over `--art` (the canvas backdrop), not over `--paper`, so it uses the
panel vocabulary — `--panel`/`--surface` fills, `--line2` borders, `--edge` shadow — and inverts with
the theme like the rest of the chrome. `--tint` and `--tintline` remain reserved for what is drawn
over the page itself: selection outline, handles, rotation grip, bulk ring and badge, JP pill,
caret. Nothing in this slice adds a new element over `--paper`, so nothing new needs them.

Both themes are checked on: the pills, the rail, the sidebar, the zoom dock, the pager, both panels
in their open state, both in their hidden-button state, and the detect menu.

## Error handling

- **Corrupt `mt.panels`** — defaults, silently. A layout preference is not worth a message.
- **A panel stranded off-screen** — `clampAll` on load and on every window resize.
- **`logs/` cannot be created or written** — one toast, then history stays in memory for the live
  page and page switches drop what they spill. Editing is unaffected.
- **Corrupt `logs/history.json`** — the file is replaced on the next write; undo starts empty. No
  attempt to salvage a partial parse.
- **An undo that cannot apply** — toast naming the command, entry dropped, stack continues.
- **Detection with no sidecar** — the menu items are disabled with the existing tooltip.

## Testing

`npm test` is Vitest in the `node` environment; these are all pure-logic tests, in keeping with
what is there:

- `panels.test.js` — defaults, clamping against a viewport smaller than the stored geometry, a
  hidden panel's button staying reachable, corrupt JSON falling back, the storage round-trip.
- `history.test.js` — every command type's undo and redo restoring exactly what it should; the cap
  dropping the oldest at six; a new record clearing redo; a drag producing one entry, not many;
  bulk as one entry; an entry naming a missing box being refused and dropped rather than throwing;
  the page-switch spill and reload; the file's round-trip through `fsx`.
- `store.test.js` — box ids surviving a `loadProjectPages` round-trip, colliding ids being reminted,
  `boxSeq` seeded past the highest kept id.

The layout itself is verified in the running app, not in tests: every panel dragged, resized,
hidden and restored across a relaunch; both themes on every piece of chrome; undo driven to its cap
and past it; and typesetting exercised end to end to prove nothing regressed. The window under test
must be proven to be this worktree's build — a temporary marker in the wordmark, confirmed on
screen, then reverted — before any of it is believed.

## Acceptance

1. No top bar, no status bar, no column resizers anywhere in the source or on screen.
2. The canvas is full-bleed: the page fits to the whole canvas viewport, and a floating panel
   dragged over it covers it rather than reflowing it.
3. Both panels drag, resize, hide into a button, restore from it, and come back where they were
   after a relaunch.
4. The rail switches all three tools and resizes the sidebar; the caret hides and restores it.
5. Undo and redo work for place, move, resize, delete, style, text edit and bulk apply; the stack
   holds five and drops the oldest at six; switching pages and coming back restores that page's
   stack; closing the chapter and reopening it still offers it.
6. A queue line can be translated in place, and a box placed from it shows the new text.
7. Detection runs on one page or the whole chapter, and its JSON can be saved from the same menu.
8. Both themes render every piece of chrome, over the canvas backdrop and over a page.
9. `npm test` passes with the new suites, `npm run build` and `cargo check` are clean.
