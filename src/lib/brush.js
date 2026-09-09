// ===== The brush engine =====
//
// Pure geometry, no canvas and no DOM: the tests run in node, and the two
// renderers (the editor's overlay and the exporter's box canvas) must be handed
// the same stamps rather than each working the path out for itself.
//
// Two pipelines meet here. Capture turns a raw pointer gesture into a stored
// stroke - resample, stabilise, smooth, resolve a width per point. Render turns
// a stored stroke into stamps - the tip pressed down again and again along the
// path. Everything that draws ink consumes `strokeStamps`.

// A small deterministic PRNG (Tommy Ettinger's mulberry32). Angle jitter has to
// land in the same places in the editor and in the export, so randomness is
// seeded off the stroke rather than taken from Math.random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A stored point is `[x, y, ...factors]`: the position, then the 0..1 factors
// the dynamics resolved when it was drawn - width at index 2, opacity at 3 and
// thickness at 4. A factor that is absent is 1, so a stroke saved as `[x, y, w]`
// before the last two existed reads as fully opaque and unsquashed, and a
// stroke with no dynamics at all is still stored as three numbers. Every
// function here that makes a new point goes through these two so no factor is
// dropped on the floor by a correction that only thought about width.
export const PT_W = 2;
export const PT_O = 3;
export const PT_F = 4;

// The factor at `k` on a point, 1 when the point does not carry it.
export function ptFactor(p, k) {
  const v = p[k];
  return Number.isFinite(v) ? v : 1;
}

// The point a fraction `f` of the way from `p` to `q`, every factor
// interpolated. The tuple is as long as the longer of the two.
export function mixPoint(p, q, f) {
  const n = Math.max(p.length, q.length, 3);
  const out = new Array(n);
  out[0] = p[0] + (q[0] - p[0]) * f;
  out[1] = p[1] + (q[1] - p[1]) * f;
  for (let k = 2; k < n; k++) {
    const a = ptFactor(p, k);
    out[k] = a + (ptFactor(q, k) - a) * f;
  }
  return out;
}

// `p` moved to (x, y), factors kept.
export function movePoint(p, x, y) {
  const out = p.slice();
  out[0] = x;
  out[1] = y;
  if (out.length < 3) out.push(1);
  return out;
}

// Walk a path at even arc length, interpolating the factors. Pointer
// events arrive at whatever rate the device felt like, so spacing the stamps
// off the raw points would make a fast stroke sparse and a slow one clotted.
export function resamplePath(pts, step) {
  if (!pts?.length) return [];
  if (pts.length === 1) return [movePoint(pts[0], pts[0][0], pts[0][1])];
  const d = Math.max(0.01, step);
  const out = [movePoint(pts[0], pts[0][0], pts[0][1])];
  let carry = 0; // distance already walked into the current segment
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (seg === 0) continue;
    let t = d - carry;
    while (t <= seg) {
      out.push(mixPoint(p, q, t / seg));
      t += d;
    }
    carry = seg - (t - d);
  }
  return out;
}

// Where the taper leaves the width, at a point `dist` px into a stroke of
// `total` px. `ratio` is how sharp the point is: 0 blunts the taper to a
// straight ramp, 100 pulls it to a fine tip.
function taperFactor(taper, dist, total, size) {
  if (!taper?.on) return 1;
  const len = Math.min(taperPx(taper, size), total / 2);
  if (len <= 0 || dist >= len) return 1;
  const f = dist / len;
  // ratio 0 -> linear, ratio 100 -> f^3, which is what makes an SFX stroke end
  // in a hair rather than a wedge.
  return Math.pow(f, 1 + (taper.ratio / 100) * 2);
}

// How far a ribbon advances between slices, page px. A ribbon is the tip laid
// out continuously, so its slices have to butt up against each other: the step
// is a fraction of the width rather than the stamp spacing, floored so a fine
// line does not turn into thousands of hairline slices.
function ribbonStep(size) {
  return Math.max(1, size / 12);
}

export const TIP_ORDERS = ['repeat', 'reverse', 'once', 'random'];

// CSP's Flip horizontal / Flip vertical under Brush tip: never, always, or
// decided per stamp.
export const FLIP_MODES = ['off', 'on', 'random'];

// How a finished stroke lands on the ink under it. `over` is plain alpha
// compositing; `density` is CSP's Compare density, where the denser of the
// stroke and what is already there wins and nothing adds up - two passes of a
// 72% marker stay 72%.
export const BLEND_MODES = ['over', 'density'];

// Anti-aliasing as CSP grades it: 0 None, 1 Weak, 2 Middle, 3 Strong. A
// boolean is the two ends of that scale, which is what every stroke and every
// setting saved before the levels existed stored.
export const AA_LEVELS = ['none', 'weak', 'middle', 'strong'];
export function aaLevel(v) {
  if (v === false) return 0;
  if (v === true || v === undefined || v === null) return 3;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 3;
}

// The engine's grain, as a stroke stores it. The corpus's textured pens all
// name CSP's stock "ノイズテクスチャ" material by id - the pixels are not in
// the file - so the grain is the engine's own noise, laid at the scale and
// density the brush asked for. `scale` is CSP's percent, `density` 0-1, and
// `stress` is Emphasize density: the grain's dark side pushed harder.
export function normalizeTexture(t) {
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);
  return {
    on: t?.on === true,
    density: num(t?.density, 0.5, 0, 1),
    scale: num(t?.scale, 100, 10, 1000),
    stress: t?.stress === true,
  };
}

// Whether a texture setting will change a pixel. Read by the renderer and by
// the bounds, so it is said once.
export function textureActive(t) {
  return t?.on === true && +t.density > 0;
}

// A flip per stamp. `mode` is one of FLIP_MODES; `rnd` is the stroke's own
// stream for the random one so a saved stroke flips the same way every time.
function flipSign(mode, rnd) {
  if (mode === 'on') return -1;
  if (mode === 'random') return rnd() < 0.5 ? -1 : 1;
  return 1;
}

// Which of `n` tips the `i`th stamp uses under CSP's Repeat method. `rnd` is
// the stroke's own PRNG for the random order, so the run is repeatable.
export function tipIndex(order, i, n, rnd) {
  if (!(n > 1)) return 0;
  switch (order) {
    case 'reverse': {
      const period = 2 * (n - 1);
      const k = i % period;
      return k < n ? k : period - k;
    }
    case 'once':
      return Math.min(i, n - 1);
    case 'random':
      return Math.min(n - 1, Math.floor(rnd() * n));
    default:
      return i % n;
  }
}

// The direction the path is heading at each resampled point, degrees. Central
// difference inside, one-sided at the ends; a single point has no heading and
// gets 0.
function headings(path) {
  const n = path.length;
  const out = new Array(n).fill(0);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    out[i] = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  }
  return out;
}

// A stored stroke as the list of tip impressions that make it up.
//
// Every stamp is `{ x, y, size, angle, alpha }`. A ribbon stroke's stamps are
// slices rather than dabs and carry two more numbers: `d`, the arc length at
// which the slice sits, and `len`, how much of the path it covers - the
// renderer unrolls the tip image along `d` and draws the `len` px of it that
// belong here. `size` is the ribbon's width at that point.
export function strokeStamps(stroke) {
  if (!stroke?.pts?.length) return [];
  const ribbon = stroke.ribbon === true;
  const step = ribbon
    ? ribbonStep(stroke.size)
    : Math.max(0.5, (stroke.size * stroke.spacing) / 100);
  const path = resamplePath(stroke.pts, step);
  // Arc length at each resampled point, so the taper knows how far in it is.
  const dist = [0];
  for (let i = 1; i < path.length; i++) {
    dist.push(dist[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const total = dist.at(-1);
  // A ribbon always follows the line - a band that did not would be a stack of
  // slices all facing one way, which is not a ribbon.
  const follow = ribbon || stroke.followDir === true;
  const head = follow ? headings(path) : null;
  const rnd = mulberry32(stroke.seed);
  // The tip cycle draws from its own stream so that switching a brush's
  // repeat method does not shift its angle jitter.
  const tips = Array.isArray(stroke.tips) ? stroke.tips.length : 0;
  const tipRnd = tips > 1 ? mulberry32(stroke.seed + 0x9e3779b9) : null;
  // The flips draw from a third stream, for the same reason the cycle does.
  const flipX = FLIP_MODES.includes(stroke.flipX) ? stroke.flipX : 'off';
  const flipY = FLIP_MODES.includes(stroke.flipY) ? stroke.flipY : 'off';
  const flips = flipX !== 'off' || flipY !== 'off';
  const flipRnd = flips ? mulberry32(stroke.seed + 0x7f4a7c15) : null;
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const [x, y, w] = path[i];
    const t = taperFactor(stroke.taperIn, dist[i], total, stroke.size) *
      taperFactor(stroke.taperOut, total - dist[i], total, stroke.size);
    const size = stroke.size * w * t;
    // The opacity and thickness the dynamics left at this point. `alpha` is
    // the stroke's opacity faded by the first; `flat` rides on the stamp only
    // when the second squashed it, so a stroke without thickness dynamics
    // stamps exactly as it did.
    const alpha = stroke.opacity * ptFactor(path[i], PT_O);
    const f = ptFactor(path[i], PT_F);
    const flat = f !== 1 ? { flat: stroke.flatness * f } : null;
    // A jitter draw happens for every stamp whether or not it is used, so the
    // sequence does not shift when a stamp is skipped for being too small.
    const jit = (rnd() * 2 - 1) * (stroke.angleJitter / 100) * 180;
    const fx = flips ? flipSign(flipX, flipRnd) : 1;
    const fy = flips ? flipSign(flipY, flipRnd) : 1;
    if (size < 0.25) continue; // below a quarter pixel there is nothing to see
    const angle = stroke.angle + jit + (head ? head[i] : 0);
    const flip = fx !== 1 || fy !== 1 ? { fx, fy } : null;
    if (ribbon) {
      // The slice reaches halfway to each neighbour, so a run of them tiles
      // the path with no gap and no double cover. The quarter turn is the
      // ribbon's own convention, measured on the corpus: a ribbon tip is a
      // tall strip whose vertical axis runs along the stroke, so at a heading
      // of 0 - travelling right - the image stands up 90 degrees to it.
      const back = i > 0 ? (dist[i] - dist[i - 1]) / 2 : 0;
      const fwd = i + 1 < path.length ? (dist[i + 1] - dist[i]) / 2 : 0;
      const len = Math.max(0.5, back + fwd);
      out.push({ x, y, size, angle: angle - 90, alpha, d: dist[i], len, ...flip, ...flat });
    } else if (tips > 1) {
      out.push({ x, y, size, angle, alpha, tip: tipIndex(stroke.tipOrder, out.length, tips, tipRnd), ...flip, ...flat });
    } else {
      out.push({ x, y, size, angle, alpha, ...flip, ...flat });
    }
  }
  // The pointed corners come last so the cycle and the jitter of the stamps
  // along the path do not shift when a corner is found or lost.
  if (!ribbon && stroke.corners > 0) mitreStamps(stroke, step, follow, out);
  return out;
}

// CSP's Sharp angles, the half the corrections cannot do: a corner the path
// turns at is a POINT, not two round ends meeting. Two legs of a round tip meet
// with the outer corner rounded off to the tip's radius; the guide's "BANG"
// has square corners, and this is where they come from.
//
// At every corner the stroke's own `corners` threshold finds, the wedge between
// the two legs' outer edges is filled with discs inscribed in it: a disc at
// distance `s` from the wedge's tip along its bisector fits exactly when its
// radius is `s * sin(phi)`, phi being the wedge's half angle, and the run of
// them from the tip back to where the legs already cover is the mitre. The
// stamps are ordinary dabs - the same tip at a smaller size - so every renderer
// draws them the way it draws the rest of the stroke.
function mitreStamps(stroke, step, follow, out) {
  const pts = stroke.pts;
  const pins = sharpCorners(pts, stroke.corners);
  if (!pins.size) return;
  const arc = arcLengths(pts);
  const total = arc[arc.length - 1];
  const last = pts.length - 1;
  for (const i of pins) {
    const leg = legs(pts, arc, i, last);
    if (!leg) continue;
    // The turn between the legs, and the wedge the outer edges leave open.
    const dot = (leg.ux * leg.vx + leg.uy * leg.vy) / (leg.u * leg.v);
    const turn = Math.acos(Math.min(1, Math.max(-1, dot)));
    const phi = (Math.PI - turn) / 2;
    if (!(phi > 0.01) || !(turn > 0.01)) continue;
    // Outward: away from the inside of the turn, which is where the two leg
    // directions differ.
    let wx = leg.ux / leg.u - leg.vx / leg.v;
    let wy = leg.uy / leg.u - leg.vy / leg.v;
    const wl = Math.hypot(wx, wy);
    if (!(wl > 0)) continue;
    wx /= wl;
    wy /= wl;
    const w = ptFactor(pts[i], PT_W);
    const t = taperFactor(stroke.taperIn, arc[i], total, stroke.size) *
      taperFactor(stroke.taperOut, total - arc[i], total, stroke.size);
    const r = (stroke.size * w * t) / 2;
    const alpha = stroke.opacity * ptFactor(pts[i], PT_O);
    const f = ptFactor(pts[i], PT_F);
    const flat = f !== 1 ? { flat: stroke.flatness * f } : null;
    if (!(r > 0.125)) continue;
    const tip = r / Math.sin(phi); // the wedge's point, out from the vertex
    // A hairpin's point would run off for ever; past the limit the corner is
    // cut square across, the way every vector renderer's mitre limit does.
    const limit = Math.min(tip, r * MITRE_LIMIT);
    const [vx, vy] = pts[i];
    const angle = stroke.angle + (follow ? (Math.atan2(leg.vy, leg.vx) * 180) / Math.PI : 0);
    // From one step past the vertex - the disc at the vertex is the one the
    // legs already draw - out to the point or the limit.
    for (let d = step; d <= limit; d += step) {
      const size = 2 * (tip - d) * Math.sin(phi);
      if (size < 0.25) break;
      out.push({ x: vx + wx * d, y: vy + wy * d, size, angle, alpha, ...flat });
    }
    if (tip <= limit) {
      // The point itself, at the smallest stamp worth drawing.
      const d = tip - 0.125 / Math.sin(phi);
      out.push({ x: vx + wx * d, y: vy + wy * d, size: 0.25, angle, alpha, ...flat });
    }
  }
}

// How far a pointed corner may reach past the vertex, in radii. SVG's default.
const MITRE_LIMIT = 4;

// The box-local rectangle the stroke's ink actually reaches, stamp radius
// included. Used to grow the export's padding and to size the editor's canvas;
// null when the stroke paints nothing. A caller that has already laid the
// stamps out - the painter has, once per stroke per frame - passes them in
// rather than paying for the whole walk a second time.
export function strokeBounds(stroke, laid) {
  const stamps = laid ?? strokeStamps(stroke);
  if (!stamps.length) return null;
  // How far one stamp reaches from its centre, as a fraction of its size. The
  // round dab reaches half of it in every direction. An imported tip is an
  // IMAGE, and an image is a rectangle whose LONGEST side is the stamp's size -
  // so a square one turned 45 degrees reaches sqrt(2)/2 of it at the corners.
  // This file never sees a bitmap and cannot know the aspect, so a stroke drawn
  // with anything but the round tip takes the worst case for any tip at any
  // angle. The bound is only ever used to pad a canvas and to bound a pixel
  // pass, where being generous costs a few px of margin and nothing else.
  const reach = stroke?.brush && stroke.brush !== 'round' ? Math.SQRT1_2 : 0.5;
  // The watercolour edge sits OUTSIDE the ink, so a stroke wearing one reaches
  // further than its stamps by the rim and its blur.
  const rim = stroke?.waterEdge === true
    ? Math.max(0, +stroke.waterEdgeWidth || 0) + Math.max(0, +stroke.waterEdgeBlur || 0)
    : 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stamps) {
    const r = s.size * reach + rim;
    if (s.x - r < minX) minX = s.x - r;
    if (s.y - r < minY) minY = s.y - r;
    if (s.x + r > maxX) maxX = s.x + r;
    if (s.y + r > maxY) maxY = s.y + r;
  }
  return { minX, minY, maxX, maxY };
}

// Scale a stroke coordinates and sizes by the given scale factors.
// sx and sy are the horizontal and vertical scale ratios.
export function scaleStroke(stroke, sx, sy = sx) {
  if (!stroke || typeof stroke !== 'object') return stroke;
  const s = Math.sqrt(Math.abs(sx * sy));
  if (sx === 1 && sy === 1) return stroke;
  const pts = Array.isArray(stroke.pts)
    ? stroke.pts.map((p) => (Array.isArray(p) ? movePoint(p, p[0] * sx, p[1] * sy) : p))
    : stroke.pts;
  const out = { ...stroke, pts };
  if (Number.isFinite(stroke.size)) {
    out.size = Math.min(2000, Math.max(0.5, stroke.size * s));
  }
  if (Number.isFinite(stroke.waterEdgeWidth)) {
    out.waterEdgeWidth = Math.min(20, Math.max(1, stroke.waterEdgeWidth * s));
  }
  if (Number.isFinite(stroke.waterEdgeBlur)) {
    out.waterEdgeBlur = Math.min(20, Math.max(0, stroke.waterEdgeBlur * s));
  }
  if (stroke.taperIn && typeof stroke.taperIn === 'object') {
    out.taperIn = { ...stroke.taperIn };
    if (out.taperIn.mode !== 'pct' && Number.isFinite(out.taperIn.len)) {
      out.taperIn.len = Math.min(500, Math.max(0, out.taperIn.len * s));
    }
  }
  if (stroke.taperOut && typeof stroke.taperOut === 'object') {
    out.taperOut = { ...stroke.taperOut };
    if (out.taperOut.mode !== 'pct' && Number.isFinite(out.taperOut.len)) {
      out.taperOut.len = Math.min(500, Math.max(0, out.taperOut.len * s));
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Correction: what the CSP guide groups under Correction, and what makes an
// unsteady hand draw a clean letter.

// Arc length at every point: how far along the path each one sits.
function arcLengths(pts) {
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return arc;
}

// How far along the path a turn is measured over, page px. A hand does not
// turn a corner in one sample: it slows into it and leaves two or three points
// within a few px of each other, each turning a little, and the corner is only
// there in their sum. Measured over a reach it is found; and a one-px wobble on
// a straight line, which sample to sample can be a full right angle, is spread
// thin enough to be ignored.
const CORNER_REACH = 6;

// The two chords a turn at vertex `i` is measured between: from the nearest
// point at least a reach behind to the vertex, and from the vertex to the
// nearest at least a reach ahead - the ends of the stroke when there is no
// such point. Null within half a reach of either end, where the chord is too
// short to trust: the first px of a stroke wobble as the pen lands, and a
// chord of one sample is the per-sample reading the reach exists to avoid.
function legs(pts, arc, i, last) {
  let a = i - 1;
  while (a > 0 && arc[i] - arc[a] < CORNER_REACH) a--;
  let b = i + 1;
  while (b < last && arc[b] - arc[i] < CORNER_REACH) b++;
  const ux = pts[i][0] - pts[a][0];
  const uy = pts[i][1] - pts[a][1];
  const vx = pts[b][0] - pts[i][0];
  const vy = pts[b][1] - pts[i][1];
  const u = Math.hypot(ux, uy);
  const v = Math.hypot(vx, vy);
  if (u < CORNER_REACH / 2 || v < CORNER_REACH / 2) return null;
  return { ux, uy, vx, vy, u, v };
}

// The vertices the sharp-angle setting protects: where the path turns by at
// least `deg`, one vertex per corner - the sharpest of a cluster, the earliest
// of equals. Empty at a threshold of 0, which is "protect nothing".
//
// A pinned vertex is treated like the ends of the stroke by both corrections
// below: it does not move, and no averaging window reaches across it. That is
// what makes a boxy letter's corner stay a corner instead of being rounded a
// little by stabilisation and then a little more by smoothing.
export function sharpCorners(pts, deg) {
  const guard = Number(deg) || 0;
  const out = new Set();
  if (guard <= 0 || !pts || pts.length < 3) return out;
  const arc = arcLengths(pts);
  const last = pts.length - 1;
  const found = []; // [index, turn] for every vertex over the threshold
  for (let i = 1; i < last; i++) {
    const leg = legs(pts, arc, i, last);
    if (!leg) continue;
    const dot = (leg.ux * leg.vx + leg.uy * leg.vy) / (leg.u * leg.v);
    const turn = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    if (turn >= guard) found.push([i, turn]);
  }
  for (let n = 0; n < found.length; n++) {
    const [i, turn] = found[n];
    let best = true;
    for (let m = n - 1; best && m >= 0 && arc[i] - arc[found[m][0]] <= CORNER_REACH; m--) {
      if (found[m][1] >= turn) best = false;
    }
    for (let m = n + 1; best && m < found.length && arc[found[m][0]] - arc[i] <= CORNER_REACH; m++) {
      if (found[m][1] > turn) best = false;
    }
    if (best) out.add(i);
  }
  return out;
}

// Stabilisation. Each point is pulled towards the running average of the points
// behind it, which is why a high setting makes the stroke visibly trail the
// cursor - the panel says so out loud rather than letting it read as lag. The
// first point never moves: it is where the user put the pen down, and shifting
// it makes the stroke start somewhere they did not click. A sharp corner (see
// `sharpCorners`) is a fresh start in the same way: it stays put, and the
// points after it average only with each other, not with the leg before.
//
// `speed`, when given, is one 0..1 number per point against the stroke's
// fastest moment, and scales the window at that point between one-and-a-half
// and half its size: CSP's Adjust by speed under Stabilization, where a slow,
// deliberate stretch is steadied hard and a fast sweep is trusted to be
// meant. (The opposite way round from Post correction's Adjust by speed, which
// is CSP's own asymmetry: stabilisation fights a shaking hand, post correction
// fights a rushed one.)
export function stabilisePath(pts, amount, sharpDeg = 0, speed = null) {
  const a = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
  if (a <= 0 || !pts?.length) return pts ?? [];
  // 0..100 maps to a window of 1..16 points. Past that the trail is so long the
  // stroke stops following the hand at all.
  const base = Math.max(1, Math.round(a * 15) + 1);
  const winAt = speed?.length === pts.length
    ? (i) => Math.max(1, Math.round(base * (1.5 - Math.min(1, Math.max(0, speed[i])))))
    : () => base;
  const pins = sharpCorners(pts, sharpDeg);
  const out = [[...pts[0]]];
  let anchor = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pins.has(i)) {
      out.push([...pts[i]]);
      anchor = i;
      continue;
    }
    const win = winAt(i);
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(anchor, i - win + 1); j <= i; j++) {
      sx += pts[j][0];
      sy += pts[j][1];
      n++;
    }
    const ax = sx / n;
    const ay = sy / n;
    out.push(movePoint(pts[i], pts[i][0] + (ax - pts[i][0]) * a, pts[i][1] + (ay - pts[i][1]) * a));
  }
  return out;
}

// How far along the path smoothing reaches, page px each way at full strength.
// Stated in px rather than in points because a hand that slows down leaves
// points a px apart and a hand that sweeps leaves them ten apart, and the
// same slider has to iron the same wobble out of both. It is also the radius a
// corner is rounded to when nothing protects it: at full strength a right
// angle becomes a quarter circle about this big.
const SMOOTH_REACH = 60;

// The window's half-width for a strength slider position, page px. Cubic in
// the slider, which keeps the bottom half of it gentle - 35, the default, irons
// a 12 px wobble as it always has - and lets the top of it do what CSP's post
// correction does at 40 and above: pull a wavy pass into a near-straight line.
export function smoothReach(strength) {
  const k = Math.min(100, Math.max(0, Number(strength) || 0)) / 100;
  return Math.pow(k, 1.5) * SMOOTH_REACH;
}

// Post-correction: one smoothing pass over the finished stroke. Each point
// becomes the average of the path within `reach` px of it on either side,
// weighted by arc length so the answer does not depend on how the samples
// happen to fall. The window never crosses the ends of the stroke or a
// protected corner - it shrinks to stay symmetric inside them - so the ends
// stay put and a sharp corner stays sharp, which is the guide's sharp-angle
// setting. `sharpDeg` of 0 protects nothing, and a corner is then rounded.
//
// `speed`, when given, is one 0..1 number per point - the hand's speed there
// against the stroke's fastest moment - and scales the window at that point
// between half and one-and-a-half times: CSP's Adjust by speed, where a fast
// sweep is trusted less than a slow, deliberate one.
export function smoothPath(pts, strength, sharpDeg, speed) {
  const k = Math.min(100, Math.max(0, Number(strength) || 0)) / 100;
  if (k <= 0 || !pts || pts.length < 3) return pts ?? [];
  const base = smoothReach(strength);
  const reachAt = speed?.length === pts.length
    ? (i) => base * (0.5 + Math.min(1, Math.max(0, speed[i])))
    : () => base;
  const last = pts.length - 1;
  const pins = sharpCorners(pts, sharpDeg);
  const arc = arcLengths(pts);
  // Where the window may not cross: the ends and the pins. `prev[i]` is the
  // nearest such index at or before i, `next[i]` the nearest at or after.
  const prev = new Array(pts.length);
  const next = new Array(pts.length);
  for (let i = 0, p = 0; i <= last; i++) {
    if (i === 0 || pins.has(i)) p = i;
    prev[i] = p;
  }
  for (let i = last, n = last; i >= 0; i--) {
    if (i === last || pins.has(i)) n = i;
    next[i] = n;
  }
  // Each sample stands for the stretch of path nearer to it than to its
  // neighbours: from halfway back to halfway forward.
  const cellLo = (j) => (j === 0 ? arc[0] : (arc[j - 1] + arc[j]) / 2);
  const cellHi = (j) => (j === last ? arc[last] : (arc[j] + arc[j + 1]) / 2);
  const out = [[...pts[0]]];
  for (let i = 1; i < last; i++) {
    const lo = prev[i];
    const hi = next[i];
    const r = Math.min(reachAt(i), arc[i] - arc[lo], arc[hi] - arc[i]);
    if (lo === i || hi === i || !(r > 0)) {
      out.push([...pts[i]]);
      continue;
    }
    const w0 = arc[i] - r;
    const w1 = arc[i] + r;
    let sx = 0, sy = 0, sw = 0;
    for (let j = i; j >= lo && cellHi(j) > w0; j--) {
      const w = Math.min(cellHi(j), w1) - Math.max(cellLo(j), w0);
      if (w <= 0) continue;
      sx += pts[j][0] * w;
      sy += pts[j][1] * w;
      sw += w;
    }
    for (let j = i + 1; j <= hi && cellLo(j) < w1; j++) {
      const w = Math.min(cellHi(j), w1) - Math.max(cellLo(j), w0);
      if (w <= 0) continue;
      sx += pts[j][0] * w;
      sy += pts[j][1] * w;
      sw += w;
    }
    out.push(sw > 0 ? movePoint(pts[i], sx / sw, sy / sw) : [...pts[i]]);
  }
  out.push([...pts[last]]);
  return out;
}

// How far apart the points of a fitted curve are laid, page px. Fine enough
// that no renderer's resample sees the polygon under it, coarse enough that a
// page-wide stroke is hundreds of points rather than thousands.
const SPLINE_STEP = 2;

// CSP's Post correction with Bezier: the corrected line is a curve, not a
// polyline of the samples it was drawn as. A Catmull-Rom spline through the
// points - it passes through every one, so the ends stay where the pen was
// put down and lifted, and its tangents are the local chord, so a smoothed
// path comes out as the curve the smoothing was reaching for. A protected
// corner is a break: the spline runs up to it and starts again after it, and
// the corner stays a corner. Width rides along linearly between the points.
export function splinePath(pts, sharpDeg = 0) {
  if (!pts || pts.length < 3) return pts ?? [];
  const pins = sharpCorners(pts, sharpDeg);
  const last = pts.length - 1;
  const out = [[...pts[0]]];
  const at = (k) => pts[Math.min(last, Math.max(0, k))];
  for (let i = 0; i < last; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    // A pin is an end of its segment on both sides: the tangent into it and
    // the tangent out of it are each taken from that side alone.
    const p0 = i === 0 || pins.has(i) ? p1 : at(i - 1);
    const p3 = i + 1 === last || pins.has(i + 1) ? p2 : at(i + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(len / SPLINE_STEP));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push(k === n ? [...p2] : movePoint(mixPoint(p1, p2, t), x, y));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capture: a raw pointer gesture becomes a stored stroke.

// What can drive the tip's width along a stroke.
export const DYN_SOURCES = ['off', 'pressure', 'velocity', 'random'];

// The tool's live settings. Everything the brush panel edits sits here; the
// subset that decides how a finished stroke draws is copied onto the stroke by
// `buildStroke`, and the rest (the correction group) is baked into its points.
export function defaultBrushSettings() {
  return {
    brush: 'round',
    size: 24,
    color: '#000000',
    opacity: 1,
    spacing: 10,
    hardness: 100,
    angle: 0,
    angleJitter: 0,
    // CSP's Direction "Direction of line": the tip turns to follow the
    // stroke, with `angle` added on top. Off for the round dab, where it
    // changes nothing; an imported pattern tip switches it on.
    followDir: false,
    // CSP's Stroke "Ribbon": the tip is not stamped but laid along the path as
    // a continuous band, its height across the stroke and its width unrolled
    // along it. What makes a dry-brush pen streak instead of dot.
    ribbon: false,
    // CSP's Stroke "Blend brush tips with Darken": where dabs overlap the
    // darker wins rather than the two adding up, so a textured tip keeps its
    // texture through the overlap instead of clotting solid.
    darkenTips: false,
    // A brush with several tip images: the ids of all of them, in order, and
    // CSP's Repeat method for cycling through them. Empty for one tip.
    tips: [],
    tipOrder: 'repeat',
    // CSP's Flip horizontal and Flip vertical under Brush tip.
    flipX: 'off',
    flipY: 'off',
    flatness: 1,
    // 0 None, 1 Weak, 2 Middle, 3 Strong - CSP's four grades.
    antialias: 3,
    // How the finished stroke lands on the ink before it; see BLEND_MODES.
    blend: 'over',
    // CSP's Texture category, on the engine's own grain; see normalizeTexture.
    texture: { on: false, density: 0.5, scale: 100, stress: false },
    // The watercolour edge is off by default: it is a look, not a default, and
    // a brush that rings every stroke without being asked reads as a bug.
    waterEdge: false,
    waterEdgeWidth: 4,
    waterEdgePower: 0.5,
    // CSP's Darkness: how far the rim's colour drops towards black, 0-1.
    waterEdgeDark: 0,
    // CSP's Blurring width: how far the rim is softened, page px.
    waterEdgeBlur: 0,
    // Velocity by default: it is the setting the CSP guide leads with, and it
    // is the one that reads as hand lettering rather than as a marker pen.
    dyn: { src: 'velocity', amount: 70 },
    // The same shape for the tip's opacity and its thickness (CSP's Opacity
    // and Thickness effectors, Photoshop's Transfer and Shape Dynamics). Off
    // by default: a pen that fades with pressure is a look, and the guide's
    // SFX are solid ink.
    dynOpacity: { src: 'off', amount: 100 },
    dynThick: { src: 'off', amount: 100 },
    // `mode` is CSP's Specification method: 'px' is Specify length, 'pct' is
    // By percentage, where `len` is a percentage of the brush size.
    taperIn: { on: true, len: 20, ratio: 60, mode: 'px' },
    taperOut: { on: true, len: 20, ratio: 60, mode: 'px' },
    // CSP's Starting and ending by speed: a slow stroke tapers less.
    taperBySpeed: false,
    stabilise: 12,
    // CSP's Adjust by speed under Stabilization: a slow stretch is steadied
    // harder than a fast one.
    stabiliseBySpeed: false,
    postCorrect: 35,
    // CSP's Adjust by speed under Post correction: the faster the hand moved
    // through a stretch, the harder that stretch is smoothed.
    postBySpeed: false,
    // CSP's Bezier under Post correction: the corrected line is fitted as a
    // curve rather than kept as the polyline of its samples.
    postBezier: false,
    sharpAngles: { on: false, deg: 45 },
  };
}

// The taper's length in page px for a stroke of `size`: what the brush stores,
// or that many percent of the size when the taper is stated that way.
export function taperPx(taper, size) {
  const len = Math.max(0, Number(taper?.len) || 0);
  return taper?.mode === 'pct' ? (size * len) / 100 : len;
}

// How much smaller the thinnest part of a stroke may get. Zero would break the
// stroke into beads wherever the source bottomed out.
const MIN_W = 0.08;

// The most nodes a response curve may carry. CSP's graph editor offers a
// handful and the imported corpus tops out at fourteen, so past this an array
// is damage rather than a graph and is refused whole. Two is the floor: one
// node is a dot, and a line needs two ends.
export const DYN_CURVE_MAX_POINTS = 32;

// A response curve as the engine will use it, or null when there is not one to
// use - which every brush without a graph has, and which reads as the straight
// line through the origin.
//
// All-or-nothing, like the warp mesh and unlike a stroke's points: a graph
// missing a node is not a coarser graph, it is a different pen, and there is no
// honest way to guess where the missing node was. `x` is allowed to repeat (a
// vertical step is a shape CSP's editor can draw) but never to go backwards,
// because a curve that doubles back has no single output for an input.
export function dynCurve(c) {
  if (!Array.isArray(c) || c.length < 2 || c.length > DYN_CURVE_MAX_POINTS) return null;
  const out = [];
  let prev = -Infinity;
  for (const p of c) {
    if (!Array.isArray(p)) return null;
    const x = +p[0];
    const y = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cx = Math.min(1, Math.max(0, x));
    if (cx < prev) return null;
    prev = cx;
    out.push([cx, Math.min(1, Math.max(0, y))]);
  }
  return out;
}

// The interpolation itself, on a curve `dynCurve` has already passed.
function curveAt(c, x) {
  if (x <= c[0][0]) return c[0][1];
  const end = c[c.length - 1];
  if (x >= end[0]) return end[1];
  for (let i = 1; i < c.length; i++) {
    const [x0, y0] = c[i - 1];
    const [x1, y1] = c[i];
    // A repeated x is a step: the node above wins, so the graph jumps rather
    // than dividing by a zero-width segment.
    if (x <= x1) return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
  }
  return end[1];
}

// What a source's raw input becomes after the brush's own response graph.
//
// CSP draws that graph beside every dynamic source - input across, output up,
// both 0 to 1 - and it is the difference between "this pen thins with pressure"
// and "this pen is at full width by 1% pressure and stays there", which is a
// shape the imported corpus really uses. The engine's `amount` slider is a
// straight fade of the whole effect and cannot say it.
//
// Piecewise linear between the nodes and FLAT outside them: a graph whose first
// node sits at x = 0.2 says nothing about what happens below it, and holding its
// first value is the only reading that does not invent one. An absent or
// unusable curve is the identity, so a brush without a graph is untouched.
//
// Pure and deterministic: the same curve and the same input give the same
// answer in the editor, in the export, and in a test.
export function curveEval(curve, t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  const c = dynCurve(curve);
  return c ? curveAt(c, x) : x;
}

// The width factor at every raw point. `raw` is the captured gesture:
// [{ x, y, pressure, t }], t in ms from the start of the stroke. `floor` is
// how far the factor may fall: the width's `MIN_W`, so a stroke never beads;
// opacity is allowed all the way to nothing (see `dynFactors`).
export function widthFactors(raw, source, amount, seed, curve, floor = MIN_W) {
  const n = raw?.length ?? 0;
  if (!n) return [];
  const a = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
  if (a <= 0 || source === 'off' || !DYN_SOURCES.includes(source)) {
    return new Array(n).fill(1);
  }
  const base = new Array(n).fill(1);
  if (source === 'pressure') {
    for (let i = 0; i < n; i++) {
      base[i] = Math.min(1, Math.max(0, Number(raw[i].pressure) || 0));
    }
  } else if (source === 'random') {
    const rnd = mulberry32(seed);
    for (let i = 0; i < n; i++) base[i] = rnd();
  } else if (source === 'velocity') {
    // Speed per point, then normalised against this stroke's own fastest
    // moment: a brush must behave the same on a page zoomed out as on one
    // zoomed in, and an absolute px/ms threshold would not.
    const speed = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const dt = Math.max(1, (Number(raw[i].t) || 0) - (Number(raw[i - 1].t) || 0));
      speed[i] = Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y) / dt;
    }
    speed[0] = speed[1] ?? 0;
    const top = Math.max(...speed);
    for (let i = 0; i < n; i++) base[i] = top > 0 ? 1 - speed[i] / top : 1;
  }
  // The brush's own response graph remaps the source's raw input - pressure,
  // normalised speed, the random draw - BEFORE the strength slider sees it.
  // That is the order CSP composes them in: the graph says what this pen does
  // with the input, and `amount` then says how much of that to apply. Doing it
  // the other way round would let the slider flatten the shape it is meant to
  // be scaling.
  const c = dynCurve(curve);
  if (c) {
    for (let i = 0; i < n; i++) base[i] = curveAt(c, base[i]);
  }
  // `amount` fades the whole effect back towards a constant full width, so the
  // slider reads as strength rather than as a hard switch.
  return base.map((b) => Math.min(1, Math.max(0, 1 - a * (1 - Math.max(floor, b)))));
}

// The three dynamics a stroke resolves at capture: width, opacity and
// thickness, each `{ src, amount, curve? }`. Each random source draws from its
// own stream, offset from the stroke's seed, so a pen whose size and opacity
// are both random does not flicker the two in lockstep. Opacity has no floor:
// a pressure-faded stroke may thin to nothing where the pen barely touched.
const OPACITY_SEED = 0x3c6ef372;
const THICK_SEED = 0x1b873593;
export function dynFactors(raw, settings, seed) {
  const one = (dyn, s, floor) => widthFactors(raw, dyn?.src, dyn?.amount, s, dyn?.curve, floor);
  return {
    w: one(settings.dyn, seed, MIN_W),
    o: one(settings.dynOpacity, (seed + OPACITY_SEED) >>> 0, 0),
    f: one(settings.dynThick, (seed + THICK_SEED) >>> 0, MIN_W),
  };
}

// Seeds have to differ between two identical drags or jitter would repeat, and
// they have to be stable once stored. A counter is enough and, unlike a clock,
// stays deterministic within a session.
let seedCounter = 1;

// One captured gesture as a storable stroke. This is the only place correction
// runs: it is an input filter, so it is baked into the points. Re-running it on
// every repaint would be slower and would let a settings change silently
// rewrite ink the user already accepted.
export function buildStroke(raw, settings) {
  if (!raw?.length) return null;
  const seed = seedCounter++;
  // The dynamics resolve HERE and are then baked into the points' third number,
  // which is why no stroke carries a `dyn` of its own: source, strength and
  // response curve are capture-time inputs, and a saved stroke reproduces
  // exactly because its widths are already resolved. Re-reading them at draw
  // time would let a later settings change silently rewrite accepted ink.
  const { w, o, f } = dynFactors(raw, settings, seed);
  // Three numbers per point unless the opacity or thickness dynamics did
  // something: a stroke they left alone is stored as it always was.
  const wide = o.some((v) => v !== 1) || f.some((v) => v !== 1);
  let pts = raw.map((p, i) => (wide ? [p.x, p.y, w[i], o[i], f[i]] : [p.x, p.y, w[i]]));
  const speed = speedProfile(raw);
  // Both corrections protect the same corners: a corner stabilisation had
  // already rounded is not there for smoothing to protect.
  const sharp = settings.sharpAngles?.on ? Math.max(0, Number(settings.sharpAngles.deg) || 0) : 0;
  pts = stabilisePath(pts, settings.stabilise, sharp, settings.stabiliseBySpeed === true ? speed : null);
  pts = smoothPath(pts, settings.postCorrect, sharp, settings.postBySpeed === true ? speed : null);
  if (settings.postBezier === true && Number(settings.postCorrect) > 0) pts = splinePath(pts, sharp);
  // The speed tapers are resolved here too, for the same reason the widths
  // are: how fast the hand came in and left is a capture-time fact, and it is
  // folded into the stored taper length rather than kept beside it.
  const bySpeed = settings.taperBySpeed === true;
  const taperIn = { ...settings.taperIn };
  const taperOut = { ...settings.taperOut };
  if (bySpeed) {
    taperIn.len = taperIn.len * endSpeed(raw, speed, taperPx(taperIn, settings.size), false);
    taperOut.len = taperOut.len * endSpeed(raw, speed, taperPx(taperOut, settings.size), true);
  }
  return {
    brush: settings.brush,
    size: settings.size,
    color: settings.color,
    opacity: settings.opacity,
    spacing: settings.spacing,
    hardness: settings.hardness,
    angle: settings.angle,
    angleJitter: settings.angleJitter,
    followDir: settings.followDir === true,
    ribbon: settings.ribbon === true,
    darkenTips: settings.darkenTips === true,
    // The cycle only when there is one: a single-tip stroke carries no list.
    ...(Array.isArray(settings.tips) && settings.tips.length > 1
      ? { tips: settings.tips.slice(), tipOrder: TIP_ORDERS.includes(settings.tipOrder) ? settings.tipOrder : 'repeat' }
      : null),
    flipX: FLIP_MODES.includes(settings.flipX) ? settings.flipX : 'off',
    flipY: FLIP_MODES.includes(settings.flipY) ? settings.flipY : 'off',
    flatness: settings.flatness,
    // Absent reads as Strong: the smooth edge is what a brush gives by
    // default, and only a deliberate lower grade asks for a harder one.
    antialias: aaLevel(settings.antialias),
    blend: BLEND_MODES.includes(settings.blend) ? settings.blend : 'over',
    texture: normalizeTexture(settings.texture),
    // The corner threshold rides on the stroke, because the pointed corners
    // are drawn at render time from the points the corrections protected.
    corners: sharp,
    // The opposite reading to anti-aliasing: only a deliberate true asks for
    // the rim, so settings from before the pass existed draw plain ink.
    waterEdge: settings.waterEdge === true,
    waterEdgeWidth: Number.isFinite(+settings.waterEdgeWidth) ? +settings.waterEdgeWidth : 4,
    waterEdgePower: Number.isFinite(+settings.waterEdgePower) ? +settings.waterEdgePower : 0.5,
    waterEdgeDark: Number.isFinite(+settings.waterEdgeDark) ? +settings.waterEdgeDark : 0,
    waterEdgeBlur: Number.isFinite(+settings.waterEdgeBlur) ? +settings.waterEdgeBlur : 0,
    taperIn,
    taperOut,
    seed,
    pts,
  };
}

// The hand's speed at every raw point against the stroke's own fastest moment,
// 0..1. The same normalisation `widthFactors` uses for the velocity source: a
// brush must behave the same on a page zoomed out as on one zoomed in.
export function speedProfile(raw) {
  const n = raw?.length ?? 0;
  if (n < 2) return new Array(n).fill(0);
  const speed = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1, (Number(raw[i].t) || 0) - (Number(raw[i - 1].t) || 0));
    speed[i] = Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y) / dt;
  }
  speed[0] = speed[1];
  const top = Math.max(...speed);
  return top > 0 ? speed.map((v) => v / top) : speed.fill(0);
}

// How much of its taper an end keeps under Starting and ending by speed: the
// mean speed over the taper's own length, as a fraction of the stroke's top
// speed. A hand that crawled into a stroke keeps a fifth of the taper, one
// that swept in keeps all of it. The floor is what stops a careful stroke
// from losing its point altogether.
function endSpeed(raw, speed, len, fromEnd) {
  const n = raw.length;
  if (n < 2 || !(len > 0)) return 1;
  let walked = 0;
  let sum = 0;
  let count = 0;
  for (let k = 0; k < n && walked <= len; k++) {
    const i = fromEnd ? n - 1 - k : k;
    sum += speed[i];
    count++;
    if (k + 1 < n) {
      const j = fromEnd ? n - 2 - k : k + 1;
      walked += Math.hypot(raw[j].x - raw[i].x, raw[j].y - raw[i].y);
    }
  }
  return Math.max(0.2, Math.min(1, count ? sum / count : 1));
}

// Whether an eraser of `radius` at (x, y) touches this stroke's ink. Tested
// against the stamps rather than the stored points because those are where the
// ink actually is: a fat tip on a sparse path covers far more than its
// centreline, and erasing should follow what is visible.
export function strokeHit(stroke, x, y, radius) {
  const r = Math.max(0, Number(radius) || 0);
  for (const s of strokeStamps(stroke)) {
    if (Math.hypot(s.x - x, s.y - y) <= s.size / 2 + r) return true;
  }
  return false;
}
