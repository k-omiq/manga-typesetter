// ===== Central reactive store (Svelte 5 runes) =====
import {
  PAGE_W,
  PAGE_H,
  BUILTIN_FONTS,
  USER_FONTS,
  defaultStyle,
  normalizeStyle,
} from './data.js';

export { PAGE_W, PAGE_H };

let boxSeq = 1;
let pageLoadSeq = 5000; // page ids for imported projects that carry none

// Replace all pages from an imported project (e.g. a lossless PSD). Normalizes
// styles up to the current schema.
// Object URLs (raw/cleaned) are passed through as-is — the caller regenerates
// them from the source.
//
// Page and box ids are persisted in chapter.json and are addressed by the undo
// history across sessions, so a load keeps the id it was given. A fresh one is
// minted only when there is none, or when the file names two of them the same —
// two boxes answering to one id would confuse selection, deletion and undo
// alike, and so would two pages. The pre-pass walks the whole document first so
// both sequences start past the highest id in it, and something minted on page
// one cannot take an id that page nine already owns.
//
// Returns how many ids it had to mint. Anything above zero means what is now in
// memory disagrees with the file, and the caller has to get that written back:
// the minted ids come off module-global counters, so leaving the repair unsaved
// means the same box is called something different every session — the drift the
// history cannot see.
const idNum = (id) => (typeof id === 'string' && /^b\d+$/.test(id) ? Number(id.slice(1)) : 0);

export function loadProjectPages(rawPages) {
  const takenBoxes = new Set();
  const takenPages = new Set();
  let minted = 0;
  for (const p of rawPages) {
    if (typeof p.id === 'number' && p.id >= pageLoadSeq) pageLoadSeq = p.id + 1;
    for (const b of p.boxes ?? []) {
      const n = idNum(b.id);
      if (n >= boxSeq) boxSeq = n + 1;
    }
  }
  app.pages = rawPages.map((p) => {
    const keepPage = p.id != null && !takenPages.has(p.id);
    const pageId = keepPage ? p.id : pageLoadSeq++;
    takenPages.add(pageId);
    if (!keepPage) minted++;
    const cp = {
      id: pageId,
      raw: p.raw ?? null,
      cleaned: p.cleaned ?? null,
      // The page's own durable filenames inside the chapter's raws/ and
      // cleaned/. Carried on the page, never re-derived by position, so a save
      // can never hand one page's images to another. `raw` and `cleaned` above
      // are the runtime blob URLs and never reach disk.
      file: p.file ?? null,
      cleanedFile: p.cleanedFile ?? null,
      w: p.w ?? PAGE_W,
      h: p.h ?? PAGE_H,
      lines: (p.lines ?? []).map((l) => ({ ...l })),
      detect: p.detect
        ? { panels: (p.detect.panels ?? []).slice(), boxes: p.detect.boxes.map((b) => ({ ...b })) }
        : null,
      boxes: (p.boxes ?? []).map((b) => {
        const keep = typeof b.id === 'string' && b.id !== '' && !takenBoxes.has(b.id);
        const id = keep ? b.id : 'b' + boxSeq++;
        takenBoxes.add(id);
        if (!keep) minted++;
        return {
          id,
          lineN: b.lineN,
          text: b.text ?? null,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          style: normalizeStyle(b.style),
        };
      }),
      activeLineN: null,
    };
    cp.activeLineN = firstUnplaced(cp);
    return cp;
  });
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  clearPending();
  app.loaded = true;
  markUnsaved();
  return minted;
}

export function firstUnplaced(p) {
  const u = p.lines.find((l) => !p.boxes.some((b) => b.lineN === l.n));
  return u ? u.n : p.lines.length ? p.lines[p.lines.length - 1].n : null;
}
export const isPlaced = (p, n) => p.boxes.some((b) => b.lineN === n);
export const lineByN = (p, n) => p.lines.find((l) => l.n === n);

// ---------- reactive state ----------
export const app = $state({
  loaded: false, // becomes true once real pages/images/JSON are imported
  pageIndex: 0,
  // Empty until a chapter is opened from the library; the editor is only
  // routed to once one has been.
  pages: [],
  selectedId: null,
  editingId: null, // box currently in inline-edit mode
  tool: 'place', // 'place' | 'text'
  lastStyle: defaultStyle(), // style new boxes inherit (follows the previous box)
  bulk: { active: false, targets: [], style: null }, // bulk-style picker mode
  exportOpen: false, // export scope/destination dialog
  exportDir: '', // last chosen output directory (native only), persisted
  exportName: 'page', // base filename, persisted
  zoom: 1,
  fitZoom: 1,
  isFit: true,
  fmt: 'PNG',
  fonts: { builtin: BUILTIN_FONTS.slice(), user: USER_FONTS.slice() },
  rawZoom: 0, // 0 = Fit, else scale
  saved: false,
  // The last autosave was rejected by the disk. There is no manual save in this
  // app, so this is the user's only signal that their work is not reaching the
  // filesystem — it stays raised until a write lands, not just until the next
  // toast fades.
  saveFailed: false,
  exporting: false,
  leftWidth: 280,
  sidebarHidden: false, // raw reference sidebar collapsed to the rail's caret
  toast: { msg: '', seq: 0 },
  sidecar: { status: 'unknown', device: null, info: null }, // Python ML sidecar health
  detecting: false, // detection/OCR request in flight
  detectBatch: null, // { done, total } while a whole-chapter detect runs, else null
  chapterRef: null, // { projectId, chapterId } while a chapter is open
});

// ---------- derived helpers ----------
// A blank stand-in keeps every consumer total while no chapter is open. The
// editor is only routed to with pages loaded, so this is a safety net, not a
// code path with a UI.
// Frozen, arrays included: a write to the shared singleton is a bug, and it
// should throw where it happens rather than quietly pollute a non-reactive
// object that every empty-document consumer shares.
const NO_PAGE = Object.freeze({
  id: 0,
  raw: null,
  cleaned: null,
  file: null,
  cleanedFile: null,
  w: PAGE_W,
  h: PAGE_H,
  lines: Object.freeze([]),
  detect: null,
  boxes: Object.freeze([]),
  activeLineN: null,
});
export const page = () => app.pages[app.pageIndex] ?? NO_PAGE;
export const byId = (id) => page().boxes.find((b) => b.id === id);
// English text for a line. Back-compat: fall back to legacy natural/stylised/text
// fields so projects saved under the old schema still render.
export const lineText = (ln) => {
  if (!ln) return '';
  return ln.en ?? ln.natural ?? ln.stylised ?? ln.text ?? '';
};
// Resolve a box's display text. Line-backed boxes (text == null) look up their
// line on `p` — defaulting to the current page, but callers rendering another
// page (e.g. export-all) must pass that page so glyphs resolve correctly.
export const boxText = (b, p = page()) => {
  if (b.text != null) return b.text;
  return lineText(lineByN(p ?? page(), b.lineN));
};
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// Deep copy of a style object (handles nested shadow/roughen), safe for reactive proxies.
export function cloneStyle(s) {
  return normalizeStyle($state.snapshot(s));
}

// Remember the active box's style so the next placed box inherits it.
export function rememberStyle(box) {
  const b = box ?? (app.selectedId ? byId(app.selectedId) : null);
  if (b?.style) app.lastStyle = cloneStyle(b.style);
}

// ---------- export prefs persistence ----------
try {
  const saved = JSON.parse(localStorage.getItem('mt.export') || '{}');
  if (saved.dir) app.exportDir = saved.dir;
  if (saved.name) app.exportName = saved.name;
} catch {
  /* ignore */
}
export function saveExportPrefs(dir, name) {
  if (dir != null) app.exportDir = dir;
  if (name != null) app.exportName = name;
  try {
    localStorage.setItem('mt.export', JSON.stringify({ dir: app.exportDir, name: app.exportName }));
  } catch {
    /* ignore */
  }
}

// ---------- reference sidebar persistence ----------
// The rail drags the sidebar between these two widths; a value off disk gets
// the same clamp, so a hand-edited or stale entry can never wedge the sidebar
// at a width the rail itself would refuse to produce.
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 460;
export const clampSidebarWidth = (w) => clamp(w, SIDEBAR_MIN, SIDEBAR_MAX);
// What comes back out of storage is parsed and vetted here rather than inline
// below, because the read itself runs once at module load in an environment the
// tests do not have — split out, the part that can actually be wrong is the
// part that can be tested. Anything the rail could not have written is dropped
// rather than coerced: a width that is not a number, a `hidden` that is not a
// boolean, a blob that is not an object at all. Absent keys stay absent so the
// caller can tell "not stored" from "stored as the default".
export function sidebarFromJSON(raw) {
  let saved;
  try {
    saved = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (!saved || typeof saved !== 'object') return {};
  const out = {};
  if (Number.isFinite(saved.width)) out.width = clampSidebarWidth(saved.width);
  if (typeof saved.hidden === 'boolean') out.hidden = saved.hidden;
  return out;
}
// Same defensive shape as the export prefs above: read once at module load,
// written back through one function, every failure swallowed. Storage is
// absent entirely in the node test environment, and a corrupt entry must cost
// the user their sidebar width, not the editor.
try {
  const { width, hidden } = sidebarFromJSON(localStorage.getItem('mt.sidebar'));
  if (width != null) app.leftWidth = width;
  if (hidden != null) app.sidebarHidden = hidden;
} catch {
  /* ignore */
}
export function saveSidebar() {
  try {
    localStorage.setItem(
      'mt.sidebar',
      JSON.stringify({ width: app.leftWidth, hidden: app.sidebarHidden }),
    );
  } catch {
    /* ignore */
  }
}

// ---------- save indicator + autosave ----------
// The saver is registered by library.svelte.js rather than imported, so the
// store stays unaware of the filesystem and the two modules do not cycle.
let saver = null;
let saveT;
export function setSaver(fn) {
  saver = fn;
}
export function markUnsaved() {
  app.saved = false;
  if (!saver || !app.chapterRef) return;
  clearTimeout(saveT);
  // There is no manual save in this app, so a rejected autosave is the user's
  // only signal that their work is not reaching the disk. Never swallow it.
  saveT = setTimeout(() => {
    Promise.resolve()
      .then(saver)
      .catch((e) => {
        // A toast lasts two seconds; the work being off-disk lasts until a write
        // lands. The indicator carries the second half of that, so the user can
        // still find out why an hour later.
        app.saveFailed = true;
        toast(`Could not save — ${e?.message ?? e}`);
      });
  }, 800);
}
export function markSaved() {
  app.saved = true;
}
export function flushSave() {
  clearTimeout(saveT);
  // Every non-debounce save comes through here — leaving the editor, quitting,
  // opening another chapter — and this is the path most likely to be the one
  // that fails, because it is the one that runs when the user is on their way
  // out. It also cancels the debounce, so a rejection here leaves nothing
  // scheduled to raise the indicator later: without this catch the pill would
  // sit on its neutral dot promising a save that no longer exists. The error is
  // rethrown untouched — flushBeforeLeaving still decides whether the user may
  // go, and says why.
  return saver && app.chapterRef
    ? saver().catch((e) => {
        app.saveFailed = true;
        throw e;
      })
    : Promise.resolve();
}

// ---------- edit recorder (undo/redo) ----------
// The store stays unaware of the history the same way it stays unaware of the
// filesystem: the history module registers itself, and a build with no history
// records nothing and behaves exactly as before.
let recorder = null;
export function setRecorder(fn) {
  recorder = fn;
}
export function recordEdit(entry) {
  if (recorder) recorder(entry);
}
// Registered the same way, for the same reason: only the page on screen keeps
// its undo stack in memory, so something has to hear about a page turn and swap
// it for the one on disk. The store must not be the module that knows that,
// hence a hook rather than an import.
let pageSwitchHook = null;
export function setPageSwitchHook(fn) {
  pageSwitchHook = fn;
}
// And a third, for the edit that is still being made when something else
// happens. A panel that coalesces a run of changes into one entry — the
// Inspector's settle timer — always leaves a window in which an edit has been
// applied to the document and not yet recorded. `recordEdit` has no page
// awareness of its own: it pushes onto whichever stack is live at the moment it
// is called. So everything that would make a late entry land somewhere it does
// not belong — a page turn, an undo, the start of a drag — closes that window
// through here first.
let editSettleHook = null;
export function setEditSettleHook(fn) {
  editSettleHook = fn;
}
export function settleEdits() {
  editSettleHook?.();
}
// The history addresses pages by id, not by index: an entry may outlive the
// page being the one on screen.
export const pageById = (id) => app.pages.find((p) => p.id === id) ?? null;

// A free-typed box is not history until the gesture that made it is over.
// Creating it and dropping it again empty are halves of one gesture, and
// recording them separately would cost two undo presses, the first of which
// brings back an empty box the user never wanted. So `addEmptyBox` only leaves
// the box pending, and whoever ends the edit settles it: one `place` record if
// the box survived, nothing at all if it did not.
let pendingPlace = null;
// What the box being edited read when the edit began. Held here rather than in
// the component that opened the edit, because that component is frequently not
// the one that ends it — see `settleText` — and one entry per edit session is
// only possible while somebody still remembers the text it started from.
let editBefore = undefined;
// Exported for the paths that put the whole document away: there is nothing
// left to record against, so the gesture is dropped rather than settled.
export const clearPending = () => {
  pendingPlace = null;
  editBefore = undefined;
};
// Every path that ends an edit calls this — not just `endEdit`. `deselect` and
// `selectBox` null `editingId` on pointerdown, before the browser fires blur on
// the contenteditable, so the blur's `endEdit` finds nothing to end and returns
// early. Settling only there would leave the box pending for good, and the next
// `deleteBox` would mistake a real box full of real text for a gesture that
// never happened and record nothing — undo silently losing the user's work.
function settlePending() {
  const pend = pendingPlace;
  if (!pend) return;
  pendingPlace = null;
  const p = pageById(pend.pageId);
  // The index is read now rather than remembered from creation time: boxes may
  // have come and gone while the user was typing.
  const index = p ? p.boxes.findIndex((x) => x.id === pend.id) : -1;
  if (index === -1) return; // already gone — the gesture left nothing to undo
  // No queue fields: a free-typed box never touched `activeLineN`, and claiming
  // it did would make this undo rewind a queue move belonging to another edit.
  recordEdit({ t: 'place', pageId: p.id, index, box: $state.snapshot(p.boxes[index]) });
}

// The text half of ending an edit, and it has to live beside `settlePending`
// for exactly the same reason: the contenteditable writes `box.text` on every
// keystroke, so by the time anything ends the edit the document is already
// current — what is missing is the one record that stands for the whole
// session. And the blur that would carry it arrives after `deselect` or
// `selectBox` has already nulled `editingId`, so `endEdit` finds nothing to end
// and returns early. Left to the blur alone, every edit finished by clicking
// somewhere else would be applied and never recorded, and the next undo would
// rewind an edit the user did not just make.
//
// A box whose placement is still pending is left alone: `settlePending` records
// that gesture as one `place` carrying the typed text, and a `text` record
// beside it would be the same edit counted twice.
function settleText() {
  const before = editBefore;
  editBefore = undefined;
  const id = app.editingId;
  if (id == null || before === undefined) return;
  if (pendingPlace?.id === id) return;
  const b = byId(id);
  if (!b || b.text === before) return;
  recordEdit({ t: 'text', pageId: page().id, boxId: id, before: before ?? null, after: b.text });
}

// ---------- toast ----------
let toastT;
export function toast(msg) {
  app.toast = { msg, seq: app.toast.seq + 1 };
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    app.toast = { msg: '', seq: app.toast.seq + 1 };
  }, 2200);
}

// ---------- page nav ----------
export function gotoPage(i) {
  if (i < 0 || i > app.pages.length - 1) return;
  // Before the index moves, and it has to be: an entry still inside its settle
  // window belongs to the page being left, and the stack that is live is the
  // only place it can be pushed. A step later and it would land on the page
  // being arrived at, where the next write would file that page's entries under
  // this one's key.
  settleEdits();
  const from = page().id;
  app.pageIndex = i;
  app.selectedId = null;
  // A box left mid-edit on the page behind us is no longer a gesture in
  // progress; leaving it pending would suppress the record of its own deletion.
  clearPending();
  const p = page();
  if (p.activeLineN == null) p.activeLineN = firstUnplaced(p);
  // Only when the page actually changed. A re-entry onto the page already on
  // screen would otherwise hand the live stack over and take it straight back,
  // scheduling a write of a document nothing has changed.
  if (pageSwitchHook && from !== p.id) pageSwitchHook(from, p.id);
}
export const nextPage = () => gotoPage(app.pageIndex + 1);
export const prevPage = () => gotoPage(app.pageIndex - 1);

// ---------- selection ----------
export function selectBox(id) {
  // Text first: it is the half that has to see `pendingPlace` still standing.
  if (app.editingId && app.editingId !== id) {
    settleText();
    settlePending();
  }
  app.selectedId = id;
  if (app.editingId && app.editingId !== id) app.editingId = null;
}
export function deselect() {
  if (app.editingId) {
    settleText();
    settlePending();
  }
  app.selectedId = null;
  app.editingId = null;
}

// ---------- inline editing ----------
export function beginEdit(id) {
  // Re-entrant: the box carries the double-click that opens the edit, and the
  // contenteditable inside it has no handler of its own, so double-clicking a
  // word to select it lands here again on the box already being edited. Taking
  // the before-text again would move it forward to whatever has been typed
  // since, and the undo would then only rewind as far as the last double-click.
  const already = app.editingId === id;
  selectBox(id);
  app.editingId = id;
  // Remembered here, at the one moment it is still true, so whoever ends the
  // edit records one entry for the session rather than one per keystroke.
  if (!already) editBefore = byId(id)?.text ?? null;
}
// `beforeText` is what the box read when the edit began. It is optional — left
// off, what `beginEdit` remembered is used, which is what every caller in the
// app relies on; an explicit one is for a caller that knows better.
export function endEdit(commitText, beforeText) {
  const id = app.editingId;
  const before = beforeText !== undefined ? beforeText : editBefore;
  app.editingId = null;
  if (id == null) return;
  // Below the early return on purpose: a blur that arrives after something else
  // has already ended the edit must not clear the before-text of an edit that
  // has since begun. Whoever ended it took this with them.
  editBefore = undefined;
  const b = byId(id);
  if (!b) return;
  if (commitText != null) {
    b.text = commitText;
    markUnsaved();
  }
  // drop an empty placeholder box the user never typed into
  if (b.text != null && b.text.trim() === '' && b.lineN == null) {
    deleteBox(id);
    return;
  }
  // The box survived, so the gesture that created it is now worth one record —
  // with the text the user actually typed, not the empty string it was born
  // with. Its own `text` record would be the same gesture counted twice.
  if (pendingPlace?.id === id) {
    settlePending();
    return;
  }
  if (before !== undefined && commitText != null && commitText !== before) {
    recordEdit({
      t: 'text',
      pageId: page().id,
      boxId: id,
      before: before ?? null,
      after: commitText,
    });
  }
}

// ---------- page dimensions (set from a loaded image's natural size) ----------
export function setPageDims(w, h) {
  const p = page();
  if (w > 0 && h > 0 && (p.w !== w || p.h !== h)) {
    p.w = w;
    p.h = h;
  }
}

// ---------- tool mode ----------
export function setTool(t) {
  app.tool = t;
}

// ---------- apply sidecar detection result to the current page ----------
// result = { img_width, img_height, panels, lines:[{n,type,jp,en,box,vertical,font_size}] }
export function applyDetection(result, target = null) {
  const p = target ?? page();
  if (result.img_width && result.img_height) {
    p.w = result.img_width;
    p.h = result.img_height;
  }
  p.lines = result.lines.map((l) => ({ n: l.n, type: l.type, jp: l.jp ?? '', en: '' }));
  // Detection geometry kept separately — drives box auto-placement and the
  // detected-text JSON export.
  p.detect = {
    panels: result.panels ?? [],
    boxes: result.lines.map((l) => ({
      n: l.n,
      box: l.box,
      vertical: l.vertical,
      font_size: l.font_size,
    })),
  };
  p.boxes = [];
  p.activeLineN = firstUnplaced(p);
  app.loaded = true;
  markUnsaved();
}

// ---------- placement ----------
export function placeActiveAt(imgX, imgY) {
  const p = page();
  if (p.activeLineN == null) return;
  const ln = lineByN(p, p.activeLineN);
  if (!ln) return;
  // The queue advances as part of this edit, so the record carries both sides
  // of it — undoing the box without rewinding the queue would leave the two
  // disagreeing about what still needs placing.
  const activeBefore = p.activeLineN;
  const w = 220,
    h = 92;
  const b = {
    id: 'b' + boxSeq++,
    lineN: ln.n,
    text: null,
    x: clamp(imgX - w / 2, 0, p.w - w),
    y: clamp(imgY - h / 2, 0, p.h - h),
    w,
    h,
    style: cloneStyle(app.lastStyle),
  };
  p.boxes.push(b);
  p.activeLineN = firstUnplaced(p);
  recordEdit({
    t: 'place',
    pageId: p.id,
    index: p.boxes.length - 1,
    box: $state.snapshot(b),
    activeBefore,
    activeAfter: p.activeLineN,
  });
  markUnsaved();
  selectBox(b.id);
  toast(
    `Placed line ${ln.n} → next: ${p.activeLineN ? 'line ' + p.activeLineN : 'all placed'}`,
  );
}

// ---------- empty text box (free-typed) ----------
export function addEmptyBox(imgX, imgY) {
  if (!app.pages.length) return null; // no chapter open: never write into the stand-in page
  const p = page();
  const w = 200,
    h = 70;
  const b = {
    id: 'b' + boxSeq++,
    lineN: null,
    text: '',
    x: clamp(imgX - w / 2, 0, Math.max(0, p.w - w)),
    y: clamp(imgY - h / 2, 0, Math.max(0, p.h - h)),
    w,
    h,
    style: cloneStyle(app.lastStyle),
  };
  p.boxes.push(b);
  markUnsaved();
  // `beginEdit` selects, which settles whatever gesture was in progress before
  // this one. Only then is this box the pending one.
  beginEdit(b.id);
  pendingPlace = { id: b.id, pageId: p.id };
  return b.id;
}

// ---------- delete ----------
export function deleteBox(id) {
  const p = page();
  const b = byId(id);
  if (!b) return;
  // All three taken before the removal: the undo has to put the box back where
  // it was in the stacking order, not on the end, and take its line back out of
  // the queue.
  const index = p.boxes.findIndex((x) => x.id === id);
  const snap = $state.snapshot(b);
  const activeBefore = p.activeLineN;
  p.boxes = p.boxes.filter((x) => x.id !== id);
  // only queued (line-backed) boxes return to the queue; free-typed boxes (lineN=null) don't
  if (b.lineN != null && !isPlaced(p, b.lineN)) p.activeLineN = b.lineN;
  // A box that was never recorded as placed is never recorded as deleted: this
  // is the half of the empty-placeholder gesture that undoes the other half.
  if (pendingPlace?.id === id) clearPending();
  else {
    recordEdit({
      t: 'delete',
      pageId: p.id,
      index,
      box: snap,
      activeBefore,
      activeAfter: p.activeLineN,
    });
  }
  app.selectedId = null;
  markUnsaved();
  toast(b.lineN != null ? `Deleted box · line ${b.lineN} back to queue` : 'Deleted text box');
}

// ---------- bulk style mode ----------
// Opened by double-clicking the Text tool. User tweaks one style, clicks the
// boxes to apply it to, then hits Apply.
export function openBulk() {
  // Bulk mode ends any inline edit, and the box being typed into stays on the
  // page — so the gesture that created it is settled and recorded, not dropped.
  if (app.editingId) {
    settleText();
    settlePending();
  }
  const seed = app.selectedId ? byId(app.selectedId)?.style : null;
  app.bulk = {
    active: true,
    targets: [],
    style: cloneStyle(seed ?? app.lastStyle),
  };
  app.editingId = null;
}
export function closeBulk() {
  app.bulk = { active: false, targets: [], style: null };
}
export const isBulkTarget = (id) => app.bulk.active && app.bulk.targets.includes(id);
export function toggleBulkTarget(id) {
  if (!app.bulk.active) return;
  const i = app.bulk.targets.indexOf(id);
  if (i === -1) app.bulk.targets = [...app.bulk.targets, id];
  else app.bulk.targets = app.bulk.targets.filter((x) => x !== id);
}
export function applyBulk() {
  if (!app.bulk.active || !app.bulk.style) return;
  const p = page();
  let n = 0;
  // One record for the whole apply, so undoing it is one press rather than one
  // per box.
  const items = [];
  for (const id of app.bulk.targets) {
    const b = p.boxes.find((x) => x.id === id);
    if (b) {
      items.push({ boxId: id, before: cloneStyle(b.style), after: cloneStyle(app.bulk.style) });
      b.style = cloneStyle(app.bulk.style);
      n++;
    }
  }
  if (items.length) recordEdit({ t: 'bulk', pageId: p.id, items });
  app.lastStyle = cloneStyle(app.bulk.style);
  markUnsaved();
  const count = n;
  closeBulk();
  toast(count ? `Applied style to ${count} box${count > 1 ? 'es' : ''}` : 'No boxes selected');
}

// ---------- queue row click ----------
export function activateLine(n) {
  const p = page();
  p.activeLineN = n;
  const b = p.boxes.find((x) => x.lineN === n);
  if (b) selectBox(b.id);
  else deselect();
}

// ---------- zoom ----------
export function setZoom(z, isFit = false) {
  app.zoom = clamp(z, 0.1, 4);
  app.isFit = isFit;
}
export function applyFit(z) {
  app.fitZoom = z;
  setZoom(z, true);
}
export const zoomIn = () => setZoom(app.zoom * 1.2);
export const zoomOut = () => setZoom(app.zoom / 1.2);
export const zoomReset = () => setZoom(1);

// ---------- raw zoom ----------
export function rawZoomIn() {
  app.rawZoom = (app.rawZoom === 0 ? 1 : app.rawZoom) * 1.25;
}
export function rawZoomOut() {
  app.rawZoom = (app.rawZoom === 0 ? 1 : app.rawZoom) / 1.25;
  if (app.rawZoom < 0.3) app.rawZoom = 0;
}

// ---------- fonts ----------
export function fontCssFor(name) {
  const f = [...app.fonts.builtin, ...app.fonts.user].find((x) => x.name === name);
  return f ? f.css : "'Comic Neue', cursive";
}
