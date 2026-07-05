// Native-resolution raster export via canvas 2D. PNG is lossless.
import { app, page, toast, boxText, saveExportPrefs } from './store.svelte.js';
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
function layoutBox(box) {
  const s = box.style;
  const text = applyCase(boxText(box), s);
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
function renderBox(box) {
  const L = layoutBox(box);
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

const MIME = { PNG: 'image/png', JPG: 'image/jpeg', WebP: 'image/webp' };
const EXT = { PNG: 'png', JPG: 'jpg', WebP: 'webp' };
const QUALITY = { PNG: undefined, JPG: 0.95, WebP: 0.92 };

// Render one page to a Blob in the requested format (native resolution).
async function renderPageBlob(p, fmt) {
  const W = p.w,
    H = p.h;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  // white base (JPG has no alpha; manga pages are white anyway)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (p.cleaned) {
    try {
      const img = await loadImage(p.cleaned);
      ctx.drawImage(img, 0, 0, W, H);
    } catch {
      /* draw text on white if image fails */
    }
  }
  ctx.imageSmoothingQuality = 'high'; // crisp downscale of the supersampled text
  for (const box of p.boxes) {
    const s = box.style;
    const rot = s.rotation || 0;
    const opaque = (s.opacity ?? 1) >= 0.999;
    ctx.save();
    ctx.globalAlpha = s.opacity ?? 1;
    if (rot !== 0 && !s.roughen.on && opaque) {
      // Rotated text: paint glyphs DIRECTLY at the angle so they rasterize sharp
      // (rotating a pre-rendered bitmap would resample and soften it). Pivot
      // around the box center like the editor rotates .tbox. Roughened or
      // translucent boxes fall through to the raster path so their pixel filter
      // / alpha compositing stays correct.
      const L = layoutBox(box);
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.translate(-box.w / 2 - L.ox, -box.h / 2 - L.oy);
      paintBox(ctx, box, L);
    } else {
      const { canvas: bc, pad, leftExtra, topExtra, cw, ch } = renderBox(box);
      if (rot === 0) {
        // Integer-snap the bitmap origin so a sub-pixel box position doesn't
        // force a bilinear resample of the whole text block (the primary blur).
        const originX = Math.round(box.x - leftExtra - pad);
        const originY = Math.round(box.y - topExtra - pad);
        ctx.drawImage(bc, originX, originY, cw, ch);
      } else {
        // Rotated raster fallback (roughened/translucent): downsample the SSx
        // bitmap into its native footprint, pivoting at the box center.
        ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(bc, -(box.w / 2 + leftExtra + pad), -(box.h / 2 + topExtra + pad), cw, ch);
      }
    }
    ctx.restore();
  }
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
    const base = (await basename(path)).replace(/\.[^.]+$/, '').replace(/-\d+$/, '');
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
  toast(`Saved ${items.length} image(s) to ${dir}`);
  return dir;
}

// Public entry: scope = 'current' | 'all', fmt = PNG|JPG|WebP.
export async function exportImages(fmt, scope) {
  app.exporting = true;
  try {
    await document.fonts.ready;
    const pages = scope === 'all' ? app.pages : [page()];
    const ext = EXT[fmt];
    const items = [];
    for (const p of pages) {
      const blob = await renderPageBlob(p, fmt);
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
