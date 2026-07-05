// Layered PSD import/export with lossless round-trip.
//
// Dual representation: the PSD's visible layers are real, editable Photoshop
// objects (editable text layers, non-destructive clean patches with masks,
// base rasters), AND the complete project is embedded as JSON in an image
// resource (XMP) so this app can reconstruct the page with zero loss of
// editable state. On import we prefer the embedded JSON (lossless path) and
// fall back to a best-effort layer mapping for foreign PSDs.
//
// ag-psd auto-initializes its canvas backend when `document` is present (the
// Tauri webview / vite browser), so no explicit initializeCanvas call is needed.
import { writePsd, readPsd } from 'ag-psd';
import { app, toast, loadProjectPages, PAGE_W, PAGE_H } from './store.svelte.js';
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

// Decode a bare base64 PNG (no data: prefix, as stored in clean layers/masks).
function imageDataFromBase64Png(b64, w, h) {
  const src = b64.startsWith('data:') ? b64 : 'data:image/png;base64,' + b64;
  return imageDataFromSrc(src, w, h);
}

// Crop an RGBA ImageData region (clamped to source bounds). Returns a fresh
// PixelData {data,width,height} suitable for a layer or mask.
function cropImageData(full, x, y, w, h) {
  const cnv = document.createElement('canvas');
  cnv.width = w;
  cnv.height = h;
  const ctx = cnv.getContext('2d');
  // draw the source ImageData, then read back the region
  const tmp = document.createElement('canvas');
  tmp.width = full.width;
  tmp.height = full.height;
  tmp.getContext('2d').putImageData(full, 0, 0);
  ctx.drawImage(tmp, x, y, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
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
// (box.id, layer.id — reassigned on import) and object URLs (page.raw/cleaned,
// clean.base — rebuilt from the base rasters). Clean patches + mask are kept as
// their existing base64 PNGs (already lossless, never recompressed).
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
    clean: p.clean
      ? {
          maskPng: p.clean.maskPng ?? null,
          status: { ...(p.clean.status ?? {}) },
          layers: (p.clean.layers ?? []).map((L) => ({
            n: L.n,
            box: L.box,
            method: L.method,
            requested: L.requested,
            fellBack: L.fellBack,
            uniform: L.uniform,
            ringStd: L.ringStd,
            patchPng: L.patchPng,
            visible: L.visible,
          })),
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
function textLayerFor(p, box, rendered) {
  const s = box.style;
  const raw = boxTextFor(p, box);
  const content = s.uppercase ? raw.toUpperCase() : raw;
  const rot = ((s.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Rotate the box top-left about the box center (pivot matches exporter.js).
  const tx = cx + (box.x - cx) * cos - (box.y - cy) * sin;
  const ty = cy + (box.x - cx) * sin + (box.y - cy) * cos;
  const fontSize = s.size;
  const tracking = fontSize > 0 ? Math.round(((s.letterSpacing || 0) / fontSize) * 1000) : 0;

  // Layer bounds follow the cached raster (tight) when present, else the box.
  const bounds = rendered
    ? { left: rendered.left, top: rendered.top, right: rendered.right, bottom: rendered.bottom }
    : { left: Math.round(box.x), top: Math.round(box.y), right: Math.round(box.x + box.w), bottom: Math.round(box.y + box.h) };

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
      boxBounds: [0, 0, Math.round(box.w), Math.round(box.h)],
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
//   Text     — one editable text layer per box
//   Brush    — reserved slot for Phase 4 brush layers (empty for now)
//   Cleaning — one masked patch per clean layer + hidden full-page AI mask
//   Base     — Cleaned (if any) over Raw
export async function buildPagePsd(p) {
  await document.fonts.ready;
  const W = p.w ?? PAGE_W;
  const H = p.h ?? PAGE_H;

  // Exact app composite (mirrors renderPageBlob) → the PSD's merged image AND a
  // hidden reference layer, so the file's appearance matches the app even where
  // Photoshop can't reproduce roughen/curve.
  const compCanvas = await renderPageCanvas(p);
  const compImageData = compCanvas.getContext('2d').getImageData(0, 0, W, H);

  const children = [];

  // Flattened preview (hidden)
  children.push({
    name: 'Flattened preview',
    hidden: true,
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    imageData: compImageData,
  });

  // Text group — one editable type layer per box, each backed by the box's
  // exact sharp pixels (a shared scratch canvas avoids per-box allocations).
  const scratch = document.createElement('canvas');
  children.push({
    name: 'Text',
    opened: true,
    children: (p.boxes ?? []).map((b) => textLayerFor(p, b, renderBoxLayer(b, W, H, scratch, p))),
  });

  // Brush group — reserved for Phase 4, empty for now.
  children.push({ name: 'Brush', opened: true, children: [] });

  // Cleaning group
  const cleanChildren = [];
  let fullMask = null;
  if (p.clean?.maskPng) {
    try {
      fullMask = await imageDataFromBase64Png(p.clean.maskPng);
    } catch {
      fullMask = null;
    }
  }
  for (const L of p.clean?.layers ?? []) {
    if (!L.patchPng) continue;
    const [bx, by, bw, bh] = L.box;
    let patch;
    try {
      patch = await imageDataFromBase64Png(L.patchPng, bw, bh);
    } catch {
      continue;
    }
    const layer = {
      name: `clean-${L.n} (${L.method})`,
      hidden: !L.visible,
      left: Math.round(bx),
      top: Math.round(by),
      right: Math.round(bx + bw),
      bottom: Math.round(by + bh),
      imageData: patch,
    };
    // Non-destructive: mask the patch to the detected text region so it only
    // covers the original text, cropped from the full-page mask.
    if (fullMask) {
      try {
        const maskData = cropImageData(fullMask, Math.round(bx), Math.round(by), bw, bh);
        layer.mask = { left: Math.round(bx), top: Math.round(by), imageData: maskData, defaultColor: 0 };
      } catch {
        /* skip mask on failure — patch still exports */
      }
    }
    cleanChildren.push(layer);
  }
  if (fullMask) {
    cleanChildren.push({
      name: 'AI inpaint mask',
      hidden: true,
      left: 0,
      top: 0,
      right: fullMask.width,
      bottom: fullMask.height,
      imageData: fullMask,
    });
  }
  if (cleanChildren.length) children.push({ name: 'Cleaning', opened: true, children: cleanChildren });

  // Base group — Cleaned over Raw (bottom).
  const baseChildren = [];
  if (p.cleaned) {
    try {
      const data = await imageDataFromSrc(p.cleaned, W, H);
      baseChildren.push({ name: 'Cleaned', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }
  if (p.raw) {
    try {
      const data = await imageDataFromSrc(p.raw);
      baseChildren.push({ name: 'Raw', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }
  if (baseChildren.length) children.push({ name: 'Base', opened: true, children: baseChildren });

  // Embedded lossless project state.
  const project = { key: PROJECT_KEY, schema: SCHEMA, page: serializePage(p) };

  const psd = {
    width: W,
    height: H,
    colorMode: 3, // RGB
    bitsPerChannel: 8,
    children,
    imageData: compImageData, // merged/composite image = exact app render
    imageResources: {
      resolutionInfo: {
        horizontalResolution: 72,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: 72,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
      xmpMetadata: wrapXmp(JSON.stringify(project)),
    },
  };

  const psb = W > PSD_MAX || H > PSD_MAX;
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
    clean: sp.clean
      ? {
          base: null,
          maskPng: sp.clean.maskPng ?? null,
          status: { ...(sp.clean.status ?? {}) },
          layers: (sp.clean.layers ?? []).map((L) => ({ ...L })),
        }
      : { base: null, maskPng: null, status: {}, layers: [] },
  };
  if (sp.hasRaw) {
    page.raw = await layerToUrl(findInGroup(psd, 'Base', 'Raw'));
    if (page.clean) page.clean.base = page.raw;
  }
  if (sp.hasCleaned) page.cleaned = await layerToUrl(findInGroup(psd, 'Base', 'Cleaned'));
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

  // Editable text layers → boxes.
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
  collectText(psd.children);

  return {
    id: undefined,
    raw: cleaned,
    cleaned,
    w: W,
    h: H,
    lines: [],
    boxes,
    detect: null,
    clean: { base: null, maskPng: null, status: {}, layers: [] },
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

// Import one or more .psd files → pages (lossless when embedded JSON present).
export async function importPsdFiles(files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (!list.length) return;
  const pages = [];
  let lossless = 0;
  for (const file of list) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { project, psd } = parsePagePsd(bytes);
      if (project) {
        pages.push(await reconstructFromProject(project, psd));
        lossless++;
      } else {
        pages.push(await reconstructForeign(psd));
      }
    } catch (e) {
      toast(`Could not read ${file.name}: ${e?.message || e}`);
    }
  }
  if (!pages.length) return;
  loadProjectPages(pages);
  toast(
    lossless === pages.length
      ? `Imported ${pages.length} page(s) from PSD (lossless)`
      : `Imported ${pages.length} page(s) from PSD (${lossless} lossless, ${pages.length - lossless} foreign)`,
  );
}

export async function pickPsd() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.psd,.psb,image/vnd.adobe.photoshop';
  input.multiple = true;
  await new Promise((resolve) => {
    input.onchange = resolve;
    input.click();
  });
  if (input.files && input.files.length) await importPsdFiles(input.files);
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

  // 2) Visual parity: PSD composite vs the exact app render (byte-identical by
  // construction — we wrote the render as the merged image).
  const comp = psd.canvas ? psd.canvas.getContext('2d').getImageData(0, 0, psd.width, psd.height) : psd.imageData;
  const refCanvas = await renderPageCanvas(src);
  const ref = refCanvas.getContext('2d').getImageData(0, 0, src.w, src.h);
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
  const cleanGroup = (psd.children ?? []).find((c) => c.name === 'Cleaning' && c.children);
  report.checks.groups = groupNames;
  report.checks.hasTextGroup = !!textGroup;
  report.checks.hasBrushSlot = groupNames.includes('Brush');
  report.checks.textLayersEditable =
    !!textGroup && textGroup.children.length === (src.boxes ?? []).length && textGroup.children.every((l) => !!l.text);
  const patchLayers = cleanGroup ? cleanGroup.children.filter((l) => l.name.startsWith('clean-')) : [];
  report.checks.cleanPatchesHaveMask = patchLayers.length === 0 || patchLayers.every((l) => !!l.mask);
  report.checks.aiMaskPresent = !cleanGroup || !!cleanGroup.children.find((l) => l.name === 'AI inpaint mask');
  if (
    !report.checks.hasBrushSlot ||
    !report.checks.textLayersEditable ||
    !report.checks.cleanPatchesHaveMask ||
    !report.checks.aiMaskPresent
  ) {
    report.ok = false;
  }

  return report;
}
