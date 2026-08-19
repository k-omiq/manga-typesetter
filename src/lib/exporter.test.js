import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app, loadProjectPages } from './store.svelte.js';
import {
  exportTextJson,
  buildTextJson,
  pageSpace,
  renderPageCanvas,
  renderStripSliceCanvas,
  exportImages,
  stripPageSuffix,
} from './exporter.js';
import { PAGE_W, PAGE_H, normalizeStyle } from './data.js';
import { layoutLines, BOX_PAD, balloonWidthsFor } from './measure.js';
import { neededHeight } from './typeset.js';

// exportTextJson is the single writer of the detection JSON - the detect menu
// and the export dialog both go through it - so what its two scopes select is
// worth pinning down. Everything under test here is scope arithmetic: which
// pages go in, and what the file is called.
//
// The browser-download branch is the one reachable outside Tauri, and it wants
// exactly two things this environment lacks: an anchor to click and an object
// URL to point it at. Three stubs, not a DOM: a real one would only make the
// same two facts harder to read off.
//
// The canvas half of the exporter wants two more: an element that answers to
// `width`/`height`/`getContext`, and an `Image` that decodes. Both are stubs of
// exactly the surface `renderPageCanvas` touches for a page with no boxes on it
// - the geometry is what is under test, not the painting - and `naturalSizes`
// below is what the fake decoder knows about each src.
let downloaded;
let naturalSizes;
const realDocument = globalThis.document;
const realImage = globalThis.Image;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

// Draws nothing, and records the two things worth reading back: the strings
// `paintBox` hands to `fillText`, which are the lines the export actually puts
// on the page, and where they landed. Everything else exists so the render can
// run to the end and the canvas's own dimensions can be read off it.
//
// A box with no rotation is painted onto its own offscreen canvas and then
// composited onto the page, so the page coordinate of a glyph run is the origin
// of that bitmap plus the position inside it - `composited` is the first half.
let painted;
let placed;
let composited;
const stubContext = () => ({
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  lineJoin: '',
  miterLimit: 0,
  font: '',
  textBaseline: '',
  textAlign: '',
  globalAlpha: 1,
  imageSmoothingQuality: '',
  fillRect() {},
  drawImage(_img, x, y) {
    composited.push([x, y]);
  },
  scale() {},
  save() {},
  restore() {},
  translate() {},
  rotate() {},
  fillText(s, x, y) {
    painted.push(s);
    placed.push([x, y]);
  },
  strokeText() {},
});

beforeEach(() => {
  downloaded = [];
  painted = [];
  placed = [];
  composited = [];
  naturalSizes = {};
  globalThis.document = {
    // `exportImages` waits for the fonts before it measures anything. Under node
    // there are none and there is nothing to wait for.
    fonts: { ready: Promise.resolve() },
    createElement: (tag) =>
      tag === 'canvas'
        ? {
            width: 0,
            height: 0,
            getContext: stubContext,
            // The strip export asks each slice canvas for its file. Nothing
            // reads the bytes - what is under test there is how many files come
            // out and what they are called.
            toBlob(cb) {
              cb(new Blob([`${this.width}x${this.height}`]));
            },
          }
        : {
            click() {
              downloaded.push(this.download);
            },
          },
  };
  // `loadImage` sets crossOrigin, then the handlers, then src - so firing off
  // the src setter is safe, and asynchronously, because a synchronous onload
  // would run before the promise it resolves exists.
  globalThis.Image = class {
    set src(url) {
      const size = naturalSizes[url];
      queueMicrotask(() => {
        if (!size) return this.onerror?.(new Error('decode failed'));
        this.naturalWidth = size[0];
        this.naturalHeight = size[1];
        this.onload?.();
      });
    }
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};

  app.exportName = 'ch01';
  loadProjectPages([
    { id: 11, w: 800, h: 1200, lines: [{ n: 1, jp: 'あ', en: 'ah' }], boxes: [] },
    { id: 22, w: 800, h: 1200, lines: [{ n: 1, jp: 'い', en: 'ee' }], boxes: [] },
    { id: 33, w: 800, h: 1200, lines: [], boxes: [] },
  ]);
});

afterEach(() => {
  // A layout is a property of the open project, and one test opening a
  // longstrip one must not leave every later test in a strip.
  app.projectLayout = 'pages';
  globalThis.document = realDocument;
  globalThis.Image = realImage;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('exportTextJson', () => {
  it("names the whole-chapter document once, without any page's id in it", async () => {
    await exportTextJson('all');
    expect(downloaded).toEqual(['ch01-text.json']);
    // One document for three pages, not three files - the reason the export
    // dialog's 'all' still goes through the single-file save path.
    expect(app.toast.msg).toBe('Exported text for 3 page(s) as JSON (browser download)');
  });

  it('names the current-page document after the page, not after its index', async () => {
    app.pageIndex = 1;
    await exportTextJson('current');
    expect(downloaded).toEqual(['ch01-22-text.json']);
    expect(app.toast.msg).toBe('Exported text for 1 page(s) as JSON (browser download)');
  });
});

// The text JSON is otherwise a full round trip, and `type` can only hold one of
// the three names the importer validates - so without `tags` a line the user
// tagged `shout` came back as `dialogue` and their own vocabulary was lost.
describe('text JSON carries tags', () => {
  it('writes the tags a line carries alongside its legacy type', () => {
    const pages = [
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [
          { n: 1, type: 'sfx', jp: 'ドン', en: 'DOOM', tags: ['sfx', 'shout'] },
          { n: 2, type: 'dialogue', jp: 'あ', en: 'ah' },
        ],
        boxes: [],
      },
    ];
    const out = JSON.parse(buildTextJson(pages));
    expect(out.pages[0].lines[0].tags).toEqual(['sfx', 'shout']);
    expect(out.pages[0].lines[0].type).toBe('sfx');
    // A line the user never tagged reads through its legacy type, so the round
    // trip neither invents a tag nor drops the one the file already implied.
    expect(out.pages[0].lines[1].tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// what size a page exports at when nobody has ever measured it
// ---------------------------------------------------------------------------
//
// A page is `w:0,h:0` until something decodes its image, and until `createChapter`
// started measuring at import the only thing that ever did was the canvas - one
// page at a time, as the user opened it. Every chapter imported before that is
// still on disk that way: 23 of the 28 pages in the author's own chapter.
//
// Export All reaches every page, looked at or not. `const W = p.w` handed the
// unmeasured ones straight to `canvas.width`, and a 0x0 canvas is not a small
// page - it is an empty file written under the page's name with a success toast
// over it. (The PSD path had the same hole and failed louder: ag-psd throws
// `Invalid document size`.)
describe('pageSpace', () => {
  it('is the page itself once the page has been measured', async () => {
    // No decode: a measured page already knows, and the raster is not asked -
    // which is what keeps the box coordinates and the document in one space
    // even for a page whose art was replaced at a different resolution.
    naturalSizes = { 'blob:art': [4000, 4000] };
    expect(await pageSpace({ w: 1080, h: 1535, cleaned: 'blob:art' })).toEqual({ w: 1080, h: 1535 });
  });

  it('asks the art when the page has no size of its own', async () => {
    naturalSizes = { 'blob:raw': [1080, 1535] };
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:raw' })).toEqual({ w: 1080, h: 1535 });
  });

  it('measures the image the app would actually draw', async () => {
    // `cleaned ?? raw` is what the canvas and this exporter both put on screen,
    // so a page with both is the size of its cleaned raster and not its raw.
    naturalSizes = { 'blob:raw': [1080, 1535], 'blob:clean': [2160, 3070] };
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:raw', cleaned: 'blob:clean' })).toEqual({
      w: 2160,
      h: 3070,
    });
  });

  it('falls back to the default page rather than to nothing', async () => {
    // No size, and art that will not decode. Whatever number is chosen the file
    // exports as a blank sheet - but 0 is the one that makes it unopenable.
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:gone' })).toEqual({ w: PAGE_W, h: PAGE_H });
    expect(await pageSpace({ w: 0, h: 0 })).toEqual({ w: PAGE_W, h: PAGE_H });
  });
});

describe('renderPageCanvas', () => {
  it('sizes the canvas to a never-visited page instead of exporting nothing', async () => {
    naturalSizes = { 'blob:raw-7': [1080, 1535] };
    const canvas = await renderPageCanvas({ id: 7, w: 0, h: 0, raw: 'blob:raw-7', boxes: [] });
    expect([canvas.width, canvas.height]).toEqual([1080, 1535]);
  });

  it('still supersamples from the measured space', async () => {
    const canvas = await renderPageCanvas({ id: 7, w: 800, h: 1200, boxes: [] }, 2);
    expect([canvas.width, canvas.height]).toEqual([1600, 2400]);
  });
});

// The editor and the export must break a box's text in the same places, and the
// mechanism is that both ask `layoutLines` - the same function, with the same
// two arguments: the style's own size, and `box.w` less the padding on each
// side. So what is pinned here is that the exporter draws exactly what that
// function returns for exactly those arguments, which is the half of the parity
// a node test can see. (Under node there is no canvas, so `lineWidth` falls back
// to a stand-in metric; the claim is about which strings are drawn, not about
// what a real font measures.)
describe('shaped lines reach the page', () => {
  const boxWith = (style) => ({
    id: 'b1',
    lineN: null,
    text: 'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle(style),
  });

  it('draws the shaped breaking, not the greedy one', async () => {
    const box = boxWith({ size: 20, outlineWidth: 0, shadow: { on: false } });
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted).toEqual(
      layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2),
    );
    // And that is genuinely a balanced block rather than the whole string.
    expect(painted.length).toBeGreaterThan(1);
  });

  // The `shape: 'off'` half is pinned in typeset.test.js instead, against
  // `layoutLines` directly: taking it through the exporter would mean standing
  // up the hidden-element measurement `wrapLinesDOM` performs - a div with real
  // layout and a Range over it - which is a browser, not a stub.

  // The box lays text out inside 2px of padding on every edge - `.tbox` carries
  // it in the editor, and the wrapping width has always been `box.w - 4` on both
  // sides to match. The export honoured it when it broke the lines and then
  // ignored it when it placed them, anchoring the block at the box's own corner:
  // so a left-aligned box drew 2px further left in the PNG than on the canvas,
  // and a top-aligned block 2px higher. The auto-height made that worse than
  // cosmetic - `neededHeight` sizes a box as its block plus the pad on BOTH
  // edges, so every auto-fitted box exported with 4px of empty space under its
  // text that the editor did not show.
  //
  // The page coordinate of a glyph run is the offscreen bitmap's origin plus the
  // position inside it, which is what the two stubs above record.
  describe('the block sits inside the padding, exactly as the canvas shows it', () => {
    const drawnAt = () => [composited[0][0] + placed[0][0], composited[0][1] + placed[0][1]];

    it('anchors a left/top-aligned block 2px in from the box corner', async () => {
      const box = boxWith({ size: 20, align: 'left', valign: 'top', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      expect(x).toBe(box.x + BOX_PAD);
      // The baseline sits half the leading below the top of the line box, which
      // is the same offset the un-padded version had - the padding is the only
      // thing that moved.
      const lineH = box.style.size * box.style.lineHeight;
      expect(y).toBe(box.y + BOX_PAD + (lineH - box.style.size) / 2);
    });

    it('anchors a right/bottom-aligned block 2px in from the far corner', async () => {
      const box = boxWith({ size: 20, align: 'right', valign: 'bottom', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      expect(x).toBe(box.x + box.w - BOX_PAD);
      const lineH = box.style.size * box.style.lineHeight;
      expect(y).toBe(box.y + box.h - BOX_PAD - lineH + (lineH - box.style.size) / 2);
    });

    it('leaves a centred block where it was — the padding is symmetric', async () => {
      const box = boxWith({ size: 20, align: 'center', valign: 'middle', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      const lineH = box.style.size * box.style.lineHeight;
      expect(x).toBe(box.x + box.w / 2);
      expect(y).toBe(box.y + (box.h - lineH) / 2 + (lineH - box.style.size) / 2);
    });

    it('gives an auto-fitted box no slack under its last line', async () => {
      // A box sized by `neededHeight` for the block it holds: the text ends
      // exactly one padding above the box's bottom edge, with nothing left over.
      const style = { size: 20, align: 'left', valign: 'top', outlineWidth: 0, shadow: { on: false } };
      const box = boxWith(style);
      box.text = 'ONE';
      const lineH = box.style.size * box.style.lineHeight;
      box.h = neededHeight(1, box.style, BOX_PAD);
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const blockBottom = drawnAt()[1] - (lineH - box.style.size) / 2 + lineH;
      expect(box.y + box.h - blockBottom).toBe(BOX_PAD);
    });
  });

  // The balloon a box was fitted to is the fifth argument to that same
  // function, and the export has to pass it or the PNG breaks its lines
  // somewhere the canvas does not - which is the identical failure the padding
  // above describes, one step further along. `balloonWidthsFor` is the single
  // helper all three layout sites call, so what is pinned here is that the
  // exporter calls it: with the fit in place the drawn strings are the ones that
  // helper produces, and they are NOT the ones the flat content width produces.
  it('draws the balloon’s breaking for a box that was fitted to one', async () => {
    const box = boxWith({ size: 20, lineHeight: 1, outlineWidth: 0, shadow: { on: false } });
    box.text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US';
    box.w = 200;
    box.fit = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    const flat = layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2);
    expect(painted).toEqual(
      layoutLines(
        box.text,
        box.style,
        box.style.size,
        box.w - BOX_PAD * 2,
        balloonWidthsFor(box, box.style, box.style.size),
      ),
    );
    expect(painted).not.toEqual(flat);
  });

  it('draws exactly what it drew before for a box with no fit', async () => {
    // The other half of the same claim, and the one that has to stay true for
    // every box in every chapter that predates fitting: no fit, no fifth
    // argument, no change.
    const box = boxWith({ size: 20, outlineWidth: 0, shadow: { on: false } });
    box.fit = null;
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted).toEqual(layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2));
  });

  it('uppercases before it measures, so the breaks match the glyphs drawn', async () => {
    const box = boxWith({ size: 20, outlineWidth: 0, uppercase: true, shadow: { on: false } });
    box.text = 'the world is ending and nobody cares at all';
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted.join(' ')).toBe(box.text.toUpperCase());
  });
});

// A longstrip chapter exports as slices of one column rather than as its source
// pages, so what has to be pinned down is the geometry of a slice - which pages
// land in it and where - and the shape of the file set that comes out. The
// cut-planning arithmetic itself lives in editor/strip-cuts.js and is tested
// there against nothing but numbers.
describe('renderStripSliceCanvas', () => {
  const strip = () => [
    { id: 1, w: 800, h: 1000, raw: 'blob:a', lines: [], boxes: [] },
    { id: 2, w: 600, h: 1000, raw: 'blob:b', lines: [], boxes: [] },
  ];

  it('is the widest page wide and exactly one slice tall', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    const canvas = await renderStripSliceCanvas(strip(), [0, 1000], 900, 1600);
    expect([canvas.width, canvas.height]).toEqual([800, 700]);
  });

  it('draws every page the slice crosses at its offset, narrow ones centred', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    await renderStripSliceCanvas(strip(), [0, 1000], 900, 1600);
    // Page one hangs off the top of the slice; page two starts 100px into it
    // and is 200px narrower, so it sits 100px in from the left.
    expect(composited).toEqual([
      [0, -900],
      [100, 100],
    ]);
  });

  it('leaves out the pages the slice does not reach', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    await renderStripSliceCanvas(strip(), [0, 1000], 0, 500);
    expect(composited).toEqual([[0, 0]]);
  });
});

describe('exportImages in a longstrip project', () => {
  beforeEach(() => {
    app.projectLayout = 'longstrip';
    app.stripSliceH = 1000;
  });

  it('writes numbered slices of the whole column instead of one file per page', async () => {
    // Three 1200px pages is 3600px of strip; at 1000px a slice with nothing in
    // the way that is four files, the last one short.
    await exportImages('PNG', 'all');
    expect(downloaded).toEqual([
      'ch01-strip-01.png',
      'ch01-strip-02.png',
      'ch01-strip-03.png',
      'ch01-strip-04.png',
    ]);
  });

  it('still exports one page as that page', async () => {
    await exportImages('PNG', 'current');
    expect(downloaded).toEqual(['ch01-11.png']);
  });

  it('leaves the text document alone — it is one file for the chapter either way', async () => {
    await exportImages('JSON', 'all');
    expect(downloaded).toEqual(['ch01-text.json']);
  });
});

describe('renderPageCanvas robustness', () => {
  it('handles a page object missing the boxes property without throwing', async () => {
    const canvas = await renderPageCanvas({ id: 1, w: 800, h: 1200 });
    expect(canvas).toBeDefined();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1200);
  });
});

describe('stripPageSuffix — single-page save stem logic', () => {
  it('strips the page suffix when it matches the exported page id', () => {
    expect(stripPageSuffix('Chapter-10-1', 1)).toBe('Chapter-10');
    expect(stripPageSuffix('MyManga-5', 5)).toBe('MyManga');
    expect(stripPageSuffix('special-edition-1', '1')).toBe('special-edition');
  });

  it('preserves numbered chapter names when not matching page id', () => {
    expect(stripPageSuffix('Chapter-10', 1)).toBe('Chapter-10');
    expect(stripPageSuffix('Chapter-10', null)).toBe('Chapter-10');
    expect(stripPageSuffix('Vol-1-Ch-05', 1)).toBe('Vol-1-Ch-05');
  });

  it('strips actual matching page id on numbered chapters', () => {
    expect(stripPageSuffix('Chapter-10', 10)).toBe('Chapter');
  });
});
