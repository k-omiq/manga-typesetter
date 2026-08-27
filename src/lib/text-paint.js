// The arithmetic behind a text block's paint: strokes, gradient, pattern.
//
// It lives on its own because the editor draws a box with stacked DOM layers and
// the exporter draws the same box with canvas calls, and the two have to agree
// pixel for pixel. Anything both of them have to compute - how wide a stroke is
// actually drawn, where a gradient starts and ends, what one pattern tile looks
// like - is answered here once, so a change lands on both at the same time.

import { strokeStamps, strokeBounds } from './brush.js';

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

// ---------------------------------------------------------------------------
// Hand-drawn ink.
//
// The same arrangement the mask uses: one painter, called by the editor's
// overlay canvas and by the exporter's box canvas, so what is on screen and
// what lands in the file are the one drawing. Coordinates are box-local page
// px; the caller has already translated to the box's top-left.

// Whether the ink draws anything at all: on, with at least one stroke.
export function inkActive(ink) {
  return !!(ink?.on && (ink.strokes?.length ?? 0) > 0);
}

// How far the ink reaches outside the box past its origin, in page px on the
// furthest edge. The export pads its canvas by this so a stroke drawn over the
// box edge is not cut off - the same job `motionBlurExtent` does for the smear.
// Only the outward overhang counts: ink inside the box needs no padding, and
// the origin sides are the only ones a stroke can be measured against without
// the box's size. Measuring the far edges the same way - from the origin - would
// pad every inked box by its own width, since ink normally covers the box.
export function inkExtent(ink) {
  if (!inkActive(ink)) return 0;
  let out = 0;
  for (const k of ink.strokes) {
    const b = strokeBounds(k);
    if (!b) continue;
    out = Math.max(out, -b.minX, -b.minY);
  }
  return Math.ceil(Math.max(0, out));
}

// One stamp of a round tip. `hardness` 100 is a flat disc; below that the edge
// falls off, which is the only way a synthesised tip can look like anything
// other than a marker pen.
//
// `hardness` belongs to this tip and to no other: an imported tip carries its
// edge in its own pixels, and CSP ignores the setting for a pattern tip in the
// same way. The stroke still stores it, for the moment the letterer switches
// the same settings back to round.
function stampRound(ctx, s, color, hardness, flatness) {
  const r = s.size / 2;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
  if (flatness !== 1) ctx.scale(1, flatness);
  ctx.globalAlpha = s.alpha;
  if (hardness >= 100) {
    ctx.fillStyle = color;
  } else {
    // A radial ramp from solid to clear. The solid core is the hardness, so
    // hardness 0 is a fully soft dab and 99 is a disc with a one-percent edge.
    const g = ctx.createRadialGradient(0, 0, r * (hardness / 100), 0, 0, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Imported tips.
//
// A `.sut` tip arrives as an 8-bit greyscale image with the ink at 255 - a
// coverage mask, not a picture - so stamping it is two problems: it has to be
// tinted to the stroke's colour, and it has to be drawn at a fraction of its
// own size without the shimmer a per-stamp downscale of a 2000 px tip gives.
//
// Both are answered once per (tip, colour) and then reused by every stamp:
//
//   * The tint is a canvas whose RGB is the ink's colour and whose ALPHA is the
//     tip's grey. Per stamp it would be a full-resolution pixel pass each time,
//     which is the difference between a brush that draws and one that hangs.
//   * The mip chain halves that canvas until the short side would drop under
//     `MIP_MIN`, and a stamp draws from the smallest level still at least as
//     big as it needs. Downscaling by less than 2x is what a canvas resamples
//     well; downscaling a 2352 px tip to 24 px in one step is what makes a
//     stroke crawl and sparkle as the size dynamics move.
//
// The chain hangs off the tip wrapper the library handed us, so the library's
// cache owns its lifetime: when a tip is evicted or forgotten, the wrapper goes
// and its canvases go with it. See THE TIP LIFETIME CONTRACT in
// `brush-library.svelte.js` - a painter holds a tip for one frame and re-asks.

// The short side a mip level may not go under. Below this the levels stop
// being useful (a stamp that small is a smudge either way) and the chain is
// mostly bookkeeping.
const MIP_MIN = 32;

// How many colours of one tip are kept. A stroke is one colour and the panel's
// preview is often another; a third is a colour nobody is drawing with any more.
const TINT_SLOTS = 2;

// The longest side a tinted chain is built at. The corpus has tips up to
// 2352 x 11394, and a tinted copy of one is 107 MB of canvas held for as long
// as the library keeps the tip - on top of the decoded tip the library's own
// budget already accounts for. Nothing stamps a brush 2048 device px across, so
// the cap costs no picture anyone will see and keeps the tint a fraction of the
// tip rather than a second copy of it. The full-resolution read still happens -
// there is no other way to get at the grey - but it is handed back at once.
export const TINT_MAX = 2048;

// Hand a canvas's pixels back rather than waiting for a collection - the same
// thing `drawInk` does with its layers, and for the same reason.
function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

// The tip's own pixel size. The decoded image is the authority where it has
// one; the index's dimensions are what a platform without a decoder knows.
function tipSize(tip) {
  const w = Number(tip?.image?.width) || Number(tip?.width) || 0;
  const h = Number(tip?.image?.height) || Number(tip?.height) || 0;
  return w > 0 && h > 0 ? [w, h] : null;
}

// The tinted tip and its mip chain, biggest first. Null when the tip cannot be
// read - no decoded image, or a canvas that will not give its pixels back
// (a tainted one), both of which fall the stroke back to the round dab.
function buildTinted(tip, color, alloc) {
  const size = tipSize(tip);
  if (!size || !tip.image) return null;
  const [w, h] = size;
  const base = alloc(w, h);
  const bctx = base?.getContext?.('2d');
  if (!bctx) return null;
  let px;
  try {
    bctx.drawImage(tip.image, 0, 0, w, h);
    px = bctx.getImageData(0, 0, w, h);
  } catch {
    releaseCanvas(base);
    return null;
  }
  const [r, g, b] = channels(color);
  const d = px.data;
  // The tip is greyscale, so one channel is the grey; its own alpha is opaque
  // across the whole image, and multiplying by it costs nothing and keeps a
  // hand-made RGBA tip honest.
  for (let i = 0; i < d.length; i += 4) {
    const cov = (d[i] * d[i + 3]) / 255;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = cov;
  }
  bctx.putImageData(px, 0, 0);
  const levels = [capTint(base, alloc)];
  let cur = levels[0];
  // Halve while the halved level still has a usable short side. Halving rather
  // than jumping straight to the size a stamp wants is what keeps the average
  // right: each level is the box filter of the one above it.
  while (Math.min(cur.width, cur.height) >= MIP_MIN * 2) {
    const nw = Math.max(1, Math.round(cur.width / 2));
    const nh = Math.max(1, Math.round(cur.height / 2));
    if (nw === cur.width && nh === cur.height) break;
    const next = alloc(nw, nh);
    const nctx = next?.getContext?.('2d');
    if (!nctx) break;
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, nw, nh);
    levels.push(next);
    cur = next;
  }
  return levels;
}

// The tinted tip at no more than `TINT_MAX` on its longest side, handing the
// full-resolution one back when it had to shrink.
function capTint(full, alloc) {
  const long = Math.max(full.width, full.height);
  if (long <= TINT_MAX) return full;
  const k = TINT_MAX / long;
  const cw = Math.max(1, Math.round(full.width * k));
  const ch = Math.max(1, Math.round(full.height * k));
  const small = alloc(cw, ch);
  const sctx = small?.getContext?.('2d');
  if (!sctx) return full;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(full, 0, 0, cw, ch);
  releaseCanvas(full);
  return small;
}

// The chain for this tip in this colour, built on first use and then reused.
function tipLevels(tip, color, alloc) {
  if (!tip) return null;
  let byColour = tip.tinted;
  if (!(byColour instanceof Map)) {
    byColour = new Map();
    tip.tinted = byColour;
  }
  const key = String(color ?? '#000000').toLowerCase();
  const had = byColour.get(key);
  if (had) {
    // Touch: insertion order is least recently used first.
    byColour.delete(key);
    byColour.set(key, had);
    return had;
  }
  const levels = buildTinted(tip, color, alloc);
  if (!levels) return null;
  byColour.set(key, levels);
  while (byColour.size > TINT_SLOTS) {
    const oldest = byColour.keys().next().value;
    for (const c of byColour.get(oldest)) releaseCanvas(c);
    byColour.delete(oldest);
  }
  return levels;
}

// The level to stamp from: the smallest one still at least as wide as the
// stamp will be drawn on the device. Anything smaller would be upscaled, which
// is blur; anything bigger is a downscale the chain has already paid for.
export function pickTipLevel(levels, devicePx) {
  let out = levels[0];
  for (let i = 1; i < levels.length; i++) {
    if (Math.max(levels[i].width, levels[i].height) < devicePx) break;
    out = levels[i];
  }
  return out;
}

// One stamp of an imported tip. The tip's LONGEST side is the stamp's size, so
// a tall tip stays tall and a stroke's size means the same thing whichever
// brush is loaded; `flatness` then squashes the tip's own y axis, exactly as it
// squashes the round dab's, so the two tips read the same at the same setting.
function stampTip(ctx, s, levels, natural, flatness, smooth, scale) {
  const [nw, nh] = natural;
  const f = s.size / Math.max(nw, nh);
  const dw = nw * f;
  const dh = nh * f;
  if (!(dw > 0) || !(dh > 0)) return;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
  if (flatness !== 1) ctx.scale(1, flatness);
  ctx.globalAlpha = s.alpha;
  // The pixel look CSP gives with anti-aliasing off starts here: a tip drawn
  // through a smoothing resample would arrive with a soft edge for the snap to
  // find, and half of it would land on the wrong side.
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pickTipLevel(levels, Math.max(dw, dh) * scale), -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// The tip a stroke stamps with, or null for the round dab. Null covers every
// way an imported brush can fail to be there - the stroke was drawn with the
// round tip, the caller prefetched nothing, the tip has not finished decoding,
// the brush is missing from this install - and in all of them the stroke draws
// round FOR THIS FRAME while keeping the brush id it was drawn with. See
// `resolveBrush`: the fallback is a reading, never a rewrite.
function tipFor(k, tips) {
  const id = k?.brush;
  if (!tips || !id || id === 'round') return null;
  const tip = typeof tips.get === 'function' ? tips.get(id) : tips[id];
  return tip?.image && tipSize(tip) ? tip : null;
}

// ---------------------------------------------------------------------------
// The watercolour edge: CSP's darkened rim, where the pigment pools as the
// water dries. It is a post-pass over the finished stroke's alpha, never a
// property of the tip - a stamp has no idea where the stroke's outline is, so
// running it per dab would ring every overlap down the middle of the line
// instead of drawing one rim around the whole thing.

// How many device px one page px is worth under `t`. The editor hands drawInk
// its zoom, the exporter its supersample and the brush panel its pixel ratio,
// and a band stated in page px has to come out the same width in all three - so
// the pass takes its radius from the transform it was actually given rather
// than from a scale passed alongside it. The square root of the determinant is
// the area scale, which stays honest under rotation and mirroring.
export function transformScale(t) {
  const det = Math.abs((t?.a ?? 1) * (t?.d ?? 1) - (t?.b ?? 0) * (t?.c ?? 0));
  return det > 0 ? Math.sqrt(det) : 1;
}

// The smallest value in every window of 2r+1 along one line of the plane.
// Anything past the ends counts as clear, so the first and last r entries erode
// to nothing - which is what they are, since the ink stops there. A monotonic
// deque, so the cost is the plane and not the plane times the radius: the
// radius follows the zoom, and a 20 px band at 400% is an 80 px window.
function minLine(src, dst, n, base, stride, r, dq) {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n; j++) {
    const v = src[base + j * stride];
    while (tail > head && src[base + dq[tail - 1] * stride] >= v) tail--;
    dq[tail++] = j;
    // The window ending at j is centred on j - r, and is only whole once that
    // centre is r past the start.
    const i = j - r;
    if (i >= r) {
      while (dq[head] < j - 2 * r) head++;
      dst[base + i * stride] = src[base + dq[head] * stride];
    }
  }
}

// The alpha plane shrunk by r px on every side: a pixel keeps its value only if
// nothing fainter sits within r of it. Two separable passes, which makes the
// structuring element a square rather than a disc - at these radii that is a
// fraction of a pixel out at the diagonals, and it costs an order of magnitude
// less than the true disc.
export function erodeAlpha(alpha, w, h, r) {
  const dq = new Int32Array(Math.max(w, h));
  const tmp = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) minLine(alpha, tmp, w, y * w, 1, r, dq);
  const out = new Uint8ClampedArray(w * h);
  for (let x = 0; x < w; x++) minLine(tmp, out, h, x, w, r, dq);
  return out;
}

// The pass itself, in place over an ImageData's bytes. The band is what the
// erosion took off - every pixel within `radius` of the stroke's edge - and it
// does two things there, because a rim has to read as darker and only one of
// the two can say that on its own:
//
//   - the alpha goes up by the band scaled by `power`, which is the pigment
//     pooling: a soft edge gets denser rather than fading out;
//   - the colour goes down towards black by the same amount, which is what
//     shows on the brush people actually use. A hardness-100 stroke is already
//     opaque to the rim, so there is no alpha left to add and an alpha-only
//     pass would be invisible on the default brush and on every coloured one.
//
// The core - alpha already flat for `radius` in every direction - comes out
// byte-identical, and power 0 changes nothing at all, so the slider and the
// switch agree. ImageData is not premultiplied, so the colour under the band is
// the ink's own and can be scaled directly; where there is no alpha there is no
// band either, since the erosion has nothing to take off.
export function waterEdgePixels(data, w, h, radius, power) {
  const p = Math.min(1, Math.max(0, Number(power) || 0));
  const r = Math.max(1, Math.round(Number(radius) || 0));
  if (p <= 0) return data;
  const n = w * h;
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) alpha[i] = data[j];
  const er = erodeAlpha(alpha, w, h, r);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const band = alpha[i] - er[i];
    if (band <= 0) continue;
    const f = Math.max(0, 1 - (p * band) / 255);
    data[j] *= f;
    data[j + 1] *= f;
    data[j + 2] *= f;
    data[j + 3] = Math.min(255, alpha[i] + band * p);
  }
  return data;
}

// Whether a stroke asks for the edge at all. Read twice - once to decide the
// stroke needs a layer, once to run the pass - so it is stated once here.
function wantsWaterEdge(k) {
  return k?.waterEdge === true && +k.waterEdgePower > 0 && +k.waterEdgeWidth > 0;
}

// The device-px rectangle the pass has to touch: the stroke's own ink, grown by
// the band and a pixel of slack, clipped to the layer. Bounding the read is
// what keeps a live stroke cheap - the alternative is reading a whole layer
// back per stroke per frame - and the margin of clear pixels the padding buys
// is what lets the erosion see an edge where the edge is.
function inkRect(k, stamps, t, w, h, pad) {
  const b = strokeBounds(k, stamps);
  if (!b) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]]) {
    const dx = t.a * x + t.c * y + t.e;
    const dy = t.b * x + t.d * y + t.f;
    if (dx < x0) x0 = dx;
    if (dx > x1) x1 = dx;
    if (dy < y0) y0 = dy;
    if (dy > y1) y1 = dy;
  }
  const rx = Math.max(0, Math.floor(x0 - pad));
  const ry = Math.max(0, Math.floor(y0 - pad));
  const rw = Math.min(w, Math.ceil(x1 + pad)) - rx;
  const rh = Math.min(h, Math.ceil(y1 + pad)) - ry;
  if (rw <= 0 || rh <= 0) return null;
  return { x: rx, y: ry, w: rw, h: rh };
}

// Paint every stroke. Stamps overlap heavily by design, so each stroke is drawn
// into its own layer and composited once: stamping straight onto the target at
// a stroke opacity below 1 would darken every overlap and turn a smooth line
// into a string of beads.
//
// `tips` is the decoded tips this frame has in hand, id -> the library's tip
// wrapper. The painter is synchronous and reading a tip off disk is not, so the
// caller prefetches - `settleInkTips` / `settleBoxTips` in `brush-tips.js` - and
// hands the result down. A stroke whose tip is not in there stamps the round
// dab for this frame and keeps its brush id, which is what makes the first
// frame of a chapter draw immediately instead of waiting on a decode.
export function drawInk(ctx, ink, makeCanvas, tips) {
  if (!inkActive(ink)) return;
  const alloc = makeCanvas ?? ((w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
  for (const k of ink.strokes) {
    const stamps = strokeStamps(k);
    if (!stamps.length) continue;
    // The caller's transform, read once. The layer below copies it, and the
    // mip chain is asked for the level a stamp lands at through it - so how
    // many device px a page px is worth is one answer serving both paths.
    const t = ctx.getTransform();
    const scale = transformScale(t);
    const tip = tipFor(k, tips);
    const levels = tip ? tipLevels(tip, k.color, alloc) : null;
    const natural = levels ? tipSize(tip) : null;
    const stamp = levels
      ? (c, s) => stampTip(c, s, levels, natural, k.flatness, k.antialias !== false, scale)
      : (c, s) => stampRound(c, s, k.color, k.hardness, k.flatness);
    const solid = k.opacity >= 0.999;
    const water = wantsWaterEdge(k);
    // Three reasons to detour through a layer: a translucent stroke must not
    // let its own stamps darken each other where they overlap, an aliased one
    // needs its finished shape in hand before the edge can be cut hard, and the
    // watercolour edge is a pass over that finished shape too.
    const layered = !solid || k.antialias === false || water;
    if (!layered) {
      for (const s of stamps) stamp(ctx, s);
      continue;
    }
    // The layer is only as big as the target; the caller's transform already
    // places the box, so the layer copies that transform rather than guessing
    // its own bounds.
    const layer = alloc(ctx.canvas.width, ctx.canvas.height);
    const lctx = layer.getContext('2d');
    lctx.setTransform(t);
    for (const s of stamps) stamp(lctx, { ...s, alpha: 1 });
    if (water) {
      // Once per stroke, over its own layer, and before the anti-aliasing snap
      // below: the edge is drawn on the soft alpha the stamps left, and the
      // pixel look is the last word on what is in the stroke and what is out.
      // The snap only ever touches alpha, so the darkened rim survives it.
      // The radius is the band's page px through the caller's transform, which
      // is what keeps the screen and the file the same picture. The stamps are
      // handed on rather than laid out again: this runs per stroke per frame
      // while the pointer is down.
      const r = Math.max(1, Math.round(k.waterEdgeWidth * scale));
      const rect = inkRect(k, stamps, t, layer.width, layer.height, r + 2);
      if (rect) {
        const px = lctx.getImageData(rect.x, rect.y, rect.w, rect.h);
        waterEdgePixels(px.data, rect.w, rect.h, r, k.waterEdgePower);
        lctx.putImageData(px, rect.x, rect.y);
      }
    }
    if (k.antialias === false) {
      // The pixel look CSP gives with anti-aliasing off: every pixel is either
      // in the stroke or out of it, so the soft ramp the stamps painted is
      // snapped to the nearest of the two at the halfway point.
      const px = lctx.getImageData(0, 0, layer.width, layer.height);
      const d = px.data;
      for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
      lctx.putImageData(px, 0, 0);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = k.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    // Hand the pixels back rather than waiting for a collection: a batch export
    // renders one of these per stroke per page.
    layer.width = 0;
    layer.height = 0;
  }
}

// Which fill the style asks for. Pattern beats gradient when both are on, which
// is stated once here rather than in each renderer's if-chain.
export function fillKind(style) {
  if (style?.pattern?.on) return 'pattern';
  if (style?.gradient?.on) return 'gradient';
  return 'solid';
}
