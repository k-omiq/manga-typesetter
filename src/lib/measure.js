// Shared text measurement + line wrapping (used by curved rendering and export).
import { fontCssFor } from './store.svelte.js';
import { balanceLines, neededHeight, balancedBlockSize, BALANCED_DEFAULTS } from './typeset.js';
import { interiorLineWidths } from './balloon.js';
import { normalizeFit } from './data.js';

const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _c ? _c.getContext('2d') : null;

// Whether this environment can actually measure text. Node cannot, and every
// function below falls back to a stand-in metric there so nothing throws - but a
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

// ---- typesetting engine switch (beta) ----
// The shaped line breaking, hyphenation and balloon fitting in typeset.js /
// balloon.js are a beta feature, off unless the user turns it on in Settings.
// This is the one switch every layout path reads: `layoutLines` falls back to
// plain CSS-equivalent wrapping and `balloonWidthsFor` answers null when it is
// off, so the editor, the exporter, the PSD writer and auto-height all agree
// without each of them knowing about the preference. Set from the prefs
// module at boot and on toggle; default off so a cold test run is plain.
let _typeset = false;
export function setTypesetEnabled(on) {
  _typeset = !!on;
  // Every cached break was decided under the old switch. See `clearLayoutMemo`.
  clearLayoutMemo();
}
export function typesetEnabled() {
  return _typeset;
}

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
// the pure core in `typeset.js`. `text` must already be case-applied - same
// contract as `wrapLinesDOM` - because uppercasing changes every width.
//
// `widthsFor` is optional and, when given, replaces the single content width
// with a per-line one: `widthsFor(lineCount) -> number[]`, the usable width of
// each line of a block of that many lines. That is how a balloon's actual shape
// gets into the line breaker - inside an ellipse the room narrows towards the
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
// Returns null - meaning "no per-line widths, use the flat content width" - for
// a box with no fit, a malformed one, or a box whose style has balloon layout
// switched off. That null is what makes the promise "a box with no fit produces
// byte-identical output to today" true by construction rather than by testing:
// `layoutLines` ignores an absent `widthsFor` entirely.
//
// Two adjustments to what `balloon.js` hands back, and both are the caller's own
// debt rather than something that module could have done:
//
//   BOX_PAD per edge. `interiorLineWidths` returns the BALLOON's usable width.
//   The text is drawn inside a box that pads itself by BOX_PAD on every edge -
//   which is exactly why every flat call site says `box.w - BOX_PAD * 2` - so
//   the same 2px each side comes off here.
//
//   the box's own content width is a ceiling. The box is placed at the balloon's
//   INSCRIBED rectangle, which for an ellipse is about 70% of its bounding box,
//   while the interior width across the middle of that same ellipse is the full
//   100%. Left uncapped, the middle lines of every fitted box would be laid out
//   wider than the rectangle the user drags, resizes and aligns - the box would
//   stop describing its own text, which is the bug `autoFitBox` exists to
//   prevent on the other axis. Capped, the fit can only ever narrow a line
//   relative to today, and it narrows exactly the lines that would otherwise run
//   into the curve: the first and the last.
//
// The widths are read off the shape in PAGE coordinates while the block is
// positioned inside the shape by the style's own `valign`. A box dragged away
// from the balloon it was fitted to therefore keeps an oval profile that no
// longer sits on any bubble - which is why the Inspector offers both a re-fit
// and an off switch, and why neither is optional chrome.
export function balloonWidthsFor(box, style, sizePx) {
  // Balloon layout is part of the typesetting beta, so the switch is read here
  // rather than at each of the three call sites: with it off there are no
  // per-line widths at all, which is the state every box was in before fitting
  // existed and the state `layoutLines` treats as "just wrap it".
  if (!typesetEnabled()) return null;
  if (!box || !style || style.balloon === false) return null;
  const shape = normalizeFit(box.fit);
  if (!shape) return null;
  const contentW = Math.max(1, box.w - BOX_PAD * 2);
  const lineH = sizePx * (style.lineHeight ?? 1);
  const valign = style.valign ?? 'middle';
  const fn = (lineCount) =>
    interiorLineWidths(shape, lineH, lineCount, valign).map((w) =>
      Math.max(1, Math.min(contentW, w - BOX_PAD * 2)),
    );
  // What this closure IS, written down, so `layoutLines` can memoise a result
  // that depends on it. A callback cannot be a cache key - two closures built
  // from the same shape are different objects - and the alternative, hashing
  // the widths it hands back, means calling it, which is a share of the work
  // being avoided. Everything the closure captures is here; a `widthsFor` from
  // anywhere else carries no key and is simply not cached (see `memoKey`).
  fn.key = JSON.stringify([shape, lineH, valign, contentW]);
  return fn;
}

// ===== the same block, broken twice =====
//
// `layoutLines` is not cheap - a shaped break runs the balancer over every
// candidate split, and on a page of fifteen boxes that is tens of milliseconds -
// and the app asks it the same question repeatedly with the same answer. A page
// turn used to pay for two full passes over every box on the page (the component
// laying its lines out, and auto-height counting them); the exporter asks a
// third time for a page the editor has just drawn; and `balancedBoxSize` walks
// five candidate widths, some of which repeat.
//
// So the answer is remembered, keyed on every input that can change it. The
// bound is a count rather than bytes: an entry is a handful of short strings,
// and the number that matters is "more than a chapter's worth of visible boxes,
// less than a chapter" - a resident window of fifteen-box pages is under a
// hundred, and five hundred leaves room for the exporter walking a chapter
// without letting the map grow with one.
//
// The returned array is SHARED with every other caller holding the same key.
// Nothing in the app mutates a `layoutLines` result - the editor iterates it,
// auto-height takes its length, the exporter measures it - and a copy per call
// would give back a real share of what the memo saves.
const MEMO_MAX = 500;
const memo = new Map();

// Everything that decides where the lines fall, and nothing that does not.
//
// `text` is already case-applied by every caller (that is `layoutLines`'s
// contract), so `uppercase` cannot change the answer - it is in the key anyway,
// because a style whose case flag disagrees with the text it was applied to is a
// bug elsewhere and this is not the place to make it invisible.
//
// The font FAMILY is keyed as `style.font`, the app's own name for it, rather
// than the resolved CSS list. What the name resolves to can change - a user font
// finishing its registration is exactly that - and so can the metrics of a face
// already resolved. Neither is visible in any argument here, which is why the
// map is cleared wholesale on that event instead; see `clearLayoutMemo`.
//
// Null - meaning "do not cache this one" - for a `widthsFor` this module did not
// build, since there is nothing to say about what it will return.
function memoKey(text, style, sizePx, w, widthsFor) {
  if (widthsFor && !widthsFor.key) return null;
  return JSON.stringify([
    _typeset,
    text,
    style.font,
    sizePx,
    style.size,
    style.bold ? 1 : 0,
    style.italic ? 1 : 0,
    style.lineHeight,
    style.letterSpacing,
    style.uppercase ? 1 : 0,
    style.align,
    style.shape ?? 'auto',
    style.minOrphan ?? 3,
    style.hyphenate ?? true,
    w,
    widthsFor ? widthsFor.key : 0,
  ]);
}

// Every measurement in this module is stale. Called from `relayoutAll` in the
// store - the one event that says a face has arrived, been replaced or been
// removed - and from the typesetting switch above. Both are rare and both change
// the answer to every question this map holds, so the map goes rather than being
// invalidated key by key.
export function clearLayoutMemo() {
  memo.clear();
}

// For the tests, and for the same sort of introspection `pagePixelsHeld` offers.
export const layoutMemoSize = () => memo.size;

// THE place the question "where does this box's text break" is answered, and the
// only one either the editor or the exporter is allowed to ask. Both call this
// with identical arguments - the box's unzoomed style size and its content width
// - so the canvas and the exported PNG break in the same places by construction
// rather than by two implementations happening to agree.
//
// `shape: 'off'` hands the job back to `wrapLinesDOM`, which reproduces the
// browser's own greedy wrapping. That is the path for a user who wants plain CSS
// behaviour, and it is unchanged - including that it ignores `widthsFor`, since
// the browser has no way to wrap text to a width that varies line by line and
// pretending otherwise would break the one promise that path makes.
// `shape: 'off'` - and the typesetting switch being off, which is the same thing
// said for the whole document - hands the job back to `wrapLinesDOM`.
//
// A line at the START or the END of a block that holds nothing but whitespace is
// not a line: it is a stray Return the user pressed, and it moved the text up or
// down the box, grew the box under auto-height, and shifted the export by a
// whole line. Interior blank lines stay - between two paragraphs a blank line is
// the paragraph break, and it is the only way to type one. Trimmed here rather
// than in each renderer because every path that lays a box out comes through
// this function, so one rule covers the editor, the export, the PSD and
// auto-height at once. Empty text still answers `['']`: a caller that asks for
// the lines of an empty box gets one empty line to place a caret in, not
// nothing to iterate.
export function layoutLines(text, style, sizePx, contentWidthPx, widthsFor) {
  // A pixel is the narrowest a column can be. Every caller computes the width as
  // `box.w - BOX_PAD * 2` and a box may be narrower than its own padding, so the
  // width handed in can be zero or negative - and the editor clamped it while
  // the raster exporter and the PSD's type layers did not, which is three
  // renderers free to break the same box in three different places. Clamped here
  // instead, where the one rule reaches all of them.
  const w = contentWidthPx > 1 ? contentWidthPx : 1;
  // Asked and answered - see the memo above. A hit promotes, so what survives
  // eviction is what the editor is actually laying out rather than whatever a
  // chapter export happened to walk past last.
  const key = memoKey(text, style, sizePx, w, widthsFor);
  if (key !== null) {
    const hit = memo.get(key);
    if (hit) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
  }
  const lines =
    !typesetEnabled() || (style.shape ?? 'auto') === 'off'
      ? wrapLinesDOM(text, style, sizePx, w)
      : shapedLines(text, style, sizePx, w, widthsFor);
  let a = 0;
  let b = lines.length;
  while (a < b && !/\S/.test(lines[a])) a++;
  while (b > a && !/\S/.test(lines[b - 1])) b--;
  const out = a === 0 && b === lines.length ? lines : b > a ? lines.slice(a, b) : [''];
  if (key !== null) {
    memo.set(key, out);
    // One over the bound, once per miss, so the oldest key is the only thing
    // that ever has to be found - `Map` iterates in insertion order.
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  return out;
}

// ===== the size a box should be placed at, when nothing else knows =====
//
// `balancedBlockSize` in typeset.js answers this in closed form from an area and
// an aspect. This is the half that needs a metric: it measures the text, seeds
// the closed form with it, and then CHECKS the answer against the real line
// breaker rather than trusting the arithmetic.
//
// The check is not ceremony. The closed form models breaking as "cut the text
// into n equal pieces", and the breaker does nothing of the sort - it refuses to
// leave an orphan, it hyphenates, it balances the ragged edge, and any one of
// those can turn the width that should give n lines into one that gives n-1 or
// n+1. So each candidate line count near the ideal is laid out for real, its
// actual height taken from the actual line count, and the candidate whose block
// comes out closest to the target aspect wins. The score is on the log of the
// ratio so that being a factor of two too wide and a factor of two too tall cost
// the same - on a plain difference, wide always looks cheaper.
//
// Returns a BOX size: the content width plus the padding a box lays out inside,
// and the height through `neededHeight`, so the caller can use it as a rectangle
// without knowing what BOX_PAD is.
//
// Null when there is nothing to measure: no text, or no size.
//
// "No canvas to measure with" is deliberately NOT checked here, and the omission
// is the same one `layoutLines` makes. Under node every metric in this file falls
// back to a stand-in, which is fine for deciding where a line breaks and not fine
// for writing a number into the user's document - so the guard belongs to the
// caller that is doing the writing, exactly as `autoFitBox` guards itself with
// `canMeasure()` before it touches a box. Putting it here as well would look like
// belt and braces and is in fact worse than useless: a `vi.mock` of this module
// replaces the EXPORT, not the call this function would make to its own local
// binding, so the guard would be un-mockable and the balanced size would be dead
// code in every test that grants the stand-in metric.
export function balancedBoxSize(text, style, opts = {}) {
  const o = { ...BALANCED_DEFAULTS, ...opts };
  const size = Number(style?.size);
  if (!(size > 0)) return null;
  const cased = applyCase(String(text ?? ''), style);
  if (!/\S/.test(cased)) return null;
  const lh = size * (style.lineHeight > 0 ? style.lineHeight : 1);
  // Paragraphs, because a typed Return is a line the breaker cannot undo: three
  // paragraphs are at least three lines however wide the box is, so they are the
  // floor on the search below as well as the pieces the total is summed from.
  const paras = cased.split('\n').filter((s) => /\S/.test(s));
  let total = 0;
  for (const s of paras) total += lineWidth(s, style, size);
  if (!(total > 0)) return null;

  const seed = balancedBlockSize(total, lh, o);
  if (!seed) return null;
  const lo = Math.max(1, paras.length, seed.lines - 2);
  const hi = Math.max(lo, Math.min(Math.round(o.maxLines), seed.lines + 2));
  let best = null;
  for (let n = lo; n <= hi; n++) {
    const contentW = Math.max(o.minWidth, (total / n) * o.slack);
    const count = layoutLines(cased, style, size, contentW, null).length;
    const h = count * lh;
    if (!(h > 0)) continue;
    const score = Math.abs(Math.log(contentW / h / o.targetAspect));
    if (!best || score < best.score) best = { score, contentW, count };
  }
  if (!best) return null;
  return {
    w: Math.ceil(best.contentW) + BOX_PAD * 2,
    h: neededHeight(best.count, style, BOX_PAD),
    lines: best.count,
  };
}

// Widest wrapped line width (used by export to size the offscreen canvas so
// horizontally-overflowing lines aren't clipped).
export function maxLineWidth(lines, style, sizePx) {
  let m = 0;
  for (const ln of lines) m = Math.max(m, lineWidth(ln, style, sizePx));
  return m;
}
