// ===== A brush tip drawn into a small canvas =====
//
// The Svelte action behind every tip thumbnail: the picker's grid, the
// manager's list. Keyed by brush id, so a cell's node never changes brush -
// create and destroy is the whole lifetime, and destroy hands the pixels back,
// because a library of a hundred brushes is a hundred canvases.
import { BUILTIN_BRUSH, brushTip } from './brush-library.svelte.js';

// The backing size of one cell's canvas, in CSS px; scaled by CSS from there.
export const CELL = 64;

// Ink, not the stroke colour: the cell is a tip on paper, and a white brush
// painted on white paper would show an empty square.
const INK = [34, 33, 30];

// A tip PNG is 8-bit greyscale with the ink at 255 and an opaque alpha, which
// is white-on-white until it is turned into coverage. Same transform the
// painter's `buildTinted` runs, at cell size.
function inkify(ctx, w, h) {
  const px = ctx.getImageData(0, 0, w, h);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const cov = (d[i] * d[i + 3]) / 255;
    d[i] = INK[0];
    d[i + 1] = INK[1];
    d[i + 2] = INK[2];
    d[i + 3] = cov;
  }
  ctx.putImageData(px, 0, 0);
}

async function paintCell(node, id, gone) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(CELL * dpr));
  node.width = W;
  node.height = W;
  const ctx = node.getContext('2d');
  if (!ctx) return;
  if (id === BUILTIN_BRUSH) {
    ctx.fillStyle = `rgb(${INK[0]},${INK[1]},${INK[2]})`;
    ctx.beginPath();
    ctx.arc(W / 2, W / 2, W * 0.3, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // One frame's worth of tip - see THE TIP LIFETIME CONTRACT in the library.
  // It is read, drawn, and let go of; the cache decides how long the bitmap
  // itself lives.
  const tip = await brushTip(id);
  if (gone() || !tip?.image) return;
  const iw = Number(tip.image.width) || tip.width;
  const ih = Number(tip.image.height) || tip.height;
  if (!(iw > 0 && ih > 0)) return;
  const pad = Math.round(3 * dpr);
  const k = Math.min((W - pad * 2) / iw, (W - pad * 2) / ih);
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  // Down to cell size first, then converted: the conversion is a pass over
  // every pixel, and the corpus's biggest tip is 27 megapixels.
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  try {
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(tip.image, 0, 0, w, h);
    inkify(sctx, w, h);
    if (gone()) return;
    ctx.drawImage(scratch, Math.round((W - w) / 2), Math.round((W - h) / 2));
  } catch {
    /* a tip that will not decode leaves an empty cell; the name still names it */
  } finally {
    scratch.width = 0;
    scratch.height = 0;
  }
}

export function tipCell(node, id) {
  let dead = false;
  paintCell(node, id, () => dead).catch(() => {});
  return {
    destroy() {
      dead = true;
      node.width = 0;
      node.height = 0;
    },
  };
}
