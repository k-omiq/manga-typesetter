// ===== The seam between the async library and the synchronous painter =====
//
// `drawInk` is synchronous - it is called from a Svelte effect while the
// pointer is down and from the exporter in the middle of composing a page - and
// a tip is a file on disk that has to be read and decoded. Something has to
// bridge that, and the choice made here is: the CALLER prefetches.
//
// Before painting, a caller collects the brush ids its strokes name, awaits a
// tip for each, and hands the resulting map to `drawInk`. The painter never
// awaits, never blocks, and never throws when a tip is not there yet - it draws
// that stroke with the round dab for that frame and asks again next frame.
//
// Everything here is best-effort by construction: a missing brush, a library
// that failed to load, a tip that will not decode, no Tauri host at all. All of
// them come out as "no tip for that id", which the painter already handles.
//
// See THE TIP LIFETIME CONTRACT in `brush-library.svelte.js`: the map a settle
// hands back is for the frame it was asked for. Hold it across a paint, not
// across a chapter.
import { brushTip, loadBrushLibrary, BUILTIN_BRUSH } from './brush-library.svelte.js';

// The imported brush ids an ink block names. The round tip is not one: it is
// the engine's own dab and has no file behind it.
export function inkTipIds(ink, into = new Set()) {
  for (const k of ink?.strokes ?? []) {
    const id = k?.brush;
    if (typeof id === 'string' && id && id !== BUILTIN_BRUSH) into.add(id);
  }
  return into;
}

// The same, over every box on a page (or every box of several pages).
export function boxTipIds(boxes, into = new Set()) {
  for (const b of boxes ?? []) {
    if (b?.style?.ink?.on) inkTipIds(b.style.ink, into);
  }
  return into;
}

// Decode the tips for `ids`, as a map the painter can read synchronously. Null
// when there is nothing to stamp with, which is the common case and is what
// lets a caller pass the result straight on without a branch.
//
// The library is loaded first: strokes can name brushes on a chapter opened
// without the brush panel ever being shown, and an unloaded library would read
// every one of them as missing. `loadBrushLibrary` is idempotent and shared, so
// this is a settled promise after the first call.
export async function settleTips(ids) {
  const list = [...(ids ?? [])];
  if (!list.length) return null;
  try {
    await loadBrushLibrary();
  } catch {
    /* an unreadable library is an empty one; every id falls back to round */
  }
  const out = new Map();
  await Promise.all(
    list.map(async (id) => {
      try {
        const tip = await brushTip(id);
        if (tip?.image) out.set(id, tip);
      } catch {
        /* this brush draws round this frame */
      }
    }),
  );
  return out.size ? out : null;
}

// The tips one ink block needs.
export function settleInkTips(ink) {
  return settleTips(inkTipIds(ink));
}

// The tips a page's - or a strip's - boxes need, in one pass.
export function settleBoxTips(boxes) {
  return settleTips(boxTipIds(boxes));
}
