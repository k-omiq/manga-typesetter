// Shared text measurement + line wrapping (used by curved rendering and export).
import { fontCssFor } from './store.svelte.js';

const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _c ? _c.getContext('2d') : null;

// Build a CSS font shorthand. `family` is a CSS family list (e.g. "'Bangers', cursive").
export function fontShorthand(style, sizePx, family) {
  const w = style.bold ? '700' : '400';
  const i = style.italic ? 'italic ' : '';
  return `${i}${w} ${sizePx}px ${family}`;
}

export function familyFor(style) {
  return fontCssFor(style.font);
}

export function applyCase(text, style) {
  return style.uppercase ? text.toUpperCase() : text;
}

// Measure a single string's width at a given px size.
export function measureText(text, style, sizePx) {
  if (!_ctx) return text.length * sizePx * 0.55;
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  return _ctx.measureText(text).width;
}

// Per-character advances (width incl. letterSpacing is added by caller).
export function charWidths(text, style, sizePx) {
  if (!_ctx) return [...text].map(() => sizePx * 0.55);
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  return [...text].map((ch) => _ctx.measureText(ch).width);
}

// Lay out characters along a circular arc. Returns positions relative to the
// box center (0,0). Reduces to a flat line as curve → 0. `curve` is -100..100.
// For canvas: translate(cx+x, cy+y); rotate(rot); draw char centered.
// For DOM: place each span at box center, then translate(x,y) rotate(rot).
export function arcLayout(text, style, sizePx) {
  const chars = [...text];
  const widths = charWidths(text, style, sizePx);
  const ls = style.letterSpacing * (sizePx / style.size);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * ls;
  if (total <= 0) return [];
  const maxAng = Math.max((Math.abs(style.curve) / 100) * 2.4, 1e-4);
  const R = total / maxAng;
  const sign = Math.sign(style.curve) || 1;
  const out = [];
  let cum = 0;
  for (let i = 0; i < chars.length; i++) {
    const centerOff = cum + widths[i] / 2;
    const a = (centerOff - total / 2) / R;
    out.push({
      ch: chars[i],
      x: R * Math.sin(a),
      y: sign * (R - R * Math.cos(a)),
      rot: sign * a, // radians
      w: widths[i],
    });
    cum += widths[i] + ls;
  }
  return out;
}

// Greedy word-wrap to a max pixel width. Respects explicit newlines.
export function wrapLines(text, style, sizePx, maxWidth) {
  if (!_ctx) return text.split('\n');
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = style.letterSpacing * (sizePx / style.size); // scale ls to this size
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/); // keep spaces
    let line = '';
    const widthOf = (s) => _ctx.measureText(s).width + Math.max(0, [...s].length - 1) * ls;
    for (const word of words) {
      const trial = line + word;
      if (line && widthOf(trial) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = trial;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Wrap text EXACTLY like the editor by laying it out in a hidden DOM element
// with identical CSS, then reading the browser's own line breaks. Greedy canvas
// wrapping (wrapLines) only breaks on spaces, so it can't reproduce CSS rules
// like hyphen breaks or `word-break:break-word` (breaking inside long words).
// `contentWidthPx` must be the box's CONTENT width (box.w minus horizontal
// padding) so breaks land where the editor puts them. `text` should already be
// case-applied; this sets text-transform:none.
export function wrapLinesDOM(text, style, sizePx, contentWidthPx) {
  if (typeof document === 'undefined') return wrapLines(text, style, sizePx, contentWidthPx);
  const ls = style.letterSpacing * (sizePx / style.size);
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre-wrap;' +
    'word-break:break-word;overflow-wrap:break-word;box-sizing:content-box;padding:0;margin:0;border:0;' +
    `width:${Math.max(1, contentWidthPx)}px;` +
    `font-family:${familyFor(style)};font-weight:${style.bold ? 700 : 400};` +
    `font-style:${style.italic ? 'italic' : 'normal'};font-size:${sizePx}px;` +
    `line-height:${style.lineHeight};letter-spacing:${ls}px;text-transform:none;text-align:${style.align};`;
  document.body.appendChild(el);
  const out = [];
  try {
    for (const para of text.split('\n')) {
      if (para === '') {
        out.push('');
        continue;
      }
      el.textContent = para;
      const node = el.firstChild;
      const range = document.createRange();
      let curTop = null;
      let start = 0;
      for (let i = 0; i < para.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) continue;
        const top = Math.round(rect.top);
        if (curTop === null) curTop = top;
        else if (Math.abs(top - curTop) > 1) {
          out.push(para.slice(start, i).replace(/\s+$/, ''));
          start = i;
          curTop = top;
        }
      }
      out.push(para.slice(start).replace(/\s+$/, ''));
    }
  } finally {
    el.remove();
  }
  return out.length ? out : [''];
}

// Measured width of a single wrapped line at sizePx, including letter-spacing
// between characters (matches how wrapLines measures and how the canvas draws
// with ctx.letterSpacing). Trailing spaces are trimmed like the app does.
export function lineWidth(line, style, sizePx) {
  if (!_ctx) return line.length * sizePx * 0.55;
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = style.letterSpacing * (sizePx / style.size);
  const s = line.replace(/\s+$/, '');
  return _ctx.measureText(s).width + Math.max(0, [...s].length - 1) * ls;
}

// Widest wrapped line width (used by export to size the offscreen canvas so
// horizontally-overflowing lines aren't clipped).
export function maxLineWidth(lines, style, sizePx) {
  let m = 0;
  for (const ln of lines) m = Math.max(m, lineWidth(ln, style, sizePx));
  return m;
}
