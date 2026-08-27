// ===== The detected/translated text of a chapter, as one JSON document =====
//
// Lifted out of exporter.js so that the library can write this file on every
// autosave without importing the raster exporter. exporter.js pulls in the
// canvas renderer, the PSD writer's shared helpers and the Tauri dialog plugin;
// library.svelte.js is loaded on boot and runs under a `node` test environment,
// and neither has any business dragging that in to serialise some text. The two
// functions here need nothing but the document itself, so they live in a leaf
// and exporter.js re-exports `buildTextJson` - one serialiser, one file format,
// no second copy to drift.
import { lineText } from './store.svelte.js';

// One page → the detected/typeset text plus the geometry it came from. `jp` is
// the OCR'd source text, `en` the translation you typed (or that came in via a
// JSON import); `box` is the detector's [x1,y1,x2,y2] in image coordinates and
// `placed` is where the line's text box actually sits on the page, when one has
// been placed. Free-typed boxes (no detected line behind them) are listed
// separately so nothing typeset is lost.
export function serializePageText(p) {
  const geom = new Map((p.detect?.boxes ?? []).map((d) => [d.n, d]));
  const placedFor = (n) => {
    const b = (p.boxes ?? []).find((x) => x.lineN === n);
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  };
  return {
    page: p.id,
    // `null`, never a stand-in. A page nobody has measured is stored `w:0,h:0`
    // - "unknown" - and this file is what a translator's tooling reads the
    // page's coordinate space out of: every `box` and every `placed` in it is
    // quoted in that space. Exporting `PAGE_W`/`PAGE_H` for an unmeasured page
    // published a space the boxes were never authored in, and a consumer that
    // scaled by it (or re-imported through it) placed every line against a
    // 1080x1535 sheet the art never was. `null` says what is true, and a reader
    // that needs a size has the image itself to measure - the same answer the
    // app gives itself on the next open.
    width: p.w > 0 ? p.w : null,
    height: p.h > 0 ? p.h : null,
    panels: (p.detect?.panels ?? []).slice(),
    lines: (p.lines ?? []).map((l) => {
      const g = geom.get(l.n);
      // `tags` alongside `type`, not instead of it: `type` is the legacy field
      // every other consumer still reads, and it can only ever hold one of the
      // three names the importer validates - so a line tagged `shout` would come
      // back as `dialogue` and the user's own vocabulary would be lost on the
      // round trip through this file. Written only where the line really has an
      // array, because the array's *presence* is what tells `lineTags` the user
      // has taken over from the legacy `type` - materialising `[]` for every line
      // would read as the user having deliberately cleared every tag in the chapter.
      return {
        n: l.n,
        type: l.type ?? 'dialogue',
        ...(Array.isArray(l.tags) ? { tags: l.tags.slice() } : null),
        jp: l.jp ?? '',
        en: lineText(l),
        box: g?.box ?? null,
        vertical: g?.vertical ?? null,
        font_size: g?.font_size ?? null,
        placed: placedFor(l.n),
      };
    }),
    // Text boxes the user typed directly, with no detected line behind them.
    extraBoxes: (p.boxes ?? [])
      .filter((b) => b.lineN == null)
      .map((b) => ({ text: b.text ?? '', x: b.x, y: b.y, w: b.w, h: b.h })),
  };
}

// The whole export scope as one JSON document. The `pages` shape is exactly what
// the JSON importer accepts, so an exported file re-imports cleanly.
export function buildTextJson(pages) {
  return JSON.stringify(
    { schema: 1, generator: 'manga-typesetter', pages: pages.map(serializePageText) },
    null,
    2,
  );
}
