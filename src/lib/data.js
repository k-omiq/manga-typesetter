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
];

// User fonts start empty and are populated only by real uploads (restored
// from IndexedDB on launch). No fake entries.
export const USER_FONTS = [];

export function fontCss(name, userFonts = USER_FONTS) {
  const f = [...BUILTIN_FONTS, ...userFonts].find((f) => f.name === name);
  return f ? f.css : "'Comic Neue', cursive";
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
    color: '#1a1a1a',
    opacity: 1,
    uppercase: false,
    outline: '#ffffff',
    outlineWidth: 3,
    lineHeight: 1.1,
    letterSpacing: 0,
    rotation: 0,
    // mirror flip (applied around the box centre, inside rotation)
    flipH: false, // horizontal mirror (left↔right)
    flipV: false, // vertical mirror (top↔bottom)
    // drop shadow
    shadow: { on: false, x: 2, y: 2, blur: 2, color: '#000000', opacity: 0.6 },
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
// `defaultStyle()`'s value stands and an old project opens with shaping and
// auto-height on. Only the two nested groups need naming, because a spread would
// otherwise replace the whole group with a partial one.
export function normalizeStyle(s) {
  return { ...defaultStyle(), ...s, shadow: { ...defaultStyle().shadow, ...(s?.shadow || {}) }, roughen: { ...defaultStyle().roughen, ...(s?.roughen || {}) } };
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
