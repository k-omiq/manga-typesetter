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

// ===== The projective corner, for the four-handle case =====
//
// Piecewise affine is the right mapping for a GRID: each cell is small, and
// two triangles per cell is what CSP's mesh transform draws too. It is the
// wrong mapping for ONE cell. Drag a single corner of a 1x1 mesh and the two
// triangles no longer agree about the diagonal's interior: each is exact at
// its own three corners and linear in between, so the pair meets at a crease
// running corner to corner - the failure every naive quad-warp has, and the
// one thing a four-handle Free Transform must not do, because a perspective
// drag is exactly what it is for.
//
// The map that carries a rectangle onto an arbitrary quadrilateral without a
// crease is the projective one, `solveHomography` below. The painter does not
// draw through it directly (canvas 2D has no projective transform): it
// evaluates it on a fine virtual grid and draws THAT with the same
// affine-per-triangle technique, where the cells are small enough for the
// piecewise error to fall under a pixel. So there is one drawing technique in
// the app, and this is only where the corners of its cells come from.
//
// `warpPoint` deliberately stays piecewise affine, including for a 1x1 mesh:
// it is the reviewed READ side (hit-tests, resampling) and its answers are
// already stated in terms of the triangles. Inside one cell the two disagree
// by at most the crease this exists to remove - sub-pixel for anything a
// gizmo drag produces, and never at a control point, where both are exact.

// Whether a quad is a parallelogram, which is the same question as "is the
// affine map already exact here": TL + BR and TR + BL are the two diagonals'
// midpoints doubled, and they coincide only for a parallelogram. Points in
// polygon order (tl, tr, br, bl). The tolerance is relative to the quad's own
// size, so it means the same thing on a 20px box and a 2000px one.
export function isParallelogram(quad, eps = 1e-6) {
  if (!Array.isArray(quad) || quad.length < 4) return true;
  const [a, b, c, d] = quad.map(pt);
  const dx = a[0] + c[0] - b[0] - d[0];
  const dy = a[1] + c[1] - b[1] - d[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true;
  let span = 0;
  for (const p of [a, b, c, d]) {
    span = Math.max(span, Math.abs(p[0] - a[0]), Math.abs(p[1] - a[1]));
  }
  return Math.hypot(dx, dy) <= Math.abs(eps) * Math.max(1, span);
}

// A quad a projective map can be built onto: four points in polygon order,
// turning the same way at every corner, with no three of them in a line. A
// crossed ("bowtie") or dented quad - what a corner dragged past its own
// diagonal makes - has no honest homography onto it, and the painter falls
// back to the two triangles for that case rather than inventing one.
function convexQuad(q, eps = 1e-9) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const cross = ux * vy - uy * vx;
    // Relative to the two edges it is built from, so "in a line" means the
    // same thing whatever the box is measured in.
    const scale = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (!(scale > 0) || Math.abs(cross) <= eps * scale) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Gaussian elimination with partial pivoting over an n x (n+1) augmented
// matrix, in place. Returns the solution vector, or null when the system is
// singular - which for the system below means the two quads do not determine a
// map.
function solveLinear(rows, n) {
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[best][col])) best = r;
    }
    const piv = rows[best][col];
    if (!Number.isFinite(piv) || Math.abs(piv) < 1e-12) return null;
    const t = rows[col];
    rows[col] = rows[best];
    rows[best] = t;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = rows[r][col] / piv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) rows[r][c] -= f * rows[col][c];
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = rows[i][n] / rows[i][i];
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

// The projective map taking `src`'s four corners onto `dst`'s, as the nine
// coefficients of the 3x3 matrix in row-major order, normalised so the last is
// 1:
//
//   x' = (h0*x + h1*y + h2) / (h6*x + h7*y + 1)
//   y' = (h3*x + h4*y + h5) / (h6*x + h7*y + 1)
//
// Both quads are given in the SAME polygon order (the painter passes
// tl, tr, br, bl). Four point pairs fix the eight unknowns exactly, so this is
// a solve and not a fit.
//
// Returns null when either quad is degenerate or non-convex, or when the
// system does not resolve. Null is not a failure to be worked around: it is
// this module saying the piecewise-affine mapping is the one to draw.
export function solveHomography(src, dst) {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length < 4 || dst.length < 4) return null;
  const s = src.slice(0, 4).map(pt);
  const d = dst.slice(0, 4).map(pt);
  for (const p of [...s, ...d]) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  }
  if (!convexQuad(s) || !convexQuad(d)) return null;
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = s[i];
    const [u, v] = d[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solveLinear(rows, 8);
  if (!h) return null;
  return [...h, 1];
}

// A point through a homography. `[NaN, NaN]` on the map's horizon - the line
// where the denominator vanishes and there is no image point at all - so a
// caller that maps a grid can see the failure rather than draw through it.
export function applyHomography(h, x, y) {
  const X = +x;
  const Y = +y;
  if (!Array.isArray(h) || h.length < 9) return [X, Y];
  const w = h[6] * X + h[7] * Y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(h[0] * X + h[1] * Y + h[2]) / w, (h[3] * X + h[4] * Y + h[5]) / w];
}

// Whether a style's warp changes anything, which is the question every renderer
// asks before it pays for a texture pass.
//
// The box's size is optional because the two callers know different things.
// The painter has the box and passes it, so an identity mesh is skipped
// exactly - the box draws the bytes it drew before the feature existed. The PSD
// exporter's `isRasterOnly` is handed a style alone; without the box, a mesh
// that is switched on and fully stated counts as active, which errs towards a
// flat raster layer rather than towards a live type layer Photoshop would
// re-render unwarped.
export function warpActive(style, w, h) {
  const wp = style?.warp;
  if (!wp?.on) return false;
  const c = gridN(wp.cols);
  const r = gridN(wp.rows);
  const pts = wp.pts;
  if (!Array.isArray(pts) || pts.length !== (c + 1) * (r + 1)) return false;
  if (!(Number(w) > 0) || !(Number(h) > 0)) return true;
  return !isIdentityMesh(pts, c, r, w, h);
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
