// Native-resolution raster export via canvas 2D. PNG is lossless.
import { app, page, toast, boxText, lineText, saveExportPrefs, PAGE_W, PAGE_H } from './store.svelte.js';
import { familyFor, fontShorthand, applyCase, wrapLinesDOM, arcLayout, maxLineWidth } from './measure.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function hexToRgba(hex, alpha) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16),
    g = parseInt(h.slice(2, 4), 16),
    b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Seeded pseudo-noise displacement to approximate SVG edge-roughening in export.
function roughen(ctx, w, h, amount, detail, seed) {
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const s = src.data,
    d = dst.data;
  const f = detail * 40 + 0.4;
  const n = (x, y, o) =>
    Math.sin((x * f + seed) * 1.7 + o) * Math.cos((y * f - seed) * 1.3 + o) +
    Math.sin((x + y) * f * 0.5 + seed + o) * 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.round(n(x, y, 0) * amount);
      const dy = Math.round(n(x, y, 11.3) * amount);
      let sx = x + dx,
        sy = y + dy;
      if (sx < 0) sx = 0;
      else if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0;
      else if (sy >= h) sy = h - 1;
      const di = (y * w + x) * 4,
        si = (sy * w + sx) * 4;
      d[di] = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
      d[di + 3] = s[si + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// Lay out a box's text and compute its canvas geometry WITHOUT drawing. The
// footprint (cw×ch) grows to contain the full block incl. overflow beyond the
// box rect on all sides — mirroring the editor's `overflow:visible` centered
// layout so nothing clips on export. (ox,oy) is where the box's top-left sits
// inside that footprint. Split out from painting so rotated text can be drawn
// directly onto the page canvas (sharp glyphs) instead of rotating a raster.
function layoutBox(box, p) {
  const s = box.style;
  const text = applyCase(boxText(box, p), s);
  const lineH = s.size * s.lineHeight;
  const pad = Math.ceil(
    Math.max(s.outlineWidth * 2, s.shadow.on ? Math.abs(s.shadow.x) + Math.abs(s.shadow.y) + s.shadow.blur : 0, s.roughen.on ? s.roughen.amount + 2 : 0) + 4,
  );

  const isCurve = s.curve && s.curve !== 0 && text.trim() !== '';

  let lines = null;
  let layout = null;
  let leftExtra = 0,
    rightExtra = 0,
    topExtra = 0,
    bottomExtra = 0;

  if (isCurve) {
    layout = arcLayout(text, s, s.size);
    let minX = 0,
      maxX = 0,
      minY = 0,
      maxY = 0;
    const half = s.size * 0.75; // generous half-glyph margin around each anchor
    for (const g of layout) {
      minX = Math.min(minX, g.x - half);
      maxX = Math.max(maxX, g.x + half);
      minY = Math.min(minY, g.y - half);
      maxY = Math.max(maxY, g.y + half);
    }
    leftExtra = Math.max(0, -minX - box.w / 2);
    rightExtra = Math.max(0, maxX - box.w / 2);
    topExtra = Math.max(0, -minY - box.h / 2);
    bottomExtra = Math.max(0, maxY - box.h / 2);
  } else {
    // box.w - 4 = content width (2px horizontal padding each side), so export
    // breaks lines exactly where the editor's CSS does.
    lines = wrapLinesDOM(text, s, s.size, box.w - 4);
    const blockH = lines.length * lineH;
    const blockW = maxLineWidth(lines, s, s.size);

    if (s.valign === 'middle') {
      const o = Math.max(0, (blockH - box.h) / 2);
      topExtra = o;
      bottomExtra = o;
    } else if (s.valign === 'bottom') {
      topExtra = Math.max(0, blockH - box.h);
    } else {
      bottomExtra = Math.max(0, blockH - box.h);
    }

    const hOver = Math.max(0, blockW - box.w);
    if (s.align === 'center') {
      leftExtra = hOver / 2;
      rightExtra = hOver / 2;
    } else if (s.align === 'right') {
      leftExtra = hOver;
    } else {
      rightExtra = hOver;
    }
  }

  leftExtra = Math.ceil(leftExtra);
  rightExtra = Math.ceil(rightExtra);
  topExtra = Math.ceil(topExtra);
  bottomExtra = Math.ceil(bottomExtra);
  const ox = leftExtra + pad; // box's top-left X inside the footprint
  const oy = topExtra + pad; // box's top-left Y inside the footprint
  const cw = Math.ceil(box.w + leftExtra + rightExtra + pad * 2);
  const ch = Math.ceil(box.h + topExtra + bottomExtra + pad * 2);
  return { s, lineH, pad, isCurve, lines, layout, leftExtra, topExtra, ox, oy, cw, ch };
}

// Paint a laid-out box (L from layoutBox) onto `ctx`, with the box's top-left at
// (L.ox, L.oy) in the current transform. Works on either an offscreen canvas or
// directly on a rotated page context.
function paintBox(ctx, box, L) {
  const s = L.s;
  ctx.font = fontShorthand(s, s.size, familyFor(s));
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const strokeFill = (drawFns) => {
    if (s.shadow.on) {
      ctx.save();
      ctx.shadowColor = hexToRgba(s.shadow.color, s.shadow.opacity);
      ctx.shadowOffsetX = s.shadow.x;
      ctx.shadowOffsetY = s.shadow.y;
      ctx.shadowBlur = s.shadow.blur;
      ctx.fillStyle = s.color;
      drawFns.fill();
      ctx.restore();
    }
    if (s.outlineWidth > 0) {
      ctx.strokeStyle = s.outline;
      ctx.lineWidth = s.outlineWidth * 2;
      drawFns.stroke();
    }
    ctx.fillStyle = s.color;
    drawFns.fill();
  };

  if (L.isCurve) {
    const cx = L.ox + box.w / 2;
    const cy = L.oy + box.h / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const place = (cb) => {
      for (const g of L.layout) {
        ctx.save();
        ctx.translate(cx + g.x, cy + g.y);
        ctx.rotate(g.rot);
        cb(g.ch, 0, 0);
        ctx.restore();
      }
    };
    strokeFill({
      stroke: () => place((c, x, y) => ctx.strokeText(c, x, y)),
      fill: () => place((c, x, y) => ctx.fillText(c, x, y)),
    });
  } else {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${s.letterSpacing}px`;
    const blockH = L.lines.length * L.lineH;
    let startY = L.oy;
    if (s.valign === 'middle') startY = L.oy + (box.h - blockH) / 2;
    else if (s.valign === 'bottom') startY = L.oy + (box.h - blockH);
    ctx.textAlign = s.align;
    const anchorX = s.align === 'left' ? L.ox : s.align === 'right' ? L.ox + box.w : L.ox + box.w / 2;
    const drawAll = (fn) => {
      L.lines.forEach((ln, i) => fn(ln, anchorX, startY + i * L.lineH + (L.lineH - s.size) / 2));
    };
    strokeFill({
      stroke: () => drawAll((ln, x, y) => ctx.strokeText(ln, x, y)),
      fill: () => drawAll((ln, x, y) => ctx.fillText(ln, x, y)),
    });
  }
}

// Render a box to its own supersampled offscreen canvas. Used for un-rotated
// boxes and for rotated+roughened boxes (whose pixel-space displacement needs
// an axis-aligned raster). Non-roughened text is supersampled 2x so the
// downscale-on-composite yields crisp edges.
function renderBox(box, p) {
  const L = layoutBox(box, p);
  const s = L.s;
  const SS = s.roughen.on ? 1 : 2;
  const cnv = document.createElement('canvas');
  cnv.width = L.cw * SS;
  cnv.height = L.ch * SS;
  const ctx = cnv.getContext('2d');
  ctx.scale(SS, SS); // all drawing stays in native units; SS handled here
  ctx.imageSmoothingQuality = 'high';
  paintBox(ctx, box, L);
  if (s.roughen.on) roughen(ctx, L.cw, L.ch, s.roughen.amount, s.roughen.detail, s.roughen.seed);
  return { canvas: cnv, pad: L.pad, leftExtra: L.leftExtra, topExtra: L.topExtra, cw: L.cw, ch: L.ch };
}

const MIME = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  WebP: 'image/webp',
  PSD: 'image/vnd.adobe.photoshop',
  JSON: 'application/json',
};
const EXT = { PNG: 'png', JPG: 'jpg', WebP: 'webp', PSD: 'psd', JSON: 'json' };
const QUALITY = { PNG: undefined, JPG: 0.95, WebP: 0.92, PSD: undefined };

// Render one page to a canvas: white base + cleaned image (if any) + all text
// boxes composited exactly as the editor shows them. Split out from
// renderPageBlob so the PSD exporter can grab the exact composite ImageData
// (for the flattened preview / merged image) without a Blob round-trip.
// `scale` supersamples the whole page (2 = 2x pixel dims); because text is
// already rendered 2x internally, an outer scale maps that bitmap 1:1 to device
// pixels — so 2x output stays genuinely sharp, not a soft upscale.
export async function renderPageCanvas(p, scale = 1) {
  const W = p.w,
    H = p.h;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  // white base (JPG has no alpha; manga pages are white anyway)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Background: the cleaned page when there is one, else the raw — mirroring
  // what the editor shows, so a raws-only chapter doesn't export as a blank
  // white sheet.
  const base = p.cleaned ?? p.raw;
  if (base) {
    try {
      const img = await loadImage(base);
      ctx.drawImage(img, 0, 0, W, H);
    } catch {
      /* draw text on white if image fails */
    }
  }
  ctx.imageSmoothingQuality = 'high'; // crisp downscale of the supersampled text
  for (const box of p.boxes) {
    ctx.save();
    ctx.globalAlpha = box.style.opacity ?? 1;
    paintBoxOnPage(ctx, box, p);
    ctx.restore();
  }
  return canvas;
}

// Draw one box's glyphs onto `ctx` at page coordinates, exactly as the page
// composite does — sharp direct-angle draw for rotated opaque text, raster
// fallback for roughened/translucent. Opacity is applied by the caller (via
// ctx.globalAlpha or a layer opacity), NOT here, so the same pixels can back a
// translucent PSD layer.
function paintBoxOnPage(ctx, box, p) {
  const s = box.style;
  const rot = s.rotation || 0;
  const opaque = (s.opacity ?? 1) >= 0.999;
  // Mirror flip around the box center, applied INSIDE rotation to match the
  // editor (rotation on .tbox, flip on the inner text → rotate ∘ flip).
  const fx = s.flipH ? -1 : 1;
  const fy = s.flipV ? -1 : 1;
  const flipped = fx !== 1 || fy !== 1;
  if (rot !== 0 && !s.roughen.on && opaque) {
    // Rotated text: paint glyphs DIRECTLY at the angle so they rasterize sharp
    // (rotating a pre-rendered bitmap would resample and soften it). Pivot
    // around the box center like the editor rotates .tbox. Roughened or
    // translucent boxes fall through to the raster path so their pixel filter
    // / alpha compositing stays correct.
    const L = layoutBox(box, p);
    ctx.save();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    if (flipped) ctx.scale(fx, fy);
    ctx.translate(-box.w / 2 - L.ox, -box.h / 2 - L.oy);
    paintBox(ctx, box, L);
    ctx.restore();
  } else {
    const { canvas: bc, pad, leftExtra, topExtra, cw, ch } = renderBox(box, p);
    if (rot === 0) {
      // Integer-snap the bitmap origin so a sub-pixel box position doesn't
      // force a bilinear resample of the whole text block (the primary blur).
      const originX = Math.round(box.x - leftExtra - pad);
      const originY = Math.round(box.y - topExtra - pad);
      if (flipped) {
        // Mirror the bitmap around the box center.
        ctx.save();
        ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
        ctx.scale(fx, fy);
        ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
        ctx.drawImage(bc, originX, originY, cw, ch);
        ctx.restore();
      } else {
        ctx.drawImage(bc, originX, originY, cw, ch);
      }
    } else {
      // Rotated raster fallback (roughened/translucent): downsample the SSx
      // bitmap into its native footprint, pivoting at the box center.
      ctx.save();
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      if (flipped) ctx.scale(fx, fy);
      ctx.drawImage(bc, -(box.w / 2 + leftExtra + pad), -(box.h / 2 + topExtra + pad), cw, ch);
      ctx.restore();
    }
  }
}

// Render a single box to its own compact, transparent canvas with the exact
// sharp pixels the page composite would show for it (opacity NOT baked in —
// returned as `opacity`). Used as the cached rasterization of an editable PSD
// text layer so it displays pixel-identical to the app even when the manga
// font is missing in Photoshop. Returns null for a box that paints nothing.
// `scratch` is an optional reusable (W*scale)×(H*scale) canvas to avoid per-box
// allocations. `p` is the box's page (so line-backed text resolves correctly).
// `scale` supersamples to match a scaled document; returned bounds are in the
// scaled (device) pixel space.
export function renderBoxLayer(box, W, H, scratch, p, scale = 1) {
  const SW = Math.round(W * scale);
  const SH = Math.round(H * scale);
  const cnv = scratch || document.createElement('canvas');
  if (cnv.width !== SW) cnv.width = SW;
  if (cnv.height !== SH) cnv.height = SH;
  const ctx = cnv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SW, SH);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = 'high';
  paintBoxOnPage(ctx, box, p); // full opacity; layer opacity applied by consumer
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const full = ctx.getImageData(0, 0, SW, SH);
  const d = full.data;
  let minX = SW,
    minY = SH,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (d[(y * SW + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // nothing drawn (empty text)
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(full, -minX, -minY);
  return {
    imageData: out.getContext('2d').getImageData(0, 0, w, h),
    left: minX,
    top: minY,
    right: minX + w,
    bottom: minY + h,
    opacity: box.style.opacity ?? 1,
  };
}

// ---------------------------------------------------------------------------
// detected-text JSON export
// ---------------------------------------------------------------------------

// One page → the detected/typeset text plus the geometry it came from. `jp` is
// the OCR'd source text, `en` the translation you typed (or that came in via a
// JSON import); `box` is the detector's [x1,y1,x2,y2] in image coordinates and
// `placed` is where the line's text box actually sits on the page, when one has
// been placed. Free-typed boxes (no detected line behind them) are listed
// separately so nothing typeset is lost.
function serializePageText(p) {
  const geom = new Map((p.detect?.boxes ?? []).map((d) => [d.n, d]));
  const placedFor = (n) => {
    const b = (p.boxes ?? []).find((x) => x.lineN === n);
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  };
  return {
    page: p.id,
    width: p.w ?? PAGE_W,
    height: p.h ?? PAGE_H,
    panels: (p.detect?.panels ?? []).slice(),
    lines: (p.lines ?? []).map((l) => {
      const g = geom.get(l.n);
      return {
        n: l.n,
        type: l.type ?? 'dialogue',
        jp: l.jp ?? '',
        en: lineText(l),
        box: g?.box ?? null,
        vertical: g?.vertical ?? null,
        font_size: g?.font_size ?? null,
        placed: placedFor(l.n),
      };
    }),
    // Text boxes the user typed directly, with no detected line behind them.
    extraBoxes: (p.boxes ?? [])
      .filter((b) => b.lineN == null)
      .map((b) => ({ text: b.text ?? '', x: b.x, y: b.y, w: b.w, h: b.h })),
  };
}

// The whole export scope as one JSON document. The `pages` shape is exactly what
// the JSON importer accepts, so an exported file re-imports cleanly.
export function buildTextJson(pages) {
  return JSON.stringify(
    { schema: 1, generator: 'manga-typesetter', pages: pages.map(serializePageText) },
    null,
    2,
  );
}

// Render one page to a Blob in the requested raster format (native resolution).
async function renderPageBlob(p, fmt) {
  const canvas = await renderPageCanvas(p);
  return new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
}

// Running inside the Tauri webview?
function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// Native save via the OS dialog + filesystem (Tauri). Returns the directory used.
async function saveNative(items, scope, fmt) {
  const [{ save, open }, { writeFile }, { join, dirname, basename }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
    import('@tauri-apps/api/path'),
  ]);
  const ext = EXT[fmt];
  if (scope === 'current') {
    const first = items[0];
    const defaultPath = app.exportDir ? await join(app.exportDir, first.name) : first.name;
    const path = await save({
      defaultPath,
      filters: [{ name: fmt, extensions: [ext] }],
    });
    if (!path) return null; // user cancelled
    await writeFile(path, await blobBytes(first.blob));
    const dir = await dirname(path);
    // Learn the base name from a page file only — the JSON export's name carries
    // a "-text" suffix that must not become the project's export base.
    const base =
      fmt === 'JSON'
        ? app.exportName
        : (await basename(path)).replace(/\.[^.]+$/, '').replace(/-\d+$/, '');
    saveExportPrefs(dir, base || app.exportName);
    toast(`Saved to ${path}`);
    return dir;
  }
  // scope === 'all' → pick a directory, write every page into it
  const dir = await open({ directory: true, defaultPath: app.exportDir || undefined });
  if (!dir) return null; // cancelled
  for (const it of items) {
    await writeFile(await join(dir, it.name), await blobBytes(it.blob));
  }
  saveExportPrefs(dir, app.exportName);
  toast(`Saved ${items.length} file(s) to ${dir}`);
  return dir;
}

// The detected/typeset text for a scope: one document, not one file per page,
// and the same document the export dialog's JSON format produces. Lifted out of
// exportImages so the detect menu and the dialog run identical code — two
// serialisers for one file format would drift the moment either was touched.
// Does NOT set app.exporting: exportImages already holds it across this call,
// and every other caller wraps it the same way.
export async function exportTextJson(scope) {
  const pages = scope === 'all' ? app.pages : [page()];
  const suffix = scope === 'all' ? 'text' : `${pages[0].id}-text`;
  const items = [
    {
      name: `${app.exportName}-${suffix}.json`,
      blob: new Blob([buildTextJson(pages)], { type: MIME.JSON }),
      page: pages[0],
    },
  ];
  if (isTauri()) {
    // Always the single-file save dialog — 'all' is still one document.
    await saveNative(items, 'current', 'JSON');
  } else {
    downloadBlob(items[0].blob, items[0].name);
    toast(`Exported text for ${pages.length} page(s) as JSON (browser download)`);
  }
  return true;
}

// Public entry: scope = 'current' | 'all', fmt = PNG|JPG|WebP|PSD|JSON.
export async function exportImages(fmt, scope) {
  app.exporting = true;
  try {
    await document.fonts.ready;
    const pages = scope === 'all' ? app.pages : [page()];
    const ext = EXT[fmt];

    // JSON is one document for the whole scope (not one file per page), so it
    // round-trips through the JSON importer in a single pick.
    if (fmt === 'JSON') return await exportTextJson(scope);

    const items = [];
    for (const p of pages) {
      let blob;
      if (fmt === 'PSD') {
        // Layered, editable PSD carrying the full project as embedded JSON so
        // it round-trips losslessly (one .psd per page). Lazily imported so
        // ag-psd isn't pulled into the raster-export path.
        const { buildPagePsd } = await import('./psd.js');
        const bytes = await buildPagePsd(p);
        blob = new Blob([bytes], { type: MIME.PSD });
      } else {
        blob = await renderPageBlob(p, fmt);
      }
      items.push({ name: `${app.exportName}-${p.id}.${ext}`, blob, page: p });
    }
    if (isTauri()) {
      await saveNative(items, scope, fmt);
    } else {
      for (const it of items) downloadBlob(it.blob, it.name);
      toast(`Exported ${items.length} image(s) as ${fmt} (browser download)`);
    }
    return true;
  } catch (e) {
    toast('Export failed: ' + (e?.message || e));
    return false;
  } finally {
    app.exporting = false;
  }
}

// Back-compat wrapper.
export async function exportCurrentPage(fmt) {
  return exportImages(fmt, 'current');
}
