// Layered PSD import/export with lossless round-trip.
//
// Dual representation: the PSD's visible layers are real, editable Photoshop
// objects (editable text layers, base rasters), AND the complete project is
// embedded as JSON in an image resource (XMP) so this app can reconstruct the
// page with zero loss of editable state. On import we prefer the embedded JSON
// (lossless path) and fall back to a best-effort layer mapping for foreign PSDs.
//
// ag-psd auto-initializes its canvas backend when `document` is present (the
// Tauri webview / vite browser), so no explicit initializeCanvas call is needed.
import { writePsd, readPsd } from 'ag-psd';
import { app, PAGE_W, PAGE_H } from './store.svelte.js';
import { isTauri, pickFilesTauri } from './importer.js';
import { renderPageCanvas, renderBoxLayer } from './exporter.js';
import { fontCssFor } from './store.svelte.js';

// Bumped when the embedded schema changes in a non-back-compatible way. Import
// refuses newer majors it can't understand and falls back to layer mapping.
const SCHEMA = 1;
const PROJECT_KEY = 'mt:project';
const XMP_NS = 'https://manga-typesetter.app/ns/mt/1.0/';
// PSD/PSB hard limits: PSD tops out at 30000px per side, PSB at 300000.
const PSD_MAX = 30000;

// ---------------------------------------------------------------------------
// pixel helpers
// ---------------------------------------------------------------------------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Decode any image source (object URL / data URL) to raw RGBA ImageData at its
// natural size, unless (w,h) force a target size. Raw pixels — no lossy
// re-encode — are what we hand to ag-psd.
async function imageDataFromSrc(src, w, h) {
  const img = await loadImage(src);
  const cw = w || img.naturalWidth || img.width;
  const ch = h || img.naturalHeight || img.height;
  const cnv = document.createElement('canvas');
  cnv.width = cw;
  cnv.height = ch;
  const ctx = cnv.getContext('2d');
  ctx.drawImage(img, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

// Re-encode a canvas/ImageData source into a PNG object URL (used to rebuild
// page.raw / page.cleaned from PSD base layers on import).
function canvasToObjectUrl(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(URL.createObjectURL(b)), 'image/png'));
}

function imageDataToCanvas(imageData) {
  const cnv = document.createElement('canvas');
  cnv.width = imageData.width;
  cnv.height = imageData.height;
  cnv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height), 0, 0);
  return cnv;
}

function hexToRgb(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
}

// ---------------------------------------------------------------------------
// embedded JSON (XMP image resource) — the lossless source of truth
// ---------------------------------------------------------------------------

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Wrap the project JSON in a minimal XMP packet under our own namespace. The
// payload is base64 so it's XML-safe and Photoshop preserves the custom
// property across its own XMP rewrites.
function wrapXmp(jsonStr) {
  const payload = b64EncodeUtf8(jsonStr);
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    `  <rdf:Description rdf:about="" xmlns:mt="${XMP_NS}">\n` +
    `   <mt:project>${payload}</mt:project>\n` +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>'
  );
}

function extractProject(xmp) {
  if (!xmp) return null;
  const m = xmp.match(/<mt:project>([\s\S]*?)<\/mt:project>/);
  if (!m) return null;
  try {
    return JSON.parse(b64DecodeUtf8(m[1].trim()));
  } catch {
    return null;
  }
}

// Page → plain JSON with every field needed to rebuild it, minus volatile ids
// (box.id — reassigned on import) and object URLs (page.raw/cleaned — rebuilt
// from the base rasters).
function serializePage(p) {
  return {
    id: p.id,
    w: p.w ?? PAGE_W,
    h: p.h ?? PAGE_H,
    lines: (p.lines ?? []).map((l) => ({ n: l.n, type: l.type, jp: l.jp ?? '', en: l.en ?? '' })),
    boxes: (p.boxes ?? []).map((b) => ({
      lineN: b.lineN,
      text: b.text ?? null,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      style: JSON.parse(JSON.stringify(b.style)),
    })),
    detect: p.detect
      ? {
          panels: (p.detect.panels ?? []).slice(),
          boxes: (p.detect.boxes ?? []).map((d) => ({ n: d.n, box: d.box, vertical: d.vertical, font_size: d.font_size })),
        }
      : null,
    hasRaw: !!p.raw,
    hasCleaned: !!p.cleaned,
  };
}

// ---------------------------------------------------------------------------
// style → PSD text/effects mapping (best-effort; JSON carries the exact truth)
// ---------------------------------------------------------------------------

const JUSTIFY = { left: 'left', center: 'center', right: 'right' };

// Page-scoped text resolver (store.boxText() reads the *current* page, wrong
// during an export-all of another page).
function boxTextFor(p, box) {
  if (box.text != null) return box.text;
  const ln = (p.lines ?? []).find((l) => l.n === box.lineN);
  if (!ln) return '';
  return ln.en ?? ln.natural ?? ln.stylised ?? ln.text ?? '';
}

// A CSS family list like "'Bangers', cursive" → a plausible PostScript name.
// Fonts substitute in Photoshop anyway; the embedded JSON keeps the exact
// family for lossless re-import.
function postScriptName(family) {
  const css = fontCssFor(family) || family || '';
  const first = String(css).split(',')[0].replace(/['"]/g, '').trim();
  return first.replace(/\s+/g, '') || 'MyriadPro-Regular';
}

function warpForCurve(curve) {
  if (!curve) return { style: 'none' };
  // our curve is -100..100 (negative = frown); PS arc value is -100..100 too.
  return { style: 'arc', value: Math.max(-100, Math.min(100, curve)), perspective: 0, perspectiveOther: 0, rotate: 'horizontal' };
}

// Build one editable text layer for a box. `rendered` (from renderBoxLayer) is
// the box's exact sharp pixels — the layer's cached rasterization — so it
// displays pixel-identical to the app even when the manga font is missing in
// Photoshop, while remaining an editable type layer (engineData below).
function textLayerFor(p, box, rendered, scale = 1) {
  const s = box.style;
  const raw = boxTextFor(p, box);
  const content = s.uppercase ? raw.toUpperCase() : raw;
  const rot = ((s.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Rotate the box top-left about the box center (pivot matches exporter.js).
  // All geometry is scaled to the document so live (font-present) re-rendering
  // aligns with the scaled cached pixels; tracking is per-em, so scale-invariant.
  const tx = (cx + (box.x - cx) * cos - (box.y - cy) * sin) * scale;
  const ty = (cy + (box.x - cx) * sin + (box.y - cy) * cos) * scale;
  const fontSize = s.size * scale;
  const tracking = s.size > 0 ? Math.round(((s.letterSpacing || 0) / s.size) * 1000) : 0;

  // Layer bounds follow the cached raster (tight, already scaled) when present,
  // else the box rect scaled to the document.
  const bounds = rendered
    ? { left: rendered.left, top: rendered.top, right: rendered.right, bottom: rendered.bottom }
    : {
        left: Math.round(box.x * scale),
        top: Math.round(box.y * scale),
        right: Math.round((box.x + box.w) * scale),
        bottom: Math.round((box.y + box.h) * scale),
      };

  return {
    name: (raw || `line ${box.lineN ?? '·'}`).slice(0, 40),
    ...bounds,
    imageData: rendered ? rendered.imageData : undefined,
    opacity: s.opacity ?? 1,
    blendMode: 'normal',
    // Outline + shadow (and roughen/curve) are baked into the cached pixels
    // above for pixel-exact, sharp display; we deliberately DON'T also attach
    // layer effects here — Photoshop would double them over the baked pixels.
    text: {
      text: content,
      orientation: 'horizontal',
      transform: [cos, sin, -sin, cos, tx, ty],
      antiAlias: 'smooth',
      warp: warpForCurve(s.curve),
      shapeType: 'box',
      boxBounds: [0, 0, Math.round(box.w * scale), Math.round(box.h * scale)],
      style: {
        font: { name: postScriptName(s.font) },
        fontSize,
        fauxBold: !!s.bold,
        fauxItalic: !!s.italic,
        autoLeading: false,
        leading: (s.lineHeight || 1.1) * fontSize,
        tracking,
        fillColor: hexToRgb(s.color),
        fontCaps: s.uppercase ? 2 : 0,
        strokeColor: hexToRgb(s.outline),
      },
      paragraphStyle: { justification: JUSTIFY[s.align] || 'center' },
    },
  };
}

// ---------------------------------------------------------------------------
// export: page → PSD bytes
// ---------------------------------------------------------------------------

// Build a layered, editable PSD (Uint8Array) for one page, with the complete
// project embedded as JSON for lossless re-import. Group/layer schema (top of
// list = top in Photoshop):
//   Flattened preview (hidden) — exact app composite
//   Text  — one editable text layer per box
//   Base  — Cleaned (if any) over Raw
//
// `scale` supersamples the whole document (default 2) so the rasterized text
// stays sharp when zoomed in Preview / on lower-res pages. Text is rendered
// natively at the scaled resolution (crisp), base art is scaled up. The
// embedded JSON stays in ORIGINAL page coordinates, so re-import is unaffected
// by scale and remains lossless.
export async function buildPagePsd(p, scale = 2) {
  await document.fonts.ready;
  const W = p.w ?? PAGE_W;
  const H = p.h ?? PAGE_H;
  const SW = Math.round(W * scale);
  const SH = Math.round(H * scale);
  const sc = (v) => Math.round(v * scale);

  // Exact app composite at the scaled resolution → the PSD's merged image AND a
  // hidden reference layer, so the file's appearance matches the app even where
  // Photoshop can't reproduce roughen/curve.
  const compCanvas = await renderPageCanvas(p, scale);
  const compImageData = compCanvas.getContext('2d').getImageData(0, 0, SW, SH);

  const children = [];

  // Flattened preview (hidden)
  children.push({
    name: 'Flattened preview',
    hidden: true,
    left: 0,
    top: 0,
    right: SW,
    bottom: SH,
    imageData: compImageData,
  });

  // Text group — one editable type layer per box, each backed by the box's
  // exact sharp pixels (a shared scratch canvas avoids per-box allocations).
  const scratch = document.createElement('canvas');
  children.push({
    name: 'Text',
    opened: true,
    children: (p.boxes ?? []).map((b) => textLayerFor(p, b, renderBoxLayer(b, W, H, scratch, p, scale), scale)),
  });

  // Base group — Cleaned over Raw (bottom). Both scaled to fill the document.
  const baseChildren = [];
  if (p.cleaned) {
    try {
      const data = await imageDataFromSrc(p.cleaned, SW, SH);
      baseChildren.push({ name: 'Cleaned', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }
  if (p.raw) {
    try {
      const data = await imageDataFromSrc(p.raw, SW, SH);
      baseChildren.push({ name: 'Raw', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }
  if (baseChildren.length) children.push({ name: 'Base', opened: true, children: baseChildren });

  // Embedded lossless project state — ORIGINAL page coordinates (scale-agnostic).
  const project = { key: PROJECT_KEY, schema: SCHEMA, scale, page: serializePage(p) };

  const dpi = Math.round(72 * scale); // higher DPI keeps physical size constant
  const psd = {
    width: SW,
    height: SH,
    colorMode: 3, // RGB
    bitsPerChannel: 8,
    children,
    imageData: compImageData, // merged/composite image = exact app render (scaled)
    imageResources: {
      resolutionInfo: {
        horizontalResolution: dpi,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: dpi,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
      xmpMetadata: wrapXmp(JSON.stringify(project)),
    },
  };

  const psb = SW > PSD_MAX || SH > PSD_MAX;
  return writePsd(psd, { noBackground: true, generateThumbnail: true, psb });
}

// ---------------------------------------------------------------------------
// import: PSD bytes → page
// ---------------------------------------------------------------------------

// Find a layer by name within a named group (case-insensitive).
function findInGroup(psd, groupName, layerName) {
  const grp = (psd.children ?? []).find((c) => c.children && c.name === groupName);
  if (!grp) return null;
  return grp.children.find((l) => l.name === layerName) || null;
}

function revokeAll(...urls) {
  for (const u of new Set(urls.filter(Boolean))) URL.revokeObjectURL(u);
}

async function layerToUrl(layer) {
  if (!layer) return null;
  if (layer.canvas) return canvasToObjectUrl(layer.canvas);
  if (layer.imageData) return canvasToObjectUrl(imageDataToCanvas(layer.imageData));
  return null;
}

// Rebuild a full page object from the embedded project JSON (lossless path).
// Object URLs for raw/cleaned are regenerated from the PSD base rasters.
async function reconstructFromProject(project, psd) {
  const sp = project.page;
  const page = {
    id: sp.id,
    raw: null,
    cleaned: null,
    w: sp.w,
    h: sp.h,
    lines: (sp.lines ?? []).map((l) => ({ ...l })),
    boxes: (sp.boxes ?? []).map((b) => ({ ...b, style: { ...b.style } })),
    detect: sp.detect
      ? { panels: (sp.detect.panels ?? []).slice(), boxes: (sp.detect.boxes ?? []).map((d) => ({ ...d })) }
      : null,
  };
  try {
    if (sp.hasRaw) page.raw = await layerToUrl(findInGroup(psd, 'Base', 'Raw'));
    if (sp.hasCleaned) page.cleaned = await layerToUrl(findInGroup(psd, 'Base', 'Cleaned'));
  } catch (e) {
    // A URL minted before the failure has no owner to revoke it, and it holds a
    // whole page raster alive for as long as the app runs.
    revokeAll(page.raw, page.cleaned);
    throw e;
  }
  return page;
}

// Best-effort reconstruction for a foreign PSD (no embedded project). Maps the
// document size, bottom raster → raw/cleaned, and any editable text layers →
// text boxes with an approximate style.
async function reconstructForeign(psd) {
  const W = psd.width || PAGE_W;
  const H = psd.height || PAGE_H;

  // Bottom-most raster becomes the base image. Prefer a named Base/Cleaned/Raw
  // if present, else the last flat pixel layer, else the composite.
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.children) walk(n.children);
      else if (n.canvas || n.imageData) flat.push(n);
    }
  };
  walk(psd.children);
  const baseLayer =
    findInGroup(psd, 'Base', 'Cleaned') || findInGroup(psd, 'Base', 'Raw') || flat[flat.length - 1] || null;
  let cleaned = baseLayer ? await layerToUrl(baseLayer) : null;
  if (!cleaned && psd.canvas) cleaned = await canvasToObjectUrl(psd.canvas);

  // Editable text layers → boxes. Anything that throws from here on has to give
  // the raster URL back first; nothing else holds it yet.
  const boxes = [];
  const collectText = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.children) collectText(n.children);
      else if (n.text) {
        const st = n.text.style || {};
        const left = n.left ?? 0;
        const top = n.top ?? 0;
        boxes.push({
          lineN: null,
          text: n.text.text ?? '',
          x: left,
          y: top,
          w: Math.max(40, (n.right ?? left + 200) - left),
          h: Math.max(24, (n.bottom ?? top + 80) - top),
          style: {
            size: st.fontSize || 26,
            bold: !!st.fauxBold,
            italic: !!st.fauxItalic,
            align: n.text.paragraphStyle?.justification === 'left' ? 'left' : n.text.paragraphStyle?.justification === 'right' ? 'right' : 'center',
            color: st.fillColor ? '#' + [st.fillColor.r, st.fillColor.g, st.fillColor.b].map((v) => (v | 0).toString(16).padStart(2, '0')).join('') : '#1a1a1a',
          },
        });
      }
    }
  };
  try {
    collectText(psd.children);
  } catch (e) {
    revokeAll(cleaned);
    throw e;
  }

  return {
    id: undefined,
    raw: cleaned,
    cleaned,
    w: W,
    h: H,
    lines: [],
    boxes,
    detect: null,
  };
}

// Parse PSD bytes → { project, psd, foreign }. Exposed for verification.
export function parsePagePsd(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const psd = readPsd(buf, { skipThumbnail: false });
  const project = extractProject(psd.imageResources?.xmpMetadata);
  const supported = project && project.key === PROJECT_KEY && Math.floor(project.schema) <= SCHEMA;
  return { project: supported ? project : null, psd };
}

// ---------------------------------------------------------------------------
// import: PSD files → a whole chapter's worth of pages, ready for the library
// ---------------------------------------------------------------------------

// A PSD describes a whole typeset chapter, so it creates one rather than being
// merged into an existing one — importing into an open chapter substituted the
// document and orphaned every raw in raws/, which is why the editor no longer
// has this button at all.
//
// THIS IS THE ONE PLACE A RAW IS NOT THE USER'S ORIGINAL FILE. A PSD carries
// rasters, not the files they were made from, so pages come out of here as
// freshly encoded PNG bytes. Callers say so before importing.

const psdBytes = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));

function psdPageName(index, suffix) {
  return `page-${String(index + 1).padStart(3, '0')}${suffix}.png`;
}

// A reconstructed page (blob URLs) → the byte-carrying shape the library writes.
// Returns null when the PSD yielded no raster at all: a page with no image
// would persist with an empty `file`, unrenderable and impossible to remove.
async function toChapterPage(page, index) {
  try {
    // Every page needs a raw, because `file` is what resolves a page back to an
    // image on disk. Three cases:
    //   both rasters      → raw and cleaned, as they were
    //   one flattened one → written once as the raw (a foreign PSD hands the
    //                       same URL back as both; so does a PSD whose Base
    //                       group only has a Cleaned layer)
    //   none              → not a page this app can store
    const rawUrl = page.raw ?? page.cleaned;
    if (!rawUrl) return null;
    const cleanedUrl = page.cleaned && page.cleaned !== rawUrl ? page.cleaned : null;

    return {
      // The page's only image came from a Cleaned layer, so what lands in raws/
      // is text-erased art. Counted and stated by the caller: detection would
      // find nothing on it, and that should not look like a broken detector.
      cleanedOnly: !page.raw && !!page.cleaned,
      rawName: psdPageName(index, ''),
      rawBytes: await psdBytes(rawUrl),
      cleanedName: cleanedUrl ? psdPageName(index, '-cleaned') : null,
      cleanedBytes: cleanedUrl ? await psdBytes(cleanedUrl) : null,
      w: page.w ?? PAGE_W,
      h: page.h ?? PAGE_H,
      lines: (page.lines ?? []).map((l) => ({ ...l })),
      // Box ids are per-document and are reassigned when the chapter opens;
      // these only have to be unique inside the record.
      boxes: (page.boxes ?? []).map((b, i) => ({ ...b, id: `b${i + 1}`, style: { ...b.style } })),
      detect: page.detect ?? null,
    };
  } finally {
    revokeAll(page.raw, page.cleaned);
  }
}

export async function chapterPagesFromPsdFiles(files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const pages = [];
  const problems = [];
  let lossless = 0;
  for (const file of list) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { project, psd } = parsePagePsd(bytes);
      const page = project ? await reconstructFromProject(project, psd) : await reconstructForeign(psd);
      const built = await toChapterPage(page, pages.length);
      if (!built) {
        problems.push(`${file.name} — no page image in it`);
        continue;
      }
      pages.push(built);
      if (project) lossless++;
    } catch (e) {
      problems.push(`${file.name} — ${e?.message || e}`);
    }
  }
  return {
    pages,
    lossless,
    foreign: pages.length - lossless,
    cleanedOnly: pages.filter((pg) => pg.cleanedOnly).length,
    problems,
  };
}

export async function pickPsdFiles() {
  // Native dialog under Tauri — a detached <input type=file> never opens in the
  // packaged app (WKWebView runOpenPanel silently fails). Browser keeps the
  // input fallback.
  if (isTauri()) {
    return pickFilesTauri({ name: 'Photoshop', extensions: ['psd', 'psb'], multiple: true });
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.psd,.psb,image/vnd.adobe.photoshop';
  input.multiple = true;
  await new Promise((resolve) => {
    input.onchange = resolve;
    input.click();
  });
  return input.files && input.files.length ? [...input.files] : null;
}

// ---------------------------------------------------------------------------
// self-test (verification) — build → parse → deep-compare the serialized page.
// Ignores volatile ids/URLs by construction (serializePage omits them). Also
// checks visual parity of the composite and PSD editability/structure.
// ---------------------------------------------------------------------------
export async function psdSelfTest(p) {
  const src = p ?? app.pages[app.pageIndex];
  const before = serializePage(src);
  const bytes = await buildPagePsd(src);
  const { project, psd } = parsePagePsd(bytes);
  const report = { ok: true, checks: {}, diffs: [] };

  report.checks.embeddedProject = !!project;
  if (!project) {
    report.ok = false;
    return report;
  }

  // 1) Lossless round-trip: reconstruct → re-serialize → deep-equal.
  const rebuilt = await reconstructFromProject(project, psd);
  const after = serializePage(rebuilt);
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  report.checks.losslessRoundTrip = a === b;
  if (a !== b) {
    report.ok = false;
    // surface the first divergence for debugging
    for (const k of Object.keys(before)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) report.diffs.push(k);
    }
  }

  // 2) Visual parity: PSD composite vs the exact app render at the same scale
  // (byte-identical by construction — we wrote that render as the merged image).
  const scale = project.scale || 1;
  const comp = psd.canvas ? psd.canvas.getContext('2d').getImageData(0, 0, psd.width, psd.height) : psd.imageData;
  const refCanvas = await renderPageCanvas(src, scale);
  const ref = refCanvas.getContext('2d').getImageData(0, 0, Math.round(src.w * scale), Math.round(src.h * scale));
  let maxDiff = 0;
  if (comp && comp.data.length === ref.data.length) {
    for (let i = 0; i < ref.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(comp.data[i] - ref.data[i]));
  } else {
    maxDiff = 255;
  }
  report.checks.visualMaxChannelDiff = maxDiff;
  report.checks.visualParity = maxDiff <= 2; // AA tolerance
  if (!report.checks.visualParity) report.ok = false;

  // 3) Editability / structure.
  const groupNames = (psd.children ?? []).filter((c) => c.children).map((c) => c.name);
  const textGroup = (psd.children ?? []).find((c) => c.name === 'Text' && c.children);
  report.checks.groups = groupNames;
  report.checks.hasTextGroup = !!textGroup;
  report.checks.textLayersEditable =
    !!textGroup && textGroup.children.length === (src.boxes ?? []).length && textGroup.children.every((l) => !!l.text);
  if (!report.checks.hasTextGroup || !report.checks.textLayersEditable) report.ok = false;

  return report;
}
