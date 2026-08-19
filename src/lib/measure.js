// Shared text measurement + line wrapping (used by curved rendering and export).
import { fontCssFor } from './store.svelte.js';
import { balanceLines } from './typeset.js';
import { interiorLineWidths } from './balloon.js';
import { normalizeFit } from './data.js';

const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _c ? _c.getContext('2d') : null;

// Whether this environment can actually measure text. Node cannot, and every
// function below falls back to a stand-in metric there so nothing throws — but a
// stand-in is fine for laying out a line and not fine for writing a number into
// the user's document, so the auto-height path asks this first.
export function canMeasure() {
  return _ctx != null;
}

// The padding a text box lays out inside, on every edge. It is 2px in the
// editor (`padding:${2 * z}px` on `.tbox`, scaled with zoom so wrapping is
// zoom-stable) and the same 2 in the exporter, which is why the exporter's
// content width has always been `box.w - 4`. Named here because the auto-height
// helper needs the same number, and three copies of a layout constant is two
// copies too many.
export const BOX_PAD = 2;

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

// Per-character advances (width incl. letterSpacing is added by caller).
export function charWidths(text, style, sizePx) {
  if (!text || sizePx <= 0) return [];
  if (!_ctx) return [...text].map(() => sizePx * 0.55);
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  return [...text].map((ch) => _ctx.measureText(ch).width);
}

// Lay out characters along a circular arc. Returns positions relative to the
// box center (0,0). Reduces to a flat line as curve → 0. `curve` is -100..100.
// For canvas: translate(cx+x, cy+y); rotate(rot); draw char centered.
// For DOM: place each span at box center, then translate(x,y) rotate(rot).
export function arcLayout(text, style, sizePx) {
  if (!text || sizePx <= 0 || !style || (style.size ?? 0) <= 0) return [];
  const chars = [...text];
  const widths = charWidths(text, style, sizePx);
  // Guard against missing letterSpacing or zero style.size causing NaN
  const ls = (Number(style?.letterSpacing) || 0) * (style.size > 0 ? sizePx / style.size : 0);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * ls;
  if (!Number.isFinite(total) || total <= 0) return [];
  const curve = Number(style?.curve) || 0;
  const maxAng = Math.max((Math.abs(curve) / 100) * 2.4, 1e-4);
  const R = total / maxAng;
  const sign = Math.sign(curve) || 1;
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
  if (!text) return [''];
  if (sizePx <= 0) return text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!_ctx) return text.split('\n').map((l) => l.replace(/\s+$/, ''));
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0); // scale ls to this size
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
    // Terminal line must strip trailing whitespace to match wrapped lines and wrapLinesDOM
    out.push(line.replace(/\s+$/, ''));
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
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0);
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
      for (let i = 0; i < para.length;) {
        const cp = para.codePointAt(i);
        const charLen = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + charLen);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) {
          i += charLen;
          continue;
        }
        const top = Math.round(rect.top);
        if (curTop === null) curTop = top;
        else if (Math.abs(top - curTop) > 1) {
          const raw = para.slice(start, i).replace(/\s+$/, '');
          out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
          start = i;
          curTop = top;
        }
        i += charLen;
      }
      const raw = para.slice(start).replace(/\s+$/, '');
      out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
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
  if (!line || sizePx <= 0) return 0;
  const s = line.replace(/\s+$/, '');
  if (!_ctx) return s.length * sizePx * 0.55;
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0);
  return _ctx.measureText(s).width + Math.max(0, [...s].length - 1) * ls;
}

// Scanlation-shaped line breaking, with this module's real metric wired into
// the pure core in `typeset.js`. `text` must already be case-applied — same
// contract as `wrapLinesDOM` — because uppercasing changes every width.
//
// `widthsFor` is optional and, when given, replaces the single content width
// with a per-line one: `widthsFor(lineCount) -> number[]`, the usable width of
// each line of a block of that many lines. That is how a balloon's actual shape
// gets into the line breaker — inside an ellipse the room narrows towards the
// top and the bottom, and a block laid out against one flat number runs into the
// curve at both ends. `contentWidthPx` stays required and stays the answer when
// no callback is supplied, so every existing caller means exactly what it did.
export function shapedLines(text, style, sizePx, contentWidthPx, widthsFor) {
  return balanceLines(text, widthsFor ?? contentWidthPx, (s) => lineWidth(s, style, sizePx), {
    minOrphan: style.minOrphan ?? 3,
    // `??` rather than a plain read, and the distinction is load-bearing:
    // `TYPESET_DEFAULTS.hyphenate` is true, so handing `undefined` across would
    // turn the feature OFF for every style saved before the knob existed. A
    // missing key means "the default", which is what `normalizeStyle` would
    // have supplied anyway had the style come through it.
    hyphenate: style.hyphenate ?? true,
  });
}

// ===== the balloon a box was fitted to, as a `widthsFor` callback =====
//
// THE one place a box's stored fit turns into per-line widths, and the reason it
// is one place is the same reason `layoutLines` is: the editor, the raster
// exporter and the PSD's type layers all lay the same box out, and they have to
// agree glyph for glyph or the canvas and the exports draw different pictures of
// the same document. Three copies of this arithmetic would be three chances to
// round differently.
//
// Returns null — meaning "no per-line widths, use the flat content width" — for
// a box with no fit, a malformed one, or a box whose style has balloon layout
// switched off. That null is what makes the promise "a box with no fit produces
// byte-identical output to today" true by construction rather than by testing:
// `layoutLines` ignores an absent `widthsFor` entirely.
//
// Two adjustments to what `balloon.js` hands back, and both are the caller's own
// debt rather than something that module could have done:
//
//   BOX_PAD per edge. `interiorLineWidths` returns the BALLOON's usable width.
//   The text is drawn inside a box that pads itself by BOX_PAD on every edge —
//   which is exactly why every flat call site says `box.w - BOX_PAD * 2` — so
//   the same 2px each side comes off here.
//
//   the box's own content width is a ceiling. The box is placed at the balloon's
//   INSCRIBED rectangle, which for an ellipse is about 70% of its bounding box,
//   while the interior width across the middle of that same ellipse is the full
//   100%. Left uncapped, the middle lines of every fitted box would be laid out
//   wider than the rectangle the user drags, resizes and aligns — the box would
//   stop describing its own text, which is the bug `autoFitBox` exists to
//   prevent on the other axis. Capped, the fit can only ever narrow a line
//   relative to today, and it narrows exactly the lines that would otherwise run
//   into the curve: the first and the last.
//
// The widths are read off the shape in PAGE coordinates while the block is
// positioned inside the shape by the style's own `valign`. A box dragged away
// from the balloon it was fitted to therefore keeps an oval profile that no
// longer sits on any bubble — which is why the Inspector offers both a re-fit
// and an off switch, and why neither is optional chrome.
export function balloonWidthsFor(box, style, sizePx) {
  if (!box || !style || style.balloon === false) return null;
  const shape = normalizeFit(box.fit);
  if (!shape) return null;
  const contentW = Math.max(1, box.w - BOX_PAD * 2);
  const lineH = sizePx * (style.lineHeight ?? 1);
  const valign = style.valign ?? 'middle';
  return (lineCount) =>
    interiorLineWidths(shape, lineH, lineCount, valign).map((w) =>
      Math.max(1, Math.min(contentW, w - BOX_PAD * 2)),
    );
}

// THE place the question "where does this box's text break" is answered, and the
// only one either the editor or the exporter is allowed to ask. Both call this
// with identical arguments — the box's unzoomed style size and its content width
// — so the canvas and the exported PNG break in the same places by construction
// rather than by two implementations happening to agree.
//
// `shape: 'off'` hands the job back to `wrapLinesDOM`, which reproduces the
// browser's own greedy wrapping. That is the path for a user who wants plain CSS
// behaviour, and it is unchanged — including that it ignores `widthsFor`, since
// the browser has no way to wrap text to a width that varies line by line and
// pretending otherwise would break the one promise that path makes.
export function layoutLines(text, style, sizePx, contentWidthPx, widthsFor) {
  if ((style.shape ?? 'auto') === 'off') return wrapLinesDOM(text, style, sizePx, contentWidthPx);
  return shapedLines(text, style, sizePx, contentWidthPx, widthsFor);
}

// Widest wrapped line width (used by export to size the offscreen canvas so
// horizontally-overflowing lines aren't clipped).
export function maxLineWidth(lines, style, sizePx) {
  let m = 0;
  for (const ln of lines) m = Math.max(m, lineWidth(ln, style, sizePx));
  return m;
}
