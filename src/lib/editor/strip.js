// Arithmetic and layout functions for longstrip webtoon columns.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Calculate page top offsets and total column height.
export function stripOffsets(pages, zoom = 1) {
  const tops = [];
  let y = 0;
  for (const p of pages ?? []) {
    tops.push(y);
    y += Math.max(0, p?.h ?? 0) * zoom;
  }
  return { tops, total: y };
}

// Determine page index at center of scroll viewport.
export function pageIndexAtCenter(tops, scrollTop, viewportH, heights = null) {
  const n = tops?.length ?? 0;
  if (!n) return 0;
  if (!heights && n > 1 && !(tops[n - 1] > tops[0])) return 0;
  const spans = (i) =>
    heights ? (heights[i] ?? 0) > 0 : i + 1 < n ? tops[i + 1] > tops[i] : true;
  const center = scrollTop + viewportH / 2;
  let idx = -1;
  for (let i = 0; i < n; i++) {
    if (tops[i] > center) break;
    if (spans(i)) idx = i;
  }
  return idx < 0 ? 0 : idx;
}

// Measure visible height of a frame in viewport.
export function visibleHeightOf(top, height, scrollTop, viewportH) {
  const h = Math.max(0, height ?? 0);
  if (!(h > 0)) return 0;
  const t = top ?? 0;
  return Math.max(0, Math.min(t + h, scrollTop + viewportH) - Math.max(t, scrollTop));
}

// Hold page index on selected box while page remains visible.
export const FOCUS_HOLD_PX = 8;

export function focusHoldsIndex(tops, heights, index, scrollTop, viewportH, minPx = FOCUS_HOLD_PX) {
  if (!(index >= 0) || index >= (tops?.length ?? 0)) return false;
  const h = Math.max(0, heights?.[index] ?? 0);
  const shown = visibleHeightOf(tops[index], h, scrollTop, viewportH);
  return shown > 0 && shown >= Math.min(minPx, h);
}

// Find maximum page width across chapter.
export function maxPageWidth(pages) {
  let max = 0;
  for (const p of pages ?? []) if (p?.w > 0 && p.w > max) max = p.w;
  return max;
}

// Calculate zoom level to fit widest page width in viewport.
export function fitWidthZoom(pages, vw, padX = 0) {
  const w = maxPageWidth(pages);
  if (!(w > 0)) return 0;
  const z = (vw - padX) / w;
  return z > 0 && isFinite(z) ? z : 0;
}

// Calculate lookahead page window for longstrip prefetch.
export const RESIDENT_MIN = 2;
export const RESIDENT_MAX = 12;
export const RESIDENT_SCREENS = 3;

export function residentRadiusFor(heights, index, viewportH, opts = {}) {
  const { min = RESIDENT_MIN, max = RESIDENT_MAX, screens = RESIDENT_SCREENS } = opts;
  const n = heights?.length ?? 0;
  if (!n) return min;
  const want = (viewportH > 0 ? viewportH : 0) * screens;
  if (!(want > 0)) return min;
  let up = 0;
  let down = 0;
  for (let r = 1; r <= max; r++) {
    const a = index - r;
    const b = index + r;
    up = a >= 0 ? up + Math.max(0, heights[a] || 0) : Infinity;
    down = b < n ? down + Math.max(0, heights[b] || 0) : Infinity;
    if (up >= want && down >= want) return Math.max(min, r);
  }
  return max;
}

// Convert scroll fraction between scroll containers.
const scrollRange = (m) => Math.max(0, (m?.scrollHeight ?? 0) - (m?.clientHeight ?? 0));

export function scrollFraction(m) {
  const max = scrollRange(m);
  return max > 0 ? clamp((m.scrollTop ?? 0) / max, 0, 1) : 0;
}

export function scrollTopForFraction(fraction, m) {
  const max = scrollRange(m);
  if (!(max > 0)) return 0;
  return clamp(fraction ?? 0, 0, 1) * max;
}
