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

// Render one box's text onto an offscreen canvas (native units).
// The canvas is grown to contain the FULL text block, including any overflow
// beyond the box rectangle on all sides — mirroring the editor's
// `overflow:visible` centered layout so nothing gets clipped on export.
// Returns {canvas, pad, leftExtra, topExtra}: leftExtra/topExtra are how far
// the box's top-left sits inside the (padded) canvas, so the caller can pivot
// rotation around the box center exactly like the app.
function renderBox(box) {
  const s = box.style;
  const text = applyCase(boxText(box), s);
  const lineH = s.size * s.lineHeight;
  const pad = Math.ceil(
    Math.max(s.outlineWidth * 2, s.shadow.on ? Math.abs(s.shadow.x) + Math.abs(s.shadow.y) + s.shadow.blur : 0, s.roughen.on ? s.roughen.amount + 2 : 0) + 4,
  );

  const isCurve = s.curve && s.curve !== 0 && text.trim() !== '';

  // ---- 1. Lay out text and compute its real bounds relative to the box rect.
  // Bounds are expressed as overflow distances beyond each edge of the box
  // (0 when the text fits inside that edge).
  let lines = null;
  let layout = null;
  let leftExtra = 0,
    rightExtra = 0,
    topExtra = 0,
    bottomExtra = 0;

  if (isCurve) {
    // Curved single-line: glyphs are positioned around the box center. Find the
    // glyph extent (incl. half a glyph's size as a rough cap for stroke/shape).
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
    // Glyph coords are relative to box center; convert to per-edge overflow.
    leftExtra = Math.max(0, -minX - box.w / 2);
    rightExtra = Math.max(0, maxX - box.w / 2);
    topExtra = Math.max(0, -minY - box.h / 2);
    bottomExtra = Math.max(0, maxY - box.h / 2);
  } else {
    // box.w - 4 = content width (the box has 2px horizontal padding each side),
    // so export breaks lines exactly where the editor's CSS does.
    lines = wrapLinesDOM(text, s, s.size, box.w - 4);
    const blockH = lines.length * lineH;
    const blockW = maxLineWidth(lines, s, s.size);

    // Vertical overflow depends on valign (mirrors flex align-items).
    if (s.valign === 'middle') {
      const o = Math.max(0, (blockH - box.h) / 2);
      topExtra = o;
      bottomExtra = o;
    } else if (s.valign === 'bottom') {
      topExtra = Math.max(0, blockH - box.h); // block ends at box bottom
    } else {
      bottomExtra = Math.max(0, blockH - box.h); // top: block starts at box top
    }

    // Horizontal overflow depends on text-align (line wider than box.w spills).
    const hOver = Math.max(0, blockW - box.w);
    if (s.align === 'center') {
      leftExtra = hOver / 2;
      rightExtra = hOver / 2;
    } else if (s.align === 'right') {
      leftExtra = hOver; // anchored at box right → spills left
    } else {
      rightExtra = hOver; // left: anchored at box left → spills right
    }
  }

  // ---- 2. Size the canvas to box + overflow + pad (for stroke/shadow/roughen).
  leftExtra = Math.ceil(leftExtra);
  rightExtra = Math.ceil(rightExtra);
  topExtra = Math.ceil(topExtra);
  bottomExtra = Math.ceil(bottomExtra);
  const ox = leftExtra + pad; // box's top-left X inside the canvas
  const oy = topExtra + pad; // box's top-left Y inside the canvas
  const cw = Math.ceil(box.w + leftExtra + rightExtra + pad * 2);
  const ch = Math.ceil(box.h + topExtra + bottomExtra + pad * 2);

  // Supersample non-roughened text 2x: render the glyphs at double resolution so
  // that downsampling them onto the page canvas yields crisp edges (fixes export
  // blur). Roughened boxes stay 1x — their effect is pixel-space displacement
  // (getImageData/putImageData) that must match the composited resolution.
  const SS = s.roughen.on ? 1 : 2;
  const cnv = document.createElement('canvas');
  cnv.width = cw * SS;
  cnv.height = ch * SS;
  const ctx = cnv.getContext('2d');
  ctx.scale(SS, SS); // all drawing stays in native units; SS handled here
  ctx.imageSmoothingQuality = 'high';
  const family = familyFor(s);
  ctx.font = fontShorthand(s, s.size, family);
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const strokeFill = (drawFns) => {
    // shadow pass
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
    // outline
    if (s.outlineWidth > 0) {
      ctx.strokeStyle = s.outline;
      ctx.lineWidth = s.outlineWidth * 2;
      drawFns.stroke();
    }
    ctx.fillStyle = s.color;
    drawFns.fill();
  };

  if (isCurve) {
    // curved single-line layout along a circular arc, centered on the box.
    const cx = ox + box.w / 2;
    const cy = oy + box.h / 2;
    const prevBaseline = ctx.textBaseline;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const place = (cb) => {
      for (const g of layout) {
        ctx.save();
        ctx.translate(cx + g.x, cy + g.y);
        ctx.rotate(g.rot);
        cb(g.ch, 0, 0);
        ctx.restore();
      }
    };
    strokeFill({
      stroke: () => place((ch, x, y) => ctx.strokeText(ch, x, y)),
      fill: () => place((ch, x, y) => ctx.fillText(ch, x, y)),
    });
    ctx.textBaseline = prevBaseline;
  } else {
    // straight multi-line layout. The text block is positioned relative to the
    // box rectangle (whose top-left sits at ox,oy inside the enlarged canvas).
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${s.letterSpacing}px`;
    const blockH = lines.length * lineH;
    let startY = oy;
    if (s.valign === 'middle') startY = oy + (box.h - blockH) / 2;
    else if (s.valign === 'bottom') startY = oy + (box.h - blockH);
    ctx.textAlign = s.align;
    const anchorX = s.align === 'left' ? ox : s.align === 'right' ? ox + box.w : ox + box.w / 2;
    const drawAll = (fn) => {
      lines.forEach((ln, i) => fn(ln, anchorX, startY + i * lineH + (lineH - s.size) / 2));
    };
    strokeFill({
      stroke: () => drawAll((ln, x, y) => ctx.strokeText(ln, x, y)),
      fill: () => drawAll((ln, x, y) => ctx.fillText(ln, x, y)),
    });
  }

  if (s.roughen.on) roughen(ctx, cw, ch, s.roughen.amount, s.roughen.detail, s.roughen.seed);
  // cw/ch are the NATIVE (unscaled) draw size; the caller downsamples the SSx
  // bitmap into that footprint.
  return { canvas: cnv, pad, leftExtra, topExtra, cw, ch };
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
    const { canvas: bc, pad, leftExtra, topExtra, cw, ch } = renderBox(box);
    ctx.save();
    ctx.globalAlpha = box.style.opacity ?? 1;
    const rot = box.style.rotation || 0;
    if (rot === 0) {
      // Integer-snap the bitmap origin so a sub-pixel box position doesn't force
      // a bilinear resample of the whole text block (the primary export blur).
      // The box's top-left sits at (box.x - leftExtra - pad) inside the bitmap.
      const originX = Math.round(box.x - leftExtra - pad);
      const originY = Math.round(box.y - topExtra - pad);
      ctx.drawImage(bc, originX, originY, cw, ch);
    } else {
      // Rotated: pivot around the box center like the editor rotates .tbox, and
      // downsample the SSx bitmap into its native footprint.
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(bc, -(box.w / 2 + leftExtra + pad), -(box.h / 2 + topExtra + pad), cw, ch);
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
