// The arithmetic behind a text block's paint: strokes, gradient, pattern.
//
// It lives on its own because the editor draws a box with stacked DOM layers and
// the exporter draws the same box with canvas calls, and the two have to agree
// pixel for pixel. Anything both of them have to compute - how wide a stroke is
// actually drawn, where a gradient starts and ends, what one pattern tile looks
// like - is answered here once, so a change lands on both at the same time.

// A stroke's `width` is the VISIBLE band the user asked for, but neither a
// canvas stroke nor `-webkit-text-stroke` can draw a band: both draw a line
// CENTRED on the glyph outline, half of it falling inside the glyph. So each
// stroke is drawn at twice the sum of every width up to and including itself,
// outermost first, and whatever is painted after it - the next stroke in, and
// finally the fill - covers its inner half. What is left showing is exactly the
// width that was asked for, per stroke.
//
// Takes the style's list (innermost first) and answers it in PAINT order,
// outermost first, with `line` being the width to hand to the renderer. Strokes
// of zero width are dropped rather than drawn as a hairline.
export function strokeBands(strokes) {
  const out = [];
  let cum = 0;
  for (const k of strokes ?? []) {
    const w = Math.max(0, Number(k?.width) || 0);
    if (w <= 0) continue;
    cum += w;
    out.push({
      color: k?.color ?? '#ffffff',
      opacity: Math.min(1, Math.max(0, Number(k?.opacity ?? 1))),
      width: w,
      line: cum * 2,
    });
  }
  return out.reverse();
}

// How far the ink reaches past the glyph outline, in page px. The sum of the
// visible widths, which is the outermost band's outer edge.
export function strokeExtent(strokes) {
  let cum = 0;
  for (const k of strokes ?? []) cum += Math.max(0, Number(k?.width) || 0);
  return cum;
}

// `#rrggbb` → the three channels as numbers. #rgb / #rgba short forms are
// doubled out; a trailing alpha nibble is dropped, because in this app alpha is
// always a field of its own beside the colour and never part of the hex.
function channels(hex) {
  let h = String(hex ?? '#000000').replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

// `#rrggbb` + alpha → a CSS colour both the DOM and the canvas accept.
export function rgba(hex, a = 1) {
  const [r, g, b] = channels(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// One gradient stop as a colour string, which is the ONE place the editor's CSS
// and the exporter's canvas agree on what a stop's alpha means. A fully opaque
// stop stays the hex it was written as - the common case, and the one the CSS
// reads best - and anything else becomes rgba().
export function stopColor(st) {
  const a = Number.isFinite(+st?.opacity) ? Math.min(1, Math.max(0, +st.opacity)) : 1;
  return a >= 1 ? (st?.color ?? '#000000') : rgba(st?.color, a);
}

// The colour and alpha the ramp is showing at `p` (0..1), by the same linear
// interpolation both renderers do between two stops. Clicking an empty spot on
// the editor's stop bar adds a stop there, and the stop it adds has to be the
// colour that was already at that spot or the ramp visibly jumps on a gesture
// that was only meant to give it a handle.
export function sampleStops(stops, p) {
  const list = (stops ?? []).slice().sort((a, b) => (a?.pos ?? 0) - (b?.pos ?? 0));
  if (!list.length) return { color: '#000000', opacity: 1 };
  const at = (st) => ({
    color: st?.color ?? '#000000',
    opacity: Number.isFinite(+st?.opacity) ? Math.min(1, Math.max(0, +st.opacity)) : 1,
  });
  const t = Math.min(1, Math.max(0, Number(p) || 0));
  if (t <= (list[0].pos ?? 0)) return at(list[0]);
  const last = list[list.length - 1];
  if (t >= (last.pos ?? 0)) return at(last);
  for (let i = 1; i < list.length; i++) {
    const b = list[i];
    if (t > (b.pos ?? 0)) continue;
    const a = list[i - 1];
    const span = (b.pos ?? 0) - (a.pos ?? 0);
    // Two stops stacked on the same position have no span to interpolate
    // across; the later one is what the ramp is showing there.
    const f = span <= 0 ? 1 : (t - (a.pos ?? 0)) / span;
    const ca = channels(a.color);
    const cb = channels(b.color);
    const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
    const oa = at(a).opacity;
    const ob = at(b).opacity;
    return {
      color: '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join(''),
      opacity: oa + (ob - oa) * f,
    };
  }
  return at(last);
}

// The gradient as CSS. `angle` is already in CSS degrees (0 = bottom→top), which
// is why the style stores it that way: the editor can hand it straight over and
// only the canvas has to do the conversion below.
// A radial gradient is stated the same way in both renderers: centred at
// (cx,cy) as a fraction of the fill rect, ending at `radius` x the distance from
// that centre to the rect's farthest corner - which is exactly the size CSS
// calls `farthest-corner`. That equivalence is what lets the CSS below carry the
// radius in the STOP POSITIONS rather than in a pixel length: a stop at `p` of a
// gradient that ends at `radius` x D sits at `p * radius` of D, and CSS is happy
// with stop percentages past 100% (the last colour simply continues outwards,
// as it does past a canvas gradient's last stop).
// A percentage as CSS writes it. Three decimals rather than the whole number
// this used to round to: the exporter states the same stop as a float, so a
// ramp rounded to 1% here could sit up to half a percent of the gradient's
// length away from the one in the PNG - visible on a long, shallow ramp, and
// invisible in any test that only reads one side of it. Trailing zeros are
// dropped so the common case still reads as `50%`.
function pct(v) {
  return String(Math.round((Number(v) || 0) * 1000) / 1000);
}

export function gradientCss(g) {
  const radial = g?.kind === 'radial';
  const scale = radial ? Math.max(0.01, Number(g?.radius) || 1) : 1;
  const stops = (g?.stops ?? [])
    .map((st) => `${stopColor(st)} ${pct((st.pos ?? 0) * scale * 100)}%`)
    .join(', ');
  if (radial) {
    const cx = pct((Number(g?.cx) ?? 0.5) * 100);
    const cy = pct((Number(g?.cy) ?? 0.5) * 100);
    return `radial-gradient(circle farthest-corner at ${cx}% ${cy}%, ${stops})`;
  }
  return `linear-gradient(${Number(g?.angle) || 0}deg, ${stops})`;
}

// The radial gradient as a canvas circle over the rect (x,y,w,h): the centre in
// page coordinates and the radius the last stop lands on. Stops keep their own
// 0..1 positions, because `radius` is already in the circle.
export function radialEndpoints(g, x, y, w, h) {
  const cx = x + (Number.isFinite(+g?.cx) ? +g.cx : 0.5) * w;
  const cy = y + (Number.isFinite(+g?.cy) ? +g.cy : 0.5) * h;
  // farthest-corner: the corner is whichever is further on each axis, so the
  // distance is to the far side in x and the far side in y.
  const dx = Math.max(Math.abs(cx - x), Math.abs(x + w - cx));
  const dy = Math.max(Math.abs(cy - y), Math.abs(y + h - cy));
  const far = Math.hypot(dx, dy);
  const scale = Math.max(0.01, Number(g?.radius) || 1);
  return { cx, cy, r: Math.max(0.01, far * scale) };
}

// The same gradient as two canvas points, over the rect (x,y,w,h).
//
// CSS measures the gradient line from the centre of the box, long enough that
// the two ends cover the whole rect, and counts degrees clockwise from "up".
// Screen coordinates run y-down, so "up" is (0,-1) and the direction of travel
// is (sin a, -cos a).
export function gradientEndpoints(angleDeg, x, y, w, h) {
  const a = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x0: cx - (dx * len) / 2,
    y0: cy - (dy * len) / 2,
    x1: cx + (dx * len) / 2,
    y1: cy + (dy * len) / 2,
  };
}

// How many device pixels per page px a tile is rasterised at, in both renderers:
// the exporter's box canvas is supersampled by exactly this, and the editor asks
// for the same multiple of its zoom.
export const TILE_SS = 2;

// One pattern tile is a square this many page px on a side, so a pattern keeps
// its proportion to the letters when the size changes.
//
// Snapped to a whole number of the raster's own pixels. Unsnapped, the tile was
// drawn at `round(tile * 2)` device px and then repeated at a pitch of `tile * 2`
// device px: the two disagree by up to half a pixel, so every repeat lands on a
// slightly different sub-pixel phase and the resampling leaves a hairline seam
// between some pairs of tiles and not others. At a snapped pitch the tile maps
// 1:1 onto the raster and there is no resampling left to seam. Both renderers
// read the pitch from here, so snapping it moves neither against the other.
export function patternTilePx(style) {
  const tile = (Number(style?.size) || 0) * 0.3 * (Number(style?.pattern?.scale) || 1);
  return Math.max(2, Math.round(tile * TILE_SS) / TILE_SS);
}

// Draw one tile of `pattern` into the square (0,0,tile,tile) of `ctx`. The tile
// has to be seamless in both directions - it is repeated by `createPattern` in
// the exporter and by `background-repeat` in the editor - so every shape either
// sits wholly inside it or runs the full width or height of it.
export function drawPatternTile(ctx, pattern, tile) {
  const fg = pattern?.fg ?? '#000000';
  const bg = pattern?.bg ?? '#ffffff';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, tile, tile);
  ctx.fillStyle = fg;
  const kind = pattern?.kind ?? 'dots';
  const dot = (cx, cy, r) => {
    ctx.beginPath();
    ctx.arc(cx * tile, cy * tile, r * tile, 0, Math.PI * 2);
    ctx.fill();
  };
  if (kind === 'dots') {
    dot(0.5, 0.5, 0.25);
  } else if (kind === 'halftone') {
    // The screentone stagger: two dots on the tile's diagonal read as a 45°
    // grid once the tile repeats, which is what a manga tone actually looks
    // like. Both sit wholly inside the tile, so it stays seamless.
    dot(0.25, 0.25, 0.17);
    dot(0.75, 0.75, 0.17);
  } else if (kind === 'stripes') {
    ctx.fillRect(0, 0, tile / 2, tile);
  } else if (kind === 'hstripes') {
    ctx.fillRect(0, 0, tile, tile / 2);
  } else if (kind === 'diagonal') {
    drawDiagonalBands(ctx, tile, 1, 0.5);
  } else if (kind === 'diagonal-alt') {
    drawDiagonalBands(ctx, tile, -1, 0.5);
  } else if (kind === 'crosshatch') {
    // Thinner than the single-direction bands, or the two sets meet and the
    // tile is simply solid fg.
    drawDiagonalBands(ctx, tile, 1, 0.3);
    drawDiagonalBands(ctx, tile, -1, 0.3);
  } else if (kind === 'checker') {
    ctx.fillRect(0, 0, tile / 2, tile / 2);
    ctx.fillRect(tile / 2, tile / 2, tile / 2, tile / 2);
  } else if (kind === 'grid') {
    const t = Math.max(1, tile * 0.12);
    ctx.fillRect(0, 0, tile, t);
    ctx.fillRect(0, 0, t, tile);
  } else if (kind === 'vlines') {
    ctx.fillRect(0, 0, Math.max(1, tile * 0.12), tile);
  } else if (kind === 'hlines') {
    ctx.fillRect(0, 0, tile, Math.max(1, tile * 0.12));
  }
}

// 45° bands across the tile, `dir` 1 for "/" and -1 for "\", `duty` the share of
// each period the band covers.
//
// Seamlessness is the whole reason for the numbers here: measured along the
// band's own perpendicular, moving one tile across in x (or down in y) shifts
// the phase by tile / sqrt(2), so that - and nothing else - is the period the
// bands have to repeat at for the tile's left edge to line up with its right.
function drawDiagonalBands(ctx, tile, dir, duty) {
  const period = tile / Math.SQRT2;
  const band = period * duty;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, tile, tile);
  ctx.clip();
  ctx.translate(tile / 2, tile / 2);
  ctx.rotate((dir * Math.PI) / 4);
  // The rotated frame is at most tile*sqrt(2) across, so ±2 periods either side
  // of centre covers it whichever way it is turned.
  for (let k = -2; k <= 2; k++) ctx.fillRect(-tile, k * period - band / 2, tile * 2, band);
  ctx.restore();
}

// One tile as its own canvas, at `dpr` device pixels per tile px. The exporter
// feeds it to `createPattern`; the editor turns it into a data URL and lets CSS
// repeat it. Both get their tiles from the same drawing, which is the point.
// Needs a document, so it answers null where there is none (the node tests).
export function patternTileCanvas(style, dpr = 1) {
  if (typeof document === 'undefined') return null;
  const tile = patternTilePx(style);
  const px = Math.max(2, Math.round(tile * dpr));
  const cnv = document.createElement('canvas');
  cnv.width = px;
  cnv.height = px;
  const ctx = cnv.getContext('2d');
  if (!ctx) return null;
  ctx.scale(px / tile, px / tile);
  drawPatternTile(ctx, style?.pattern, tile);
  return cnv;
}

// ---------------------------------------------------------------------------
// Edge roughening.
//
// The editor roughens by hanging an SVG filter on the text stack - feTurbulence
// feeding feDisplacementMap - and the exporter has to reach the same picture by
// moving pixels itself. What used to stand here for the export was a pair of
// sines playing the part of the noise, and it was not the same picture at all:
// its frequency worked out at `detail * 40 + 0.4`, which at the default detail
// of 0.05 is 2.4 cycles per PIXEL. Neighbouring pixels were therefore pulled
// from sources a dozen pixels apart, and text that showed clean rough edges on
// the canvas came out of the export as shredded confetti.
//
// So the noise here is the real one: the reference implementation of
// feTurbulence from the SVG 1.1 spec, which is what every browser's filter runs.
// Same seed, same baseFrequency, same octave count, therefore the same field the
// editor displaces by - which is what makes the export's roughening the
// canvas's roughening rather than a lookalike.

// The spec's PRNG, verbatim: r = (16807 * r) mod (2^31 - 1), by Schrage's method
// so it stays inside a 32-bit signed range.
const RAND_M = 2147483647;
const RAND_A = 16807;
const RAND_Q = 127773; // m / a
const RAND_R = 2836; // m % a

function nextRand(seed) {
  let r = RAND_A * (seed % RAND_Q) - RAND_R * ((seed / RAND_Q) | 0);
  if (r <= 0) r += RAND_M;
  return r;
}

function setupSeed(seed) {
  let s = Math.trunc(Number(seed) || 0);
  if (s <= 0) s = -(s % (RAND_M - 1)) + 1;
  if (s > RAND_M - 1) s = RAND_M - 1;
  return s;
}

const B_SIZE = 0x100;
const B_MASK = 0xff;
// The offset that keeps the lattice lookup on positive coordinates. Roughening
// samples a little outside the block (the padding around it), so the noise is
// asked for negative coordinates and `(int)t` has to stay a floor.
const PERLIN_N = 0x1000;

// The lattice and the four channels' gradients for one seed. All four are built
// even though only R and G are ever read, because the shuffle that follows them
// continues the same random stream - build two and every lattice index moves.
function buildNoise(seed) {
  let s = setupSeed(seed);
  const lattice = new Int32Array(B_SIZE + B_SIZE + 2);
  const grad = [];
  for (let k = 0; k < 4; k++) grad.push(new Float64Array((B_SIZE + B_SIZE + 2) * 2));
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < B_SIZE; i++) {
      lattice[i] = i;
      s = nextRand(s);
      let gx = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
      s = nextRand(s);
      let gy = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
      const len = Math.sqrt(gx * gx + gy * gy) || 1;
      grad[k][i * 2] = gx / len;
      grad[k][i * 2 + 1] = gy / len;
    }
  }
  // Fisher-Yates over the lattice, downwards from the last index - the spec's
  // `while(--i)`, which leaves slot 0 alone.
  for (let i = B_SIZE - 1; i > 0; i--) {
    const k = lattice[i];
    s = nextRand(s);
    const j = s % B_SIZE;
    lattice[i] = lattice[j];
    lattice[j] = k;
  }
  // Wrap: the second half repeats the first so a lookup at bx0 + by1 never has
  // to be masked twice.
  for (let i = 0; i < B_SIZE + 2; i++) {
    lattice[B_SIZE + i] = lattice[i];
    for (let k = 0; k < 4; k++) {
      grad[k][(B_SIZE + i) * 2] = grad[k][i * 2];
      grad[k][(B_SIZE + i) * 2 + 1] = grad[k][i * 2 + 1];
    }
  }
  return { lattice, grad };
}

// One field per seed. A page's worth of roughened boxes usually shares a seed,
// and building the lattice is ~2k random draws.
const noiseCache = new Map();
export function noiseFor(seed) {
  const key = setupSeed(seed);
  let n = noiseCache.get(key);
  if (!n) {
    n = buildNoise(key);
    if (noiseCache.size > 16) noiseCache.clear();
    noiseCache.set(key, n);
  }
  return n;
}

// Gradient noise at (vx, vy) on one channel's lattice. The spec's `noise2`.
//
// Takes the lattice and the channel's gradients rather than the field and a
// channel number, so the caller can hoist both out of a loop that runs once per
// device pixel of a page-sized block - see `roughenPixels`.
function noise2(lat, g, vx, vy) {
  let t = vx + PERLIN_N;
  const ix = Math.floor(t);
  const bx0 = ix & B_MASK;
  const bx1 = (bx0 + 1) & B_MASK;
  const rx0 = t - ix;
  const rx1 = rx0 - 1;

  t = vy + PERLIN_N;
  const iy = Math.floor(t);
  const by0 = iy & B_MASK;
  const by1 = (by0 + 1) & B_MASK;
  const ry0 = t - iy;
  const ry1 = ry0 - 1;

  const i = lat[bx0];
  const j = lat[bx1];
  const b00 = lat[i + by0];
  const b10 = lat[j + by0];
  const b01 = lat[i + by1];
  const b11 = lat[j + by1];

  const sx = rx0 * rx0 * (3 - 2 * rx0);
  const sy = ry0 * ry0 * (3 - 2 * ry0);

  let u = rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1];
  let v = rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1];
  const a = u + sx * (v - u);
  u = rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1];
  v = rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1];
  const b = u + sx * (v - u);
  return a + sy * (b - a);
}

// How many octaves the fractal sum runs to. Stated once here because the editor
// hands the same number to `feTurbulence`'s `numOctaves` and the two fields are
// only the same field if they agree on it.
export const OCTAVES = 2;

// The fractal sum at a point already multiplied by the base frequency, on one
// channel's lattice. Split out from `turbulenceChannel` so the per-pixel loop
// can hoist the lattice lookup; the arithmetic is unchanged.
function turbAt(lat, g, vx0, vy0, octaves) {
  let vx = vx0;
  let vy = vy0;
  let sum = 0;
  let ratio = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(lat, g, vx, vy) / ratio;
    vx *= 2;
    vy *= 2;
    ratio *= 2;
  }
  const c = (sum + 1) / 2;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

// `type="fractalNoise"` turbulence as a colour channel in 0..1 - the sum of
// `octaves` octaves, then mapped the way the spec maps a fractal sum:
// (turb + 1) / 2, clamped as the 8-bit channel it becomes in the browser.
export function turbulenceChannel(nz, channel, x, y, baseFreq, octaves = OCTAVES) {
  return turbAt(nz.lattice, nz.grad[channel], x * baseFreq, y * baseFreq, octaves);
}

// ---------------------------------------------------------------------------
// The phase between the browser's turbulence and this one.
//
// Rasterising `feTurbulence` and reading the pixels back puts the browser's
// value for the pixel at user-space x at this field's x + 1 - half a pixel of
// that being the pixel's own centre, which the loops below already add, and half
// a pixel being the browser's. It is the difference between two crumples that
// look the same and two that are the same.
//
// That half pixel was measured in Chromium and then written down as a constant,
// which is only right where the app runs on Blink. It ships in WKWebView on
// macOS and runs in Firefox in the browser build, and neither one is obliged to
// place its samples where Chromium does. So it is measured here instead, once,
// against the browser actually running: a tiny probe filter is rasterised, and
// the offset that best explains its pixels is the phase. Anywhere the probe
// cannot run - node, a canvas-less environment, a blocked data URL - the
// Chromium value stands, which is the behaviour this replaced.
const DEFAULT_NOISE_PHASE = 0.5;
let NOISE_PHASE = DEFAULT_NOISE_PHASE;

// What the roughening is currently using. Exported for tests and diagnostics.
export function noisePhase() {
  return NOISE_PHASE;
}

const PROBE_PX = 32; // a 32x32 probe is 1024 samples: plenty, and instant
const PROBE_SEED = 3;
// One cycle every 8px, so half a pixel of phase is an eighth of a cycle - far
// enough to tell the candidates apart, and still smooth enough that neither
// renderer's sampling is fighting its own resolution.
const PROBE_FREQ = 0.125;

function probeSvg(n) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}">` +
    `<filter id="p" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"` +
    ` x="0" y="0" width="${n}" height="${n}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${PROBE_FREQ}"` +
    ` numOctaves="${OCTAVES}" seed="${PROBE_SEED}"/>` +
    // Turbulence writes noise into the alpha channel too, and a channel read
    // back through an alpha of its own is a channel read back through a
    // rounding error. Forced opaque, R comes out as it went in.
    `<feComponentTransfer><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>` +
    `</filter>` +
    `<rect x="0" y="0" width="${n}" height="${n}" filter="url(#p)"/>` +
    `</svg>`
  );
}

// The browser's own turbulence, as bytes, or null where it cannot be had.
async function probePixels() {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const n = PROBE_PX;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(probeSvg(n));
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('probe did not decode'));
    i.src = url;
  });
  const cnv = document.createElement('canvas');
  cnv.width = n;
  cnv.height = n;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  if (!ctx?.drawImage || !ctx.getImageData) return null;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, n, n);
  // A filter that did not run leaves a flat rectangle; matching a phase against
  // one would answer whatever the search happened to start at.
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return max - min > 16 ? data : null;
}

// The offset that best explains the probe, searched at a sixteenth of a pixel
// over the range any browser could plausibly be at. `null` when nothing fits,
// which is a browser whose turbulence is not this turbulence at all - and then
// a measured phase would be worse than the default, not better.
function phaseFrom(data) {
  const n = PROBE_PX;
  const nz = noiseFor(PROBE_SEED);
  const lat = nz.lattice;
  const g = nz.grad[0];
  let best = null;
  let bestErr = Infinity;
  for (let k = -16; k <= 24; k++) {
    const phase = k / 16;
    let err = 0;
    for (let y = 0; y < n; y++) {
      const vy = (y + 0.5 + phase) * PROBE_FREQ;
      for (let x = 0; x < n; x++) {
        const want = turbAt(lat, g, (x + 0.5 + phase) * PROBE_FREQ, vy, OCTAVES);
        err += Math.abs(want - data[(y * n + x) * 4] / 255);
      }
    }
    if (err < bestErr) {
      bestErr = err;
      best = phase;
    }
  }
  // Byte quantisation alone costs about 1/512 per sample; anything past a few
  // percent is not this field seen through a shift.
  return bestErr / (n * n) < 0.04 ? best : null;
}

let phasePromise = null;

// Measure the phase once and remember it. Cheap after the first call - it is the
// same promise - and safe to call where there is nothing to measure with.
// Roughening is only exported, never previewed, so nothing pays for this unless
// a box actually asks to be roughened.
export function ensureNoisePhase() {
  if (!phasePromise) {
    phasePromise = (async () => {
      try {
        const data = await probePixels();
        const p = data && phaseFrom(data);
        if (Number.isFinite(p)) NOISE_PHASE = p;
      } catch {
        /* keep the default */
      }
      return NOISE_PHASE;
    })();
  }
  return phasePromise;
}

// Where the pixel drawn at (x, y) takes its colour from, in the same page px
// (x, y) is given in. This is feDisplacementMap's own statement -
// P'(x,y) = P(x + scale*(R-0.5), y + scale*(G-0.5)) - so `amount` means here
// exactly what the filter's `scale` means in the editor: the full span of the
// displacement, half of it either way.
export function roughenOffset(r, x, y) {
  const nz = noiseFor(r?.seed ?? 0);
  const freq = Number(r?.detail) || 0;
  const amount = Number(r?.amount) || 0;
  const px = x + NOISE_PHASE;
  const py = y + NOISE_PHASE;
  return [
    amount * (turbulenceChannel(nz, 0, px, py, freq) - 0.5),
    amount * (turbulenceChannel(nz, 1, px, py, freq) - 0.5),
  ];
}

// Roughen a rendered block: read `src`, write the displaced picture into `dst`.
// Both are ImageData (or anything with `width`, `height` and a `data` of RGBA
// bytes) of the same size.
//
// `ss` is how many device pixels the raster holds per page px, and (originX,
// originY) is where the noise field's origin sits in it, in page px - the corner
// of the element the editor hangs the filter on, so the pattern lands on the
// letters the same way on both sides. A whole pixel is copied rather than
// sampled, which is what the filter does too, and premultiplication cannot
// matter to a copy.
// Four noise lookups per device pixel is the whole cost of this pass, and a
// page-filling roughened box is several million of them on the main thread. The
// loop below spends them only where they can change something:
//
//   - a whole RGBA pixel is one 32-bit word, so "is anything drawn here" is one
//     comparison per pixel rather than four, and one scan of the source gives
//     the first and last drawn column of every row;
//   - a pixel is displaced by at most half of `amount`, so a pixel further than
//     that from every drawn pixel copies a fully zero one whichever way the
//     noise pushes it. Those get their zero written straight out, and the noise
//     is asked only inside the band that can actually pick up ink. On a block of
//     text that is the difference between the whole footprint and the letters.
//
// Both shortcuts are exact rather than approximate: the skipped pixels are the
// ones whose every possible source is zero in all four channels.

// The pixels as 32-bit words, where the bytes are a real view over a buffer.
function wordsOf(bytes, n) {
  try {
    if (bytes?.buffer && bytes.byteOffset % 4 === 0 && bytes.byteLength >= n * 4) {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, n);
    }
  } catch {
    /* not a view over anything: fall back to the byte loops */
  }
  return null;
}

export function roughenPixels(src, dst, r, { ss = 1, originX = 0, originY = 0 } = {}) {
  const w = src.width;
  const h = src.height;
  const s = src.data;
  const d = dst.data;
  const nz = noiseFor(r?.seed ?? 0);
  const lat = nz.lattice;
  const gx = nz.grad[0];
  const gy = nz.grad[1];
  const freq = Number(r?.detail) || 0;
  const amount = Number(r?.amount) || 0;
  const sw = wordsOf(s, w * h);
  const dw = wordsOf(d, w * h);

  // Nothing to displace by: the pass is a copy, and saying so is faster than
  // evaluating a field that will round to zero at every pixel.
  if (amount === 0) {
    if (sw && dw) dw.set(sw);
    else d.set(s);
    return dst;
  }

  // How far a pixel can be pulled from, in device px. `amount` is the full span
  // of the displacement, so half of it either way, and the rounding is worth a
  // pixel more.
  const reach = Math.ceil(Math.abs(amount) * 0.5 * ss) + 1;
  // The drawn span of every row, or -1 for a row with nothing in it.
  const rowLo = new Int32Array(h).fill(-1);
  const rowHi = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    if (!sw) {
      rowLo[y] = 0;
      rowHi[y] = w - 1;
      continue;
    }
    let lo = -1;
    for (let x = 0; x < w; x++) {
      if (sw[base + x] !== 0) {
        lo = x;
        break;
      }
    }
    if (lo < 0) continue;
    let hi = lo;
    for (let x = w - 1; x > lo; x--) {
      if (sw[base + x] !== 0) {
        hi = x;
        break;
      }
    }
    rowLo[y] = lo;
    rowHi[y] = hi;
  }

  const zero = (from, to) => {
    if (from >= to) return;
    if (dw) dw.fill(0, from, to);
    else for (let i = from * 4; i < to * 4; i++) d[i] = 0;
  };

  const invSS = 1 / ss;
  const xBase = 0.5 * invSS - originX + NOISE_PHASE;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    // The rows this one can reach into, and the columns any of them has ink in.
    let lo = w;
    let hi = -1;
    const k0 = y - reach < 0 ? 0 : y - reach;
    const k1 = y + reach > h - 1 ? h - 1 : y + reach;
    for (let k = k0; k <= k1; k++) {
      if (rowHi[k] < 0) continue;
      if (rowLo[k] < lo) lo = rowLo[k];
      if (rowHi[k] > hi) hi = rowHi[k];
    }
    if (hi < 0) {
      zero(base, base + w);
      continue;
    }
    const xlo = lo - reach < 0 ? 0 : lo - reach;
    const xhi = hi + reach > w - 1 ? w - 1 : hi + reach;
    zero(base, base + xlo);
    zero(base + xhi + 1, base + w);

    // Pixel centres, so the field is sampled where the pixel actually is.
    const pyf = ((y + 0.5) * invSS - originY + NOISE_PHASE) * freq;
    for (let x = xlo; x <= xhi; x++) {
      const pxf = (xBase + x * invSS) * freq;
      const ox = Math.round(amount * (turbAt(lat, gx, pxf, pyf, OCTAVES) - 0.5) * ss);
      const oy = Math.round(amount * (turbAt(lat, gy, pxf, pyf, OCTAVES) - 0.5) * ss);
      let sx = x + ox;
      let sy = y + oy;
      if (sx < 0) sx = 0;
      else if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0;
      else if (sy >= h) sy = h - 1;
      const di = base + x;
      const si = sy * w + sx;
      if (sw && dw) {
        dw[di] = sw[si];
      } else {
        d[di * 4] = s[si * 4];
        d[di * 4 + 1] = s[si * 4 + 1];
        d[di * 4 + 2] = s[si * 4 + 2];
        d[di * 4 + 3] = s[si * 4 + 3];
      }
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Motion blur.
//
// TypeBubble's shader, restated as a flat tap list. The original (see
// external/TypeBubble/src/Shaders/motion_blur.gdshader) runs `amount`
// iterations of the Experience-Monks 5-tap gaussian, each iteration at a
// growing spread (`size = amount - i`), and divides the sum by `amount + 1` -
// which dims the picture by amount/(amount+1), and that dimming is part of
// the look, so it is kept. Every sample is a point mass on the line through
// the direction vector, so the whole thing collapses to one weighted tap
// list, computed here once and executed by BOTH renderers: the editor as an
// SVG feOffset + feComposite/arithmetic accumulation chain, the exporter as
// 'lighter' canvas draws at each tap's weight. One list, two executions, the
// same smear.
//
// `x`/`y` are the shader's blur_direction (pixels per unit step - the shader
// divides its uv offsets by pixel size, so the vector is already in pixels),
// `amount` its iteration count. Direction (0,0) means no taps at all: the
// shader would still dim by 1/(amount+1), but a smear control that only
// darkens is a bug, not a look.
const MB_OFF1 = 1.3846153846;
const MB_OFF2 = 3.2307692308;
const MB_W0 = 0.227027027;
const MB_W1 = 0.3162162162;
const MB_W2 = 0.0702702703;

export function motionBlurTaps(x, y, amount) {
  const dx = Number(x) || 0;
  const dy = Number(y) || 0;
  if (dx === 0 && dy === 0) return [];
  const it = Math.min(32, Math.max(1, Math.round(Number(amount) || 0)));
  const norm = 1 / (it + 1);
  // The centre tap is sampled once per iteration, always at the origin.
  const out = [{ dx: 0, dy: 0, w: MB_W0 * it * norm }];
  for (let s = 1; s <= it; s++) {
    for (const [c, w] of [[MB_OFF1, MB_W1], [MB_OFF2, MB_W2]]) {
      out.push({ dx: c * dx * s, dy: c * dy * s, w: w * norm });
      out.push({ dx: -c * dx * s, dy: -c * dy * s, w: w * norm });
    }
  }
  return out;
}

// The editor's live filter pays for taps in a way the exporter does not: every
// named result in an SVG filter chain is its own raster surface in WebKit, so
// 129 taps on one box is hundreds of megabytes of backing store the canvas
// path never allocates. The preview therefore samples the same smear coarser:
// at most `maxIt` iterations stretched over the full extent (offsets scale
// with the step, so scaling the direction keeps the reach), re-dimmed to the
// full list's it/(it+1) brightness so the preview and the export match in
// tone. The exporter keeps calling `motionBlurTaps` - its accumulation is flat
// canvas draws, where taps are nearly free.
export function motionBlurPreviewTaps(x, y, amount, maxIt = 8) {
  const dx = Number(x) || 0;
  const dy = Number(y) || 0;
  if (dx === 0 && dy === 0) return [];
  const it = Math.min(32, Math.max(1, Math.round(Number(amount) || 0)));
  if (it <= maxIt) return motionBlurTaps(dx, dy, it);
  const stretch = it / maxIt;
  const dim = (it / (it + 1)) / (maxIt / (maxIt + 1));
  return motionBlurTaps(dx * stretch, dy * stretch, maxIt).map((t) => ({ ...t, w: t.w * dim }));
}

// How far the smear can carry ink past the glyphs, in page px: the furthest
// tap, plus a pixel for the rounding.
export function motionBlurExtent(mb) {
  if (!mb?.on) return 0;
  const d = Math.hypot(Number(mb.x) || 0, Number(mb.y) || 0);
  if (d === 0) return 0;
  const it = Math.min(32, Math.max(1, Math.round(Number(mb.amount) || 0)));
  return Math.ceil(MB_OFF2 * d * it) + 1;
}

// ---------------------------------------------------------------------------
// The visibility mask.
//
// Paints the style's mask shapes as opaque ink into `ctx`, in the same
// box-local page px the shapes are stored in. What the caller does with the
// ink is the mode: the exporter composites it 'destination-in' (include) or
// 'destination-out' (exclude) over the finished raster, the editor turns the
// same drawing into a CSS mask-image. One painter, so the two masks are the
// one mask.
export function drawClipShapes(ctx, shapes) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sh of shapes ?? []) {
    if (sh.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(sh.cx, sh.cy, sh.rx, sh.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (sh.kind === 'poly') {
      ctx.beginPath();
      sh.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fill();
    } else if (sh.kind === 'stroke') {
      if (sh.pts.length === 1) {
        // A click with no drag: the brush's dot.
        ctx.beginPath();
        ctx.arc(sh.pts[0][0], sh.pts[0][1], sh.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        sh.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.lineWidth = sh.size;
        ctx.stroke();
      }
    }
  }
}

// Whether the mask changes anything at all: on, with at least one shape.
export function clipActive(clip) {
  return !!(clip?.on && (clip.shapes?.length ?? 0) > 0);
}

// Which fill the style asks for. Pattern beats gradient when both are on, which
// is stated once here rather than in each renderer's if-chain.
export function fillKind(style) {
  if (style?.pattern?.on) return 'pattern';
  if (style?.gradient?.on) return 'gradient';
  return 'solid';
}
