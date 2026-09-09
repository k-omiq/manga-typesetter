import { describe, it, expect } from 'vitest';
import {
  strokeBands,
  strokeExtent,
  gradientCss,
  gradientEndpoints,
  radialEndpoints,
  patternTilePx,
  drawPatternTile,
  fillKind,
  rgba,
  stopColor,
  sampleStops,
  noiseFor,
  turbulenceChannel,
  roughenOffset,
  roughenPixels,
} from './text-paint.js';
import { PATTERN_KINDS } from './data.js';

// The arithmetic the editor's CSS layers and the exporter's canvas calls share.
// It is worth its own file because both renderers are hard to see into - one is
// a DOM stack, the other a canvas stub - and everything that can actually be
// wrong about a stroke or a gradient is a number computed here.

describe('strokeBands', () => {
  it('paints outermost first, each at twice its own outer edge', () => {
    // 3px of white against the glyph, 2px of black around that: the black band
    // reaches 5px out, so it is drawn 10 wide and the white one 6 over the top
    // of it, leaving 3 of white and 2 of black showing.
    const bands = strokeBands([
      { color: '#ffffff', width: 3, opacity: 1 },
      { color: '#000000', width: 2, opacity: 0.5 },
    ]);
    expect(bands.map((b) => [b.color, b.line, b.opacity])).toEqual([
      ['#000000', 10, 0.5],
      ['#ffffff', 6, 1],
    ]);
  });

  it('answers nothing for an empty list, a missing one, or zero widths', () => {
    expect(strokeBands([])).toEqual([]);
    expect(strokeBands(undefined)).toEqual([]);
    expect(strokeBands([{ color: '#fff', width: 0, opacity: 1 }])).toEqual([]);
  });

  it('reports how far the ink reaches as the sum of the visible widths', () => {
    expect(strokeExtent([{ width: 3 }, { width: 2 }])).toBe(5);
    expect(strokeExtent([])).toBe(0);
  });
});

describe('gradientEndpoints', () => {
  // CSS degrees: 0 points up, and the gradient travels the way the angle points.
  const at = (angle) => gradientEndpoints(angle, 0, 0, 100, 50);

  it('runs top to bottom at 180 and bottom to top at 0', () => {
    const down = at(180);
    expect(down.y0).toBeLessThan(down.y1);
    expect(down.x0).toBeCloseTo(down.x1, 6);
    const up = at(0);
    expect(up.y0).toBeGreaterThan(up.y1);
  });

  it('runs left to right at 90', () => {
    const across = at(90);
    expect(across.x0).toBeLessThan(across.x1);
    expect(across.y0).toBeCloseTo(across.y1, 6);
    // The line covers the rect it is measured against, no more.
    expect(across.x1 - across.x0).toBeCloseTo(100, 6);
  });

  it('is centred on the rect it is given', () => {
    const g = gradientEndpoints(180, 10, 20, 100, 50);
    expect((g.x0 + g.x1) / 2).toBeCloseTo(60, 6);
    expect((g.y0 + g.y1) / 2).toBeCloseTo(45, 6);
  });
});

describe('the fill the style asks for', () => {
  const style = (o) => ({ gradient: { on: false }, pattern: { on: false }, ...o });

  it('is solid unless one of the two is on, and pattern wins over gradient', () => {
    expect(fillKind(style())).toBe('solid');
    expect(fillKind(style({ gradient: { on: true } }))).toBe('gradient');
    expect(fillKind(style({ pattern: { on: true } }))).toBe('pattern');
    expect(fillKind(style({ gradient: { on: true }, pattern: { on: true } }))).toBe('pattern');
  });

  it('states a gradient in CSS degrees, as the style stores them', () => {
    expect(
      gradientCss({ angle: 180, stops: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 0.5 }] }),
    ).toBe('linear-gradient(180deg, #fff 0%, #000 50%)');
  });

  // A gradient may carry up to eight stops and each of them its own alpha. The
  // hex spelling is kept for an opaque stop rather than writing every stop as an
  // rgba(): it is the common case, it is what the style stores, and a CSS
  // gradient that reads as its own hex codes is worth keeping readable.
  it('writes a multi-stop ramp in order, with alpha only where there is any', () => {
    expect(
      gradientCss({
        angle: 45,
        stops: [
          { color: '#ff0000', pos: 0, opacity: 1 },
          { color: '#00ff00', pos: 0.25, opacity: 0.5 },
          { color: '#0000ff', pos: 1, opacity: 0 },
        ],
      }),
    ).toBe('linear-gradient(45deg, #ff0000 0%, rgba(0,255,0,0.5) 25%, rgba(0,0,255,0) 100%)');
  });

  it('reads a stop with no opacity at all as opaque, which is what it was painting', () => {
    expect(stopColor({ color: '#abcdef', pos: 0 })).toBe('#abcdef');
    expect(stopColor({ color: '#abcdef', pos: 0, opacity: 1 })).toBe('#abcdef');
    expect(stopColor({ color: '#abc', pos: 0, opacity: 0.4 })).toBe('rgba(170,187,204,0.4)');
  });

  it('samples the ramp between two stops, colour and alpha together', () => {
    const stops = [
      { color: '#000000', pos: 0, opacity: 0 },
      { color: '#ffffff', pos: 1, opacity: 1 },
    ];
    expect(sampleStops(stops, 0.5)).toEqual({ color: '#808080', opacity: 0.5 });
    // Outside the ends the ramp is flat, as it is in both renderers.
    expect(sampleStops(stops, -1)).toEqual({ color: '#000000', opacity: 0 });
    expect(sampleStops(stops, 2)).toEqual({ color: '#ffffff', opacity: 1 });
  });

  it('samples the pair either side of the point, whatever order the list is in', () => {
    const stops = [
      { color: '#ffffff', pos: 1, opacity: 1 },
      { color: '#ff0000', pos: 0.5, opacity: 1 },
      { color: '#000000', pos: 0, opacity: 1 },
    ];
    expect(sampleStops(stops, 0.25).color).toBe('#800000');
    expect(sampleStops(stops, 0.75).color).toBe('#ff8080');
    // No stops at all is a fill with no colours in it; the caller gets black
    // rather than a NaN it would then write into the style.
    expect(sampleStops([], 0.5)).toEqual({ color: '#000000', opacity: 1 });
  });

  it('scales a pattern tile with the font, never to nothing', () => {
    expect(patternTilePx({ size: 100, pattern: { scale: 1 } })).toBe(30);
    expect(patternTilePx({ size: 100, pattern: { scale: 2 } })).toBe(60);
    expect(patternTilePx({ size: 0, pattern: { scale: 1 } })).toBe(2);
  });
});

describe('rgba', () => {
  it('expands a three-digit hex and carries the alpha through', () => {
    expect(rgba('#fff', 0.5)).toBe('rgba(255,255,255,0.5)');
    expect(rgba('#102030', 1)).toBe('rgba(16,32,48,1)');
  });
});

// Roughening is the one effect the editor does not compute at all - it hands the
// text to an SVG filter and the browser does it - so the export has to be the
// same filter written out longhand, and this is where that is checked. The bug
// it is here to keep out was visible from across the room: the export used a
// pair of sines in place of feTurbulence, at a frequency of `detail * 40 + 0.4`,
// which at the default detail is 2.4 cycles per PIXEL. Every pixel took its
// colour from somewhere up to six pixels away and independently of its
// neighbours, so exported text arrived as a cloud of soot while the canvas
// showed clean rough edges. Everything below is a way of saying "this is a
// smooth field, sampled at the scale the user asked for".
describe('roughening noise', () => {
  const R = { on: true, amount: 4, detail: 0.05, seed: 7 };
  const grid = (fn) => {
    let worst = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) worst = Math.max(worst, fn(x, y));
    return worst;
  };

  it('is a continuous field, not per-pixel scatter', () => {
    // The whole bug in one number. Neighbouring pixels have to be displaced by
    // very nearly the same amount, or the glyph is not roughened but shredded:
    // at the default detail one noise cycle is 20px across, so a single pixel
    // step is a twentieth of it. The old sine pair moved by up to 9.4px from one
    // pixel to the next - further than the entire displacement it was asked for.
    const step = grid((x, y) => {
      const [dx, dy] = roughenOffset(R, x, y);
      const [ex, ey] = roughenOffset(R, x + 1, y);
      const [sx, sy] = roughenOffset(R, x, y + 1);
      return Math.max(Math.abs(dx - ex), Math.abs(dy - ey), Math.abs(dx - sx), Math.abs(dy - sy));
    });
    expect(step).toBeLessThan(0.5);
  });

  it('keeps the displacement inside the amount the style asked for', () => {
    // feDisplacementMap displaces by scale * (channel - 0.5), and a channel is
    // 0..1 - so `amount` is the full span and nothing moves further than half of
    // it either way. The old noise reached 1.5x `amount`.
    const far = grid((x, y) => Math.max(...roughenOffset(R, x, y).map(Math.abs)));
    expect(far).toBeLessThanOrEqual(R.amount / 2);
    // ...and it does move: an `amount` that reaches nothing is not roughening.
    expect(far).toBeGreaterThan(1);
  });

  it('scales the displacement with `amount` and the wavelength with `detail`', () => {
    const twice = grid((x, y) => Math.max(...roughenOffset({ ...R, amount: 8 }, x, y).map(Math.abs)));
    const once = grid((x, y) => Math.max(...roughenOffset(R, x, y).map(Math.abs)));
    expect(twice).toBeCloseTo(once * 2, 6);
    // Twice the detail is half the wavelength, so a step of one pixel crosses
    // twice as much of the field.
    const coarse = grid((x, y) => {
      const [dx] = roughenOffset(R, x, y);
      const [ex] = roughenOffset(R, x + 1, y);
      return Math.abs(dx - ex);
    });
    const fine = grid((x, y) => {
      const [dx] = roughenOffset({ ...R, detail: 0.2 }, x, y);
      const [ex] = roughenOffset({ ...R, detail: 0.2 }, x + 1, y);
      return Math.abs(dx - ex);
    });
    expect(fine).toBeGreaterThan(coarse * 2);
  });

  it('is a fractalNoise channel: 0..1, centred on a half', () => {
    const nz = noiseFor(7);
    let min = 1,
      max = 0,
      sum = 0,
      n = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const c = turbulenceChannel(nz, 0, x, y, 0.05);
        min = Math.min(min, c);
        max = Math.max(max, c);
        sum += c;
        n++;
      }
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(sum / n).toBeCloseTo(0.5, 1);
  });

  it('is the same field every time for a seed, and a different one for another', () => {
    expect(roughenOffset(R, 12, 7)).toEqual(roughenOffset(R, 12, 7));
    expect(roughenOffset({ ...R, seed: 8 }, 12, 7)).not.toEqual(roughenOffset(R, 12, 7));
    // The two channels are the two displacement axes, and they are different
    // draws off the same lattice - one field used twice would push every pixel
    // along the diagonal.
    const [dx, dy] = roughenOffset(R, 12, 7);
    expect(dx).not.toBeCloseTo(dy, 6);
  });
});

// The exporter's half: the field above, applied to a raster.
describe('roughenPixels', () => {
  const R = { on: true, amount: 4, detail: 0.05, seed: 7 };
  // A block of solid ink in the middle of a transparent field, as ImageData.
  const block = (w, h, inset) => {
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = inset; y < h - inset; y++) {
      for (let x = inset; x < w - inset; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = 255;
        img.data[i + 3] = 255;
      }
    }
    return img;
  };
  const blank = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const inked = (img) => {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 0) n++;
    return n;
  };

  it('moves the edge without eating the shape', () => {
    const src = block(80, 80, 20);
    const out = roughenPixels(src, blank(80, 80), R);
    // A displacement neither creates nor destroys much ink - it pushes the
    // boundary of a 40x40 block about by half of `amount`, which is a couple of
    // percent of its area. The old noise scattered the block into speckle and
    // lost a third of it.
    expect(inked(out) / inked(src)).toBeGreaterThan(0.9);
    expect(inked(out) / inked(src)).toBeLessThan(1.1);
    // But it does move: an untouched raster would come back identical.
    expect(out.data).not.toEqual(src.data);
  });

  it('leaves the raster alone when there is nothing to displace by', () => {
    const src = block(40, 40, 10);
    const out = roughenPixels(src, blank(40, 40), { ...R, amount: 0 });
    expect(out.data).toEqual(src.data);
  });

  it('displaces in device pixels while `amount` stays in page pixels', () => {
    // The same box rendered at 1x and at 2x has to come out the same picture,
    // which means the supersampled raster moves twice as many of its own pixels.
    // Read off the ink at the same page position in both.
    const one = roughenPixels(block(60, 60, 15), blank(60, 60), R, { ss: 1 });
    const two = roughenPixels(block(120, 120, 30), blank(120, 120), R, { ss: 2 });
    let same = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const a = one.data[(y * 60 + x) * 4 + 3] !== 0;
        // The 2x raster's pixel for the same page point.
        const b = two.data[(2 * y * 120 + 2 * x) * 4 + 3] !== 0;
        if (a === b) same++;
      }
    }
    // Not identical - the finer raster resolves the same edge more exactly - but
    // the same shape. A displacement stated in the wrong space would put the 2x
    // edge half as far out and disagree along the whole boundary.
    expect(same / 3600).toBeGreaterThan(0.97);
  });

  it('anchors the field at the origin it is given', () => {
    // The origin is where the editor hangs the filter, and moving it slides the
    // whole pattern across the letters - so it has to be stated, and it has to
    // matter.
    const a = roughenPixels(block(60, 60, 15), blank(60, 60), R, { originX: 0, originY: 0 });
    const b = roughenPixels(block(60, 60, 15), blank(60, 60), R, { originX: 9, originY: 4 });
    expect(a.data).not.toEqual(b.data);
  });
});

// A radial gradient has to mean the same thing twice: `farthest-corner` in the
// editor's CSS and a circle of that radius on the exporter's canvas. The two
// tests below are the two halves of that agreement.
describe('radial gradients', () => {
  const g = (o) => ({ kind: 'radial', cx: 0.5, cy: 0.5, radius: 1, stops: [], ...o });

  it('ends at the far corner of the rect it is measured against', () => {
    const c = radialEndpoints(g(), 0, 0, 80, 60);
    expect(c.cx).toBeCloseTo(40, 6);
    expect(c.cy).toBeCloseTo(30, 6);
    // Half of 80x60 is 40x30, and the corner is 50 away.
    expect(c.r).toBeCloseTo(50, 6);
  });

  it('measures the corner from wherever the centre was put, and scales by radius', () => {
    const corner = radialEndpoints(g({ cx: 0, cy: 0 }), 0, 0, 80, 60);
    expect(corner.r).toBeCloseTo(100, 6);
    const half = radialEndpoints(g({ cx: 0, cy: 0, radius: 0.5 }), 0, 0, 80, 60);
    expect(half.r).toBeCloseTo(50, 6);
  });

  it('carries the radius in the CSS stop positions, which is the same circle', () => {
    // The canvas circle ends at 2x the far corner, so a stop at 50% of it sits
    // at 100% of what CSS calls farthest-corner.
    expect(
      gradientCss(g({ radius: 2, cx: 0.5, cy: 0, stops: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 0.5 }] })),
    ).toBe('radial-gradient(circle farthest-corner at 50% 0%, #fff 0%, #000 100%)');
  });

  it('leaves a linear gradient alone', () => {
    expect(gradientCss({ angle: 90, stops: [{ color: '#fff', pos: 1 }] })).toBe(
      'linear-gradient(90deg, #fff 100%)',
    );
  });
});

// Every tile kind has to paint something, and the diagonal ones have to repeat
// at the one period that makes the tile seamless. A stub context is enough for
// both: what is asserted is which calls were made, not what they looked like.
describe('pattern tiles', () => {
  function stub() {
    const ops = [];
    return {
      ops,
      fillStyle: '',
      beginPath() {},
      arc(...a) {
        ops.push(['arc', this.fillStyle, ...a]);
      },
      fill() {},
      fillRect(...a) {
        ops.push(['fillRect', this.fillStyle, ...a]);
      },
      rect() {},
      clip() {},
      save() {},
      restore() {},
      translate() {},
      rotate() {},
    };
  }

  it('paints foreground for every kind the picker offers', () => {
    for (const kind of PATTERN_KINDS) {
      const ctx = stub();
      drawPatternTile(ctx, { kind, fg: '#111111', bg: '#eeeeee' }, 20);
      const fg = ctx.ops.filter((o) => o[1] === '#111111');
      expect(fg.length, `${kind} painted nothing`).toBeGreaterThan(0);
    }
  });

  it('fills the whole tile with the background first', () => {
    const ctx = stub();
    drawPatternTile(ctx, { kind: 'dots', fg: '#000000', bg: '#ffffff' }, 20);
    expect(ctx.ops[0]).toEqual(['fillRect', '#ffffff', 0, 0, 20, 20]);
  });

  it('repeats 45° bands at tile/sqrt(2), the period that makes them seamless', () => {
    const ctx = stub();
    drawPatternTile(ctx, { kind: 'diagonal', fg: '#000000', bg: '#ffffff' }, 20);
    // Every band but the background fill, by its offset along the rotated axis.
    const ys = ctx.ops.slice(1).map((o) => o[3]);
    expect(ys.length).toBeGreaterThan(2);
    const step = ys[1] - ys[0];
    expect(step).toBeCloseTo(20 / Math.SQRT2, 6);
    for (let i = 2; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(step, 6);
  });

  it('crosses two sets of bands for crosshatch and one for a diagonal', () => {
    const one = stub();
    drawPatternTile(one, { kind: 'diagonal', fg: '#000000', bg: '#fff' }, 20);
    const two = stub();
    drawPatternTile(two, { kind: 'crosshatch', fg: '#000000', bg: '#fff' }, 20);
    expect(two.ops.length - 1).toBe((one.ops.length - 1) * 2);
  });
});
