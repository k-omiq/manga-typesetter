// ===== Editing a stroke that is already down =====
//
// Pure geometry, no canvas and no DOM: the tests run in node, and the gestures
// that drive this - the vector eraser and the width tool - must be able to run
// it once per pointer move without dragging a renderer along.
//
// Erasing today is all or nothing: a stroke the eraser touches goes, whole.
// That is the raster reflex applied to vector ink, and it is not what CSP's
// vector layer does. There the eraser has three settings, and this file is the
// two of them that are geometry - "Erase touched parts", which takes out the
// piece under the tool, and "Erase up to intersection", which takes out
// everything from the last line the stroke crossed to the next one, so one tap
// cleans up an overshoot at a corner. `adjustWidth` is the third vector tool,
// the one that thickens or thins a line that is already drawn.
//
// EVERYTHING HERE WORKS ON THE CENTRELINE, not on the inked width. A stroke's
// ink is the tip pressed along the path (see `strokeStamps`), and its extent
// depends on the tip, the taper and the pressure; the cut has to land on the
// path itself or a fat brush would erase far more than the circle the user saw.
// `strokeHit` in `brush.js` still decides WHETHER a gesture touched a stroke,
// on the ink, where the user's eye is; this file decides WHERE the cut falls
// once it has.
//
// THE POINT TUPLE. A point is [x, y, ...factors]: page px, then 0..1 numbers -
// index 2 is the width factor, and a stroke drawn with the opacity and
// thickness dynamics carries two more. Two rules run through every function
// below. A point CREATED between two existing ones interpolates every factor
// linearly, over the longer of the two tuples, a missing one reading as 1 - the
// same reading `resamplePath` and `resampleStroke` take. A point KEPT is copied
// whole, so a factor this module has never heard of survives a cut untouched.
//
// IDENTITY IS THE SIGNAL, as it is in `applyLiquify`: a call that changes
// nothing hands back the SAME stroke object - inside the array, for the two
// that return pieces - and the gesture uses `!==` to decide whether anything
// happened. Nothing is mutated, at any depth.
//
// Sanitising is not this module's job. `data.js` owns what a stored stroke may
// contain; this file, like `liquify.js` and `warp.js`, deliberately imports
// nothing from it so they all stay leaves.

import { falloff } from './liquify.js';

const num = (v) => (Number.isFinite(+v) ? +v : NaN);

// A point kept as it is: the whole tuple, however long, in a fresh array.
const copyPt = (p) => p.slice();

// A point BETWEEN `a` and `b`, at fraction `t`. The result is as long as the
// longer input, and every factor past x and y rides along linearly; a tuple too
// short to have one reads as 1 there, which is the width a point without a
// stored factor draws at.
function lerpPt(a, b, t) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n);
  out[0] = +a[0] + (+b[0] - +a[0]) * t;
  out[1] = +a[1] + (+b[1] - +a[1]) * t;
  for (let k = 2; k < n; k++) {
    const va = a[k] ?? 1;
    const vb = b[k] ?? 1;
    out[k] = va + (vb - va) * t;
  }
  return out;
}

// Whether a point's centre lies inside the tool. Strictly inside: a point at
// exactly the radius sits where the falloff is already zero, and it is the
// point a cut LEAVES BEHIND at the rim, so counting it as touched would eat the
// boundary point the cut just placed.
function inCircle(p, cx, cy, r) {
  return Math.hypot(+p[0] - cx, +p[1] - cy) < r;
}

// ---------------------------------------------------------------------------
// Position along a polyline is one number here: `i + t` says "fraction t of the
// way along segment i", so a whole path is a run from 0 to pts.length - 1 and
// every cut, crossing and vertex is comparable without a pair of indices being
// carried around beside it.

// How close two of those positions have to be to count as the same place, in
// param units. Only used to glue runs that meet exactly at a vertex, where the
// two intervals share an integer, so it only has to survive the arithmetic that
// produced it.
const SPAN_EPS = 1e-9;

// The point at position `s`, always a fresh tuple: an existing point copied
// whole when `s` lands on one, an interpolated one otherwise.
function pointAt(pts, s) {
  const end = pts.length - 1;
  if (!(s > 0)) return copyPt(pts[0]);
  if (s >= end) return copyPt(pts[end]);
  const i = Math.floor(s);
  const t = s - i;
  return t === 0 ? copyPt(pts[i]) : lerpPt(pts[i], pts[i + 1], t);
}

// One kept stretch of the path, [a, b] in param units, as a piece - unless
// there is no stretch there at all. A zero-length keep is where the "at least
// two points" rule bites: a span that starts exactly at a vertex would
// otherwise leave that single vertex behind as a stray dot with no line to it.
function pushPiece(out, stroke, pts, a, b) {
  if (!(b > a)) return;
  const piece = [pointAt(pts, a)];
  // Every original vertex strictly inside the stretch, in order, untouched.
  for (let k = Math.floor(a) + 1; k < b; k++) {
    if (k > a) piece.push(copyPt(pts[k]));
  }
  piece.push(pointAt(pts, b));
  if (piece.length >= 2) out.push({ ...stroke, pts: piece });
}

// The stroke with the given spans of it removed. `spans` is in param units,
// sorted and non-overlapping; what comes back is the gaps between them, each a
// `{ ...stroke, pts }` of its own, so a cut through the middle of a line gives
// two strokes that carry every setting the original had.
function cutSpans(stroke, spans) {
  const pts = stroke.pts;
  const end = pts.length - 1;
  const out = [];
  let a = 0;
  for (const [lo, hi] of spans) {
    pushPiece(out, stroke, pts, a, Math.min(lo, end));
    a = Math.max(a, Math.min(hi, end));
  }
  pushPiece(out, stroke, pts, a, end);
  return out;
}

// Merge a list of param spans that may overlap or touch into the fewest that
// cover the same ground. Two runs of the path reaching back to the same
// crossing is the ordinary case in `cutToIntersection`, and removing the same
// stretch twice would cut a piece out of nothing.
function mergeSpans(spans) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + SPAN_EPS) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two intersection tests. Both are exported because the tests read better
// stating a crossing's parameters outright than inferring them from the pieces
// a cut left, and because the gesture's hit test wants the circle one.

// Where the segment (x0, y0)-(x1, y1) is inside the circle at (cx, cy) of
// radius r, as `[tEnter, tExit]` clipped to the segment, or null when it is not
// inside it anywhere.
//
// tEnter is 0 when the segment starts inside and tExit is 1 when it ends
// inside, so the two numbers say both where the crossings are and whether there
// were any. Solving |P0 + t*d - C|^2 = r^2 gives the two roots; the stretch
// between them is the inside, and clipping it to 0..1 is the segment's share.
//
// A TOUCH IS NOT A CROSSING. A segment that grazes the circle - a tangent, or
// one that ends exactly on the rim - leaves an inside stretch of zero length,
// which removes no ink and would only split a stroke into two pieces that meet
// where they were already joined. Null for those, so nothing happens.
export function segmentCircle(x0, y0, x1, y1, cx, cy, r) {
  const rad = num(r);
  if (!(rad > 0)) return null;
  const ax = num(x0);
  const ay = num(y0);
  const bx = num(x1);
  const by = num(y1);
  const ox = num(cx);
  const oy = num(cy);
  if (!Number.isFinite(ax + ay + bx + by + ox + oy)) return null;
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - ox;
  const fy = ay - oy;
  const a = dx * dx + dy * dy;
  if (a === 0) {
    // A segment of no length is its own endpoint: either that point is inside
    // or the segment is not.
    return fx * fx + fy * fy < rad * rad ? [0, 1] : null;
  }
  const b = 2 * (dx * fx + dy * fy);
  const c = fx * fx + fy * fy - rad * rad;
  const disc = b * b - 4 * a * c;
  if (!(disc > 0)) return null;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - root) / (2 * a));
  const t1 = Math.min(1, (-b + root) / (2 * a));
  return t1 > t0 ? [t0, t1] : null;
}

// Where two segments cross, as `[t, u]` - the fraction along the first and
// along the second - or null when they do not.
//
// Parallel segments are never a crossing, collinear overlaps included: there is
// no single place to cut at, and the honest answer for "where does this line
// leave the other" is that it does not.
//
// `t` is open at both ends and `u` closed. The asymmetry is deliberate: a
// crossing at the very start or end of the stroke being cut is the stroke's own
// endpoint and cuts nothing off, while a line that ENDS on this one - a T
// junction, the shape a panel border or a speech tail makes - is a place the
// eraser should stop at, and CSP stops there too.
export function segmentsCross(x0, y0, x1, y1, x2, y2, x3, y3) {
  const ax = num(x1) - num(x0);
  const ay = num(y1) - num(y0);
  const bx = num(x3) - num(x2);
  const by = num(y3) - num(y2);
  const den = ax * by - ay * bx;
  if (!den) return null;
  const ex = num(x2) - num(x0);
  const ey = num(y2) - num(y0);
  const t = (ex * by - ey * bx) / den;
  const u = (ex * ay - ey * ax) / den;
  if (!(t > 0) || !(t < 1) || !(u >= 0) || !(u <= 1)) return null;
  return [t, u];
}

// Every maximal run of the path that lies within the tool, in param units. The
// per-segment stretches are glued as they are found: two of them meeting at a
// vertex are one run through it, not two runs that happen to touch.
function insideSpans(pts, cx, cy, r) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const hit = segmentCircle(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], cx, cy, r);
    if (!hit) continue;
    const lo = i - 1 + hit[0];
    const hi = i - 1 + hit[1];
    const last = out[out.length - 1];
    if (last && lo <= last[1] + SPAN_EPS) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// Whether the four arguments a tool call always carries are usable.
function toolOk(pts, r, cx, cy) {
  return Array.isArray(pts) && pts.length > 0 && r > 0 && Number.isFinite(cx) && Number.isFinite(cy);
}

// ---------------------------------------------------------------------------

// CSP's "Erase touched parts": the pieces of `stroke` that are left once the
// stretch of its centreline within `r` of (cx, cy) has been taken out.
//
// The cut is EXACT. A segment that crosses the circle is split where it crosses
// it - the boundary point solved for, not the nearest vertex - so the piece
// ends on the rim the user saw and not up to a segment early. A segment that
// dips in and back out within its own length is cut twice and gives a piece on
// each side.
//
// A piece needs two points. One left at a cut edge is a vertex with no line
// running to it, which draws as a dot the user did not put there.
//
// A TAP - a stroke of one point, the dot a click leaves - has no segment to
// cut, so it is all or nothing: gone when its point is inside the tool, itself
// when it is not.
export function cutStroke(stroke, cx, cy, r) {
  const pts = stroke?.pts;
  const rad = num(r);
  const ox = num(cx);
  const oy = num(cy);
  if (!toolOk(pts, rad, ox, oy)) return [stroke];
  if (pts.length === 1) return inCircle(pts[0], ox, oy, rad) ? [] : [stroke];
  const spans = insideSpans(pts, ox, oy, rad);
  if (!spans.length) return [stroke];
  return cutSpans(stroke, spans);
}

// Every place `stroke` crosses a line on the board, in param units along
// `stroke`, sorted. `all` is the whole board, `stroke` itself included.
//
// A stroke crosses ITSELF where a loop closes over its own tail, and CSP erases
// up to such a crossing like any other, so its own segments are tested too -
// but never the segment being tested nor either neighbour, which share an
// endpoint with it and would report that shared endpoint as a crossing at every
// vertex of every stroke on the page.
//
// `stroke` is recognised in `all` by reference, and by its points as well: the
// board hands its strokes over as it stores them, but a caller that has just
// rebuilt one - the way every edit here does - passes a spread copy carrying
// the same `pts`, and that copy is still the same line.
function crossingParams(stroke, all) {
  const pts = stroke.pts;
  const list = Array.isArray(all) ? all : [];
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const ax = +pts[i - 1][0];
    const ay = +pts[i - 1][1];
    const bx = +pts[i][0];
    const by = +pts[i][1];
    for (const other of list) {
      const op = other?.pts;
      if (!Array.isArray(op) || op.length < 2) continue;
      const self = other === stroke || op === pts;
      for (let j = 1; j < op.length; j++) {
        if (self && Math.abs(j - i) <= 1) continue;
        const hit = segmentsCross(ax, ay, bx, by, op[j - 1][0], op[j - 1][1], op[j][0], op[j][1]);
        if (hit) out.push(i - 1 + hit[0]);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// CSP's "Erase up to intersection": the tool picks the stretch, but the CUT
// lands on the lines the stroke crosses.
//
// This is the tool that cleans a corner up. Two strokes are drawn past each
// other so the join is solid, which leaves a whisker sticking out beyond the
// crossing; one tap anywhere on that whisker takes it off to the crossing
// exactly, with no aim required and nothing left behind. Where `cutStroke`
// removes what the circle covers, this removes from the nearest crossing before
// the touched run to the nearest crossing after it - so the size of the tool
// decides WHICH stretch goes, and the drawing decides WHERE it ends.
//
// A side with no crossing runs to the stroke's own end: a line that crosses
// nothing is one whole whisker, and tapping it takes the lot. The circle's own
// boundary points are not cut at here, which is the whole difference between
// the two erasers - a cut on the rim would leave exactly the stub this tool
// exists to avoid.
//
// Two touched runs whose spans overlap are one removal, not two.
export function cutToIntersection(stroke, all, cx, cy, r) {
  const pts = stroke?.pts;
  const rad = num(r);
  const ox = num(cx);
  const oy = num(cy);
  if (!toolOk(pts, rad, ox, oy)) return [stroke];
  if (pts.length === 1) return inCircle(pts[0], ox, oy, rad) ? [] : [stroke];
  const runs = insideSpans(pts, ox, oy, rad);
  if (!runs.length) return [stroke];

  const marks = crossingParams(stroke, all);
  const end = pts.length - 1;
  const spans = runs.map(([lo, hi]) => {
    // The nearest crossing at or before the run, and at or after it. `at or`
    // rather than `before`: a run that starts exactly on a crossing has already
    // reached one, and walking past it would eat the leg on the other side.
    let back = 0;
    let fwd = end;
    for (const m of marks) {
      if (m <= lo) back = m;
      else if (m >= hi) { fwd = m; break; }
    }
    return [back, fwd];
  });
  return cutSpans(stroke, mergeSpans(spans));
}

// The floor on a stroke's stored size, page px. Matches `normalizeInkStroke`'s,
// because a size this file wrote has to survive being saved and read back.
const MIN_SIZE = 0.5;

// CSP's vector "Correct line width": the stroke with the width of every point
// within `r` of (cx, cy) scaled by `factor`, eased in by the tool's falloff -
// 1.2 to thicken, 0.8 to thin, 1 to do nothing.
//
// The ease is what makes this usable. Scaling every point inside the circle by
// the same amount leaves a step at the rim, and running the tool along a line
// would leave it scalloped; `falloff` - full at the centre, flat to zero at the
// rim, the same field `liquify.js` bends points with - blends the change into
// the line on both sides.
//
// WIDTH IS STORED TWICE OVER: a stroke has one `size` in px and every point a
// 0..1 factor of it, and only the product is a real width. So the work is done
// in px and the pair is rebuilt afterwards. A point cannot be widened past the
// stroke's size, so when the fattest new point overflows it the SIZE grows to
// that width and every factor is renormalised against it - the touched points
// get the width asked for, and the untouched ones come out at exactly the px
// they had. Thinning never needs that and never touches the size, so a stroke
// narrowed and widened back is the stroke it was.
export function adjustWidth(stroke, cx, cy, r, factor) {
  const pts = stroke?.pts;
  const rad = num(r);
  const ox = num(cx);
  const oy = num(cy);
  const f = num(factor);
  if (!toolOk(pts, rad, ox, oy) || !(f > 0) || f === 1) return stroke;
  const size = num(stroke.size);
  if (!(size > 0)) return stroke;

  // The px width every point wants, and the widest of them.
  const px = new Array(pts.length);
  let touched = false;
  let widest = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const w = Number.isFinite(+p[2]) ? Math.min(1, Math.max(0, +p[2])) : 1;
    const k = falloff(Math.hypot(+p[0] - ox, +p[1] - oy), rad);
    if (k > 0) touched = true;
    px[i] = size * w * (1 + (f - 1) * k);
    if (px[i] > widest) widest = px[i];
  }
  // The tool can be over the stroke's box and still reach none of its points -
  // a C, an O, a square outline touched in its own empty middle - and a stroke
  // nothing reached is the stroke that came in.
  if (!touched) return stroke;

  const newSize = Math.max(MIN_SIZE, widest > size ? widest : size);
  const out = pts.map((p, i) => {
    const w = Number.isFinite(+p[2]) ? Math.min(1, Math.max(0, +p[2])) : 1;
    const next = Math.min(1, Math.max(0, px[i] / newSize));
    // A point whose width did not move keeps the tuple it had, down to its
    // length: a stroke stored as three numbers per point does not grow a
    // fourth because something at the other end of it was thickened.
    if (newSize === size && next === w) return p;
    const q = copyPt(p);
    q[2] = next;
    return q;
  });
  // Nothing moved after all - the reachable points were already at width zero,
  // or the arithmetic landed back where it started.
  if (newSize === size && out.every((p, i) => p === pts[i])) return stroke;
  return { ...stroke, size: newSize, pts: out };
}
