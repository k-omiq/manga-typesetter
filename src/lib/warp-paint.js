// ===== Drawing through the mesh =====
//
// One pass, used by both renderers: the box is already a finished picture on a
// canvas - type, ink, shadows, blur, smear, mask, all of it - and this carries
// that texture through the mesh onto a new one. `warp.js` owns the geometry and
// knows nothing about canvases; this file owns the canvas and works out no
// geometry of its own beyond the two things a rasteriser needs and pure maths
// does not: how far past the mesh the destination has to reach, and how much
// each triangle has to overdraw so the joins between them do not show.
//
// The texture is the whole box FOOTPRINT, not the box rect: a glyph can hang
// out of its box and ink is routinely drawn over the edge, and warping a box
// must not be the thing that crops them. So the mesh's own cells are drawn, and
// around them a band of cells covering the rest of the footprint, mapped by
// extending the outermost cell - which is exactly what `warpPoint` does with a
// point outside the grid, so the extension is continuous with the inside and is
// stated in one place.

import {
  identityMesh,
  isIdentityMesh,
  affineFromTriangle,
  warpPoint,
  solveHomography,
  applyHomography,
  isParallelogram,
} from './warp.js';

// How far past the deformed mesh the destination canvas reaches, page px. Two
// is the antialiasing bleed: a triangle whose edge lands on the last pixel of
// the canvas has half its coverage cut off, and the overdraw guard below pushes
// each edge out by a fraction of a pixel more.
export const WARP_PAD = 2;

// How finely the four-corner case is subdivided before it is drawn. Eight by
// eight is 64 cells over the box, which puts the piecewise error of a strong
// perspective drag under a pixel while costing 128 triangles - a fraction of
// what the same box costs to lay out and paint in the first place.
export const WARP_SUB = 8;

// How far each destination triangle's clip is grown, page px. Canvas antialiases
// a clip edge, so two triangles meeting along a shared edge each cover about
// half of the pixels on it and composite to about three quarters - a hairline
// of background showing through every join. Growing both clips past the join
// makes each one cover it fully, and the second draw lands on pixels the first
// already filled. Three quarters of a pixel is enough for the AA ramp and small
// enough that the texture it pulls in from over the edge is the neighbouring
// cell's own content.
export const SEAM_OVERDRAW = 0.75;

// A refusal to draw: the map has sent the footprint somewhere no raster can
// hold it (a projective map's horizon crossing the band, most likely), so the
// plan is thrown away and the caller falls back. Stated as a multiple of the
// source's own size rather than an absolute, so it means the same thing for a
// 40px box and a 4000px one.
const SPAN_LIMIT = 32;

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const gridN = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? v : 1;
};

// One triangle with every EDGE pushed `pad` px outwards: each edge's line is
// offset along its own outward normal and the new corners are where the offset
// lines cross.
//
// It has to be the edges and not the vertices. Moving each vertex `pad` away
// from the centroid is the obvious version and it does not work: on a
// half-cell cut along its diagonal, that displacement moves the diagonal
// itself only a fraction of `pad`, so two neighbouring halves still each cover
// about half of the pixels on their shared edge - and half over half
// composites to three quarters, which is the seam this exists to close. With
// the edge offset at three quarters of a pixel, every pixel the edge crosses
// is COMPLETELY inside at least one of the two triangles, and completely
// inside is the only coverage that composites to opaque.
//
// A miter at a very sharp corner runs away, so the vertex displacement is
// capped; a triangle with no area has no normals and is returned as it came.
export function expandTriangle(tri, pad) {
  const p = num(pad, 0);
  if (!Array.isArray(tri) || tri.length < 3) return tri;
  const a = tri.slice(0, 3).map((q) => [+q?.[0], +q?.[1]]);
  if (!p || !a.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) return a;
  // One offset line per edge, as `n . x = c` with `n` pointing away from the
  // triangle's third corner.
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = a[i];
    const [bx, by] = a[(i + 1) % 3];
    const [cx, cy] = a[(i + 2) % 3];
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) return a;
    let nx = ey / len;
    let ny = -ex / len;
    if (nx * (cx - ax) + ny * (cy - ay) > 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push([nx, ny, nx * ax + ny * ay + p]);
  }
  const out = [];
  for (let i = 0; i < 3; i++) {
    // Vertex i is where the edges (i-1, i) and (i, i+1) meet, so it is the
    // crossing of those two offset lines.
    const [n1x, n1y, c1] = lines[(i + 2) % 3];
    const [n2x, n2y, c2] = lines[i];
    const det = n1x * n2y - n2x * n1y;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return a;
    let x = (c1 * n2y - c2 * n1y) / det;
    let y = (n1x * c2 - n2x * c1) / det;
    const dx = x - a[i][0];
    const dy = y - a[i][1];
    const d = Math.hypot(dx, dy);
    const cap = Math.abs(p) * 10;
    if (d > cap) {
      x = a[i][0] + (dx / d) * cap;
      y = a[i][1] + (dy / d) * cap;
    }
    out.push([x, y]);
  }
  return out;
}

// The source grid lines for one axis: the mesh's own cell boundaries, plus the
// band the footprint reaches past them. Returns the coordinates and, for each,
// which mesh column/row it is (-1 for a band line, which has no control point
// and is mapped rather than read).
function axisLines(n, size, lo, hi) {
  const at = [];
  for (let i = 0; i <= n; i++) at.push({ v: (size * i) / n, k: i });
  if (Number.isFinite(lo) && lo < at[0].v) at.unshift({ v: lo, k: -1 });
  if (Number.isFinite(hi) && hi > at[at.length - 1].v) at.push({ v: hi, k: -1 });
  return at;
}

// Every cell of a rectangular grid as two triangles, cut top-left to
// bottom-right and emitted (tl, tr, br) then (tl, br, bl) - the same convention
// `cellTriangles` states, for the same reason: both halves carry the diagonal's
// endpoints as the same coordinates read from the same entries, so a cell's own
// diagonal cannot open a gap.
function gridTriangles(xs, ys, dst) {
  const w = xs.length;
  const out = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const tl = j * w + i;
      const tr = j * w + i + 1;
      const bl = (j + 1) * w + i;
      const br = (j + 1) * w + i + 1;
      const s = {
        tl: [xs[i].v, ys[j].v],
        tr: [xs[i + 1].v, ys[j].v],
        bl: [xs[i].v, ys[j + 1].v],
        br: [xs[i + 1].v, ys[j + 1].v],
      };
      out.push({ src: [s.tl, s.tr, s.br], dst: [dst[tl], dst[tr], dst[br]] });
      out.push({ src: [s.tl, s.br, s.bl], dst: [dst[tl], dst[br], dst[bl]] });
    }
  }
  return out;
}

// One candidate plan: map every grid point, refuse the whole thing if any of
// them is unusable or if the result has flown off to somewhere no canvas can
// hold. Refusing as a whole is deliberate - half a warped box is worse than an
// unwarped one, and the caller has a fallback to take.
function planFor(xs, ys, map, span) {
  const dst = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const y of ys) {
    for (const x of xs) {
      const q = map(x, y);
      const px = +q?.[0];
      const py = +q?.[1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
      dst.push([px, py]);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!Number.isFinite(minX)) return null;
  if (maxX - minX > span * SPAN_LIMIT || maxY - minY > span * SPAN_LIMIT) return null;
  return { tris: gridTriangles(xs, ys, dst), bounds: { minX, minY, maxX, maxY } };
}

// What the painter draws: `{ tris, bounds, projective }` in box-local page px,
// or null when there is nothing to do (an identity mesh, or a mesh that cannot
// be drawn at all).
//
// `rect` is the texture's own extent in box-local px - `{ x, y, w, h }`, with a
// negative origin for the overhang above and left of the box - and is what the
// band of cells is sized from. Omit it and only the box rect is carried.
//
// The four-handle case goes through the projective map when the quad asks for
// one: one cell drawn as two triangles creases along its diagonal, so the quad
// is subdivided into `sub` x `sub` virtual cells whose corners come from the
// homography. A quad that is already a parallelogram takes the plain path - the
// affine map is exact there, and both routes draw the same picture.
export function warpPlan(warp, w, h, rect = null, opts = {}) {
  const W = num(w);
  const H = num(h);
  if (!(W > 0) || !(H > 0)) return null;
  const cols = gridN(warp?.cols);
  const rows = gridN(warp?.rows);
  const pts = warp?.pts;
  if (isIdentityMesh(pts, cols, rows, W, H)) return null;

  const sub = gridN(opts.sub ?? WARP_SUB);
  const x0 = rect ? Math.min(0, num(rect.x)) : 0;
  const y0 = rect ? Math.min(0, num(rect.y)) : 0;
  const x1 = rect ? Math.max(W, num(rect.x) + num(rect.w)) : W;
  const y1 = rect ? Math.max(H, num(rect.y) + num(rect.h)) : H;
  const span = Math.max(x1 - x0, y1 - y0, W, H);

  // The plain reading of the mesh: the control points themselves at the grid's
  // own corners, and the outermost cell extended for the band around them.
  const affine = () => {
    const xs = axisLines(cols, W, x0, x1);
    const ys = axisLines(rows, H, y0, y1);
    const map = (x, y) =>
      x.k >= 0 && y.k >= 0
        ? pts[y.k * (cols + 1) + x.k]
        : warpPoint(pts, cols, rows, W, H, x.v, y.v);
    return planFor(xs, ys, map, span);
  };

  if (cols === 1 && rows === 1) {
    const quad = [pts[0], pts[1], pts[3], pts[2]]; // row-major tl,tr,bl,br -> polygon order
    if (!isParallelogram(quad)) {
      const src = identityMesh(1, 1, W, H);
      const m = solveHomography([src[0], src[1], src[3], src[2]], quad);
      if (m) {
        const xs = axisLines(sub, W, x0, x1);
        const ys = axisLines(sub, H, y0, y1);
        const plan = planFor(xs, ys, (x, y) => applyHomography(m, x.v, y.v), span);
        // A horizon crossing the band, or a quad so extreme the raster would be
        // useless: the two triangles are a worse picture than this one, but they
        // are a picture.
        if (plan) return { ...plan, projective: true };
      }
    }
  }
  const plan = affine();
  return plan && { ...plan, projective: false };
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Draw the finished box texture `src` through the mesh, onto a canvas of its
// own. Returns `{ canvas, ox, oy, cw, ch }` in the same terms the texture came
// in - `ox`/`oy` is where the box's top-left sits inside the footprint, `cw`/`ch`
// is the footprint in page px - or null when the mesh does nothing, which is the
// caller's signal to keep the texture it already has, byte for byte.
//
// `ss` is the texture's supersampling: it is drawn at its own pixel size, so
// nothing is resampled here beyond the warp itself.
export function warpBoxCanvas(src, opts = {}) {
  const { warp, w, h, ox, oy, cw, ch } = opts;
  const ss = num(opts.ss, 1) || 1;
  const pad = num(opts.pad ?? WARP_PAD);
  const overdraw = num(opts.overdraw ?? SEAM_OVERDRAW);
  const make = opts.makeCanvas ?? newCanvas;
  const plan = warpPlan(warp, w, h, { x: -ox, y: -oy, w: cw, h: ch }, { sub: opts.sub });
  if (!plan) return null;

  // The destination, sized to what the mesh actually covers plus the AA bleed,
  // and snapped outwards to whole page px so the box's origin inside it stays an
  // integer offset - which is what lets the page composite go on snapping the
  // bitmap to the pixel grid.
  const left = Math.floor(plan.bounds.minX - pad);
  const top = Math.floor(plan.bounds.minY - pad);
  const right = Math.ceil(plan.bounds.maxX + pad);
  const bottom = Math.ceil(plan.bounds.maxY + pad);
  const outW = Math.max(1, right - left);
  const outH = Math.max(1, bottom - top);
  const canvas = make(Math.max(1, Math.round(outW * ss)), Math.max(1, Math.round(outH * ss)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Box-local page px, at the texture's own resolution.
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.translate(-left, -top);

  for (const tri of plan.tris) {
    const m = affineFromTriangle(tri.src, tri.dst);
    if (!m) continue; // a cell with no area covers no pixels either
    const e = expandTriangle(tri.dst, overdraw);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e[0][0], e[0][1]);
    ctx.lineTo(e[1][0], e[1][1]);
    ctx.lineTo(e[2][0], e[2][1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    // Now in the texture's own (pre-warp) box-local coordinates: its top-left
    // corner is (-ox, -oy) there, and it is `cw` x `ch` page px across.
    ctx.drawImage(src, -ox, -oy, cw, ch);
    ctx.restore();
  }
  return { canvas, ox: -left, oy: -top, cw: outW, ch: outH };
}
