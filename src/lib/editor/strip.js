// ===== The arithmetic of a longstrip chapter =====
//
// A webtoon chapter is not a stack of pages the reader turns; it is one column
// of slices with nothing between them, and the "page" is only ever an artefact
// of how the file was cut. Everything that follows from that — which page the
// reader is looking at, how much of the chapter has to be in memory, what "fit"
// even means — stops being a property of one page and becomes a property of the
// column.
//
// This file is that arithmetic and nothing else: no DOM, no store, no zoom
// state. The components measure, call in here, and act on the answer, which is
// what makes any of it testable under node.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Where every page starts, measured down the strip from the top of the first
// one, and how tall the whole column is. `zoom` is the page-pixels-to-CSS-pixels
// factor the canvas is drawing at; at the default of 1 the answer is in page
// pixels, which is the space an exporter stitching the strip works in.
//
// Zero gaps is the whole point: a webtoon slice is cut mid-art and a seam
// between two of them is a visible defect, so nothing is added between the
// frames here or in the stylesheet.
export function stripOffsets(pages, zoom = 1) {
  const tops = [];
  let y = 0;
  for (const p of pages ?? []) {
    tops.push(y);
    // A page whose art has not been decoded yet is `h: 0`, and the honest
    // answer for it is a zero-height frame rather than a guess that would move
    // every page below it the moment the real number arrived.
    y += Math.max(0, p?.h ?? 0) * zoom;
  }
  return { tops, total: y };
}

// Which page the reader is actually on: the one whose frame spans the middle of
// the viewport. The middle rather than the top edge, because the top edge of a
// scroll viewport is usually the tail of the previous slice and naming that the
// current page makes the queue flicker back a page every time the user reads
// down into a new one.
//
// `tops` are the frames' offsets in the scroll container's content space — the
// same space `scrollTop` is measured in — so the caller may fold a pan offset
// into them and the answer follows what is on screen. With no gaps between the
// frames, "the frame that spans the centre" is exactly "the last frame that
// starts at or above it": above the first frame the answer is the first page,
// below the last it is the last.
//
// Which is true right up until a frame has no height. An undecoded page is
// `h: 0` and its frame is an empty box, so every frame from it down starts at
// the same offset — and "the last frame at or above the centre" then names the
// empty one, or, on a chapter nothing has measured yet, the LAST page in it.
// That was the bug: opening a longstrip chapter put the index, the queue and
// the prefetch window at the end of the chapter until the first decode landed.
//
// So a frame of no height is skipped: it occupies no part of the column and the
// centre can never be inside it. `heights` is how the caller says so — the
// canvas is already reading each frame's rect, so the number costs it nothing.
// Without them the offsets themselves still answer for every frame but the
// last (two frames starting at the same place means the first is empty), and a
// column whose frames ALL start at the same offset is an unmeasured chapter,
// whose honest answer is its first page.
export function pageIndexAtCenter(tops, scrollTop, viewportH, heights = null) {
  const n = tops?.length ?? 0;
  if (!n) return 0;
  if (!heights && n > 1 && !(tops[n - 1] > tops[0])) return 0;
  const spans = (i) =>
    heights ? (heights[i] ?? 0) > 0 : i + 1 < n ? tops[i + 1] > tops[i] : true;
  const center = scrollTop + viewportH / 2;
  let idx = -1;
  for (let i = 0; i < n; i++) {
    // The offsets only ever increase, so the first frame that starts below the
    // centre ends the search.
    if (tops[i] > center) break;
    if (spans(i)) idx = i;
  }
  // Nothing above the centre has any height to it — the reader is looking at
  // the head of the column, whatever is or is not decoded below.
  return idx < 0 ? 0 : idx;
}

// How much of one frame is inside the viewport, in the same content-space
// pixels `tops` are measured in. Zero for a frame that is off screen, or for
// one with no height at all.
export function visibleHeightOf(top, height, scrollTop, viewportH) {
  const h = Math.max(0, height ?? 0);
  if (!(h > 0)) return 0;
  const t = top ?? 0;
  return Math.max(0, Math.min(t + h, scrollTop + viewportH) - Math.max(t, scrollTop));
}

// ---------- who owns the page index while the reader is working ----------
//
// The index in a strip FOLLOWS the scroll (see `pageIndexAtCenter`), and
// `gotoPage` — the one writer of it — clears the selection and closes the
// caret, because in a paged document a page turn is the user leaving the work
// behind. In a strip they have not left anything: the chapter's pages are all
// on screen at once, so a click on a box in the tail of the slice above focuses
// that page, and the very next scroll frame re-derives the index from the
// viewport's centre, writes it back and takes the selection away again — the
// box deselects itself, an inline edit closes mid-word.
//
// The rule, and it is the reader's own: WHILE A BOX IS SELECTED OR BEING TYPED
// INTO, the page that box is on holds the index for as long as any part of that
// page is still on screen. Scroll it out of the viewport and the index goes
// back to following the centre, because at that point the reader really has
// travelled away from the work.
//
// A hold rather than a lock: nothing here suppresses the scroll publish (the
// reference strip still follows), and with nothing selected the index tracks
// the centre exactly as it always has.
export const FOCUS_HOLD_PX = 8;

export function focusHoldsIndex(tops, heights, index, scrollTop, viewportH, minPx = FOCUS_HOLD_PX) {
  if (!(index >= 0) || index >= (tops?.length ?? 0)) return false;
  const h = Math.max(0, heights?.[index] ?? 0);
  const shown = visibleHeightOf(tops[index], h, scrollTop, viewportH);
  // A page shorter than the threshold holds while any of it shows, so a thin
  // slice is not excluded by a rule that exists to ignore a sliver.
  return shown > 0 && shown >= Math.min(minPx, h);
}

// The widest page in the chapter. Not the current one: a strip is one column,
// and a fit measured against a narrow slice would let a wide one hang over both
// edges of the viewport with no way to scroll to what it cut off.
export function maxPageWidth(pages) {
  let max = 0;
  for (const p of pages ?? []) if (p?.w > 0 && p.w > max) max = p.w;
  return max;
}

// Fit in a strip is fit-WIDTH. There is no height to fit to — the column is the
// whole chapter — so the vertical axis is the container's own scrolling and the
// zoom answers only "the widest slice, whole, inside the viewport".
//
// Returns 0 when there is nothing to measure against, which callers read as
// "leave the zoom alone" exactly as the paged fit does for a non-finite result.
export function fitWidthZoom(pages, vw, padX = 0) {
  const w = maxPageWidth(pages);
  if (!(w > 0)) return 0;
  const z = (vw - padX) / w;
  return z > 0 && isFinite(z) ? z : 0;
}

// ---------- how much of the chapter stays in memory ----------
//
// The paged window is a count of pages either side, and a count is the wrong
// unit for a strip: the same five pages are five screens of lookahead when the
// slices are 1000px tall and a third of one screen when they are 8000px. What
// the reader can outrun is pixels, so the window is grown until it holds them.
//
// Three screens either side is the target — enough that a fast flick lands on
// art that is already decoded, and no more, because every page in the window is
// a whole decoded raster held in the renderer. The floor keeps a strip of huge
// slices behaving exactly like the paged window it replaces; the cap is what
// stops a chapter of thumbnail-sized slices deciding it wants two hundred
// pictures in memory at once.
export const RESIDENT_MIN = 2;
export const RESIDENT_MAX = 12;
export const RESIDENT_SCREENS = 3;

export function residentRadiusFor(heights, index, viewportH, opts = {}) {
  const { min = RESIDENT_MIN, max = RESIDENT_MAX, screens = RESIDENT_SCREENS } = opts;
  const n = heights?.length ?? 0;
  if (!n) return min;
  const want = (viewportH > 0 ? viewportH : 0) * screens;
  if (!(want > 0)) return min;
  // Each side is counted separately: a reader three pages from the end of the
  // chapter needs no more lookahead in that direction, and letting the short
  // side borrow the long side's pixels would keep growing the window for no
  // reason.
  let up = 0;
  let down = 0;
  for (let r = 1; r <= max; r++) {
    const a = index - r;
    const b = index + r;
    // Running out of chapter satisfies a side outright — there is nothing
    // further to prefetch that way.
    up = a >= 0 ? up + Math.max(0, heights[a] || 0) : Infinity;
    down = b < n ? down + Math.max(0, heights[b] || 0) : Infinity;
    if (up >= want && down >= want) return Math.max(min, r);
  }
  return max;
}

// ---------- slaving one scroll container to another ----------
//
// The reference strip and the canvas strip are the same chapter at two
// different widths, so their scroll heights differ and copying `scrollTop`
// across would drift apart within a screen. What travels between them is the
// FRACTION, which keeps the two showing the same part of the chapter whatever
// either one's zoom is.
//
// Two functions rather than one because the two halves are on opposite sides of
// a component boundary: the canvas measures itself and publishes, the sidebar
// receives and applies. Both take plain numbers, so the mapping is testable and
// the DOM read stays with whoever owns the element.
const scrollRange = (m) => Math.max(0, (m?.scrollHeight ?? 0) - (m?.clientHeight ?? 0));

export function scrollFraction(m) {
  const max = scrollRange(m);
  // A container with nothing to scroll is at the top of everything it has.
  return max > 0 ? clamp((m.scrollTop ?? 0) / max, 0, 1) : 0;
}

export function scrollTopForFraction(fraction, m) {
  const max = scrollRange(m);
  if (!(max > 0)) return 0;
  return clamp(fraction ?? 0, 0, 1) * max;
}
