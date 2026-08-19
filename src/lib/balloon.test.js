import { describe, it, expect } from 'vitest';
import {
  BALLOON_DEFAULTS,
  detectBalloon,
  fillInterior,
  fitBalloonShape,
  inscribedRect,
  interiorLineWidths,
  interiorProfile,
  interiorThreshold,
  safetyInset,
  shapeBounds,
} from './balloon.js';

// Every page in this file is built by hand as an `ImageData`-shaped object -
// `{ width, height, data }` with a plain `Uint8ClampedArray` - because a canvas
// is exactly what this module is meant not to need. The pixel values are the
// ones a scan actually has: paper near white, ink near black, with nothing in
// between except where a helper deliberately puts it.
const PAPER = 248;
const INK = 18;

function page(w, h, fill = PAPER) {
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

// A balloon: a light interior inside a dark outline. Drawn the way one is
// inked - as a single closed shape - so that a tail is part of the same outline
// rather than a second object laid over the first. Getting that right matters:
// a tail pasted on top leaves the seam between the two open, and the fill pours
// out through it, which says nothing about the module and everything about the
// fixture.
//
//   `bumps` scallops the outline, which is what makes a thought cloud a cloud.
//   `gap`   punches a hole in the outline afterwards - a bubble whose tail was
//           drawn open, or one an inked sound effect runs into.
function drawEllipse(img, cx, cy, rx, ry, { ring = 3, tail = null, gap = null, bumps = 0 } = {}) {
  // The scallop factor is taken at the same angle for the interior and for the
  // outline, so the outline strictly contains the interior at every angle and
  // the shape is closed by construction. Recomputing the angle on the grown
  // ellipse instead leaves pinholes in the valleys of the bumps.
  const radius = (x, y, g) => {
    const k = bumps
      ? 1 + 0.16 * Math.cos(bumps * Math.atan2((y + 0.5 - cy) / ry, (x + 0.5 - cx) / rx))
      : 1;
    return Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g)) / k;
  };
  const inTail = (x, y, g) => {
    if (!tail) return false;
    if (y + 0.5 < tail.y0 || y + 0.5 > tail.tipY + g) return false;
    const t = Math.min(1, (y + 0.5 - tail.y0) / (tail.tipY - tail.y0));
    return Math.abs(x + 0.5 - (tail.bx + (tail.tipX - tail.bx) * t)) <= tail.halfw * (1 - t) + g;
  };
  // The scallops push the outline past the plain ellipse, so the area walked has
  // to grow with them or the shape is drawn clipped - and a clipped outline is
  // an open one.
  const ex = rx * (bumps ? 1.2 : 1) + ring + 2;
  const ey = ry * (bumps ? 1.2 : 1) + ring + 2;
  const yLo = Math.floor(cy - ey);
  const yHi = Math.ceil(Math.max(cy + ey, tail ? tail.tipY + ring + 2 : 0));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = Math.floor(cx - ex); x <= Math.ceil(cx + ex); x++) {
      if (radius(x, y, 0) <= 1 || inTail(x, y, 0)) put(img, x, y, PAPER);
      else if (radius(x, y, ring) <= 1 || inTail(x, y, ring)) put(img, x, y, INK);
    }
  }
  if (gap) fillRect(img, gap.x, gap.y, gap.w, gap.h, PAPER);
}

function drawBox(img, x, y, w, h, { ring = 3 } = {}) {
  fillRect(img, x - ring, y - ring, w + 2 * ring, h + 2 * ring, INK);
  fillRect(img, x, y, w, h, PAPER);
}

// A column of vertical Japanese: solid-ish glyph blocks with the small gaps
// between characters a real column has. The point of it is that the detected
// text block's centre lands on ink, which is what makes the naive seed useless.
function drawGlyphColumn(img, x, y, w, h, { glyph = 22, gapY = 6 } = {}) {
  for (let gy = y; gy + glyph <= y + h; gy += glyph + gapY) {
    fillRect(img, x, gy, w, glyph, INK);
    // A counter - the enclosed white of a 口 - so a seed that wanders into one
    // has somewhere to be trapped.
    fillRect(img, x + 4, gy + 4, Math.max(1, w - 8), Math.max(1, glyph - 8), PAPER);
  }
}

// A jagged SFX burst: a star whose radius swings wildly with the angle, drawn
// scanline by scanline so it is a genuine filled region rather than an outline.
function drawBurst(img, cx, cy, r, spikes = 9) {
  for (let y = cy - r - 4; y <= cy + r + 4; y++) {
    for (let x = cx - r - 4; x <= cx + r + 4; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const rr = r * (0.45 + 0.55 * Math.abs(Math.cos(spikes * Math.atan2(dy, dx))));
      put(img, x, y, d <= rr ? PAPER : INK);
    }
  }
}

// A hand-built profile, straight from the geometry, for the pure half of the
// module. No pixels involved at all.
const ellipseProfile = (y, cx, cy, rx, ry, extra = []) => {
  const rows = [];
  for (let yy = y; yy < cy + ry; yy++) {
    const dy = (yy + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) {
      rows.push(null);
      continue;
    }
    const hw = rx * Math.sqrt(1 - dy * dy);
    rows.push([Math.round(cx - hw), Math.round(cx + hw) - 1]);
  }
  return { y, rows: [...rows, ...extra], holes: 0, escaped: false };
};

// The same sealed balloon the leak test punctures, for the control half of it.
const page500Ellipse = () => {
  const img = page(500, 500);
  drawEllipse(img, 250, 250, 90, 60);
  return img;
};

const rectProfile = (y, x, w, h) => ({
  y,
  rows: Array.from({ length: h }, () => [x, x + w - 1]),
  holes: 0,
  escaped: false,
});

describe('interiorThreshold — the cut comes from the pixels, not from a constant', () => {
  it('lands between the ink and the paper of a bimodal window', () => {
    const hist = new Uint32Array(256);
    hist[INK] = 3000;
    hist[PAPER] = 12000;
    const t = interiorThreshold(hist, 15000);
    expect(t).toBeGreaterThan(INK);
    expect(t).toBeLessThan(PAPER);
  });

  it('follows the page it is given rather than a fixed midpoint', () => {
    // A muddy newsprint scan: "ink" is 90 and "paper" is 190. A hard-coded 128
    // would be wrong for one of these two windows; Otsu is right for both.
    const muddy = new Uint32Array(256);
    muddy[90] = 4000;
    muddy[190] = 9000;
    const crisp = new Uint32Array(256);
    crisp[5] = 4000;
    crisp[250] = 9000;
    expect(interiorThreshold(muddy, 13000)).toBeGreaterThan(90);
    expect(interiorThreshold(muddy, 13000)).toBeLessThan(190);
    expect(interiorThreshold(crisp, 13000)).not.toBe(interiorThreshold(muddy, 13000));
  });

  it('refuses to split paper noise on a window with no ink in it', () => {
    // The failure mode the bounds exist for: with only paper in the histogram
    // the method happily splits it, and an unclamped threshold up at 250 would
    // make most of the balloon read as ink.
    const flat = new Uint32Array(256);
    flat[246] = 5000;
    flat[250] = 5000;
    expect(interiorThreshold(flat, 10000)).toBe(BALLOON_DEFAULTS.maxThreshold);
  });
});

describe('fillInterior — recovering the balloon from the pixels', () => {
  it('fills an oval balloon from a text block sitting on the glyphs', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 110, 70);
    // Vertical Japanese: a tall narrow column dead centre, which is where the
    // naive seed would be and is entirely made of ink.
    drawGlyphColumn(img, 192, 150, 18, 100);
    const region = fillInterior(img, [192, 150, 210, 250]);
    expect(region).not.toBeNull();
    expect(region.escaped).toBe(false);
    // The interior of a 110x70 ellipse is about 24000px. Anything much smaller
    // means the fill was trapped in a glyph counter or a gap between strokes.
    expect(region.count).toBeGreaterThan(20000);
    expect(region.bounds.w).toBeGreaterThan(210);
    expect(region.bounds.h).toBeGreaterThan(130);
  });

  it('folds the glyphs back into the interior instead of profiling around them', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 110, 70);
    drawGlyphColumn(img, 192, 150, 18, 100);
    const rows = interiorProfile(fillInterior(img, [192, 150, 210, 250])).rows;
    // The row through the middle of the column crosses the glyphs. Without the
    // enclosed-hole pass its widest run would be one side of the column - about
    // 100px - rather than the balloon's 220.
    const mid = rows[Math.floor(rows.length / 2)];
    expect(mid[1] - mid[0]).toBeGreaterThan(200);
  });

  it('keeps the search inside a window and reports a fill that got out', () => {
    const img = page(500, 500);
    const block = [220, 220, 280, 280];
    const sealed = fillInterior(page500Ellipse(), block);
    expect(sealed.escaped).toBe(false);
    // The same balloon with a hole punched in its outline - an open tail, or an
    // inked sound effect running into the wall. The fill pours out onto the page.
    drawEllipse(img, 250, 250, 90, 60, { gap: { x: 330, y: 240, w: 24, h: 24 } });
    const leaked = fillInterior(img, block);
    expect(leaked.escaped).toBe(true);
    // Bounded even so: it never looked at more than its window, which for a
    // 60x60 block is a fraction of the 250000-pixel page.
    expect(leaked.w).toBeLessThanOrEqual(320);
    expect(leaked.h).toBeLessThanOrEqual(320);
  });

  it('will not take a pocket inside a glyph for a balloon', () => {
    // The whole page is ink except one 4x4 white pocket at the block's centre -
    // a counter, the enclosed white of a 口. It is bounded, so it would win on
    // "did not escape" alone; it is far smaller than the text it is supposed to
    // contain, so it is not a candidate at all.
    const img = page(200, 200, INK);
    fillRect(img, 98, 98, 4, 4, PAPER);
    expect(fillInterior(img, [80, 80, 120, 120])).toBeNull();
  });

  it('returns null rather than guessing when there is nothing to work with', () => {
    expect(fillInterior(null, [0, 0, 10, 10])).toBeNull();
    expect(fillInterior(page(20, 20), null)).toBeNull();
    expect(fillInterior(page(20, 20), [5, 5])).toBeNull();
    expect(fillInterior(page(20, 20), [30, 30, 40, 40])).toBeNull();
  });

  it('accepts a block whose corners arrive the other way round', () => {
    const img = page(300, 300);
    drawEllipse(img, 150, 150, 80, 50);
    const a = fillInterior(img, [140, 130, 160, 170]);
    const b = fillInterior(img, [160, 170, 140, 130]);
    expect(b.count).toBe(a.count);
  });

  it('treats a transparent pixel as somewhere the fill may not go', () => {
    const img = page(300, 300);
    drawEllipse(img, 150, 150, 80, 50);
    // A transparent band across the balloon: outside the art entirely, so the
    // fill must stop at it rather than spreading through.
    for (let y = 140; y < 160; y++)
      for (let x = 70; x < 230; x++) img.data[(y * 300 + x) * 4 + 3] = 0;
    const region = fillInterior(img, [140, 100, 160, 135]);
    expect(region.bounds.y + region.bounds.h).toBeLessThanOrEqual(141);
  });
});

describe('interiorProfile — one row, one pair of numbers', () => {
  it('reports the widest contiguous run per row in page coordinates', () => {
    const mask = new Uint8Array(10 * 3);
    for (let x = 2; x < 8; x++) mask[x] = 1; // row 0: one run, 2..7
    for (let x = 1; x < 3; x++) mask[10 + x] = 1; // row 1: a short run...
    for (let x = 5; x < 9; x++) mask[10 + x] = 1; // ...and a longer one
    const p = interiorProfile({ x: 100, y: 50, w: 10, h: 3, mask, escaped: false });
    expect(p.y).toBe(50);
    expect(p.rows).toEqual([
      [102, 107],
      [105, 108],
    ]);
  });

  it('does not bridge a gap — a tail is a second run, not extra width', () => {
    const mask = new Uint8Array(20);
    for (let x = 1; x < 6; x++) mask[x] = 1;
    for (let x = 14; x < 18; x++) mask[x] = 1;
    const p = interiorProfile({ x: 0, y: 0, w: 20, h: 1, mask, escaped: false });
    expect(p.rows).toEqual([[1, 5]]);
  });

  it('counts a row with no run as a hole rather than dropping it', () => {
    const mask = new Uint8Array(4 * 3);
    mask[0] = 1;
    mask[8] = 1; // row 2; row 1 is empty and sits between two filled rows
    const p = interiorProfile({ x: 0, y: 10, w: 4, h: 3, mask, escaped: false });
    expect(p.rows.length).toBe(3);
    expect(p.rows[1]).toBeNull();
    expect(p.holes).toBe(1);
  });

  it('trims the empty rows at the ends and reports where the first one starts', () => {
    const mask = new Uint8Array(4 * 4);
    mask[4] = 1;
    mask[8] = 1;
    const p = interiorProfile({ x: 7, y: 30, w: 4, h: 4, mask, escaped: false });
    expect(p.y).toBe(31);
    expect(p.rows.length).toBe(2);
  });

  it('carries the escape flag through untouched', () => {
    const mask = new Uint8Array(4);
    mask[1] = 1;
    expect(interiorProfile({ x: 0, y: 0, w: 4, h: 1, mask, escaped: true }).escaped).toBe(true);
    expect(interiorProfile(null).escaped).toBe(true);
  });
});

describe('fitBalloonShape — what shape is this, and how much of it to believe', () => {
  it('recovers an ellipse from a clean profile', () => {
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.cx).toBeCloseTo(250, 0);
    expect(fit.shape.cy).toBeCloseTo(160, 0);
    expect(fit.shape.rx).toBeCloseTo(90, 0);
    expect(fit.shape.ry).toBeCloseTo(60, 0);
    expect(fit.confidence).toBeGreaterThan(0.9);
  });

  it('recovers a rectangle from a profile of constant width', () => {
    const fit = fitBalloonShape(rectProfile(40, 30, 120, 60));
    expect(fit.kind).toBe('rect');
    expect(fit.shape).toEqual({ kind: 'rect', x: 30, y: 40, w: 120, h: 60 });
    expect(fit.confidence).toBeGreaterThan(0.95);
  });

  it('hands back plain JSON — a handful of numbers, no mask', () => {
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    const round = JSON.parse(JSON.stringify(fit.shape));
    expect(round).toEqual(fit.shape);
    expect(Object.keys(round).sort()).toEqual(['cx', 'cy', 'kind', 'rx', 'ry']);
    for (const k of ['cx', 'cy', 'rx', 'ry']) expect(Number.isFinite(round[k])).toBe(true);
    expect(JSON.stringify(fit.shape).length).toBeLessThan(80);
  });

  it('fits the body of a balloon that has a tail', () => {
    // Twenty rows of a narrow spike hanging off the bottom, which is what a tail
    // is. The extent fit would take the spike for part of the oval and stretch
    // it; the least-squares candidate and the refit on the inliers do not.
    const tail = Array.from({ length: 20 }, (_, i) => [250 + i, 262 + i]);
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60, tail));
    const bare = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    expect(fit.kind).toBe('ellipse');
    // The body, not the body plus the spike: within a pixel of the fit the same
    // balloon gets when the tail is not there at all.
    expect(fit.shape.cy).toBeCloseTo(bare.shape.cy, 0);
    expect(fit.shape.ry).toBeCloseTo(bare.shape.ry, 0);
    expect(fit.shape.rx).toBeCloseTo(bare.shape.rx, 0);
  });

  it('refuses a wide slab hanging off the body, which is not a tail', () => {
    // The other side of the same rule: a narrow spike is a tail and is
    // tolerated, a slab as wide as the balloon means the fitted body was the
    // wrong body - two bubbles joined, or a fill that got into the panel.
    const slab = Array.from({ length: 20 }, () => [180, 320]);
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60, slab));
    expect(fit.kind).toBe('irregular');
  });

  it('refuses a fill that escaped, however well it would have fitted', () => {
    // A perfect rectangle - the shape an escaped fill very often has, because
    // what it found was the panel. Fitting it would be the one failure that
    // stops the caller's fallback from ever firing.
    const p = { ...rectProfile(40, 30, 120, 60), escaped: true };
    expect(fitBalloonShape({ ...p, escaped: false }).kind).toBe('rect');
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
    expect(fit.confidence).toBe(0);
    expect(fit.reason).toBe('escaped');
  });

  it('refuses a region that is not vertically connected', () => {
    const p = rectProfile(0, 0, 50, 40);
    for (const i of [5, 12, 19, 26, 33]) p.rows[i] = null;
    p.holes = 5;
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('holes');
  });

  it('refuses a profile too short to mean anything', () => {
    const fit = fitBalloonShape(rectProfile(0, 0, 50, 4));
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('tiny');
    expect(fitBalloonShape({ y: 0, rows: [], holes: 0, escaped: false }).reason).toBe('empty');
    expect(fitBalloonShape(null).reason).toBe('empty');
  });

  it('calls a jagged profile irregular rather than fitting it anyway', () => {
    const rows = [];
    for (let i = 0; i < 80; i++) {
      const hw = 20 + 55 * Math.abs(Math.cos(i * 1.1));
      rows.push([Math.round(200 - hw), Math.round(200 + hw)]);
    }
    const fit = fitBalloonShape({ y: 0, rows, holes: 0, escaped: false });
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('tolerates a few pixels of raggedness on the edge of a real scan', () => {
    const p = ellipseProfile(100, 250, 160, 90, 60);
    for (let i = 0; i < p.rows.length; i += 3) p.rows[i] = [p.rows[i][0] - 1, p.rows[i][1] + 1];
    expect(fitBalloonShape(p).kind).toBe('ellipse');
  });

  it('does not let the degenerate ellipse claim a rectangle', () => {
    // An ellipse fitted to constant widths has no curvature to recover: the
    // rectangle is tried first precisely so this profile never reaches it.
    const fit = fitBalloonShape(rectProfile(0, 0, 200, 100));
    expect(fit.kind).toBe('rect');
    expect(fit.shape.h).toBe(100);
  });

  it('refits a rectangle on inliers, trimming outlier edge rows from vertical bounds', () => {
    // 15 clean rows of width 100 [50, 149], plus 2 narrow outlier edge rows [76, 123] (width 48, hw 24)
    // Initial fit has 15/17 = 0.882 coverage (< minCoverage 0.90); refit on inliers trims h from 17 to 15,
    // achieving 15/15 = 1.0 coverage and successfully classifying as rect.
    const rows = [
      ...Array.from({ length: 15 }, () => [50, 149]),
      [76, 123],
      [76, 123],
    ];
    const p = { y: 10, rows, holes: 0, escaped: false };
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.y).toBe(10);
    expect(fit.shape.h).toBe(15);
    expect(fit.shape.w).toBe(100);
    expect(fit.shape.x).toBe(50);
  });
});

describe('safetyInset — derived from the shape, bounded at both ends', () => {
  it('is a fraction of the shorter side', () => {
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 400, h: 100 })).toBe(8);
    expect(safetyInset({ kind: 'ellipse', cx: 0, cy: 0, rx: 200, ry: 50 })).toBe(8);
  });

  it('is never invisible and never dominant', () => {
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 20, h: 12 })).toBe(BALLOON_DEFAULTS.insetMin);
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 900, h: 800 })).toBe(BALLOON_DEFAULTS.insetMax);
  });
});

describe('inscribedRect — the largest rectangle the shape can hold', () => {
  it('is a√2 by b√2 for an ellipse', () => {
    const shape = { kind: 'ellipse', cx: 300, cy: 200, rx: 100, ry: 60 };
    const r = inscribedRect(shape, { inset: 0 });
    expect(r.w).toBeCloseTo(100 * Math.SQRT2, 6);
    expect(r.h).toBeCloseTo(60 * Math.SQRT2, 6);
    expect(r.x + r.w / 2).toBeCloseTo(300, 6);
    expect(r.y + r.h / 2).toBeCloseTo(200, 6);
    // 70.7% of the bounding box on each axis, against the ~95% the current
    // 8%-capped-at-14px inset leaves.
    const bb = shapeBounds(shape);
    expect(r.w / bb.w).toBeCloseTo(1 / Math.SQRT2, 6);
  });

  it('puts the corners of that rectangle exactly on the curve', () => {
    const shape = { kind: 'ellipse', cx: 0, cy: 0, rx: 90, ry: 40 };
    const r = inscribedRect(shape, { inset: 0 });
    const cornerX = r.x + r.w;
    const cornerY = r.y + r.h;
    expect((cornerX / 90) ** 2 + (cornerY / 40) ** 2).toBeCloseTo(1, 6);
  });

  it('is the rectangle itself, inset, for a rect', () => {
    const r = inscribedRect({ kind: 'rect', x: 10, y: 20, w: 200, h: 100 });
    const inset = safetyInset({ kind: 'rect', x: 10, y: 20, w: 200, h: 100 });
    expect(r).toEqual({ x: 10 + inset, y: 20 + inset, w: 200 - 2 * inset, h: 100 - 2 * inset });
  });

  it('never returns a negative extent for a shape smaller than its own inset', () => {
    const r = inscribedRect({ kind: 'rect', x: 0, y: 0, w: 4, h: 4 });
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
  });
});

describe('interiorLineWidths — the width each line actually has', () => {
  const ell = { kind: 'ellipse', cx: 200, cy: 150, rx: 120, ry: 80 };

  it('degenerates to today for a rectangle: one width, repeated', () => {
    const rect = { kind: 'rect', x: 40, y: 60, w: 300, h: 120 };
    const inset = safetyInset(rect);
    for (const valign of ['top', 'middle', 'bottom']) {
      expect(interiorLineWidths(rect, 30, 4, valign)).toEqual(new Array(4).fill(300 - 2 * inset));
    }
    // ...and it is the same number for any line count, which is what makes the
    // breaker's search identical to the one it runs today.
    expect(interiorLineWidths(rect, 12, 1)[0]).toBe(300 - 2 * inset);
    expect(interiorLineWidths(rect, 12, 9)[8]).toBe(300 - 2 * inset);
  });

  it('gives the middle lines of an oval more room than the outer ones', () => {
    const w = interiorLineWidths(ell, 30, 5, 'middle');
    expect(w.length).toBe(5);
    expect(w[2]).toBeGreaterThan(w[0]);
    expect(w[2]).toBeGreaterThan(w[4]);
    expect(w[0]).toBeCloseTo(w[4], 6); // a centred block is symmetric
  });

  it('takes the narrowest width across each line band, not the width at its centre', () => {
    // This is the whole point of the band: the top line's capitals live at the
    // top of its band, where the balloon is narrower than it is at the baseline.
    const lh = 40;
    const w = interiorLineWidths(ell, lh, 3, 'middle', { inset: 0 });
    const centreWidth = (y) => 2 * ell.rx * Math.sqrt(Math.max(0, 1 - ((y - ell.cy) / ell.ry) ** 2));
    const topBandCentre = ell.cy - lh; // centre line of the first of three bands
    expect(w[0]).toBeLessThan(centreWidth(topBandCentre));
    // ...and it is exactly the width at the far edge of that band.
    expect(w[0]).toBeCloseTo(centreWidth(ell.cy - 1.5 * lh), 6);
  });

  it('anchors the block by valign', () => {
    const top = interiorLineWidths(ell, 30, 3, 'top');
    const bottom = interiorLineWidths(ell, 30, 3, 'bottom');
    const middle = interiorLineWidths(ell, 30, 3, 'middle');
    // Top-aligned, the first line sits at the very top of the oval and is the
    // narrowest of the three; bottom-aligned it is the mirror image.
    expect(top[0]).toBeLessThan(top[2]);
    expect(bottom[2]).toBeLessThan(bottom[0]);
    expect([...top].reverse()).toEqual(bottom);
    expect(middle[0]).toBeGreaterThan(top[0]);
  });

  it('agrees with the inscribed rectangle at its corners', () => {
    // A block filling the inscribed rectangle exactly: its outermost line's
    // width must be the rectangle's width, or the two halves of this module
    // would be sizing the box and breaking the text to different shapes.
    const r = inscribedRect(ell);
    const widths = interiorLineWidths(ell, r.h / 4, 4, 'middle');
    expect(widths[0]).toBeCloseTo(r.w, 6);
    expect(widths[3]).toBeCloseTo(r.w, 6);
    expect(widths[1]).toBeGreaterThan(r.w);
  });

  it('insets by the safety margin so text never touches the outline', () => {
    // Measured on the centre line (a band of no height), where the inset is the
    // whole of the difference. Off the centre line the curve takes back a little
    // more, which is the safe direction.
    const bare = interiorLineWidths(ell, 0, 1, 'middle', { inset: 0 });
    const safe = interiorLineWidths(ell, 0, 1, 'middle');
    expect(bare[0]).toBeCloseTo(2 * ell.rx, 6);
    expect(bare[0] - safe[0]).toBeCloseTo(2 * safetyInset(ell), 6);
    expect(interiorLineWidths(ell, 30, 3, 'middle')[1]).toBeLessThan(
      interiorLineWidths(ell, 30, 3, 'middle', { inset: 0 })[1]
    );
  });

  it('is pure, cheap and returns a fresh array every time', () => {
    const before = JSON.stringify(ell);
    const a = interiorLineWidths(ell, 22, 6, 'middle');
    const b = interiorLineWidths(ell, 22, 6, 'middle');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(ell)).toBe(before);
    // The line-breaker calls this once per candidate line count inside its own
    // search, so it has to stay this cheap.
    const t0 = Date.now();
    for (let i = 0; i < 20000; i++) interiorLineWidths(ell, 22, 8, 'middle');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('never hands back a width a breaker cannot divide by', () => {
    // A block far taller than the balloon: the honest answer for the outermost
    // lines is "almost nothing", and almost nothing must still be positive.
    const w = interiorLineWidths(ell, 60, 12, 'middle');
    expect(w.length).toBe(12);
    for (const v of w) expect(v).toBeGreaterThan(0);
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
    const rect = { kind: 'rect', x: 40, y: 60, w: 300, h: 120 };
    expect(interiorLineWidths(ell, 30, 0)).toEqual([]);
    expect(interiorLineWidths(ell, 30, undefined)).toEqual([]);
    expect(interiorLineWidths(ell, 30, NaN)).toEqual([]);
    expect(interiorLineWidths(ell, 30, -5)).toEqual([]);
    expect(interiorLineWidths(rect, 30, undefined)).toEqual([]);
    expect(interiorLineWidths(null, 30, 3)).toEqual([]);
  });
});

describe('detectBalloon — the whole pipeline on a synthetic page', () => {
  it('turns a vertical Japanese column into the wide oval around it', () => {
    // The motivating case, end to end. The detected block is 20x150 - tall and
    // narrow, the shape the English emphatically does not want - and the balloon
    // around it is 260x160.
    const img = page(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    const fit = detectBalloon(img, [240, 180, 260, 320]);
    expect(fit.kind).toBe('ellipse');
    expect(fit.escaped).toBe(false);
    expect(fit.shape.cx).toBeCloseTo(250, -1);
    expect(fit.shape.cy).toBeCloseTo(250, -1);
    expect(fit.shape.rx).toBeGreaterThan(120);
    expect(fit.shape.rx).toBeLessThan(140);
    expect(fit.shape.ry).toBeGreaterThan(70);
    expect(fit.shape.ry).toBeLessThan(90);
    // And the box that comes out of it is wide and short where the detected
    // block was narrow and tall.
    const r = inscribedRect(fit.shape);
    expect(r.w).toBeGreaterThan(150);
    expect(r.w).toBeGreaterThan(r.h);
  });

  it('fits the body of a real balloon with a tail, and does not leak down it', () => {
    const withTail = page(600, 600);
    drawEllipse(withTail, 300, 300, 150, 95, {
      tail: { y0: 380, bx: 330, tipX: 390, tipY: 450, halfw: 20 },
    });
    drawGlyphColumn(withTail, 290, 220, 20, 160);
    const plain = page(600, 600);
    drawEllipse(plain, 300, 300, 150, 95);
    drawGlyphColumn(plain, 290, 220, 20, 160);

    const block = [290, 220, 310, 380];
    const region = fillInterior(withTail, block);
    // The tail is part of the balloon, so the fill runs down it - and stops.
    expect(region.escaped).toBe(false);
    expect(region.bounds.h).toBeGreaterThan(200);

    const fit = detectBalloon(withTail, block);
    const bare = detectBalloon(plain, block);
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.rx).toBeCloseTo(bare.shape.rx, 0);
    expect(fit.shape.ry).toBeCloseTo(bare.shape.ry, 0);
    expect(fit.shape.cy).toBeCloseTo(bare.shape.cy, 0);
    expect(fit.confidence).toBeGreaterThan(0.8);
  });

  it('refuses a thought cloud', () => {
    const img = page(600, 600);
    drawEllipse(img, 300, 300, 160, 110, { bumps: 11 });
    const fit = detectBalloon(img, [280, 250, 320, 350]);
    expect(fit.escaped).toBe(false);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('recovers a narration box as a rectangle', () => {
    const img = page(400, 300);
    drawBox(img, 60, 60, 260, 120);
    drawGlyphColumn(img, 180, 80, 20, 80);
    const fit = detectBalloon(img, [180, 80, 200, 160]);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.w).toBeCloseTo(260, -1);
    expect(fit.shape.h).toBeCloseTo(120, -1);
    expect(fit.confidence).toBeGreaterThan(0.8);
  });

  it('refuses a jagged SFX burst', () => {
    const img = page(400, 400);
    drawBurst(img, 200, 200, 120);
    const fit = detectBalloon(img, [170, 170, 230, 230]);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('refuses a balloon whose outline leaks, and says why', () => {
    const img = page(500, 500);
    drawEllipse(img, 250, 250, 90, 60, { gap: { x: 330, y: 240, w: 24, h: 24 } });
    const fit = detectBalloon(img, [220, 220, 280, 280]);
    expect(fit.escaped).toBe(true);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('escaped');
  });

  it('reports rather than throws when there is nothing to fill', () => {
    const fit = detectBalloon(page(10, 10), [50, 50, 60, 60]);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('no-fill');
    expect(fit.shape).toBeNull();
  });
});
