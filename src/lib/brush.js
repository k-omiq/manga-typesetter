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
function taperFactor(taper, dist, total) {
  if (!taper?.on || taper.len <= 0) return 1;
  const len = Math.min(taper.len, total / 2);
  if (len <= 0 || dist >= len) return 1;
  const f = dist / len;
  // ratio 0 -> linear, ratio 100 -> f^3, which is what makes an SFX stroke end
  // in a hair rather than a wedge.
  return Math.pow(f, 1 + (taper.ratio / 100) * 2);
}

// A stored stroke as the list of tip impressions that make it up.
export function strokeStamps(stroke) {
  if (!stroke?.pts?.length) return [];
  const step = Math.max(0.5, (stroke.size * stroke.spacing) / 100);
  const path = resamplePath(stroke.pts, step);
  // Arc length at each resampled point, so the taper knows how far in it is.
  const dist = [0];
  for (let i = 1; i < path.length; i++) {
    dist.push(dist[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const total = dist.at(-1);
  const rnd = mulberry32(stroke.seed);
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const [x, y, w] = path[i];
    const t = taperFactor(stroke.taperIn, dist[i], total) *
      taperFactor(stroke.taperOut, total - dist[i], total);
    const size = stroke.size * w * t;
    // A jitter draw happens for every stamp whether or not it is used, so the
    // sequence does not shift when a stamp is skipped for being too small.
    const jit = (rnd() * 2 - 1) * (stroke.angleJitter / 100) * 180;
    if (size < 0.25) continue; // below a quarter pixel there is nothing to see
    out.push({ x, y, size, angle: stroke.angle + jit, alpha: stroke.opacity });
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stamps) {
    const r = s.size * reach;
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

// Stabilisation. Each point is pulled towards the running average of the points
// behind it, which is why a high setting makes the stroke visibly trail the
// cursor - the panel says so out loud rather than letting it read as lag. The
// first point never moves: it is where the user put the pen down, and shifting
// it makes the stroke start somewhere they did not click.
export function stabilisePath(pts, amount) {
  const a = Math.min(100, Math.max(0, Number(amount) || 0)) / 100;
  if (a <= 0 || !pts?.length) return pts ?? [];
  // 0..100 maps to a window of 1..16 points. Past that the trail is so long the
  // stroke stops following the hand at all.
  const win = Math.max(1, Math.round(a * 15) + 1);
  const out = [[...pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - win + 1); j <= i; j++) {
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

// The turn at vertex i, in degrees. 0 is straight on, 180 is a full reversal.
function turnDegrees(pts, i) {
  const [ax, ay] = pts[i - 1];
  const [bx, by] = pts[i];
  const [cx, cy] = pts[i + 1];
  const u = Math.hypot(bx - ax, by - ay);
  const v = Math.hypot(cx - bx, cy - by);
  if (u === 0 || v === 0) return 0;
  const dot = ((bx - ax) * (cx - bx) + (by - ay) * (cy - by)) / (u * v);
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

// Post-correction: one smoothing pass over the finished stroke. A vertex whose
// turn exceeds `sharpDeg` is left exactly where it is - that is the guide's
// sharp-angle setting, and it is what keeps a boxy letter's corners boxy while
// the wobble between them is ironed out. `sharpDeg` of 0 protects nothing.
export function smoothPath(pts, strength, sharpDeg) {
  const k = Math.min(100, Math.max(0, Number(strength) || 0)) / 100;
  if (k <= 0 || !pts || pts.length < 3) return pts ?? [];
  const guard = Math.max(0, Number(sharpDeg) || 0);
  const out = [[...pts[0]]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (guard > 0 && turnDegrees(pts, i) >= guard) {
      out.push([...pts[i]]);
      continue;
    }
    const mx = (pts[i - 1][0] + pts[i + 1][0]) / 2;
    const my = (pts[i - 1][1] + pts[i + 1][1]) / 2;
    out.push([
      pts[i][0] + (mx - pts[i][0]) * k,
      pts[i][1] + (my - pts[i][1]) * k,
      pts[i][2] ?? 1,
    ]);
  }
  out.push([...pts.at(-1)]);
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
    flatness: 1,
    antialias: true,
    // The watercolour edge is off by default: it is a look, not a default, and
    // a brush that rings every stroke without being asked reads as a bug.
    waterEdge: false,
    waterEdgeWidth: 4,
    waterEdgePower: 0.5,
    // Velocity by default: it is the setting the CSP guide leads with, and it
    // is the one that reads as hand lettering rather than as a marker pen.
    dyn: { src: 'velocity', amount: 70 },
    taperIn: { on: true, len: 20, ratio: 60 },
    taperOut: { on: true, len: 20, ratio: 60 },
    stabilise: 12,
    postCorrect: 35,
    sharpAngles: { on: false, deg: 45 },
  };
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
  pts = stabilisePath(pts, settings.stabilise);
  pts = smoothPath(pts, settings.postCorrect, settings.sharpAngles?.on ? settings.sharpAngles.deg : 0);
  return {
    brush: settings.brush,
    size: settings.size,
    color: settings.color,
    opacity: settings.opacity,
    spacing: settings.spacing,
    hardness: settings.hardness,
    angle: settings.angle,
    angleJitter: settings.angleJitter,
    flatness: settings.flatness,
    // Absent reads as on: the smooth edge is what a brush gives by default, and
    // only a deliberate false asks for the hard pixel edge.
    antialias: settings.antialias !== false,
    // The opposite reading to anti-aliasing: only a deliberate true asks for
    // the rim, so settings from before the pass existed draw plain ink.
    waterEdge: settings.waterEdge === true,
    waterEdgeWidth: Number.isFinite(+settings.waterEdgeWidth) ? +settings.waterEdgeWidth : 4,
    waterEdgePower: Number.isFinite(+settings.waterEdgePower) ? +settings.waterEdgePower : 0.5,
    taperIn: { ...settings.taperIn },
    taperOut: { ...settings.taperOut },
    seed,
    pts,
  };
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
