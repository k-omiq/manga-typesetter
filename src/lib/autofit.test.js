import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
// The auto-height, wired up
// ===========================================================================
// `autoFitBox` is the one function that makes a box's rectangle describe its
// text, and until this file existed nothing in the suite ever ran it: it asks
// `canMeasure()` first, and under node there is no canvas, so it declined in all
// 558 tests. Everything downstream of it — the fit at placement, the refit on
// load, the geometry an undo puts back — was comment-backed only.
//
// The seam is one function, and the mock is one line of it. `measure.js` already
// falls back to a stand-in metric with no canvas (`lineWidth` answers
// `chars * size * 0.55`), and that fallback is deterministic — so the ONLY thing
// this environment is missing is the permission to use it. Nothing else is
// stubbed: the real `layoutLines`, the real `balanceLines`, the real
// `neededHeight` and `growToFit` all run. That is deliberate. A hand-written
// fake measurer would let this file agree with itself while the app measured
// something else, and the numbers below are only worth writing down because they
// come out of the code the app runs.
//
// It also keeps the production side honest: no test-only injection point, no
// `setMeasurer` for a caller to get wrong, and the guard the app relies on
// (`canMeasure`, pinned in store.test.js) stays exactly as it is.
//
// The metric, then, for every expectation in this file:
//   width(line) = line.length * style.size * 0.55
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const { app, loadProjectPages, autoFitBox, refitPage, page, byId, placeActiveAt, beginEdit, endEdit, applyBulk, toggleBulkTarget, setBulkProp, openBulk, closeBulk, selectBox } =
  await import('./store.svelte.js');
const { record, undo, redo, resetHistory, initHistory } = await import('./editor/history.svelte.js');
const { neededHeight } = await import('./typeset.js');

const CHAR = (size) => size * 0.55;

// A box wide enough for one four-letter word and not two, at size 20: the
// content width is `w - 4` and a word is `4 * 11 = 44` wide.
const twoLiner = (over = {}) => ({
  id: 'b1',
  lineN: null,
  text: 'AAAA BBBB',
  x: 100,
  y: 500,
  w: 60,
  h: 20,
  style: { size: 20, lineHeight: 1.1, valign: 'middle', outlineWidth: 0, ...over.style },
  ...over,
});

const doc = (boxes, over = {}) => [
  { id: 1, w: 800, h: 1200, lines: [], boxes, ...over },
];

const geom = (b) => ({ y: b.y, h: b.h });

beforeEach(() => {
  initHistory();
  resetHistory();
  app.chapterRef = null;
  closeBulk();
});

describe('the metric this file measures with', () => {
  it('is the stand-in, and it is what makes every number below readable', () => {
    // Two lines, because `AAAA BBBB` is 99 wide and the content width is 56.
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const b = page().boxes[0];
    expect(CHAR(20) * 9).toBeGreaterThan(b.w - 4);
    expect(CHAR(20) * 4).toBeLessThan(b.w - 4);
  });
});

describe('the box grows to its text, anchored where the text is', () => {
  // 2 lines * 20 * 1.1 = 44, plus the 2px padding on each edge.
  const NEED = neededHeight(2, { size: 20, lineHeight: 1.1 }, 2);

  it('grows downward from a top-aligned box', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'top' } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: NEED });
  });

  it('grows upward from a bottom-aligned box', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'bottom' } })]));
    // The bottom edge stays where the user put it: 500 + 20 === 472 + 48.
    expect(geom(page().boxes[0])).toEqual({ y: 500 + 20 - NEED, h: NEED });
  });

  it('opens equally in both directions when the text is centred', () => {
    loadProjectPages(doc([twoLiner()]));
    const b = page().boxes[0];
    expect(geom(b)).toEqual({ y: 500 - (NEED - 20) / 2, h: NEED });
    expect(b.y + b.h / 2).toBe(500 + 20 / 2);
  });

  it('never shrinks a box the user left roomier than its text', () => {
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const b = page().boxes[0];
    expect(geom(b)).toEqual({ y: 500, h: 400 });
    expect(autoFitBox(b, page())).toBe(false);
  });

  it('leaves the width alone — it is what the user aimed at the bubble', () => {
    loadProjectPages(doc([twoLiner()]));
    expect(page().boxes[0].w).toBe(60);
  });

  it('declines for curved text, which is not laid out in lines at all', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'middle', curve: 40 } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: 20 });
  });

  it('declines when the box has opted out', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'middle', autoHeight: false } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: 20 });
  });

  it('is capped at the page and clamped inside it', () => {
    // A page shorter than the text needs. The box fills it rather than hanging
    // off the bottom edge where no drag can reach it.
    loadProjectPages(doc([twoLiner({ y: 10, style: { size: 20, lineHeight: 1.1, valign: 'top' } })], { h: 40 }));
    expect(geom(page().boxes[0])).toEqual({ y: 0, h: 40 });
  });

  it('does not clamp against a page nobody has measured yet', () => {
    // `p.h` is 0 until something decodes the art, and clamping against that
    // would drag every box on an unvisited page to the top of it.
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'top' } })], { w: 0, h: 0 }));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: NEED });
  });

  it('is idempotent, so a second pass can never ratchet', () => {
    loadProjectPages(doc([twoLiner()]));
    const b = page().boxes[0];
    const once = geom(b);
    expect(autoFitBox(b, page())).toBe(false);
    expect(geom(b)).toEqual(once);
  });
});

// A chapter opening is the moment a whole document's worth of boxes arrives at
// once, sized by an older build, a hand-edited file, or a font that has since
// been replaced. Nothing renders during a load, so a component effect could not
// cover it.
describe('a chapter load refits every page, not just the one on screen', () => {
  it('grows the boxes on a page the user has not turned to', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [twoLiner()] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [twoLiner({ id: 'b2' })] },
    ]);
    expect(app.pageIndex).toBe(0);
    expect(app.pages[1].boxes[0].h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, 2));
  });

  it('answers how many boxes it moved, so a caller can tell', () => {
    loadProjectPages(doc([twoLiner({ h: 400 }), twoLiner({ id: 'b2' })]));
    // Both are already fitted by the load itself, so a second pass moves none.
    expect(refitPage(page())).toBe(0);
  });
});

// The box a click places is sized from the bubble the detector found. That is
// the right width and rarely the right height, because the height belongs to the
// English rather than to the Japanese it is replacing.
describe('placement fits the box it just created', () => {
  const detected = () => [
    {
      id: 1,
      w: 1000,
      h: 2000,
      lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD' }],
      boxes: [],
      detect: { panels: [], boxes: [{ n: 1, box: [100, 100, 300, 200], vertical: false, font_size: 20 }] },
    },
  ];

  it('places at the height the text needs, not the height of the bubble', () => {
    loadProjectPages(detected());
    page().activeLineN = 1;
    placeActiveAt(200, 150);
    const b = page().boxes[0];
    // The rect is 200x100, inset by 8 on every edge: 184 wide, 84 tall. At the
    // default size of 26 a word of eight letters is 114 wide and two of them do
    // not fit the 180px content width, so the block is four lines.
    expect(b.w).toBe(184);
    expect(b.h).toBe(neededHeight(4, { size: 26, lineHeight: 1.1 }, 2));
    expect(b.h).toBeGreaterThan(84);
    // Still centred on the bubble, which is the whole point of the anchor.
    expect(b.y + b.h / 2).toBe(150);
  });

  it('records the placement at the height the user is looking at', () => {
    loadProjectPages(detected());
    page().activeLineN = 1;
    placeActiveAt(200, 150);
    const b = page().boxes[0];
    undo();
    expect(page().boxes).toHaveLength(0);
    redo();
    // The `place` entry carries the box, and the box it carries is the fitted
    // one — the fit runs before the record, not after it.
    expect(geom(page().boxes[0])).toEqual(geom(b));
  });
});

// ===========================================================================
// Undo puts back the geometry the box actually had
// ===========================================================================
// The grow is not an edit of its own and gets no history step of its own. What
// it gets is a ride on the entry for the edit that caused it: `geomBefore` and
// `geomAfter`. It used to be re-derived instead, which cannot work — the fit is
// grow-only, so nothing it could do would give back the height the grow took.
describe('undo restores the height an edit grew', () => {
  const short = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [],
      // Three lines at size 20 need 70, so the load's own refit leaves both of
      // these exactly as the file had them — the growth below belongs to the
      // edit under test and to nothing else.
      boxes: [
        { id: 'b1', lineN: null, text: 'AAAA BBBB CCCC', x: 100, y: 500, w: 60, h: 80, style: { size: 20, valign: 'middle' } },
        { id: 'b2', lineN: null, text: 'AAAA BBBB CCCC', x: 300, y: 500, w: 60, h: 80, style: { size: 20, valign: 'middle' } },
      ],
    },
  ];

  it('walks a style change and the growth it caused back together', () => {
    loadProjectPages(short());
    const b = byId('b1');
    const before = geom(b);
    // What the Inspector writes when the size field is dragged from 20 to 48:
    // the style, the fit, and one entry carrying both.
    const styleBefore = { ...b.style };
    b.style.size = 48;
    expect(autoFitBox(b, page())).toBe(true);
    const grown = geom(b);
    expect(grown.h).toBeGreaterThan(before.h);
    expect(grown.y).toBeLessThan(before.y);
    record({
      t: 'style',
      pageId: 1,
      boxId: 'b1',
      before: styleBefore,
      after: { ...b.style },
      geomBefore: before,
      geomAfter: grown,
    });
    undo();
    expect(byId('b1').style.size).toBe(20);
    expect(geom(byId('b1'))).toEqual(before);
    redo();
    expect(byId('b1').style.size).toBe(48);
    expect(geom(byId('b1'))).toEqual(grown);
  });

  // The worse half of the same bug: undo restores `autoHeight:false`, so a
  // re-derivation on the way back does not merely fail to shrink the box — it
  // declines to run at all, and the height is stuck for good.
  it('walks back a box that grew because auto-height was switched on', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA BBBB', x: 100, y: 500, w: 60, h: 20, style: { size: 20, valign: 'middle', autoHeight: false } }],
      },
    ]);
    const b = byId('b1');
    const before = geom(b);
    expect(before.h).toBe(20); // the load's refit declined, as it must
    openBulk();
    toggleBulkTarget('b1');
    app.bulk.style.autoHeight = true;
    setBulkProp('autoHeight', true);
    applyBulk();
    const grown = geom(byId('b1'));
    expect(grown.h).toBeGreaterThan(20);
    undo();
    expect(byId('b1').style.autoHeight).toBe(false);
    expect(geom(byId('b1'))).toEqual(before);
  });

  it('walks back a bulk apply across every box it touched', () => {
    loadProjectPages(short());
    const before = { b1: geom(byId('b1')), b2: geom(byId('b2')) };
    openBulk();
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    app.bulk.style.size = 60;
    setBulkProp('size', true);
    applyBulk();
    const grown = { b1: geom(byId('b1')), b2: geom(byId('b2')) };
    expect(grown.b1.h).toBeGreaterThan(before.b1.h);
    expect(grown.b2.h).toBeGreaterThan(before.b2.h);
    // One entry, every box in it, and one press.
    undo();
    expect(geom(byId('b1'))).toEqual(before.b1);
    expect(geom(byId('b2'))).toEqual(before.b2);
    expect(byId('b1').style.size).toBe(20);
    redo();
    expect(geom(byId('b1'))).toEqual(grown.b1);
    expect(geom(byId('b2'))).toEqual(grown.b2);
  });

  it('walks back the growth a text edit caused', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA', x: 100, y: 500, w: 60, h: 30, style: { size: 20, valign: 'middle' } }],
      },
    ]);
    const before = geom(byId('b1'));
    beginEdit('b1');
    endEdit('AAAA BBBB CCCC DDDD');
    const grown = geom(byId('b1'));
    expect(grown.h).toBeGreaterThan(before.h);
    undo();
    expect(byId('b1').text).toBe('AAAA');
    expect(geom(byId('b1'))).toEqual(before);
    redo();
    expect(byId('b1').text).toBe('AAAA BBBB CCCC DDDD');
    expect(geom(byId('b1'))).toEqual(grown);
  });

  // Entries outlive the build that wrote them: the history is on disk, keyed by
  // page, and reloaded next session. One with no geometry in it is what every
  // entry looked like until now, and it still has to walk.
  it('falls back to a fit for an entry that carries no geometry', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA BBBB', x: 100, y: 500, w: 60, h: 400, style: { size: 20, valign: 'top' } }],
      },
    ]);
    const b = byId('b1');
    b.style.size = 60;
    b.h = 20;
    record({ t: 'style', pageId: 1, boxId: 'b1', before: { size: 20, valign: 'top' }, after: { size: 60, valign: 'top' } });
    undo();
    // No pair to restore, so the height is re-derived — grow-only, so the box
    // is at least big enough for the text the undo just put back in it.
    expect(byId('b1').style.size).toBe(20);
    expect(byId('b1').h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, 2));
  });
});

// A font arriving changes every width in the app, and until it does every
// measurement is made against the fallback family. The editor never noticed.
describe('a font arriving invalidates the fitted heights', () => {
  it('refits the whole open chapter and bumps the counter the layouts read', async () => {
    const { noteFontsChanged } = await import('./store.svelte.js');
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [twoLiner()] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [twoLiner({ id: 'b2' })] },
    ]);
    // Both are fitted by the load. Shrink them behind the fit's back, the way a
    // measurement against the wrong font would have.
    for (const p of app.pages) p.boxes[0].h = 20;
    const seen = app.fontsVersion;
    expect(noteFontsChanged()).toBe(2);
    expect(app.fontsVersion).toBe(seen + 1);
    for (const p of app.pages) expect(p.boxes[0].h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, 2));
  });

  it('bumps the counter even when no box needed moving', async () => {
    const { noteFontsChanged } = await import('./store.svelte.js');
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const seen = app.fontsVersion;
    expect(noteFontsChanged()).toBe(0);
    // The counter is what a component's derived layout depends on, and a box
    // whose height did not change can still break its lines somewhere else.
    expect(app.fontsVersion).toBe(seen + 1);
  });
});

// The queue's translation field writes `line.en`, and a box placed from that
// line renders it — so it is an edit to the box's text arrived at from the other
// end, and the box has to follow. It used to rely on the canvas component's
// effect, which only ever covers what is rendered.
describe('the queue’s own text field is a path like any other', () => {
  it('fits the line’s box when the translation is edited', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'AAAA' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 100, y: 500, w: 60, h: 30, style: { size: 20, valign: 'top' } }],
      },
    ]);
    const p = page();
    p.lines[0].en = 'AAAA BBBB CCCC';
    // What `Queue.svelte`'s oninput does with the box behind the row.
    for (const b of p.boxes) if (b.lineN === 1) autoFitBox(b, p);
    expect(byId('b1').h).toBe(neededHeight(3, { size: 20, lineHeight: 1.1 }, 2));
  });
});

describe('selection is untouched by any of this', () => {
  it('does not select a box just because it was fitted', () => {
    loadProjectPages(doc([twoLiner()]));
    selectBox(null);
    refitPage(page());
    expect(app.selectedId).toBe(null);
  });
});
