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

// Walk a path at even arc length, interpolating the width factor. Pointer
// events arrive at whatever rate the device felt like, so spacing the stamps
// off the raw points would make a fast stroke sparse and a slow one clotted.
export function resamplePath(pts, step) {
  if (!pts?.length) return [];
  if (pts.length === 1) return [[pts[0][0], pts[0][1], pts[0][2] ?? 1]];
  const d = Math.max(0.01, step);
  const out = [[pts[0][0], pts[0][1], pts[0][2] ?? 1]];
  let carry = 0; // distance already walked into the current segment
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, w0 = 1] = pts[i - 1];
    const [x1, y1, w1 = 1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg === 0) continue;
    let t = d - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, w0 + (w1 - w0) * f]);
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
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const [x, y, w] = path[i];
    const t = taperFactor(stroke.taperIn, dist[i], total, stroke.size) *
      taperFactor(stroke.taperOut, total - dist[i], total, stroke.size);
    const size = stroke.size * w * t;
    // A jitter draw happens for every stamp whether or not it is used, so the
    // sequence does not shift when a stamp is skipped for being too small.
    const jit = (rnd() * 2 - 1) * (stroke.angleJitter / 100) * 180;
    if (size < 0.25) continue; // below a quarter pixel there is nothing to see
    const angle = stroke.angle + jit + (head ? head[i] : 0);
    if (ribbon) {
      // The slice reaches halfway to each neighbour, so a run of them tiles
      // the path with no gap and no double cover. The quarter turn is the
      // ribbon's own convention, measured on the corpus: a ribbon tip is a
      // tall strip whose vertical axis runs along the stroke, so at a heading
      // of 0 - travelling right - the image stands up 90 degrees to it.
      const back = i > 0 ? (dist[i] - dist[i - 1]) / 2 : 0;
      const fwd = i + 1 < path.length ? (dist[i + 1] - dist[i]) / 2 : 0;
      const len = Math.max(0.5, back + fwd);
      out.push({ x, y, size, angle: angle - 90, alpha: stroke.opacity, d: dist[i], len });
    } else if (tips > 1) {
      out.push({ x, y, size, angle, alpha: stroke.opacity, tip: tipIndex(stroke.tipOrder, out.length, tips, tipRnd) });
    } else {
      out.push({ x, y, size, angle, alpha: stroke.opacity });
    }
  }
  return out;
}

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
  let a = 0;
  for (let i = 1; i < last; i++) {
    // The nearest point at least a reach behind, and the nearest at least a
    // reach ahead; the ends of the stroke when there is no such point.
    while (a + 1 < i && arc[i] - arc[a + 1] >= CORNER_REACH) a++;
    let b = i + 1;
    while (b < last && arc[b] - arc[i] < CORNER_REACH) b++;
    const ux = pts[i][0] - pts[a][0];
    const uy = pts[i][1] - pts[a][1];
    const vx = pts[b][0] - pts[i][0];
    const vy = pts[b][1] - pts[i][1];
    const u = Math.hypot(ux, uy);
    const v = Math.hypot(vx, vy);
    // Within half a reach of either end the chord is too short to trust: the
    // first px of a stroke wobble as the pen lands, and a chord of one sample
    // is the per-sample reading the reach exists to avoid.
    if (u < CORNER_REACH / 2 || v < CORNER_REACH / 2) continue;
    const dot = (ux * vx + uy * vy) / (u * v);
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
export function stabilisePath(pts, amount, sharpDeg = 0) {
  const a = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
  if (a <= 0 || !pts?.length) return pts ?? [];
  // 0..100 maps to a window of 1..16 points. Past that the trail is so long the
  // stroke stops following the hand at all.
  const win = Math.max(1, Math.round(a * 15) + 1);
  const pins = sharpCorners(pts, sharpDeg);
  const out = [[...pts[0]]];
  let anchor = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pins.has(i)) {
      out.push([...pts[i]]);
      anchor = i;
      continue;
    }
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(anchor, i - win + 1); j <= i; j++) {
      sx += pts[j][0];
      sy += pts[j][1];
      n++;
    }
    const ax = sx / n;
    const ay = sy / n;
    out.push([
      pts[i][0] + (ax - pts[i][0]) * a,
      pts[i][1] + (ay - pts[i][1]) * a,
      pts[i][2] ?? 1,
    ]);
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
    out.push(sw > 0 ? [sx / sw, sy / sw, pts[i][2] ?? 1] : [...pts[i]]);
  }
  out.push([...pts[last]]);
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
    flatness: 1,
    antialias: true,
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
    // `mode` is CSP's Specification method: 'px' is Specify length, 'pct' is
    // By percentage, where `len` is a percentage of the brush size.
    taperIn: { on: true, len: 20, ratio: 60, mode: 'px' },
    taperOut: { on: true, len: 20, ratio: 60, mode: 'px' },
    // CSP's Starting and ending by speed: a slow stroke tapers less.
    taperBySpeed: false,
    stabilise: 12,
    postCorrect: 35,
    // CSP's Adjust by speed under Post correction: the faster the hand moved
    // through a stretch, the harder that stretch is smoothed.
    postBySpeed: false,
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
// [{ x, y, pressure, t }], t in ms from the start of the stroke.
export function widthFactors(raw, source, amount, seed, curve) {
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
  return base.map((b) => Math.min(1, Math.max(0, 1 - a * (1 - Math.max(MIN_W, b)))));
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
  const w = widthFactors(raw, settings.dyn?.src, settings.dyn?.amount, seed, settings.dyn?.curve);
  let pts = raw.map((p, i) => [p.x, p.y, w[i] ?? 1]);
  const speed = speedProfile(raw);
  // Both corrections protect the same corners: a corner stabilisation had
  // already rounded is not there for smoothing to protect.
  const sharp = settings.sharpAngles?.on ? settings.sharpAngles.deg : 0;
  pts = stabilisePath(pts, settings.stabilise, sharp);
  pts = smoothPath(pts, settings.postCorrect, sharp, settings.postBySpeed === true ? speed : null);
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
    flatness: settings.flatness,
    // Absent reads as on: the smooth edge is what a brush gives by default, and
    // only a deliberate false asks for the hard pixel edge.
    antialias: settings.antialias !== false,
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
