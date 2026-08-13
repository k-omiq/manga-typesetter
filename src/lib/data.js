// ===== App seed data =====
// Pages read right-to-left; text lines numbered in RTL reading order.

// Default page dimensions until a real image sets them from its natural size.
export const PAGE_W = 850;
export const PAGE_H = 1200;

// Built-in fonts: real, bundled Google Font families (loaded in index.html).
// Named by their actual family so nothing is misrepresented. Users add their
// own manga fonts via the Font Library (persisted in IndexedDB).
export const BUILTIN_FONTS = [
  { name: 'Bangers', css: "'Bangers', cursive" },
  { name: 'Comic Neue', css: "'Comic Neue', cursive" },
  { name: 'Patrick Hand', css: "'Patrick Hand', cursive" },
  { name: 'Permanent Marker', css: "'Permanent Marker', cursive" },
  { name: 'Architects Daughter', css: "'Architects Daughter', cursive" },
  { name: 'Nunito', css: "'Nunito', sans-serif" },
  { name: 'Playfair Display', css: "'Playfair Display', serif" },
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
  };
}

// merge older/partial styles up to the current schema (back-compat for saved data)
export function normalizeStyle(s) {
  return { ...defaultStyle(), ...s, shadow: { ...defaultStyle().shadow, ...(s?.shadow || {}) }, roughen: { ...defaultStyle().roughen, ...(s?.roughen || {}) } };
}
