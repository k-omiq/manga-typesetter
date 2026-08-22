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
// null when the stroke paints nothing.
export function strokeBounds(stroke) {
  const stamps = strokeStamps(stroke);
  if (!stamps.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stamps) {
    const r = s.size / 2;
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

// The width factor at every raw point. `raw` is the captured gesture:
// [{ x, y, pressure, t }], t in ms from the start of the stroke.
export function widthFactors(raw, source, amount, seed) {
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
  const w = widthFactors(raw, settings.dyn?.src, settings.dyn?.amount, seed);
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
    taperIn: { ...settings.taperIn },
    taperOut: { ...settings.taperOut },
    seed,
    pts,
  };
}
