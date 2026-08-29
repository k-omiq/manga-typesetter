// ===== The mesh warp engine =====
//
// Pure geometry, no canvas and no DOM: the tests run in node, and the three
// places that have to agree about where a warped pixel lands - the editor's
// canvas, the exporter's box layer, and the gizmo's handles - each ask this
// module rather than working the mapping out for themselves.
//
// The model is CSP's: one control at two grid sizes. `cols`/`rows` of 1 gives a
// 2x2 grid of control points, which is Free Transform's four corner handles; a
// larger grid is Mesh Transform. The control points live on the style as
// `warp.pts`, box-local page px, row-major, (cols+1) * (rows+1) of them, and
// the identity mesh - the one that changes nothing - is exactly the grid laid
// out over the box rect.
//
// Rendering is piecewise affine, not a homography: each cell is split into two
// triangles and each triangle is drawn under the affine map its three corners
// define. That is the only mapping in this file. Hit-testing (`warpPoint`) and
// grid resampling (`resampleMesh`) go through the same triangles, so what the
// gizmo says a point does is what the painter actually does to it.
//
// Nothing here clamps `cols`/`rows` to the 1..8 the panel offers: that is the
// sanitiser's job in data.js, which this module deliberately does not import so
// that both stay leaves.

// A grid whose size is not a usable count is one cell. Every entry point runs
// its cols/rows through here, so a caller cannot divide by zero from outside.
const gridN = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? v : 1;
};

// Row-major index of the control point at column `i`, row `j`.
const idx = (i, j, cols) => j * (cols + 1) + i;

// The identity position of one grid point. Written as `(w * i) / cols` rather
// than `i * (w / cols)` and used by everything that needs an identity corner,
// so the last column lands on exactly `w` and every caller agrees to the bit.
const gridPoint = (i, j, cols, rows, w, h) => [(w * i) / cols, (h * j) / rows];

// A point copied out of a caller's array, coerced. Copied rather than aliased:
// these come off the live style, and a painter that nudged one would be editing
// the document.
const pt = (p) => [+p?.[0], +p?.[1]];

// The undeformed mesh: a `cols` x `rows` grid of cells over a box `w` by `h`,
// as (cols+1) * (rows+1) points in row-major order, top-left first. This is
// both the starting value a gizmo hands the user and the source ("texture")
// space every triangle maps FROM.
export function identityMesh(cols, rows, w, h) {
  const c = gridN(cols);
  const r = gridN(rows);
  const W = Number(w) || 0;
  const H = Number(h) || 0;
  const out = [];
  for (let j = 0; j <= r; j++) {
    for (let i = 0; i <= c; i++) out.push(gridPoint(i, j, c, r, W, H));
  }
  return out;
}

// Whether this mesh does nothing, so the painter can skip the whole texture
// pass and draw the box the way it always did. Three states read as identity:
//
//   - no pts at all (the stored default, and what the sanitiser resets to)
//   - a pts array whose length does not match the grid (undrawable)
//   - every point within `eps` px of where the identity grid puts it
//
// The default epsilon is a hundredth of a page pixel: far below anything a drag
// can produce, but enough that a mesh rebuilt through a resample and back does
// not read as deformed on floating-point dust alone.
export function isIdentityMesh(pts, cols, rows, w, h, eps = 0.01) {
  const id = identityMesh(cols, rows, w, h);
  if (!Array.isArray(pts) || pts.length !== id.length) return true;
  const e = Math.abs(Number(eps)) || 0;
  for (let k = 0; k < id.length; k++) {
    const x = +pts[k]?.[0];
    const y = +pts[k]?.[1];
    // An unreadable point cannot be drawn, so the mesh it sits in cannot be
    // drawn either - it reads as identity and the pass is skipped rather than
    // painting a torn box.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    if (Math.abs(x - id[k][0]) > e || Math.abs(y - id[k][1]) > e) return false;
  }
  return true;
}

// Every cell of the mesh as two triangles: `{ src, dst }`, where `src` is the
// triangle in texture space (the identity grid over w x h, which is what the
// box was rendered into) and `dst` is where it goes.
//
// THE DIAGONAL, and this is the guarantee the painter leans on: every cell is
// cut top-left to bottom-right, and the two halves are emitted as
// `(tl, tr, br)` then `(tl, br, bl)`. Both carry the same two endpoints of that
// diagonal, as the same coordinates read from the same array entries - never
// recomputed, never rounded a second time. So the shared edge of a cell's two
// triangles is identical in both, in src and in dst alike: no hairline gap can
// open along a cell's own diagonal, and no diagonal is ever drawn twice at two
// slightly different places. (Seams BETWEEN neighbouring cells are the
// painter's problem, not this module's - the cells share their edge points the
// same way, but a rasteriser still needs its overdraw guard.)
//
// A `pts` that does not match the grid is treated as identity, so a caller that
// hands over junk gets an undeformed draw rather than nothing.
export function cellTriangles(pts, cols, rows, w, h) {
  const c = gridN(cols);
  const r = gridN(rows);
  const src = identityMesh(c, r, w, h);
  const dst = Array.isArray(pts) && pts.length === src.length ? pts : src;
  const out = [];
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < c; i++) {
      const tl = idx(i, j, c);
      const tr = idx(i + 1, j, c);
      const bl = idx(i, j + 1, c);
      const br = idx(i + 1, j + 1, c);
      out.push({
        src: [pt(src[tl]), pt(src[tr]), pt(src[br])],
        dst: [pt(dst[tl]), pt(dst[tr]), pt(dst[br])],
      });
      out.push({
        src: [pt(src[tl]), pt(src[br]), pt(src[bl])],
        dst: [pt(dst[tl]), pt(dst[br]), pt(dst[bl])],
      });
    }
  }
  return out;
}

// The canvas transform `[a, b, c, d, e, f]` that carries the three points of
// `src` onto the three of `dst`:
//
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
//
// which is the argument order `ctx.transform` / `ctx.setTransform` take. Three
// point pairs determine an affine map exactly, so there is nothing to fit and
// nothing to approximate - it is a 2x2 solve against the two edge vectors from
// the first vertex. A degenerate source triangle (three collinear points, or a
// box with no width) determines nothing and returns null; the caller skips it,
// because a triangle with no area covers no pixels either.
export function affineFromTriangle(src, dst) {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length < 3 || dst.length < 3) return null;
  const [p0, p1, p2] = src.map(pt);
  const [q0, q1, q2] = dst.map(pt);
  const u1x = p1[0] - p0[0];
  const u1y = p1[1] - p0[1];
  const u2x = p2[0] - p0[0];
  const u2y = p2[1] - p0[1];
  const det = u1x * u2y - u2x * u1y;
  // The floor is on the AREA, not on a coordinate: a sliver a thousandth of a
  // pixel across would invert into coefficients no rasteriser can use.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const v1x = q1[0] - q0[0];
  const v1y = q1[1] - q0[1];
  const v2x = q2[0] - q0[0];
  const v2y = q2[1] - q0[1];
  const a = (v1x * u2y - v2x * u1y) / det;
  const c = (v2x * u1x - v1x * u2x) / det;
  const b = (v1y * u2y - v2y * u1y) / det;
  const d = (v2y * u1x - v1y * u2x) / det;
  const e = q0[0] - (a * p0[0] + c * p0[1]);
  const f = q0[1] - (b * p0[0] + d * p0[1]);
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  return [a, b, c, d, e, f];
}

// Where the box-local point (x, y) ends up once the mesh has been applied: find
// the cell it falls in, pick the half of that cell the diagonal puts it on, and
// run it through that triangle's affine. Returns a fresh `[x, y]`.
//
// This is the READ side of the warp - hit-testing a click against a deformed
// box, placing a gizmo label, asking where a stroke's point went - and it is
// deliberately the same mapping `cellTriangles` hands the painter, so the two
// can never disagree about a pixel.
//
// OUTSIDE THE GRID: a point beyond the box rect is resolved against the nearest
// cell, which extends that cell's affine outwards. The result is continuous
// with the inside and, for a warp that only moves things a little, sensible;
// it is not a claim that content far outside the box lands anywhere in
// particular. A box with no area, or a point that is not a number, comes back
// unchanged.
export function warpPoint(pts, cols, rows, w, h, x, y) {
  const px = +x;
  const py = +y;
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return [px, py];
  if (!(W > 0) || !(H > 0)) return [px, py];
  const c = gridN(cols);
  const r = gridN(rows);
  const n = (c + 1) * (r + 1);
  // Identity mesh, or one that cannot be read as one: nothing moves.
  if (!Array.isArray(pts) || pts.length !== n) return [px, py];

  // The cell, clamped: a point off the top-left belongs to cell 0, one off the
  // bottom-right to the last cell.
  const i = Math.min(c - 1, Math.max(0, Math.floor((px * c) / W)));
  const j = Math.min(r - 1, Math.max(0, Math.floor((py * r) / H)));
  const [x0, y0] = gridPoint(i, j, c, r, W, H);
  const [x1, y1] = gridPoint(i + 1, j + 1, c, r, W, H);
  // Position within the cell, 0..1 inside it. The cell is cut along u == v, so
  // v <= u is the upper-right half - the (tl, tr, br) triangle - and the rest
  // is the lower-left (tl, br, bl) one. A point exactly on the diagonal takes
  // the first, and both give the same answer there anyway.
  const u = (px - x0) / (x1 - x0);
  const v = (py - y0) / (y1 - y0);

  const tl = idx(i, j, c);
  const tr = idx(i + 1, j, c);
  const bl = idx(i, j + 1, c);
  const br = idx(i + 1, j + 1, c);
  const corner = (k, ci, cj) => [gridPoint(ci, cj, c, r, W, H), pt(pts[k])];
  const [sTL, dTL] = corner(tl, i, j);
  const [sBR, dBR] = corner(br, i + 1, j + 1);
  let m;
  if (v <= u) {
    const [sTR, dTR] = corner(tr, i + 1, j);
    m = affineFromTriangle([sTL, sTR, sBR], [dTL, dTR, dBR]);
  } else {
    const [sBL, dBL] = corner(bl, i, j + 1);
    m = affineFromTriangle([sTL, sBR, sBL], [dTL, dBR, dBL]);
  }
  if (!m) return [px, py];
  return [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
}

// The same deformation carried onto a different grid size: the NEW grid's
// identity points, each pushed through the OLD mesh. Changing 1x1 to 3x3
// therefore keeps the shape the user already dragged and just gives them more
// handles inside it.
//
// It is not reversible, and that is not a bug to fix. Going the other way -
// 3x3 back to 1x1 - keeps only the four corners, because a 1x1 mesh has nowhere
// to put the interior detail. The Inspector's grid steppers should say so
// (or make the step undoable, which they do: one history step per change).
//
// Sampling goes through `warpPoint`, so the resample reads the mesh exactly as
// the painter draws it. On a cell EDGE that is plain linear interpolation
// between the two neighbouring control points; across a cell's interior it
// follows the triangle the diagonal puts the point in.
export function resampleMesh(oldPts, oldCols, oldRows, newCols, newRows, w, h) {
  return identityMesh(newCols, newRows, w, h).map(([x, y]) =>
    warpPoint(oldPts, oldCols, oldRows, w, h, x, y),
  );
}

// The rectangle the deformed mesh actually covers, `{ minX, minY, maxX, maxY }`
// or null when there is nothing to bound. A warp pulls content OUTSIDE the box
// rect as readily as inside it, so a painter that sized its canvas to the box
// would clip the drag off; this is what it sizes to instead. Unreadable points
// are skipped rather than poisoning the box with NaN.
export function meshBounds(pts) {
  if (!Array.isArray(pts) || !pts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const x = +p?.[0];
    const y = +p?.[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
