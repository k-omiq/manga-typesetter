// ===== App seed data =====
// Pages read right-to-left; text lines numbered in RTL reading order.

// Default page dimensions until a real image sets them from its natural size.
export const PAGE_W = 850;
export const PAGE_H = 1200;

// The four faces a family can hold. A style has two independent switches (bold,
// italic) and this is their product; the app has no weight axis beyond it, so
// anything heavier than regular lands in `bold`.
export const FACE_SLOTS = ['regular', 'bold', 'italic', 'boldItalic'];

// A face map with nothing in it. A slot holds a descriptor `{ file }` - the
// name of the file the user dropped, or null for a built-in, whose bytes come
// from Google rather than from disk - and a null slot means "no real face
// exists", which is the app's only licence to let the browser synthesise one.
export function emptyFaces() {
  return { regular: null, bold: null, italic: null, boldItalic: null };
}

const googleFaces = (...slots) => {
  const faces = emptyFaces();
  for (const s of slots) faces[s] = { file: null };
  return faces;
};

// Built-in fonts: real, bundled Google Font families (loaded in index.html).
// Named by their actual family so nothing is misrepresented. Users add their
// own manga fonts via the Font Library (persisted in IndexedDB).
//
// The `faces` map is a claim about reality that the rest of the app trusts: the
// PSD exporter reads it to decide whether Photoshop has to be told to fake a
// face, and the Font Library shows the user which of their four faces are real.
// So it mirrors, face for face, what the Google Fonts URL in index.html
// actually requests - Bangers and the three handwriting families ship regular
// only, so their bold and italic really are synthesised and are recorded as
// absent. Extend one of the two and you must extend the other.
export const BUILTIN_FONTS = [
  { name: 'Bangers', css: "'Bangers', cursive", faces: googleFaces('regular') },
  { name: 'Comic Neue', css: "'Comic Neue', cursive", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Patrick Hand', css: "'Patrick Hand', cursive", faces: googleFaces('regular') },
  { name: 'Permanent Marker', css: "'Permanent Marker', cursive", faces: googleFaces('regular') },
  { name: 'Architects Daughter', css: "'Architects Daughter', cursive", faces: googleFaces('regular') },
  { name: 'Nunito', css: "'Nunito', sans-serif", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Playfair Display', css: "'Playfair Display', serif", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Luckiest Guy', css: "'Luckiest Guy', cursive", faces: googleFaces('regular') },
  { name: 'Creepster', css: "'Creepster', cursive", faces: googleFaces('regular') },
  { name: 'Nosifer', css: "'Nosifer', cursive", faces: googleFaces('regular') },
  { name: 'Eater', css: "'Eater', cursive", faces: googleFaces('regular') },
  { name: 'Special Elite', css: "'Special Elite', cursive", faces: googleFaces('regular') },
  { name: 'Rock Salt', css: "'Rock Salt', cursive", faces: googleFaces('regular') },
  { name: 'Fredericka the Great', css: "'Fredericka the Great', cursive", faces: googleFaces('regular') },
  { name: 'Indie Flower', css: "'Indie Flower', cursive", faces: googleFaces('regular') },
  { name: 'Gloria Hallelujah', css: "'Gloria Hallelujah', cursive", faces: googleFaces('regular') },
  { name: 'Shadows Into Light', css: "'Shadows Into Light', cursive", faces: googleFaces('regular') },
  { name: 'Kalam', css: "'Kalam', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Caveat', css: "'Caveat', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Amatic SC', css: "'Amatic SC', cursive", faces: googleFaces('regular', 'bold') },
  { name: 'Bebas Neue', css: "'Bebas Neue', sans-serif", faces: googleFaces('regular') },
  { name: 'Anton', css: "'Anton', sans-serif", faces: googleFaces('regular') },
  { name: 'Oswald', css: "'Oswald', sans-serif", faces: googleFaces('regular', 'bold') },
  { name: 'Black Ops One', css: "'Black Ops One', cursive", faces: googleFaces('regular') },
  { name: 'Bungee', css: "'Bungee', cursive", faces: googleFaces('regular') },
  { name: 'Chewy', css: "'Chewy', cursive", faces: googleFaces('regular') },
  { name: 'Boogaloo', css: "'Boogaloo', cursive", faces: googleFaces('regular') },
  { name: 'Press Start 2P', css: "'Press Start 2P', monospace", faces: googleFaces('regular') },
  { name: 'Cinzel', css: "'Cinzel', serif", faces: googleFaces('regular', 'bold') },
  { name: 'Mansalva', css: "'Mansalva', cursive", faces: googleFaces('regular') },
  { name: 'Sedgwick Ave', css: "'Sedgwick Ave', cursive", faces: googleFaces('regular') },
  { name: 'Grandstander', css: "'Grandstander', cursive", faces: googleFaces('regular', 'bold', 'italic', 'boldItalic') },
  { name: 'Delius', css: "'Delius', cursive", faces: googleFaces('regular') },
  { name: 'Schoolbell', css: "'Schoolbell', cursive", faces: googleFaces('regular') },
  { name: 'Walter Turncoat', css: "'Walter Turncoat', cursive", faces: googleFaces('regular') },
  { name: 'Just Another Hand', css: "'Just Another Hand', cursive", faces: googleFaces('regular') },
  { name: 'Mouse Memoirs', css: "'Mouse Memoirs', sans-serif", faces: googleFaces('regular') },
  { name: 'Lilita One', css: "'Lilita One', cursive", faces: googleFaces('regular') },
  { name: 'Titan One', css: "'Titan One', cursive", faces: googleFaces('regular') },
  { name: 'Sigmar One', css: "'Sigmar One', cursive", faces: googleFaces('regular') },
  { name: 'Rubik Mono One', css: "'Rubik Mono One', monospace", faces: googleFaces('regular') },
];

// User fonts start empty and are populated only by real uploads (restored
// from IndexedDB on launch). No fake entries.
export const USER_FONTS = [];

export function fontCss(name, userFonts = USER_FONTS) {
  const f = [...BUILTIN_FONTS, ...userFonts].find((f) => f.name === name);
  return f ? f.css : "'Comic Neue', cursive";
}

// ===== typesetting defaults for a NEW box =====
// Five of the style properties below are not really styling at all - they are
// how the layout engine behaves - and they are set once, for the whole app, in
// Settings › Typesetting rather than per box in the Inspector. `prefs.svelte.js`
// owns the preference and mirrors it here with `setBoxDefaults` (the same way it
// mirrors the beta switch into measure.js), because this module is a leaf: it
// imports nothing, which is what lets everyone else import it.
//
// The starting values are `defaultStyle()`'s own, so a build with nothing stored
// - and every style ever saved to disk - behaves exactly as it did before this
// existed.
const boxDefaults = {
  autoHeight: true,
  shape: 'auto',
  hyphenate: true,
  balloon: true,
  minOrphan: 3,
};

export function setBoxDefaults(next) {
  if (!next || typeof next !== 'object') return;
  // Assigned key by key, not swapped wholesale: a partial object from a caller
  // that only knows about four of the five must not delete the fifth.
  for (const k of Object.keys(boxDefaults)) {
    if (next[k] !== undefined) boxDefaults[k] = next[k];
  }
}

// Stamp the defaults onto a style a box is about to be born with.
//
// PRECEDENCE, and this is the whole of it:
//
//   these five flags   always come from the preferences. They are engine
//                      behaviour, they are set in Settings, and a box created
//                      after a switch was flipped honours the switch.
//   everything else    keeps inheriting `app.lastStyle` exactly as before - the
//                      font, size, colour and strokes the user chose by hand on
//                      the last box they touched.
//
// A duplicate is NOT a box born from nothing: `duplicateBox` copies its source's
// style whole, these five included, because a copy that laid its text out
// differently from the box it was copied from would not be a copy. Loading a
// chapter is the same: every saved style is taken as written.
//
// The alternative - letting `lastStyle` carry these five forward too - meant one
// bulk edit turning auto height off somewhere quietly became the default for
// every box placed afterwards, with nothing on screen saying so now that the
// Inspector no longer shows the flag. A box that needs a different answer gets
// it from the Bulk style panel, which still exposes all five.
export function applyBoxDefaults(style) {
  if (!style || typeof style !== 'object') return style;
  Object.assign(style, boxDefaults);
  // A newborn box never inherits the previous box's bezier path or mask
  // shapes: both are that box's own geometry, and carried onto a box of
  // another size they curve or hide text they were never drawn for. A
  // DUPLICATE keeps them - duplicateBox copies the style whole and does not
  // come through here - which is the same line the comment above draws.
  style.path = { on: false, pts: [] };
  style.clip = { on: false, mode: 'exclude', brushSize: style.clip?.brushSize ?? 20, shapes: [] };
  return style;
}

// default style applied to a freshly-dropped text box
export function defaultStyle() {
  return {
    font: 'Comic Neue',
    size: 26,
    bold: true,
    italic: false,
    align: 'center',
    valign: 'middle', // top | middle | bottom
    // Whole-box alpha, applied over everything (fill, strokes, shadows).
    opacity: 1,
    // ---- fill ----
    // Solid fill colour. Still the single source for the glyph colour when
    // neither gradient nor pattern is on; when one of them is on it is the
    // colour behind the fill layer (and the PSD fallback colour).
    color: '#1a1a1a',
    // Gradient fill. `scope` decides what the gradient spans: 'box' runs once
    // across the whole text block, 'line' restarts on every wrapped line.
    // `kind` is 'linear' or 'radial'.
    // `angle` uses CSS linear-gradient degrees: 0 = bottom→top, 90 = left→right,
    // 180 = top→bottom. `stops` is kept sorted by `pos` (0..1), between
    // GRADIENT_MIN_STOPS and GRADIENT_MAX_STOPS of them, each one a colour, a
    // position and its own `opacity` (0..1) - the alpha the ramp reaches at that
    // point, which is separate from `fillOpacity` (the whole fill layer) and
    // from `opacity` (the whole box).
    // A radial gradient ignores `angle` and reads `cx`/`cy` instead - the centre
    // as a fraction of the fill rect, 0.5/0.5 being the middle - plus `radius`,
    // which multiplies the distance from that centre to the rect's farthest
    // corner (the size CSS calls `farthest-corner`, and the one both renderers
    // compute from the same helper).
    gradient: {
      on: false,
      kind: 'linear', // 'linear' | 'radial'
      angle: 180,
      cx: 0.5,
      cy: 0.5,
      radius: 1,
      scope: 'box', // 'box' | 'line'
      stops: [
        { color: '#ffffff', pos: 0, opacity: 1 },
        { color: '#9a9a9a', pos: 1, opacity: 1 },
      ],
    },
    // Pattern fill, tiled. `kind` is one of PATTERN_KINDS below. `fg` draws the
    // pattern, `bg` is what shows between. The tile is
    // `size * 0.3 * scale` page px square, so it scales with the font. Pattern
    // wins over gradient when both are on.
    pattern: { on: false, kind: 'dots', fg: '#000000', bg: '#ffffff', scale: 1 },
    // ---- strokes ----
    // Ordered innermost first: strokes[0] sits right against the glyph,
    // strokes[1] goes around strokes[0], and so on. Rendered outermost first so
    // each inner one paints over the one outside it. `width` is the VISIBLE
    // width of that band in page px (the renderer draws 2x centred and lets the
    // fill / inner stroke cover the inside half). Empty array = no stroke.
    strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
    // ---- shadows ----
    // Any number, painted in order under the text (shadows[0] on top of the
    // others). Empty array = no shadow. Each shadow uses the glyph outline plus
    // all strokes as its shape.
    shadows: [],
    // Gaussian blur of the whole text (fill + strokes + shadows), page px.
    blur: 0,
    // Directional smear of the whole text, on top of (and after) `blur`.
    // TypeBubble's own parameter model, kept verbatim so the pictures match
    // its demo: `x`/`y` are the direction vector in pixels per unit step and
    // `amount` the iteration count of the Experience-Monks gaussian. Both
    // renderers build the smear from the same tap list - see
    // `motionBlurTaps` in text-paint.js. Direction (0,0) draws nothing.
    motionBlur: { on: false, x: 2, y: 0, amount: 16 },
    // Text on an editable bezier path. `pts` is the path's anchors in
    // box-local page px (origin at the box's top-left, unscaled), each with
    // its in/out handle as an OFFSET from the anchor. Empty until the effect
    // is first switched on, when the editor seeds the TypeBubble default -
    // a straight three-point line across the box's middle. When `on` and
    // `pts` has at least two anchors, this wins over `curve` below.
    path: { on: false, pts: [] },
    // The visibility mask: shapes the user paints over the box that hide
    // ('exclude') or solely keep ('include') the text's ink under them. Not
    // tied to the box rect or the balloon fit - the shapes are their own
    // geometry, in box-local page px (origin at the box top-left; they may
    // reach outside the box). Three shape kinds, all plain JSON:
    //   { kind: 'ellipse', cx, cy, rx, ry }
    //   { kind: 'poly',    pts: [[x, y], ...] }        (>= 3 points)
    //   { kind: 'stroke',  size, pts: [[x, y], ...] }  (a brush drag)
    // With no shapes the mask does nothing, whichever mode is set - so a box
    // that only flipped the switch looks exactly like the switch is off.
    clip: { on: false, mode: 'exclude', brushSize: 20, shapes: [] },
    // Hand-drawn brush strokes inside the box, in the same box-local page px
    // the mask shapes use. Each stroke is self-describing - every field that
    // decides how it renders is on the stroke, not on the tool - so a stroke
    // drawn last week still draws the same after the brush settings moved on.
    // `pts` is [x, y, w], where w is the point's width factor in 0..1, already
    // resolved from pen pressure, stroke speed or randomness when it was drawn.
    // Taper is deliberately NOT baked in: it is cheap at render time and stays
    // adjustable afterwards.
    ink: { on: false, strokes: [] },
    // Text closed into a full circle (see `circleLayout`): the ring's size
    // comes from the text's own advance, `angle` (degrees, clockwise) turns
    // it, `inside` flips the text onto the inner face - the bottom arc of a
    // badge. Sits between `path` and `curve` in precedence: path > circle >
    // arc. `r` is a chosen radius in page px that replaces the advance-derived
    // one; 0 means auto (the closed ring). With a radius set the text need not
    // reach round - it is an arc centred on `angle`.
    circle: { on: false, angle: 0, inside: false, r: 0 },
    uppercase: false,
    lineHeight: 1.1,
    letterSpacing: 0,
    rotation: 0,
    // mirror flip (applied around the box centre, inside rotation)
    flipH: false, // horizontal mirror (left↔right)
    flipV: false, // vertical mirror (top↔bottom)
    // rough / distressed edges (SVG feDisplacementMap)
    roughen: { on: false, amount: 4, detail: 0.05, seed: 7 },
    // warp: per-character circular arc, -100..100 (negative = frown, positive = smile)
    curve: 0,
    // ---- typesetting (see typeset.js) ----
    // How lines are broken. 'auto' is the scanlation shaping - square or oval
    // block, no hourglass, no orphaned short words, no word ever split. 'off'
    // hands the job back to plain greedy CSS wrapping.
    shape: 'auto',
    // A word with fewer letters than this never sits alone on a line.
    minOrphan: 3,
    // Whether a word that fits on no line of this block may be split with a
    // hyphen. On by default: a tall narrow balloon with a name in it is the case
    // the rule was written for, and without it the name simply hangs out of the
    // bubble. `typeset.js` states the conditions - the word has to fit nowhere,
    // the split has to win on price, and the pieces have to be pronounceable -
    // and they are narrow enough that ordinary dialogue never meets them.
    hyphenate: true,
    // Whether this box lays its text out to the balloon it was fitted to. The
    // shape itself lives on the BOX (`box.fit`) rather than in the style,
    // because it is measured geometry in page coordinates and not a preference;
    // this is the preference, and it is here so a bulk edit can turn balloon
    // layout off across a page of boxes that were fitted to the wrong thing.
    // A box with no `fit` ignores it entirely and lays out rectangular, exactly
    // as every box did before fitting existed.
    balloon: true,
    // The box's HEIGHT follows its text: it grows so the wrapped block fits,
    // anchored by `valign`. Width is never touched automatically - the width is
    // what the user aimed at the bubble.
    autoHeight: true,
  };
}

// merge older/partial styles up to the current schema (back-compat for saved data)
//
// The flat spread is the whole migration for a flat key: a style saved before
// `shape`/`minOrphan`/`autoHeight` existed simply has no such property, so
// `defaultStyle()`'s value stands. Nested groups are merged by name, because a
// spread would otherwise replace the whole group with a partial one.
//
// Two old fields are migrated rather than merged, and this is the only place in
// the app that still knows they existed:
//
//   outline + outlineWidth  ->  strokes[0]   (width 0 / missing -> no stroke)
//   shadow { on, ... }      ->  shadows      ([] when `on` was false)
//
// A style that already carries `strokes` / `shadows` is taken as written; the
// legacy keys are then dropped so nothing downstream can read a stale copy.
const STROKE_DEF = { color: '#ffffff', width: 3, opacity: 1 };
const SHADOW_DEF = { x: 2, y: 2, blur: 2, color: '#000000', opacity: 0.6 };
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
// Exactly the lengths CSS reads as hex: 3/4-digit shorthand and 6/8-digit full
// forms. A 5- or 7-digit string is a typo mid-edit, not a colour - accepting it
// would store a value neither renderer can paint.
const hex = (v, d) => (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : d);

export function normalizeStroke(x) {
  return { color: hex(x?.color, STROKE_DEF.color), width: Math.max(0, num(x?.width, STROKE_DEF.width)), opacity: Math.min(1, Math.max(0, num(x?.opacity, 1))) };
}
export function normalizeShadow(x) {
  return {
    x: num(x?.x, SHADOW_DEF.x),
    y: num(x?.y, SHADOW_DEF.y),
    blur: Math.max(0, num(x?.blur, SHADOW_DEF.blur)),
    color: hex(x?.color, SHADOW_DEF.color),
    opacity: Math.min(1, Math.max(0, num(x?.opacity, SHADOW_DEF.opacity))),
  };
}
// One hand-drawn brush stroke, sanitised. Returns null for a stroke that
// cannot be drawn at all - no points, or a size of zero - because a stroke
// that paints nothing is worse than no stroke: it still costs a history slot
// and a bounds pass. Individual unreadable points are dropped, the way a mask
// shape's are, so one bad number does not lose the whole gesture.
export function normalizeInkStroke(src) {
  if (!src || typeof src !== 'object') return null;
  const pts = [];
  for (const q of Array.isArray(src.pts) ? src.pts : []) {
    if (!Array.isArray(q)) continue;
    const x = +q[0];
    const y = +q[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = Number.isFinite(+q[2]) ? Math.min(1, Math.max(0, +q[2])) : 1;
    pts.push([x, y, w]);
  }
  if (!pts.length) return null;
  const size = Math.min(2000, Math.max(0.5, num(src.size, 24)));
  const taper = (t, d) => ({
    on: !!t?.on,
    len: Math.min(500, Math.max(0, num(t?.len, d))),
    ratio: Math.min(100, Math.max(0, num(t?.ratio, 60))),
  });
  return {
    brush: typeof src.brush === 'string' && src.brush ? src.brush : 'round',
    size,
    color: hex(src.color, '#000000'),
    opacity: Math.min(1, Math.max(0, num(src.opacity, 1))),
    // Spacing is a percentage of the tip's size. Below 1% the stamp count
    // explodes with no visible gain, so that is the floor.
    spacing: Math.min(200, Math.max(1, num(src.spacing, 10))),
    hardness: Math.min(100, Math.max(0, num(src.hardness, 100))),
    angle: ((num(src.angle, 0) % 360) + 360) % 360,
    angleJitter: Math.min(100, Math.max(0, num(src.angleJitter, 0))),
    // Flatness squashes the tip across its angle. 1 is round; 0 would be a
    // line with no area, so the floor is a hair above it.
    flatness: Math.min(1, Math.max(0.01, num(src.flatness, 1))),
    // Only a literal false turns anti-aliasing off, so a stroke saved before
    // the switch existed - and any junk in its place - keeps the smooth edge it
    // was drawn with.
    antialias: src.antialias !== false,
    taperIn: taper(src.taperIn, 20),
    taperOut: taper(src.taperOut, 20),
    // The seed makes angle jitter repeatable: the same stroke must draw the
    // same picture in the editor and in the export.
    seed: Math.max(1, Math.floor(num(src.seed, 1))),
    pts,
  };
}
// Every tile `drawPatternTile` knows how to draw, in the order the picker shows
// them. A kind that is not on this list is normalized back to the default, so
// adding one here and nowhere else would show a card that paints nothing - the
// two lists are kept in step by hand.
export const PATTERN_KINDS = [
  'dots',
  'halftone',
  'stripes',
  'hstripes',
  'diagonal',
  'diagonal-alt',
  'crosshatch',
  'checker',
  'grid',
  'vlines',
  'hlines',
];

export const GRADIENT_KINDS = ['linear', 'radial'];

// How many stops a gradient may carry. Two is the floor because one stop is not
// a gradient, it is a fill; eight is the ceiling because the editor's stop bar
// is 280px of panel wide and past that the handles have nowhere to sit. Both
// renderers cope with any count - the limits are the panel's, stated here so the
// loader and the panel agree on them.
export const GRADIENT_MIN_STOPS = 2;
export const GRADIENT_MAX_STOPS = 8;

// One stop, gated. Everything a stop can arrive missing has an answer: a
// gradient saved before per-stop alpha existed has no `opacity` at all, and 1 is
// what it was painting with, so it keeps painting the same.
function normalizeStop(st) {
  return {
    color: hex(st?.color, '#000000'),
    pos: Math.min(1, Math.max(0, num(st?.pos, 0))),
    opacity: Math.min(1, Math.max(0, num(st?.opacity, 1))),
  };
}

export function normalizeStyle(s) {
  const d = defaultStyle();
  const src = s || {};
  const { outline, outlineWidth, shadow, ...srcFlat } = src;

  let strokes;
  if (Array.isArray(src.strokes)) strokes = src.strokes.map(normalizeStroke).filter((k) => k.width > 0);
  else if (outline !== undefined || outlineWidth !== undefined) {
    const w = num(outlineWidth, STROKE_DEF.width);
    strokes = w > 0 ? [normalizeStroke({ color: outline, width: w })] : [];
  } else strokes = d.strokes;

  let shadows;
  if (Array.isArray(src.shadows)) shadows = src.shadows.map(normalizeShadow);
  else if (shadow && typeof shadow === 'object') shadows = shadow.on ? [normalizeShadow(shadow)] : [];
  else shadows = d.shadows;

  const g = { ...d.gradient, ...(src.gradient || {}) };
  g.scope = g.scope === 'line' ? 'line' : 'box';
  g.kind = g.kind === 'radial' ? 'radial' : 'linear';
  g.angle = num(g.angle, d.gradient.angle);
  // A gradient saved before radial existed carries none of the three fields
  // below, so the defaults stand and it keeps painting exactly as it did.
  g.cx = Math.min(1, Math.max(0, num(g.cx, d.gradient.cx)));
  g.cy = Math.min(1, Math.max(0, num(g.cy, d.gradient.cy)));
  g.radius = Math.min(4, Math.max(0.1, num(g.radius, d.gradient.radius)));
  // Sorted here rather than trusted, because `pos` is what both renderers walk
  // in order, and clipped to the panel's ceiling so a hand-edited file cannot
  // hand the stop bar more handles than it can draw.
  g.stops = (Array.isArray(g.stops) && g.stops.length >= GRADIENT_MIN_STOPS ? g.stops : d.gradient.stops)
    .map(normalizeStop)
    .sort((a, b) => a.pos - b.pos)
    .slice(0, GRADIENT_MAX_STOPS);
  const pat = { ...d.pattern, ...(src.pattern || {}) };
  if (!PATTERN_KINDS.includes(pat.kind)) pat.kind = d.pattern.kind;
  pat.scale = Math.min(4, Math.max(0.25, num(pat.scale, 1)));

  // Flat keys are whitelisted to the schema rather than spread as they come, so
  // a style carrying keys this build has never heard of - a future schema read
  // by an older build, a hand-edited file - does not carry them forever: every
  // save would round-trip the junk through every clone and normalise. Unknown
  // in, gone out; the defaults above stand for anything missing.
  const known = new Set(Object.keys(d));
  const flat = {};
  for (const k of Object.keys(srcFlat)) if (known.has(k)) flat[k] = srcFlat[k];

  // The directional smear, gated field by field. Built explicitly rather than
  // spread so a style saved by the short-lived length/angle build arrives with
  // its `on` intact and the dead fields simply gone.
  const mb = {
    on: !!src.motionBlur?.on,
    x: Math.min(50, Math.max(-50, num(src.motionBlur?.x, d.motionBlur.x))),
    y: Math.min(50, Math.max(-50, num(src.motionBlur?.y, d.motionBlur.y))),
    amount: Math.min(32, Math.max(1, Math.round(num(src.motionBlur?.amount, d.motionBlur.amount)))),
  };

  // The bezier path. An anchor that is not finite is dropped rather than
  // repaired; a path left with fewer than two anchors cannot place a glyph,
  // and the renderers treat it as off.
  const pth = { on: !!src.path?.on, pts: [] };
  if (Array.isArray(src.path?.pts)) {
    for (const p of src.path.pts) {
      const x = num(p?.x, NaN);
      const y = num(p?.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pth.pts.push({
        x,
        y,
        ix: num(p?.ix, 0),
        iy: num(p?.iy, 0),
        ox: num(p?.ox, 0),
        oy: num(p?.oy, 0),
      });
    }
  }

  // `fillOpacity` (the fill layer's own alpha) is gone from the schema. A style
  // saved while it existed folds it into the whole-box opacity - not the same
  // picture (strokes used to stay opaque), but the intent it carried, that this
  // box was translucent, survives the migration.
  const fo = Math.min(1, Math.max(0, num(src.fillOpacity, 1)));

  // The circle, gated like the smear: angle normalized into [0, 360).
  const circ = { ...d.circle, ...(src.circle || {}) };
  circ.on = !!circ.on;
  circ.angle = ((num(circ.angle, 0) % 360) + 360) % 360;
  circ.inside = !!circ.inside;
  // 0 is auto, and anything unreadable becomes auto rather than a wild ring.
  circ.r = Math.min(4000, Math.max(0, num(circ.r, 0)));

  // The mask, shape by shape. A shape that is not one of the three kinds, or
  // whose numbers are not finite, is dropped rather than repaired - a mask
  // with no valid shapes is simply inactive, which every renderer handles.
  const pair = (q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1]);
  const cl = {
    on: !!src.clip?.on,
    mode: src.clip?.mode === 'include' ? 'include' : 'exclude',
    brushSize: Math.min(200, Math.max(2, num(src.clip?.brushSize, d.clip.brushSize))),
    shapes: [],
  };
  for (const sh of Array.isArray(src.clip?.shapes) ? src.clip.shapes : []) {
    if (sh?.kind === 'ellipse') {
      const e = { kind: 'ellipse', cx: num(sh.cx, NaN), cy: num(sh.cy, NaN), rx: num(sh.rx, 0), ry: num(sh.ry, 0) };
      if (Number.isFinite(e.cx) && Number.isFinite(e.cy) && e.rx > 0 && e.ry > 0) cl.shapes.push(e);
    } else if (sh?.kind === 'poly') {
      const pts = (Array.isArray(sh.pts) ? sh.pts : []).filter(pair).map((q) => [+q[0], +q[1]]);
      if (pts.length >= 3) cl.shapes.push({ kind: 'poly', pts });
    } else if (sh?.kind === 'stroke') {
      const pts = (Array.isArray(sh.pts) ? sh.pts : []).filter(pair).map((q) => [+q[0], +q[1]]);
      const size = num(sh.size, 0);
      if (pts.length >= 1 && size > 0) cl.shapes.push({ kind: 'stroke', size: Math.min(200, size), pts });
    }
  }

  const ink = { on: !!src.ink?.on, strokes: [] };
  for (const k of Array.isArray(src.ink?.strokes) ? src.ink.strokes : []) {
    const norm = normalizeInkStroke(k);
    if (norm) ink.strokes.push(norm);
  }

  const out = {
    ...d,
    ...flat,
    blur: Math.max(0, num(src.blur, 0)),
    motionBlur: mb,
    path: pth,
    clip: cl,
    ink,
    circle: circ,
    gradient: g,
    pattern: pat,
    strokes,
    shadows,
    roughen: { ...d.roughen, ...(src.roughen || {}) },
  };
  if (fo < 1) out.opacity = Math.min(1, Math.max(0, num(out.opacity, 1) * fo));
  return out;
}

// The path a box starts with when the effect is switched on: TypeBubble's
// default - a straight line across the box's middle, whose centre anchor
// carries symmetric horizontal handles so one drag bends it. In box-local
// page px, for a box `w` by `h`.
export function defaultPathPts(w, h) {
  const half = Math.max(10, Math.min(50, (Number(w) || 0) / 4));
  const midY = (Number(h) || 0) / 2;
  return [
    { x: 0, y: midY, ix: 0, iy: 0, ox: 0, oy: 0 },
    { x: (Number(w) || 0) / 2, y: midY, ix: -half, iy: 0, ox: half, oy: 0 },
    { x: Number(w) || 0, y: midY, ix: 0, iy: 0, ox: 0, oy: 0 },
  ];
}

// ---- the balloon a box was fitted to ----
//
// `box.fit` is the shape `balloon.js` recovered from the page's pixels, in page
// coordinates, and it is stored on the box because it has to survive a save: it
// is what the line breaker lays text out inside, and re-deriving it would mean
// re-decoding a page every time a box is drawn. Two kinds only, both plain JSON:
//
//   { kind: 'ellipse', cx, cy, rx, ry }
//   { kind: 'rect',    x,  y,  w,  h  }
//
// This is the gate every reader of that field goes through, and it exists
// because the field arrives from places this build does not control: a
// chapter.json a future version wrote with a third kind in it, a PSD's embedded
// project, a hand-edited file. A shape that is not one of the two, or whose
// numbers are not finite, or whose extent is not positive, is not an error to
// throw on - it is a box with no fit, which is a state the whole layout path
// already handles because it is what every box had before fitting existed.
//
// Returns a fresh plain object, so a caller cannot alias the document, and null
// for anything it does not recognise.
export function normalizeFit(f) {
  if (!f || typeof f !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? Number(v) : NaN);
  if (f.kind === 'ellipse') {
    const cx = n(f.cx);
    const cy = n(f.cy);
    const rx = n(f.rx);
    const ry = n(f.ry);
    if (!Number.isFinite(cx + cy + rx + ry) || !(rx > 0) || !(ry > 0)) return null;
    return { kind: 'ellipse', cx, cy, rx, ry };
  }
  if (f.kind === 'rect') {
    const x = n(f.x);
    const y = n(f.y);
    const w = n(f.w);
    const h = n(f.h);
    if (!Number.isFinite(x + y + w + h) || !(w > 0) || !(h > 0)) return null;
    return { kind: 'rect', x, y, w, h };
  }
  return null;
}
