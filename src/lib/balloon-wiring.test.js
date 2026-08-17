import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
// The balloon, wired into the app
// ===========================================================================
// `balloon.js` and its own test file prove that a shape can be recovered from a
// page's pixels. Nothing in either of them says the app ever asks. This file is
// about the wiring: that a click places a box at the balloon's inscribed
// rectangle, that the shape is kept on the box, that every layout path lays text
// out inside it, that a save and a PSD round trip carry it, and — the half that
// matters most — that all four of the ways a fit can fail land the user on
// exactly the behaviour they had before any of this existed.
//
// Two mocks, both of them a permission rather than a fake.
//
//   `page-pixels.js` is the app's decoder, and it needs a canvas. Under node
//   there is none, so it correctly answers null forever and placement would
//   never take the fitted branch at all. What is replaced is the single lookup
//   function, so the test decides which page the pixels belong to; the pixels
//   themselves are built by hand below, exactly as balloon.test.js builds them,
//   and the real `detectBalloon` runs over them.
//
//   `measure.js`'s `canMeasure` is the same one-line permission autofit.test.js
//   grants, and for the same reason: the stand-in metric
//   (`chars * size * 0.55`) is deterministic and perfectly good for deciding
//   where a line breaks, and the only thing this environment lacks is the
//   licence to use it. Everything else — the real `layoutLines`, the real
//   `balanceLines`, the real `interiorLineWidths` — runs.
let pixels = null;
vi.mock('./page-pixels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pagePixelsFor: () => pixels,
}));
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const {
  app,
  page,
  loadProjectPages,
  placeActiveAt,
  placementRect,
  transposeRect,
  fittedRect,
  refitBalloon,
  setPageDims,
  BULK_PROPS,
} = await import('./store.svelte.js');
const { balloonWidthsFor, BOX_PAD, layoutLines } = await import('./measure.js');
const { inscribedRect } = await import('./balloon.js');
const { defaultStyle, normalizeStyle, normalizeFit } = await import('./data.js');
const { serializePage } = await import('./psd.js');

// ---------------------------------------------------------------------------
// The fixtures, lifted from balloon.test.js: an `ImageData`-shaped object built
// by hand, paper near white and ink near black, with a balloon drawn as one
// closed shape so a tail or an outline is part of the same figure rather than
// something laid over it.
// ---------------------------------------------------------------------------
const PAPER = 248;
const INK = 18;

function pageImage(w, h, fill = PAPER) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

const put = (img, x, y, v) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = v;
  img.data[i + 1] = v;
  img.data[i + 2] = v;
  img.data[i + 3] = 255;
};

const fillRect = (img, x, y, w, h, v) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, v);
};

function drawEllipse(img, cx, cy, rx, ry, ring = 3) {
  const r = (x, y, g) => Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g));
  for (let y = Math.floor(cy - ry - ring - 2); y <= Math.ceil(cy + ry + ring + 2); y++) {
    for (let x = Math.floor(cx - rx - ring - 2); x <= Math.ceil(cx + rx + ring + 2); x++) {
      if (r(x, y, 0) <= 1) put(img, x, y, PAPER);
      else if (r(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}

function drawBox(img, x, y, w, h, ring = 3) {
  fillRect(img, x - ring, y - ring, w + 2 * ring, h + 2 * ring, INK);
  fillRect(img, x, y, w, h, PAPER);
}

// A column of vertical Japanese, so the detected block's centre lands on ink —
// which is the whole reason the seed search in `fillInterior` exists.
function drawGlyphColumn(img, x, y, w, h, glyph = 22, gapY = 6) {
  for (let gy = y; gy + glyph <= y + h; gy += glyph + gapY) {
    fillRect(img, x, gy, w, glyph, INK);
    fillRect(img, x + 4, gy + 4, Math.max(1, w - 8), Math.max(1, glyph - 8), PAPER);
  }
}

// A jagged SFX burst: the shape `fitBalloonShape` refuses as irregular, and so
// the fixture for "the fallback fires on a fit nobody should believe".
function drawBurst(img, cx, cy, r, spikes = 9) {
  for (let y = cy - r - 4; y <= cy + r + 4; y++) {
    for (let x = cx - r - 4; x <= cx + r + 4; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rr = r * (0.45 + 0.55 * Math.abs(Math.cos(spikes * Math.atan2(dy, dx))));
      put(img, x, y, Math.hypot(dx, dy) <= rr ? PAPER : INK);
    }
  }
}

// One detected line, one page. `box` is the detector's block in page
// coordinates; `vertical` is its claim about how the Japanese in it was set.
const withDetect = (block, vertical, w = 500, h = 500) => [
  {
    id: 1,
    w,
    h,
    lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: '' }],
    boxes: [],
    detect: { panels: [], boxes: [{ n: 1, box: block, vertical, font_size: 20 }] },
  },
];

const round2 = (v) => Math.round(v * 100) / 100;

beforeEach(() => {
  app.chapterRef = null;
  pixels = null;
});

// ---------------------------------------------------------------------------
describe('placement, when the page can be looked at', () => {
  // The motivating case, end to end and through the app rather than through the
  // module: a 20x140 column of vertical Japanese inside a 260x160 oval. The box
  // the click produces has to come out wide and short, because that is the shape
  // of the room the balloon actually has.
  const ovalPage = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    return img;
  };

  it('sizes and centres the box on the balloon’s inscribed rectangle', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];

    // The fit is stored, and it is the plain JSON the schema promises — two
    // decimals, five keys, no mask anywhere near it.
    expect(b.fit.kind).toBe('ellipse');
    expect(Object.keys(b.fit).sort()).toEqual(['cx', 'cy', 'kind', 'rx', 'ry']);
    expect(JSON.parse(JSON.stringify(b.fit))).toEqual(b.fit);
    expect(b.fit.cx).toBeCloseTo(250, -1);
    expect(b.fit.cy).toBeCloseTo(250, -1);

    // And the box is that shape's inscribed rectangle — not the detector's rect
    // inset by 8%, which is what it would have been.
    const r = inscribedRect(b.fit);
    expect([b.x, b.y, b.w, b.h].map(round2)).toEqual([r.x, r.y, r.w, r.h].map(round2));
    // Read in absolute terms so the claim survives a change of helper: the
    // detected block was 20 wide and 140 tall, and the box is the other way up.
    expect(b.w).toBeGreaterThan(150);
    expect(b.h).toBeLessThan(110);
    expect(b.w).toBeGreaterThan(b.h);
  });

  // The transpose is for the case where nothing better is known. When a balloon
  // was fitted, its inscribed rect already says how wide the room is, and
  // swapping the sides of that would be a heuristic overruling a measurement.
  it('does not also transpose a vertical block it managed to fit', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const fitted = page().boxes[0];

    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = null;
    placeActiveAt(250, 250);
    const transposed = page().boxes[0];

    // Both are wide, and they are wide for different reasons and by different
    // amounts: one is the balloon, the other is the block stood on its side.
    expect(transposed.w).toBeGreaterThan(transposed.h);
    expect(round2(fitted.w)).not.toBe(round2(transposed.w));
  });

  it('recovers a narration panel as a rectangle', () => {
    const img = pageImage(400, 300);
    drawBox(img, 60, 60, 260, 120);
    drawGlyphColumn(img, 180, 80, 20, 80);
    loadProjectPages(withDetect([180, 80, 200, 160], true, 400, 300));
    pixels = img;
    placeActiveAt(190, 120);
    const b = page().boxes[0];
    expect(b.fit.kind).toBe('rect');
    expect(Object.keys(b.fit).sort()).toEqual(['h', 'kind', 'w', 'x', 'y']);
    expect(b.fit.w).toBeCloseTo(260, -1);
  });

  // Off the page is recoverable by dragging; a box that hangs off it because the
  // arithmetic never looked is not.
  it('clamps a fitted box onto the page like every other placement', () => {
    const g = fittedRect({ w: 300, h: 300 }, { kind: 'rect', x: 200, y: 200, w: 200, h: 200 });
    expect(g.x + g.w).toBeLessThanOrEqual(300);
    expect(g.y + g.h).toBeLessThanOrEqual(300);
    // And a page nobody has measured is not clamped against at all — the same
    // rule `placementRect` follows, for the same reason.
    const un = fittedRect({ w: 0, h: 0 }, { kind: 'rect', x: 200, y: 200, w: 200, h: 200 });
    expect(un.x).toBeGreaterThan(190);
  });
});

// ---------------------------------------------------------------------------
describe('placement, when there is no fit to be had', () => {
  // Every one of these has to produce EXACTLY what the app produced before
  // fitting existed. `balloon.js` refuses bad fits on purpose, so this is not a
  // rare path — it is the path a thought cloud, an SFX burst and every
  // un-decoded page take.
  const expectFallback = (block, vertical) => {
    const b = page().boxes[0];
    expect(b.fit).toBe(null);
    const want = placementRect(
      page(),
      vertical ? transposeRect(block) : block,
      0,
      0,
    );
    expect([b.x, b.y, b.w, b.h]).toEqual([want.x, want.y, want.w, want.h]);
  };

  it('falls back on an irregular fit', () => {
    const img = pageImage(400, 400);
    drawBurst(img, 200, 200, 120);
    loadProjectPages(withDetect([170, 170, 230, 230], false, 400, 400));
    pixels = img;
    placeActiveAt(200, 200);
    expectFallback([170, 170, 230, 230], false);
  });

  // The fill runs out through the gap in an open outline and measures the paper
  // around the bubble instead. It very often fits a beautiful rectangle, which
  // is exactly why it is refused before anything is fitted.
  it('falls back when the fill escapes its window', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 90, 60);
    fillRect(img, 330, 240, 24, 24, PAPER); // punch the outline open
    loadProjectPages(withDetect([220, 220, 280, 280], false));
    pixels = img;
    placeActiveAt(250, 250);
    expectFallback([220, 220, 280, 280], false);
  });

  it('falls back when the page has not been decoded', () => {
    loadProjectPages(withDetect([170, 170, 230, 230], false, 400, 400));
    pixels = null;
    placeActiveAt(200, 200);
    expectFallback([170, 170, 230, 230], false);
  });

  // A tall narrow column of Japanese wants the opposite rectangle in English,
  // and with no balloon to measure, the block's own aspect stood on its head is
  // the best guess available.
  it('transposes a vertical block about its centre', () => {
    loadProjectPages(withDetect([220, 100, 280, 400], true));
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(b.fit).toBe(null);
    // 60x300 about (250,250) becomes 300x60: inset 5 a side, so 290x50 at
    // (105,225). Written out rather than derived, because the whole point is
    // that the box is now wider than it is tall.
    expect([b.x, b.y, b.w, b.h]).toEqual([105, 225, 290, 50]);
    expect(b.w).toBeGreaterThan(b.h);
  });

  it('leaves a horizontal block exactly as it was placed before', () => {
    loadProjectPages(withDetect([220, 100, 280, 400], false));
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect([b.x, b.y, b.w, b.h]).toEqual([225, 105, 50, 290]);
  });

  it('transposes about the centre and nothing else', () => {
    expect(transposeRect([100, 200, 300, 800])).toEqual([-100, 400, 500, 600]);
    // A rect that is already square is its own transpose, and a non-rect is
    // handed back untouched rather than turned into NaNs.
    expect(transposeRect([0, 0, 10, 10])).toEqual([0, 0, 10, 10]);
    expect(transposeRect(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('balloonWidthsFor — the one helper the three layout sites share', () => {
  const boxWith = (fit, style = {}) => ({
    id: 'b1',
    lineN: null,
    text: 'X',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', ...style }),
    fit,
  });
  const ell = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };

  it('answers null for a box with no fit, so that path cannot change', () => {
    const b = boxWith(null);
    expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
  });

  it('answers null for a fit the schema does not recognise', () => {
    for (const bad of [
      { kind: 'blob', x: 1, y: 2, w: 3, h: 4 },
      { kind: 'ellipse', cx: 1, cy: 2, rx: Number.NaN, ry: 4 },
      { kind: 'ellipse', cx: 1, cy: 2, rx: 0, ry: 4 },
      { kind: 'rect', x: 1, y: 2, w: 3 },
      'ellipse',
      42,
    ]) {
      const b = boxWith(bad);
      expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
    }
  });

  it('answers null when the style has balloon layout switched off', () => {
    const b = boxWith(ell, { balloon: false });
    expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
  });

  // A rectangle has the same room on every line, which is precisely the flat
  // number the breaker has always been given — so a narration box goes through
  // the fitted path and comes out where it started.
  it('is a constant width inside a rectangle', () => {
    const b = boxWith({ kind: 'rect', x: 0, y: 0, w: 120, h: 400 });
    const w = balloonWidthsFor(b, b.style, b.style.size)(4);
    expect(w.length).toBe(4);
    expect(new Set(w).size).toBe(1);
    // 120 wide, inset 10 a side by `safetyInset` (8% of the shorter side, which
    // is the 120), then BOX_PAD off each edge because the text is drawn inside a
    // box that pads itself.
    expect(w[0]).toBe(120 - 2 * 10 - 2 * BOX_PAD);
  });

  it('narrows the first and last lines inside an ellipse', () => {
    const b = boxWith(ell);
    const w = balloonWidthsFor(b, b.style, b.style.size)(5);
    expect(w.length).toBe(5);
    expect(w[0]).toBeLessThan(w[2]);
    expect(w[4]).toBeLessThan(w[2]);
    // Symmetric about the middle for a middle-aligned block, because the
    // ellipse is.
    expect(round2(w[0])).toBe(round2(w[4]));
    for (const v of w) expect(v).toBeGreaterThan(0);
  });

  // The box is placed at the balloon's INSCRIBED rectangle, so the interior
  // across the middle of the same ellipse is wider than the box. Uncapped, the
  // middle lines would be laid out past the rectangle the user drags.
  it('never hands back more room than the box itself has', () => {
    const b = boxWith(ell);
    const contentW = b.w - BOX_PAD * 2;
    for (const v of balloonWidthsFor(b, b.style, b.style.size)(6)) {
      expect(v).toBeLessThanOrEqual(contentW);
    }
  });

  it('follows the block up and down with valign', () => {
    const top = boxWith(ell, { valign: 'top' });
    const bottom = boxWith(ell, { valign: 'bottom' });
    const t = balloonWidthsFor(top, top.style, top.style.size)(3);
    const bo = balloonWidthsFor(bottom, bottom.style, bottom.style.size)(3);
    // Top-anchored, the block starts at the crown, so the first line is the
    // pinched one; bottom-anchored it is the last. Reversing one gives the
    // other.
    expect(t.map(round2)).toEqual([...bo].reverse().map(round2));
  });

  // The point of the whole exercise: the widths reach the breaker and change
  // where the lines land.
  it('changes the breaking of a real block', () => {
    const b = boxWith(ell);
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US';
    const flat = layoutLines(text, b.style, b.style.size, b.w - BOX_PAD * 2);
    const shaped = layoutLines(
      text,
      b.style,
      b.style.size,
      b.w - BOX_PAD * 2,
      balloonWidthsFor(b, b.style, b.style.size),
    );
    expect(shaped).not.toEqual(flat);
    expect(shaped.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
describe('the PSD’s type layer breaks where the canvas does', () => {
  // `textLayerFor` writes the app's own line breaks into the type layer as hard
  // returns, so that a re-render in Photoshop cannot re-wrap the block greedily
  // and undo the shaping. If it asked `layoutLines` without the balloon, those
  // returns would be a different set of breaks from the pixels beneath them.
  it('writes the balloon’s breaking into the editable layer', async () => {
    const { textLayerFor } = await import('./psd.js');
    const box = {
      lineN: null,
      text: 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US',
      x: 100,
      y: 100,
      w: 200,
      h: 160,
      style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', outlineWidth: 0 }),
      fit: { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 },
    };
    const p = { id: 1, w: 500, h: 500, lines: [], boxes: [box] };
    const layer = textLayerFor(p, box, null);
    const want = layoutLines(
      box.text,
      box.style,
      box.style.size,
      box.w - BOX_PAD * 2,
      balloonWidthsFor(box, box.style, box.style.size),
    );
    const flat = layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2);
    expect(layer.text.text).toBe(want.join('\n'));
    expect(layer.text.text).not.toBe(flat.join('\n'));
  });
});

// ---------------------------------------------------------------------------
describe('the fit survives a save and a round trip', () => {
  const docWith = (fit) => [
    {
      id: 1,
      w: 500,
      h: 500,
      lines: [],
      boxes: [{ id: 'b1', lineN: null, text: 'X', x: 1, y: 2, w: 30, h: 10, style: {}, fit }],
    },
  ];
  const good = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };

  it('comes back off disk as it went on', () => {
    loadProjectPages(docWith(good));
    expect(page().boxes[0].fit).toEqual(good);
  });

  // A field that arrives from a future schema, a hand edit or a corrupted file
  // has to degrade to "this box has no fit" — which is a state every layout path
  // already handles, because it is what every box had before fitting existed.
  it('degrades a malformed or unknown fit to none, rather than throwing', () => {
    for (const bad of [{ kind: 'hexagon', a: 1 }, { kind: 'rect', x: 0, y: 0, w: 0, h: 5 }, 'oval', 7, undefined]) {
      loadProjectPages(docWith(bad));
      expect(page().boxes[0].fit).toBe(null);
    }
  });

  it('is written into the PSD’s embedded project and rebuilt from it', () => {
    const p = {
      id: 3,
      w: 500,
      h: 500,
      lines: [],
      boxes: [{ lineN: null, text: 'X', x: 1, y: 2, w: 3, h: 4, style: {}, fit: good }],
    };
    const out = serializePage(p);
    expect(out.boxes[0].fit).toEqual(good);
    // The round trip `psdSelfTest` pins: reconstruct (a spread of the stored
    // box) and re-serialize, and the two JSONs must be the same string.
    const rebuilt = { ...p, boxes: out.boxes.map((b) => ({ ...b, style: { ...b.style } })) };
    expect(JSON.stringify(serializePage(rebuilt))).toBe(JSON.stringify(out));
  });

  it('writes a null rather than a shape this build cannot lay out to', () => {
    const out = serializePage({
      id: 3,
      w: 8,
      h: 8,
      lines: [],
      boxes: [{ lineN: null, text: '', x: 0, y: 0, w: 1, h: 1, style: {}, fit: { kind: 'hexagon' } }],
    });
    expect(out.boxes[0].fit).toBe(null);
  });

  // A cleaned raster arriving at another resolution rescales every box on the
  // page. The balloon is page geometry too, and a fit left in the old
  // coordinate space would lay text out to a curve that has moved.
  it('is rescaled with the page when the art underneath it changes size', () => {
    loadProjectPages(docWith(good));
    setPageDims(page(), 1000, 500);
    expect(page().boxes[0].fit).toEqual({ kind: 'ellipse', cx: 500, cy: 250, rx: 260, ry: 80 });
  });

  it('normalizes a fit to plain finite numbers or nothing', () => {
    expect(normalizeFit(good)).toEqual(good);
    expect(normalizeFit({ ...good, rx: '130' })).toBe(null);
    expect(normalizeFit(null)).toBe(null);
    // A fresh object, so a caller cannot write through it into the document.
    expect(normalizeFit(good)).not.toBe(good);
  });
});

// ---------------------------------------------------------------------------
describe('the two new style knobs', () => {
  it('are on by default and reachable by a bulk edit', () => {
    expect(defaultStyle().hyphenate).toBe(true);
    expect(defaultStyle().balloon).toBe(true);
    expect(BULK_PROPS).toContain('hyphenate');
    expect(BULK_PROPS).toContain('balloon');
  });

  // A style saved before either knob existed has no such key, and the default
  // has to stand — `hyphenate: undefined` handed to `balanceLines` would turn
  // the feature off rather than leave it alone.
  it('survive a style that predates them', () => {
    const s = normalizeStyle({ size: 20 });
    expect(s.hyphenate).toBe(true);
    expect(s.balloon).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('re-fitting by hand', () => {
  it('measures the balloon under where the box is NOW', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    loadProjectPages([
      {
        id: 1,
        w: 500,
        h: 500,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'X', x: 220, y: 230, w: 60, h: 40, style: {}, fit: null }],
      },
    ]);
    pixels = img;
    expect(refitBalloon('b1')).toBe(true);
    const b = page().boxes[0];
    expect(b.fit.kind).toBe('ellipse');
    expect(b.fit.rx).toBeGreaterThan(120);
  });

  // A stale fit is worse than none: the text would be laid out to a curve that
  // is no longer under the box.
  it('clears a fit when the box has been dragged off its balloon', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    loadProjectPages([
      {
        id: 1,
        w: 500,
        h: 500,
        lines: [],
        boxes: [
          {
            id: 'b1',
            lineN: null,
            text: 'X',
            x: 5,
            y: 5,
            w: 60,
            h: 40,
            style: {},
            fit: { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 },
          },
        ],
      },
    ]);
    pixels = img;
    expect(refitBalloon('b1')).toBe(false);
    expect(page().boxes[0].fit).toBe(null);
  });

  it('is a no-op on a box that is not there', () => {
    loadProjectPages([{ id: 1, w: 500, h: 500, lines: [], boxes: [] }]);
    expect(refitBalloon('nope')).toBe(false);
  });
});
