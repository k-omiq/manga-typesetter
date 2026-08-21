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
