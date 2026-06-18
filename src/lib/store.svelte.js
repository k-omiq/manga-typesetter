// ===== Central reactive store (Svelte 5 runes) =====
import {
  PAGES,
  PAGE_W,
  PAGE_H,
  BUILTIN_FONTS,
  USER_FONTS,
  defaultStyle,
  normalizeStyle,
} from './data.js';

export { PAGE_W, PAGE_H };

let boxSeq = 1;

function clonePage(p) {
  const cloned = {
    id: p.id,
    raw: p.raw,
    cleaned: p.cleaned,
    w: p.w ?? PAGE_W,
    h: p.h ?? PAGE_H,
    lines: p.lines.map((l) => ({ ...l })),
    // Clean-mode state: each detected text becomes its own editable patch layer.
    // composite = raw + ordered visible patches. Populated by the clean pipeline.
    clean: p.clean
      ? {
          base: p.clean.base ?? null,
          maskPng: p.clean.maskPng ?? null,
          status: { ...(p.clean.status ?? {}) },
          layers: p.clean.layers.map((l) => ({ ...l })),
        }
      : { base: null, maskPng: null, status: {}, layers: [] },
    // Detection geometry (drives the cleaning queue + box auto-placement).
    detect: p.detect
      ? { panels: (p.detect.panels ?? []).slice(), boxes: p.detect.boxes.map((b) => ({ ...b })) }
      : null,
    boxes: p.boxes.map((b) => ({
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
  cloned.activeLineN = firstUnplaced(cloned);
  return cloned;
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
  pages: PAGES.map(clonePage),
  selectedId: null,
  editingId: null, // box currently in inline-edit mode
  tool: 'place', // 'place' | 'text'
  mode: 'translate', // 'clean' | 'translate' — only the right panel changes between modes
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
  cleaning: false, // a /clean request is in flight
  selectedLayerId: null, // active clean patch layer
  flux: { available: false, reason: null, checking: false, downloading: false }, // opt-in inpaint
  // BYOK LLM translation (reuses MangaTranslator's provider set). Keys are kept
  // locally (localStorage) for convenience; never leave the machine except in
  // the loopback request the Rust side proxies to the sidecar.
  translate: {
    provider: 'Anthropic',
    model: '',
    outputLanguage: 'English',
    baseUrl: '', // OpenAI-Compatible only
    special: '', // special instructions / glossary
    apiKeys: {}, // { [provider]: key }
    providers: [], // catalogue from the sidecar
    translating: false,
  },
});

// ---------- derived helpers ----------
export const page = () => app.pages[app.pageIndex];
export const byId = (id) => page().boxes.find((b) => b.id === id);
// English text for a line. Back-compat: fall back to legacy natural/stylised/text
// fields so projects saved under the old schema still render.
export const lineText = (ln) => {
  if (!ln) return '';
  return ln.en ?? ln.natural ?? ln.stylised ?? ln.text ?? '';
};
export const boxText = (b) => {
  if (b.text != null) return b.text;
  return lineText(lineByN(page(), b.lineN));
};
export function setMode(m) {
  app.mode = m === 'clean' ? 'clean' : 'translate';
}

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
try {
  const t = JSON.parse(localStorage.getItem('mt.translate') || '{}');
  Object.assign(app.translate, {
    provider: t.provider ?? app.translate.provider,
    model: t.model ?? app.translate.model,
    outputLanguage: t.outputLanguage ?? app.translate.outputLanguage,
    baseUrl: t.baseUrl ?? app.translate.baseUrl,
    special: t.special ?? app.translate.special,
    apiKeys: t.apiKeys ?? app.translate.apiKeys,
  });
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

// ---------- save indicator ----------
export function markUnsaved() {
  app.saved = false;
}
export function markSaved() {
  app.saved = true;
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
  app.selectedLayerId = null; // layer ids are per-page; don't leak selection across pages
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
// result = { img_width, img_height, lines:[{n,type,jp,en,box,vertical,font_size}], mask_png }
export function applyDetection(result) {
  const p = page();
  if (result.img_width && result.img_height) {
    p.w = result.img_width;
    p.h = result.img_height;
  }
  p.lines = result.lines.map((l) => ({ n: l.n, type: l.type, jp: l.jp ?? '', en: '' }));
  // Detection geometry kept separately — drives cleaning (Phase 2/3) and box auto-placement.
  p.detect = {
    panels: result.panels ?? [],
    boxes: result.lines.map((l) => ({
      n: l.n,
      box: l.box,
      vertical: l.vertical,
      font_size: l.font_size,
    })),
  };
  if (result.mask_png) p.clean.maskPng = result.mask_png;
  p.boxes = [];
  p.activeLineN = firstUnplaced(p);
  app.loaded = true;
  markUnsaved();
}

// ---------- clean-mode patch layers ----------
// Each detected text becomes its own editable patch (cleaned bbox pixels). The
// composite clean page = raw + ordered visible patches (NOT a flat image), so
// any single region can be re-cleaned, hidden, or deleted without re-running
// the whole page. Populated from the sidecar /clean result.
let layerSeq = 1;

export const cleanStatus = (n) => page().clean?.status?.[n] ?? 'pending';

export function setCleanStatus(n, s) {
  const p = page();
  if (!p.clean) p.clean = { base: null, layers: [] };
  p.clean.status = { ...(p.clean.status ?? {}), [n]: s };
}

// Merge cleaned layers from a /clean result. replace=true swaps the whole set;
// replace=false updates only the regions present in the result (single-region redo).
export function applyClean(result, { replace = true, target = null } = {}) {
  const p = target ?? page();
  if (!p.clean) p.clean = { base: null, layers: [] };
  p.clean.base = p.raw ?? p.clean.base;
  const incoming = (result.layers ?? []).map((L) => ({
    id: 'L' + layerSeq++,
    n: L.n,
    box: L.box, // [x, y, w, h] in image coords
    method: L.method,
    requested: L.requested,
    fellBack: !!L.fell_back,
    uniform: !!L.uniform,
    ringStd: L.ring_std,
    patchPng: L.patch_png, // base64 PNG of the cleaned bbox
    visible: true,
  }));
  if (replace) {
    p.clean.layers = incoming;
  } else {
    const byN = new Map(incoming.map((l) => [l.n, l]));
    p.clean.layers = p.clean.layers.map((l) => byN.get(l.n) ?? l);
    for (const l of incoming) if (!p.clean.layers.some((x) => x.n === l.n)) p.clean.layers.push(l);
  }
  // Mark status on the target page directly (not page(), which may have changed
  // if the user navigated while the request was in flight).
  const st = { ...(p.clean.status ?? {}) };
  for (const l of incoming) st[l.n] = 'done';
  p.clean.status = st;
  markUnsaved();
}

export function toggleLayer(id) {
  const l = page().clean?.layers.find((x) => x.id === id);
  if (l) {
    l.visible = !l.visible;
    markUnsaved();
  }
}
export function selectCleanLayer(id) {
  app.selectedLayerId = app.selectedLayerId === id ? null : id;
}
export function deleteLayer(id) {
  const p = page();
  const l = p.clean?.layers.find((x) => x.id === id);
  if (!l) return;
  p.clean.layers = p.clean.layers.filter((x) => x.id !== id);
  setCleanStatus(l.n, 'pending');
  if (app.selectedLayerId === id) app.selectedLayerId = null;
  markUnsaved();
  toast(`Deleted clean layer · line ${l.n} back to queue`);
}
export const layerByLine = (n) => page().clean?.layers.find((x) => x.n === n) ?? null;
export const patchSrc = (layer) => (layer?.patchPng ? 'data:image/png;base64,' + layer.patchPng : null);

// ---------- translation ----------
// Apply a /translate result ({ lines:[{n,en}] }) onto the current page's lines.
export function applyTranslation(result, target = null) {
  const p = target ?? page();
  const byN = new Map((result.lines ?? []).map((l) => [l.n, l.en]));
  for (const ln of p.lines) {
    if (byN.has(ln.n) && byN.get(ln.n) != null) ln.en = byN.get(ln.n);
  }
  markUnsaved();
}

export function setTranslateProvider(provider) {
  app.translate.provider = provider;
  // Prefill the model field with the provider's suggested default when empty.
  const meta = app.translate.providers.find((x) => x.id === provider);
  if (meta && (!app.translate.model || app.translate.model === '')) {
    app.translate.model = meta.default_model ?? '';
  }
  saveTranslatePrefs();
}

export function saveTranslatePrefs() {
  const t = app.translate;
  try {
    localStorage.setItem(
      'mt.translate',
      JSON.stringify({
        provider: t.provider,
        model: t.model,
        outputLanguage: t.outputLanguage,
        baseUrl: t.baseUrl,
        special: t.special,
        apiKeys: t.apiKeys,
      }),
    );
  } catch {
    /* ignore */
  }
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
