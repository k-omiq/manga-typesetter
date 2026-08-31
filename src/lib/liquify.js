// ===== The liquify engine =====
//
// Pure geometry, no canvas and no DOM: the tests run in node, and the gesture
// that drives this (the brush tool's liquify mode) must be able to run it once
// per pointer move without dragging a renderer along.
//
// Liquify here moves stroke POINTS, not pixels. The ink is vector, so the tool
// bends the path itself and the stroke stays editable afterwards - which is
// better than the CSP behaviour it copies, where liquify is raster-only and a
// liquified stroke stops being a vector object.
//
// One tool application is a displacement FIELD over the page: a round tool at
// (cx, cy) with a radius, a mode that says which way the field points, and a
// strength that says how far. Everything a point does is a function of where it
// is, so two callers - the live preview and the committed result - cannot
// disagree, and nothing here reads a clock or a random number.
//
// Sanitising is not this module's job. `data.js` owns what a stored stroke may
// contain; this file, like `warp.js`, deliberately does not import it so both
// stay leaves.

// The four fields the tool offers, in panel order.
export const LIQUIFY_MODES = ['push', 'expand', 'pinch', 'twirl'];

// How far expand/pinch move a point at the very centre of the tool, per
// application, as a fraction of the tool's RADIUS. Stated relative to the
// radius rather than in px so that the tool feels the same when it is resized:
// a big brush should push a proportionally big distance. 5% is small enough
// that a drag reads as a continuous squeeze rather than as a jump - the gesture
// applies the field once per pointer move, so a real drag is dozens of these.
export const EXPAND_STEP = 0.05;

// The most one twirl application may turn a point, in radians (0.12 rad is
// about 6.9 degrees), reached only at the exact centre at full strength. Same
// reasoning as EXPAND_STEP: small per application, because a drag is many.
export const TWIRL_MAX = 0.12;

// The default resampling floor, derived from the tool's radius: a quarter of it,
// so a tool always has roughly four points to bend across its own width, held
// between 2 and 12 page px. The floor stops a tiny tool from exploding the
// point count; the ceiling stops a huge tool from leaving a stroke too coarse
// to bend smoothly.
const MAX_SEG_MIN = 2;
const MAX_SEG_MAX = 12;
export const defaultMaxSeg = (radius) =>
  Math.min(MAX_SEG_MAX, Math.max(MAX_SEG_MIN, (Number(radius) || 0) / 4));

const num = (v) => (Number.isFinite(+v) ? +v : NaN);

// The tool's weight at distance `d` from its centre: 1 at the centre, 0 at the
// rim and beyond.
//
//   w = (1 - (d/r)^2)^2
//
// Squaring the bracket is the point. The bare (1 - (d/r)^2) reaches zero at the
// rim too, but with a non-zero slope, so a stroke crossing the rim gets a
// visible kink there. This one meets zero flat, and the deformation fades out
// of the tool instead of stopping at an edge.
export function falloff(d, radius) {
  const r = num(radius);
  const dd = num(d);
  if (!(r > 0) || !Number.isFinite(dd)) return 0;
  const t = Math.abs(dd) / r;
  if (t >= 1) return 0;
  const k = 1 - t * t;
  return k * k;
}

// The displacement one application of the tool gives the point (x, y), as a
// fresh `[ox, oy]` to be ADDED to it. Zero for a point at or beyond the rim, and
// zero for anything unreadable.
//
// `strength` is the panel's 0..100; it is clamped and scaled to 0..1 here, so a
// caller never has to know the units.
//
// The modes:
//
//   push    - along the pointer's own motion (dx, dy). At the centre at full
//             strength the point moves exactly the pointer's delta, which is
//             what makes the tool feel like it is dragging the ink.
//   expand  - directly away from the centre, by `radius * EXPAND_STEP`.
//   pinch   - the same magnitude, inwards. Exactly expand negated.
//   twirl   - an EXACT rotation about the centre by `w * s * TWIRL_MAX`, not a
//             tangential shove. A shove would push points off their circle and
//             pull the stroke apart over a long drag; a rotation conserves the
//             distance to the centre no matter how many times it is applied.
//             The angle carries +x towards +y. Page y grows downwards, so on
//             screen that reads as a clockwise swirl; in the maths it is the
//             ordinary positive (counter-clockwise) rotation, and the test says
//             so by checking that a point at (cx + r, cy) moves towards +y.
//
// AT THE EXACT CENTRE, expand and pinch have no direction to move along - the
// radial unit vector is undefined - so they return zero there. Twirl returns
// zero there too, because rotating the centre about itself is the identity.
export function liquifyField(mode, cx, cy, radius, strength, dx, dy, x, y) {
  const r = num(radius);
  const px = num(x);
  const py = num(y);
  const ox = num(cx);
  const oy = num(cy);
  if (!(r > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return [0, 0];
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return [0, 0];
  const s = Math.min(1, Math.max(0, (Number(strength) || 0) / 100));
  if (s <= 0) return [0, 0];

  const vx = px - ox;
  const vy = py - oy;
  const d = Math.hypot(vx, vy);
  const w = falloff(d, r);
  if (w <= 0) return [0, 0];
  const k = w * s;

  if (mode === 'push') {
    const mx = num(dx);
    const my = num(dy);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return [0, 0];
    return [k * mx, k * my];
  }
  if (mode === 'expand' || mode === 'pinch') {
    if (d <= 0) return [0, 0]; // no radial direction at the centre
    const step = k * r * EXPAND_STEP * (mode === 'pinch' ? -1 : 1);
    return [(vx / d) * step, (vy / d) * step];
  }
  if (mode === 'twirl') {
    const a = k * TWIRL_MAX;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Rotate the offset, then report the difference: the returned value is a
    // displacement like every other mode's, and adding it lands the point
    // exactly on the rotated position.
    return [vx * c - vy * sn - vx, vx * sn + vy * c - vy];
  }
  return [0, 0];
}

// A copy of `stroke` whose points are close enough together to bend: no segment
// longer than `maxSeg` page px. Long segments are cut by linear interpolation of
// x, y AND the pressure factor, and every original point survives, in order and
// untouched - the endpoints exactly, so a resample never moves where the stroke
// starts or ends.
//
// IDENTITY IS THE SIGNAL. A stroke already fine enough comes back as the SAME
// object, by reference, and callers use that to skip work: `applyLiquify` only
// builds a new stroke when it has to, and the gesture only pays the resample on
// the first move it touches a given stroke.
//
// Point count over a gesture: displacement can stretch a segment back past
// `maxSeg` (the points inside the tool move, the ones outside do not), so a long
// drag can subdivide the same stroke more than once. That is self-limiting -
// only genuinely stretched segments split, and only as far as `maxSeg` - and it
// is why the contract is "same object when nothing is needed" rather than a
// one-shot flag the caller has to carry.
//
// A stroke with fewer than two points has no segment to cut and comes back as
// it is, as does one asked for a `maxSeg` that is not a usable length.
export function resampleStroke(stroke, maxSeg) {
  const pts = stroke?.pts;
  if (!Array.isArray(pts) || pts.length < 2) return stroke;
  const seg = num(maxSeg);
  if (!(seg > 0)) return stroke;

  let needed = false;
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(+pts[i][0] - +pts[i - 1][0], +pts[i][1] - +pts[i - 1][1]) > seg) {
      needed = true;
      break;
    }
  }
  if (!needed) return stroke;

  const out = [[+pts[0][0], +pts[0][1], pts[0][2] ?? 1]];
  for (let i = 1; i < pts.length; i++) {
    const x0 = +pts[i - 1][0];
    const y0 = +pts[i - 1][1];
    const w0 = pts[i - 1][2] ?? 1;
    const x1 = +pts[i][0];
    const y1 = +pts[i][1];
    const w1 = pts[i][2] ?? 1;
    const len = Math.hypot(x1 - x0, y1 - y0);
    // How many pieces this segment becomes. `ceil` and not `round`: the bound
    // is a maximum, so a segment of exactly `maxSeg` stays whole and one a hair
    // over it becomes two.
    const n = len > seg ? Math.ceil(len / seg) : 1;
    for (let j = 1; j < n; j++) {
      const f = j / n;
      out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, w0 + (w1 - w0) * f]);
    }
    // The original point itself, copied rather than interpolated, so it lands
    // on exactly the coordinates it had.
    out.push([x1, y1, w1]);
  }
  return { ...stroke, pts: out };
}

// The rectangle a stroke's POINTS span, or null when there are none. Deliberately
// the centreline and not `strokeBounds`' inked extent: this only decides whether
// the tool could possibly reach the stroke, and a point outside the tool is not
// moved however fat the tip that draws it is.
function ptsBounds(pts) {
  if (!Array.isArray(pts) || !pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

// Distance from a point to the nearest place on an axis-aligned rectangle, 0
// when the point is inside it.
function boxDistance(b, cx, cy) {
  const dx = Math.max(b.minX - cx, 0, cx - b.maxX);
  const dy = Math.max(b.minY - cy, 0, cy - b.maxY);
  return Math.hypot(dx, dy);
}

// One application of the tool to a list of strokes, as a NEW array.
//
//   opts = { mode, cx, cy, radius, strength, dx, dy, maxSeg }
//
// `maxSeg` is optional and defaults to `defaultMaxSeg(radius)`.
//
// Nothing is mutated, at any depth: a stroke that moves is rebuilt with a fresh
// pts array of fresh points, and the caller's stroke - and the array it sits in
// - are only ever read.
//
// UNTOUCHED STROKES COME BACK BY REFERENCE. A stroke whose points cannot reach
// the tool's circle is the same object in the output array, which is what lets
// the gesture repaint and diff cheaply while a drag is in flight, and what keeps
// a page of ink from being rewritten on every pointer move. A field that can do
// nothing at all - no radius, no strength, a mode this module does not know -
// returns every stroke that way.
export function applyLiquify(strokes, opts) {
  const list = Array.isArray(strokes) ? strokes : [];
  const o = opts ?? {};
  const r = num(o.radius);
  const s = Math.min(1, Math.max(0, (Number(o.strength) || 0) / 100));
  const cx = num(o.cx);
  const cy = num(o.cy);
  if (
    !(r > 0) ||
    s <= 0 ||
    !LIQUIFY_MODES.includes(o.mode) ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy)
  ) {
    return list.slice();
  }
  const seg = Number.isFinite(+o.maxSeg) && +o.maxSeg > 0 ? +o.maxSeg : defaultMaxSeg(r);

  return list.map((stroke) => {
    const b = ptsBounds(stroke?.pts);
    // `>=` and not `>`: a stroke that only touches the rim sits where the
    // falloff is exactly zero, so there is nothing to do for it either.
    if (!b || boxDistance(b, cx, cy) >= r) return stroke;
    const dense = resampleStroke(stroke, seg);
    const pts = dense.pts.map((p) => {
      const x = +p[0];
      const y = +p[1];
      const w = p[2] ?? 1;
      const [ox, oy] = liquifyField(o.mode, cx, cy, r, o.strength, o.dx, o.dy, x, y);
      // Pressure is a property of how the stroke was drawn, not of where its
      // points are, so liquify never touches it.
      return [x + ox, y + oy, w];
    });
    return { ...dense, pts };
  });
}
