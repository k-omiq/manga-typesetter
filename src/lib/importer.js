// Source material coming in from outside the library: the native file picker,
// and the tolerant normalisation of a translations JSON.
//
// Nothing here touches the open document — it does not import the store at all.
// Imports belong to the home screen: a chapter's pages come from the library,
// and the editor is for typesetting.

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
export function normalizeTranslations(data) {
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

// A picked .json → one entry per page it describes. Throws on unparseable
// input so the caller can say so where the file was chosen, rather than
// leaving the user with a picker that appears to have done nothing.
export async function readTranslations(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    throw new Error(`Invalid JSON — could not parse ${file.name}`);
  }
  return normalizeTranslations(data);
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
  const unreadable = [];
  for (const path of paths) {
    const fname = basename(path);
    try {
      const bytes = await readFile(path);
      files.push(new File([bytes], fname, { type: mimeFromExt(fname) }));
    } catch (e) {
      unreadable.push(`${fname} (${e?.message || e})`);
    }
  }
  // Everything downstream of this pairs the list with pages BY POSITION. A list
  // that quietly skipped file 5 of 20 is not 19 good files — it is 15 pages
  // about to be given the wrong image, under a summary that reports the loss as
  // one missing page at the end. So a partial read is a failure, not a result.
  if (unreadable.length) {
    throw new Error(`Could not read ${unreadable.length} of ${paths.length}: ${unreadable.join(', ')}`);
  }
  return files.length ? files : null;
}

// The image extensions every picker in the app offers.
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];

export function pickImageFiles(multiple = true) {
  return pickFilesTauri({ name: 'Images', extensions: IMAGE_EXTENSIONS, multiple });
}

export function pickJsonFile() {
  return pickFilesTauri({ name: 'JSON', extensions: ['json'], multiple: false });
}
