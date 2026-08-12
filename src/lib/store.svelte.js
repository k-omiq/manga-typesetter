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

// Replace all pages from an imported project (e.g. a lossless PSD). Assigns
// fresh box ids from the store's own sequence (so nothing collides with
// existing state) and normalizes styles up to the current schema.
// Object URLs (raw/cleaned) are passed through as-is — the caller regenerates
// them from the source.
export function loadProjectPages(rawPages) {
  app.pages = rawPages.map((p) => {
    const cp = {
      id: p.id ?? pageLoadSeq++,
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
      boxes: (p.boxes ?? []).map((b) => ({
        id: 'b' + boxSeq++,
        lineN: b.lineN,
        text: b.text ?? null,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        style: normalizeStyle(b.style),
      })),
      activeLineN: null,
    };
    cp.activeLineN = firstUnplaced(cp);
    return cp;
  });
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  app.loaded = true;
  markUnsaved();
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
  exporting: false,
  collapsed: { queue: false, inspector: false },
  leftWidth: 280,
  rightWidth: 312,
  cursor: { x: '—', y: '—' },
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
      .catch((e) => toast(`Could not save — ${e?.message ?? e}`));
  }, 800);
}
export function markSaved() {
  app.saved = true;
}
export function flushSave() {
  clearTimeout(saveT);
  return saver && app.chapterRef ? saver() : Promise.resolve();
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
  app.pageIndex = i;
  app.selectedId = null;
  const p = page();
  if (p.activeLineN == null) p.activeLineN = firstUnplaced(p);
}
export const nextPage = () => gotoPage(app.pageIndex + 1);
export const prevPage = () => gotoPage(app.pageIndex - 1);

// ---------- selection ----------
export function selectBox(id) {
  app.selectedId = id;
  if (app.editingId && app.editingId !== id) app.editingId = null;
  app.collapsed.inspector = false;
}
export function deselect() {
  app.selectedId = null;
  app.editingId = null;
}

// ---------- inline editing ----------
export function beginEdit(id) {
  selectBox(id);
  app.editingId = id;
}
export function endEdit(commitText) {
  const id = app.editingId;
  app.editingId = null;
  if (id == null) return;
  const b = byId(id);
  if (!b) return;
  if (commitText != null) {
    b.text = commitText;
    markUnsaved();
  }
  // drop an empty placeholder box the user never typed into
  if (b.text != null && b.text.trim() === '' && b.lineN == null) {
    deleteBox(id);
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
  beginEdit(b.id);
  return b.id;
}

// ---------- delete ----------
export function deleteBox(id) {
  const p = page();
  const b = byId(id);
  if (!b) return;
  p.boxes = p.boxes.filter((x) => x.id !== id);
  // only queued (line-backed) boxes return to the queue; free-typed boxes (lineN=null) don't
  if (b.lineN != null && !isPlaced(p, b.lineN)) p.activeLineN = b.lineN;
  app.selectedId = null;
  markUnsaved();
  toast(b.lineN != null ? `Deleted box · line ${b.lineN} back to queue` : 'Deleted text box');
}

// ---------- bulk style mode ----------
// Opened by double-clicking the Text tool. User tweaks one style, clicks the
// boxes to apply it to, then hits Apply.
export function openBulk() {
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
  for (const id of app.bulk.targets) {
    const b = p.boxes.find((x) => x.id === id);
    if (b) {
      b.style = cloneStyle(app.bulk.style);
      n++;
    }
  }
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
