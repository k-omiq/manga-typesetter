// Real import: tolerant JSON parsing → pages, and image files → pages by order.
import { app, toast, PAGE_W, PAGE_H, firstUnplaced } from './store.svelte.js';

let pageSeq = 1000;

function naturalSort(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// Normalize one line object/string → { n, jp, en, type }
// Back-compat: a bare string or a `{ text }`-only object becomes `en`; legacy
// `natural`/`stylised` collapse to a single `en` (natural preferred).
// jp defaults to '', type to 'dialogue'.
const TYPES = ['dialogue', 'sfx', 'narration'];
function normLine(item, idx) {
  if (typeof item === 'string') {
    return { n: idx + 1, jp: '', en: item, type: 'dialogue' };
  }
  const n = item.n ?? item.id ?? item.number ?? item.index ?? idx + 1;
  const legacy = item.text ?? item.content ?? item.tl ?? item.translation ?? item.t;
  const en = item.en ?? item.natural ?? item.stylised ?? item.stylized ?? legacy ?? '';
  const jp = item.jp ?? item.japanese ?? item.original ?? item.raw ?? '';
  const type = item.type ?? item.kind ?? 'dialogue';
  return {
    n: Number(n) || idx + 1,
    jp: String(jp),
    en: String(en),
    type: TYPES.includes(type) ? type : 'dialogue',
  };
}

// Normalize one page object → { lines: [...] }
function normPage(obj) {
  const arr = obj.texts ?? obj.lines ?? obj.text_lines ?? obj.items ?? obj.translations ?? [];
  const lines = (Array.isArray(arr) ? arr : []).map(normLine).sort((a, b) => a.n - b.n);
  return { lines };
}

// Accept: [pages], {pages:[...]}, single {page,texts}, or bare [lines]/{texts}
function normalizeJson(data) {
  let rawPages;
  if (Array.isArray(data)) {
    // could be array of pages or array of lines
    if (data.length && (data[0].texts || data[0].lines || data[0].page != null)) rawPages = data;
    else rawPages = [{ texts: data }];
  } else if (data.pages) {
    rawPages = data.pages;
  } else if (data.texts || data.lines) {
    rawPages = [data];
  } else {
    rawPages = [{ texts: [] }];
  }
  return rawPages.map(normPage);
}

function blankPage(lines, prev) {
  const p = {
    id: prev?.id ?? pageSeq++,
    raw: prev?.raw ?? null,
    cleaned: prev?.cleaned ?? null,
    w: prev?.w ?? PAGE_W,
    h: prev?.h ?? PAGE_H,
    lines,
    // Preserve placed boxes across a JSON re-import so re-importing a lines file
    // (e.g. updated translations) doesn't discard existing typesetting.
    boxes: (prev?.boxes ?? []).map((b) => ({ ...b, style: { ...b.style } })),
    detect: prev?.detect ?? null,
    activeLineN: null,
  };
  p.activeLineN = firstUnplaced(p);
  return p;
}

export async function importJsonFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('Invalid JSON — could not parse');
    return;
  }
  const parsed = normalizeJson(data);
  const old = app.pages;
  app.pages = parsed.map((pp, i) => blankPage(pp.lines, old[i]));
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  app.loaded = true;
  const total = parsed.reduce((s, p) => s + p.lines.length, 0);
  toast(`Imported ${parsed.length} page(s), ${total} line(s)`);
}

// Transient file picker (runs inside a user gesture, so .click() is allowed).
// Browser-only fallback: in the packaged Tauri app WKWebView's runOpenPanel
// silently fails for a detached input, so Tauri uses the dialog plugin below.
function pick(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files);
    input.click();
  });
}

// Tauri injects __TAURI_INTERNALS__; absent in the browser (same check as sidecar.js).
export function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  json: 'application/json',
};

function basename(path) {
  return String(path).split('/').pop().split('\\').pop();
}

function mimeFromExt(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Native file dialog (Tauri): open() → absolute paths → readFile → File objects,
// so the shared import pipeline (which works on File/Blob) stays unchanged.
// Dynamic imports keep the Tauri plugins out of the browser bundle path.
export async function pickFilesTauri({ name, extensions, multiple }) {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple, filters: [{ name, extensions }] });
  if (!selected) return null; // cancelled
  const paths = Array.isArray(selected) ? selected : [selected];
  if (!paths.length) return null;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const files = [];
  for (const path of paths) {
    const fname = basename(path);
    try {
      const bytes = await readFile(path);
      files.push(new File([bytes], fname, { type: mimeFromExt(fname) }));
    } catch (e) {
      toast(`Could not read ${fname}: ${e?.message || e}`);
    }
  }
  return files.length ? files : null;
}

export async function pickJson() {
  if (isTauri()) {
    const files = await pickFilesTauri({ name: 'JSON', extensions: ['json'], multiple: false });
    if (files && files[0]) await importJsonFile(files[0]);
    return;
  }
  const f = await pick('.json,application/json', false);
  if (f && f[0]) await importJsonFile(f[0]);
}

export async function pickImages(kind) {
  if (isTauri()) {
    const files = await pickFilesTauri({
      name: 'Images',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
      multiple: true,
    });
    if (files && files.length) await importImageFiles(files, kind);
    return;
  }
  const f = await pick('image/*', true);
  if (f && f.length) await importImageFiles(f, kind);
}

export async function importImageFiles(files, kind) {
  const list = [...files].sort(naturalSort);
  if (!list.length) return;
  // ensure enough pages
  while (app.pages.length < list.length) {
    app.pages.push(blankPage([], null));
  }
  list.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    // Revoke the blob URL we're replacing so re-importing doesn't orphan it.
    const prev = kind === 'cleaned' ? app.pages[i].cleaned : app.pages[i].raw;
    if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    if (kind === 'cleaned') app.pages[i].cleaned = url;
    else app.pages[i].raw = url;
  });
  // Either kind counts as "loaded" so the starter overlay dismisses instead of
  // covering the page you just imported.
  app.loaded = true;
  toast(`Imported ${list.length} ${kind} page(s)`);
}
