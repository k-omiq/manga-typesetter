// Native-resolution raster export via canvas 2D. PNG is lossless.
import { app, page, toast, boxText, saveExportPrefs, isLongstrip, PAGE_W, PAGE_H } from './store.svelte.js';
import { familyFor, fontShorthand, applyCase, layoutLines, arcLayout, maxLineWidth, BOX_PAD, balloonWidthsFor } from './measure.js';
import { withPageImages } from './page-images.js';
import { stripOffsets, maxPageWidth } from './editor/strip.js';
import { planStripCuts, boxSpanY, SLICE_H_DEFAULT } from './editor/strip-cuts.js';
// The detected-text JSON serialiser lives in a leaf module so the library can
// write that document on every autosave without importing this file - see the
// note at the top of text-json.js. Re-exported here because this is where every
// existing caller (and the export dialog's JSON format) asks for it.
import { buildTextJson } from './text-json.js';
import { fsx } from './fsx.js';
export { buildTextJson };

// Strip path separators and traversal from the export name, keeping unicode and spaces.
export function sanitizeExportName(name) {
  const s = String(name ?? '')
    .replace(/[/\\]/g, '')
    .replace(/\.\.+/g, '')
    .replace(/^\.+$/, '')
    .trim();
  return s || 'page';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// The page's coordinate space, for an exporter that has to put a number on a
// canvas or in a file header.
//
// `p.w`/`p.h` are it whenever the page has been measured. A page is `w:0,h:0`
// until something decodes its image, and while `createChapter` now measures at
// import, every chapter created before it did is still on disk unmeasured - 23
// of the 28 pages in the author's own chapter. Export All reaches every page,
// including those, and a 0 is not a small error: it is a zero-sized canvas that
// `toBlob` returns an empty (or null) image for, saved under the page's name
// with a success toast over it. The PSD path failed louder - ag-psd throws
// `Invalid document size` - and nothing at all here.
//
// Asking the art is what the canvas would have done one page turn later, so it
// is the same answer either way, and it is the answer the box coordinates on
// that page were authored against.
//
// PAGE_W/PAGE_H remain only for the page that has neither a size nor an image
// to measure. That page exports as a blank sheet at whatever number is chosen,
// and 0 is the one number that makes the file unopenable.
//
// Exported because `psd.js` asks the same question of the same page and has to
// get the same answer: it imports this one rather than keeping a copy, or a
// page could render at one size and write its layers at another.
export async function pageSpace(p) {
  if (p?.w > 0 && p?.h > 0) return { w: p.w, h: p.h };
  const probe = p?.cleaned ?? p?.raw;
  if (probe) {
    try {
      const img = await loadImage(probe);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { w: img.naturalWidth, h: img.naturalHeight };
      }
    } catch {
      /* fall through to the defaults */
    }
  }
  return { w: PAGE_W, h: PAGE_H };
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
// box rect on all sides - mirroring the editor's `overflow:visible` centered
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
  // The text block's top-left inside the box, for the straight-line path. Unused
  // by the curved one, which places every glyph from the box centre.
  let blockX = 0,
    blockY = 0;

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
    // `box.w - BOX_PAD * 2` is the content width (2px horizontal padding each
    // side), so export breaks lines exactly where the editor does - and it is
    // `layoutLines` on both sides, at the same unzoomed size and the same
    // content width, so "exactly" is by construction rather than by two
    // implementations agreeing. Shaping off, that function is still
    // `wrapLinesDOM` and this path is unchanged.
    // The fifth argument is the box's balloon, as one width per line. Same
    // helper, same arguments as the editor and as the PSD's type layers, which
    // is what keeps "the export breaks where the canvas breaks" a construction
    // rather than a coincidence - and null for an unfitted box, so this path is
    // byte for byte what it was.
    lines = layoutLines(text, s, s.size, box.w - BOX_PAD * 2, balloonWidthsFor(box, s, s.size));
    const blockH = lines.length * lineH;
    const blockW = maxLineWidth(lines, s, s.size);

    // Where the block sits inside the box, as an offset from the box's top-left,
    // and the one statement of it: `paintBox` draws from these and the overflow
    // below is measured from them, so the footprint cannot disagree with the
    // painting.
    //
    // The padding is what was missing. The editor's `.tbox` is `padding:2px` on
    // every edge, and wrapping has always been done at `box.w - BOX_PAD * 2` to
    // match - but the block was then anchored at the box's own edge, so a
    // left-aligned box exported 2px further left and a top-aligned one 2px
    // higher than the canvas showed. The auto-height maths made that worse
    // rather than merely visible: `neededHeight` sizes a box as the block plus
    // BOX_PAD on both sides, so every auto-fitted box exported with 4px of slack
    // under its text. Centred alignments were always right and still are - the
    // padding is symmetric, so it cancels.
    blockY =
      s.valign === 'middle'
        ? (box.h - blockH) / 2
        : s.valign === 'bottom'
          ? box.h - BOX_PAD - blockH
          : BOX_PAD;
    blockX =
      s.align === 'center'
        ? (box.w - blockW) / 2
        : s.align === 'right'
          ? box.w - BOX_PAD - blockW
          : BOX_PAD;

    topExtra = Math.max(0, -blockY);
    bottomExtra = Math.max(0, blockY + blockH - box.h);
    leftExtra = Math.max(0, -blockX);
    rightExtra = Math.max(0, blockX + blockW - box.w);
  }

  leftExtra = Math.ceil(leftExtra);
  rightExtra = Math.ceil(rightExtra);
  topExtra = Math.ceil(topExtra);
  bottomExtra = Math.ceil(bottomExtra);
  const ox = leftExtra + pad; // box's top-left X inside the footprint
  const oy = topExtra + pad; // box's top-left Y inside the footprint
  const cw = Math.ceil(box.w + leftExtra + rightExtra + pad * 2);
  const ch = Math.ceil(box.h + topExtra + bottomExtra + pad * 2);
  return { s, lineH, pad, isCurve, lines, layout, leftExtra, topExtra, ox, oy, blockX, blockY, cw, ch };
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
    // Both from `layoutBox`, which is where the padding is applied and the only
    // place it should be. `textAlign` decides which edge of the line `anchorX`
    // names, so the padded content box's own edge is the anchor - its left for
    // left-aligned text, its right for right-aligned, and the box's centre for
    // centred text, which the symmetric padding leaves where it was.
    const startY = L.oy + L.blockY;
    ctx.textAlign = s.align;
    const anchorX =
      s.align === 'left'
        ? L.ox + BOX_PAD
        : s.align === 'right'
          ? L.ox + box.w - BOX_PAD
          : L.ox + box.w / 2;
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
// renderPageBlob so a caller could take the composite ImageData without a Blob
// round-trip; the PSD exporter used to be that caller, first for its merged
// image and flattened-preview layer and then for a thumbnail resource, and has
// no use for it now that a PSD's picture lives entirely in its layers. The
// raster (PNG/JPG/WebP) export path is what's left.
// `scale` supersamples the whole page (2 = 2x pixel dims); because text is
// already rendered 2x internally, an outer scale maps that bitmap 1:1 to device
// pixels - so 2x output stays genuinely sharp, not a soft upscale.
export async function renderPageCanvas(p, scale = 1) {
  // Never `p.w` directly: an unmeasured page is 0, and a 0x0 canvas exports as
  // a broken file with a success toast over it. See `pageSpace`.
  const { w: W, h: H } = await pageSpace(p);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  // white base (JPG has no alpha; manga pages are white anyway)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Background: the cleaned page when there is one, else the raw - mirroring
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
  for (const box of p.boxes ?? []) {
    ctx.save();
    ctx.globalAlpha = box.style.opacity ?? 1;
    paintBoxOnPage(ctx, box, p);
    ctx.restore();
  }
  return canvas;
}

// Draw one box's glyphs onto `ctx` at page coordinates, exactly as the page
// composite does - sharp direct-angle draw for rotated opaque text, raster
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
// sharp pixels the page composite would show for it (opacity NOT baked in -
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

// Render one page to a Blob in the requested raster format (native resolution).
async function renderPageBlob(p, fmt) {
  const canvas = await renderPageCanvas(p);
  const blob = await new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
  if (!blob) {
    throw new Error(`Could not render page ${p?.id ?? ''} (page too large)`.trim());
  }
  return blob;
}

// ---------- longstrip: the chapter as one column, re-cut ----------
//
// A webtoon's source pages are an artefact of how the raw was cut; the files it
// ships as are cut wherever the target site wants them. So a whole-chapter
// raster export of a longstrip project does not write one file per source page:
// it stitches the column and re-slices it at the user's height, with every cut
// moved clear of lettering by `planStripCuts`.
//
// Everything below works in strip pixels - page pixels stacked with no gap,
// which is exactly what `stripOffsets(pages)` answers at zoom 1.

// The strip's arithmetic needs every page's real size, and a page that has never
// been on screen is `w:0,h:0` (see `pageSpace`). Left unmeasured it would
// contribute a zero-height frame: the export would silently drop most of the
// chapter and every offset below it would be wrong. So the sizes are resolved
// once, up front, and written back onto the pages - the same field the editor
// fills in when an image loads, so nothing downstream has to be told twice.
async function measureStrip(pages) {
  for (const p of pages) {
    if (p.w > 0 && p.h > 0) continue;
    // One page's picture at a time: the point of the slice loop below is that
    // the whole chapter is never resident, and measuring must not undo that.
    const { w, h } = await withPageImages(p, () => pageSpace(p));
    p.w = w;
    p.h = h;
  }
  const { tops, total } = stripOffsets(pages);
  return { tops, total, width: maxPageWidth(pages) || PAGE_W };
}

// What a page actually paints into the column: its frame, plus any box that
// hangs off it. A box can be dragged until only 20px of it is still over its own
// page (see TextBox's clamp), so "which pages does this slice need" is not
// answerable from the frames alone.
function pageStripSpan(p, top) {
  let a = top;
  let b = top + Math.max(0, p?.h ?? 0);
  for (const box of p?.boxes ?? []) {
    const s = boxSpanY(box);
    if (top + s.top < a) a = top + s.top;
    if (top + s.bottom > b) b = top + s.bottom;
  }
  return { top: a, bottom: b };
}

// Pin several pages' images for the duration of one call. Nesting rather than
// looping because `withPageImages` releases in its own `finally` - the pins have
// to overlap, not follow one another. Per-page nesting is explicitly fine (the
// pin is a count), and the depth here is however many pages one slice spans.
async function withPagesImages(list, fn) {
  if (!list.length) return fn();
  const [head, ...rest] = list;
  return withPageImages(head, () => withPagesImages(rest, fn));
}

// One output image: the strip from y0 to y1, at the width of the widest page.
//
// `tops` must be the offsets `stripOffsets(pages)` gives for these same pages -
// the caller measures once and slices many times, and the two must agree or the
// seams move.
//
// Narrower pages are centred, which is what the editor's `.strip` does with
// `align-items:center`. A slice is never the whole column: the canvas allocated
// here is one slice tall and is released before the next one is drawn, so a
// 200-page chapter costs one slice of memory rather than a 400,000px raster no
// browser would hand out anyway.
export async function renderStripSliceCanvas(pages, tops, y0, y1, scale = 1) {
  const W = maxPageWidth(pages) || PAGE_W;
  const H = Math.max(1, Math.round(y1 - y0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  // White base, for the same reasons a page has one: JPG has no alpha, and a
  // slice wider than the page it holds shows paper either side of it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high'; // crisp downscale of the supersampled text

  const hits = [];
  pages.forEach((p, i) => {
    const top = tops[i] ?? 0;
    const span = pageStripSpan(p, top);
    if (span.bottom > y0 && span.top < y1) hits.push({ p, top });
  });

  await withPagesImages(
    hits.map((h) => h.p),
    async () => {
      for (const { p, top } of hits) {
        const { w, h } = await pageSpace(p);
        const x = Math.round((W - w) / 2);
        const y = top - y0; // whole pixels: `planStripCuts` rounds every cut
        const base = p.cleaned ?? p.raw;
        if (base) {
          try {
            const img = await loadImage(base);
            ctx.drawImage(img, x, y, w, h);
          } catch {
            /* draw this page's text on white if its image fails */
          }
        }
        // `paintBoxOnPage` draws in page-local coordinates through the current
        // transform - its direct-angle path translates/rotates from it, and its
        // supersampled offscreen path composites through it - so translating to
        // the page's corner in the slice is all this needs. The canvas clips
        // whatever falls outside the slice, which is the neighbouring file's
        // half of a box the cut had to cross.
        for (const box of p.boxes ?? []) {
          ctx.save();
          ctx.translate(x, y);
          ctx.globalAlpha = box.style.opacity ?? 1;
          paintBoxOnPage(ctx, box, p);
          ctx.restore();
        }
      }
    },
  );
  return canvas;
}

// Raster formats - the ones a strip can be re-cut into. PSD stays one layered
// document per source page (its whole value is the editable layers, which a
// stitched slice would fuse across page boundaries) and JSON is one document for
// the chapter either way.
const RASTER = new Set(['PNG', 'JPG', 'WebP']);

// The whole-chapter strip export. Called only from `exportImages`, which already
// holds `app.exporting` across it.
async function exportStripImages(fmt) {
  const pages = app.pages;
  const { tops, total } = await measureStrip(pages);
  const target = app.stripSliceH > 0 ? app.stripSliceH : SLICE_H_DEFAULT;
  const { cuts, warnings } = planStripCuts(pages, target);
  if (!(total > 0) || cuts.length < 2) {
    toast('Nothing to export — this chapter has no page art to slice.');
    return false;
  }
  const ext = EXT[fmt];
  const n = cuts.length - 1;
  const digits = Math.max(2, String(n).length);
  const baseName = sanitizeExportName(app.exportName);
  const items = [];
  for (let i = 0; i < n; i++) {
    const canvas = await renderStripSliceCanvas(pages, tops, cuts[i], cuts[i + 1]);
    const blob = await new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
    // Hand the slice's pixels back before the next one is allocated. A canvas
    // held only by a local is collectable anyway, but "eventually" is not a
    // memory budget when the next line asks for another few hundred megapixels.
    canvas.width = 0;
    canvas.height = 0;
    items.push({
      name: `${baseName}-strip-${String(i + 1).padStart(digits, '0')}.${ext}`,
      blob,
      page: pages[0],
    });
  }
  if (isTauri()) {
    if (!(await saveNative(items, 'all', fmt))) return true; // user cancelled
  } else {
    for (const it of items) downloadBlob(it.blob, it.name);
    toast(`Exported ${items.length} strip slice(s) as ${fmt} (browser download)`);
  }
  if (warnings.length) {
    // Said out loud rather than swallowed: these are the files with a seam
    // through lettering, and the fix (a taller slice, or moving that box) is the
    // user's to make.
    toast(`Saved ${items.length} slice(s) — ${warnings.length} cut(s) had no gap to land in.`);
  }
  return true;
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

// Strip the page id suffix appended by single-page export (e.g. 'Chapter-10-1' → 'Chapter-10')
// only when it matches the actual page ID; otherwise leave the stem untouched so numbered
// chapter names (e.g. 'Chapter-10.png') are not corrupted.
export function stripPageSuffix(stem, pageId) {
  if (pageId == null) return stem;
  const suffix = `-${pageId}`;
  return stem.endsWith(suffix) ? stem.slice(0, -suffix.length) : stem;
}

// Native save via the OS dialog + filesystem (Tauri). Returns the directory used.
async function saveNative(items, scope, fmt) {
  const [{ save, open }, { join, dirname, basename }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
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
    await fsx.writeFileAtomic(path, await blobBytes(first.blob));
    const dir = await dirname(path);
    // Learn the base name from a page file only - the JSON export's name carries
    // a "-text" suffix that must not become the project's export base.
    // Only strip the suffix if it matches the current page id appended by export.
    const stem = (await basename(path)).replace(/\.[^.]+$/, '');
    const base =
      fmt === 'JSON'
        ? app.exportName
        : stripPageSuffix(stem, first?.page?.id);
    saveExportPrefs(dir, base || app.exportName);
    toast(`Saved to ${path}`);
    return dir;
  }
  // scope === 'all' → pick a directory, write every page into it
  const dir = await open({ directory: true, defaultPath: app.exportDir || undefined });
  if (!dir) return null; // cancelled
  for (const it of items) {
    await fsx.writeFileAtomic(await join(dir, it.name), await blobBytes(it.blob));
  }
  saveExportPrefs(dir, app.exportName);
  toast(`Saved ${items.length} file(s) to ${dir}`);
  return dir;
}

// The detected/typeset text for a scope: one document, not one file per page,
// and the same document the export dialog's JSON format produces. Lifted out of
// exportImages so the detect menu and the dialog run identical code - two
// serialisers for one file format would drift the moment either was touched.
// Does NOT set app.exporting: exportImages already holds it across this call,
// and every other caller wraps it the same way.
export async function exportTextJson(scope) {
  const pages = scope === 'all' ? app.pages : [page()];
  const suffix = scope === 'all' ? 'text' : `${pages[0].id}-text`;
  const baseName = sanitizeExportName(app.exportName);
  const items = [
    {
      name: `${baseName}-${suffix}.json`,
      blob: new Blob([buildTextJson(pages)], { type: MIME.JSON }),
      page: pages[0],
    },
  ];
  if (isTauri()) {
    // Always the single-file save dialog - 'all' is still one document.
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

    // A whole longstrip chapter is one column, and the files it ships as are
    // slices of that column rather than its source pages. Only 'all' - a single
    // page is still a single page, and the user asking for "this page" in a
    // strip is asking for the slice they are looking at, not a re-cut of it.
    if (isLongstrip() && scope === 'all' && RASTER.has(fmt)) {
      return await exportStripImages(fmt);
    }

    const baseName = sanitizeExportName(app.exportName);
    const items = [];
    for (const p of pages) {
      // Only five pages' pictures are in memory at a time (see page-images.js),
      // and a whole-chapter export needs all of them - one at a time. This is
      // that: the page is minted if the window does not already hold it, pinned
      // so a page turn mid-export cannot revoke the image being drawn, and
      // handed back when its file is written.
      const blob = await withPageImages(p, async () => {
        if (fmt === 'PSD') {
          // Layered, editable PSD carrying the full project as embedded JSON so
          // it round-trips losslessly (one .psd per page). Lazily imported so
          // ag-psd isn't pulled into the raster-export path.
          const { buildPagePsd } = await import('./psd.js');
          const bytes = await buildPagePsd(p);
          return new Blob([bytes], { type: MIME.PSD });
        }
        return await renderPageBlob(p, fmt);
      });
      items.push({ name: `${baseName}-${p.id}.${ext}`, blob, page: p });
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
