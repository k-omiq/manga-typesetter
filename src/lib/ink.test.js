import { describe, it, expect } from 'vitest';
import { normalizeStyle, normalizeInkStroke } from './data.js';

describe('ink style block', () => {
  it('defaults to off with no strokes', () => {
    expect(normalizeStyle({}).ink).toEqual({ on: false, strokes: [] });
  });

  it('keeps a well-formed stroke and clamps its numbers', () => {
    const s = normalizeStyle({
      ink: {
        on: true,
        strokes: [
          {
            brush: 'round',
            size: 9999,
            color: '#123456',
            opacity: 5,
            spacing: 0,
            hardness: 500,
            angle: 400,
            angleJitter: -3,
            flatness: 0,
            taperIn: { on: true, len: -5, ratio: 200 },
            taperOut: { on: false, len: 20, ratio: 60 },
            seed: 7,
            pts: [[1, 2, 0.5], [3, 4, 1]],
          },
        ],
      },
    });
    expect(s.ink.on).toBe(true);
    expect(s.ink.strokes).toHaveLength(1);
    const k = s.ink.strokes[0];
    expect(k.size).toBe(2000);
    expect(k.opacity).toBe(1);
    expect(k.spacing).toBe(1);
    expect(k.hardness).toBe(100);
    expect(k.angle).toBe(40);
    expect(k.angleJitter).toBe(0);
    expect(k.flatness).toBe(0.01);
    expect(k.taperIn).toEqual({ on: true, len: 0, ratio: 100 });
    expect(k.pts).toEqual([[1, 2, 0.5], [3, 4, 1]]);
  });

  it('drops a stroke with no usable points rather than repairing it', () => {
    expect(normalizeInkStroke({ pts: [] })).toBeNull();
    expect(normalizeInkStroke({ pts: [['a', 'b', 1]] })).toBeNull();
    expect(normalizeInkStroke(null)).toBeNull();
  });

  it('drops only the unreadable points inside an otherwise good stroke', () => {
    const k = normalizeInkStroke({ pts: [[1, 2, 1], [NaN, 4, 1], [5, 6, 1]] });
    expect(k.pts).toEqual([[1, 2, 1], [5, 6, 1]]);
  });

  it('defaults a missing width factor to full width', () => {
    const k = normalizeInkStroke({ pts: [[1, 2]] });
    expect(k.pts).toEqual([[1, 2, 1]]);
  });

  it('keeps anti-aliasing on for a stroke saved before the switch existed', () => {
    expect(normalizeInkStroke({ pts: [[1, 2, 1]] }).antialias).toBe(true);
  });

  it('keeps anti-aliasing off when the stroke was drawn with it off', () => {
    expect(normalizeInkStroke({ antialias: false, pts: [[1, 2, 1]] }).antialias).toBe(false);
  });

  it('reads anything but a literal false as anti-aliased', () => {
    expect(normalizeInkStroke({ antialias: 'no', pts: [[1, 2, 1]] }).antialias).toBe(true);
    expect(normalizeInkStroke({ antialias: 0, pts: [[1, 2, 1]] }).antialias).toBe(true);
  });

  it('leaves a project saved before ink existed untouched apart from the default', () => {
    const before = normalizeStyle({ size: 30, clip: { on: true, shapes: [] } });
    expect(before.ink).toEqual({ on: false, strokes: [] });
    expect(before.size).toBe(30);
  });
});

import { inkActive, inkExtent } from './text-paint.js';

describe('inkActive', () => {
  it('is false when off, and false when on with nothing drawn', () => {
    expect(inkActive({ on: false, strokes: [{}] })).toBe(false);
    expect(inkActive({ on: true, strokes: [] })).toBe(false);
    expect(inkActive(undefined)).toBe(false);
  });

  it('is true when on with at least one stroke', () => {
    expect(inkActive({ on: true, strokes: [{}] })).toBe(true);
  });
});

describe('inkExtent', () => {
  it('is zero for inactive ink', () => {
    expect(inkExtent({ on: false, strokes: [] })).toBe(0);
  });

  it('reports how far the stamp radius reaches past the box origin', () => {
    const ink = normalizeStyle({
      ink: { on: true, strokes: [{ size: 40, pts: [[0, 0, 1], [10, 0, 1]] }] },
    }).ink;
    // A 40 px tip centred on x = 0 reaches 20 px to the left of the origin.
    expect(inkExtent(ink)).toBe(20);
  });

  it('takes the furthest of several strokes', () => {
    const ink = normalizeStyle({
      ink: {
        on: true,
        strokes: [
          { size: 10, pts: [[0, 0, 1]] },
          { size: 200, pts: [[0, 0, 1]] },
        ],
      },
    }).ink;
    expect(inkExtent(ink)).toBe(100);
  });

  it('is zero when every stroke is too faint to paint', () => {
    const ink = normalizeStyle({
      ink: { on: true, strokes: [{ size: 40, pts: [[0, 0, 0]] }] },
    }).ink;
    expect(inkExtent(ink)).toBe(0);
  });
});

// ===========================================================================
// The watercolour edge
// ===========================================================================
// CSP's darkened rim: the band within `waterEdgeWidth` page px of a stroke's
// outline goes denser in alpha and darker in colour. It is only visible in
// pixels, and node has no canvas, so these tests bring the smallest renderer
// `drawInk` can be driven through - a transform stack, a disc filled flat or
// through the hardness ramp, the layer composite, and the image-data round trip
// the pass itself uses. Colour as well as alpha, because the rim on the brush
// people actually use - a hard opaque tip - is a colour change and nothing
// else: there is no alpha left to add to it.

import { drawInk, transformScale, erodeAlpha, waterEdgePixels } from './text-paint.js';
import { strokeStamps } from './brush.js';

const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

const inv = (m) => {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
};

const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const hexRgb = (c) => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];

function canvasOf(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const cnv = { width: w, height: h, data, reads: 0, writes: 0 };
  // Source-over on non-premultiplied bytes, which is what an ImageData holds
  // and therefore what the pass reads back.
  const over = (i, sr, sg, sb, sa) => {
    if (sa <= 0) return;
    const da = data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    data[i] = (sr * sa + data[i] * da * (1 - sa)) / oa;
    data[i + 1] = (sg * sa + data[i + 1] * da * (1 - sa)) / oa;
    data[i + 2] = (sb * sa + data[i + 2] * da * (1 - sa)) / oa;
    data[i + 3] = 255 * oa;
  };
  const ctx = {
    canvas: cnv,
    m: { ...IDENT },
    stack: [],
    globalAlpha: 1,
    fillStyle: null,
    dab: null,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    save() {
      this.stack.push({
        m: { ...this.m },
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        imageSmoothingEnabled: this.imageSmoothingEnabled,
      });
    },
    restore() {
      const s = this.stack.pop();
      if (s) Object.assign(this, s);
    },
    getTransform() {
      return { ...this.m };
    },
    setTransform(a, b, c, d, e, f) {
      this.m = typeof a === 'object' ? { ...a } : { a, b, c, d, e, f };
    },
    translate(x, y) {
      this.m = mul(this.m, { ...IDENT, e: x, f: y });
    },
    scale(x, y) {
      this.m = mul(this.m, { ...IDENT, a: x, d: y });
    },
    rotate(r) {
      this.m = mul(this.m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
    },
    createRadialGradient(_x0, _y0, r0, _x1, _y1, r1) {
      // The hardness ramp: the first stop is the ink, the last is clear, so the
      // colour is the stop colour and the falloff is coverage.
      const g = { r0, r1, color: '#000000' };
      g.addColorStop = (pos, c) => {
        if (pos === 0) g.color = c;
      };
      return g;
    },
    beginPath() {},
    arc(x, y, r) {
      this.dab = { x, y, r };
    },
    fill() {
      const { x: cx, y: cy, r } = this.dab;
      const back = inv(this.m);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [lx, ly] of [[cx - r, cy - r], [cx + r, cy - r], [cx - r, cy + r], [cx + r, cy + r]]) {
        const dx = this.m.a * lx + this.m.c * ly + this.m.e;
        const dy = this.m.b * lx + this.m.d * ly + this.m.f;
        x0 = Math.min(x0, dx);
        x1 = Math.max(x1, dx);
        y0 = Math.min(y0, dy);
        y1 = Math.max(y1, dy);
      }
      const g = this.fillStyle && typeof this.fillStyle === 'object' ? this.fillStyle : null;
      const [sr, sg, sb] = hexRgb(g ? g.color : this.fillStyle);
      for (let py = Math.max(0, Math.floor(y0)); py <= Math.min(h - 1, Math.ceil(y1)); py++) {
        for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(w - 1, Math.ceil(x1)); px++) {
          const dx = px + 0.5;
          const dy = py + 0.5;
          const lx = back.a * dx + back.c * dy + back.e - cx;
          const ly = back.b * dx + back.d * dy + back.f - cy;
          const dist = Math.hypot(lx, ly);
          if (dist > r) continue;
          let cov = 1;
          if (g) cov = dist <= g.r0 ? 1 : g.r1 > g.r0 ? 1 - (dist - g.r0) / (g.r1 - g.r0) : 0;
          over((py * w + px) * 4, sr, sg, sb, Math.min(1, Math.max(0, cov)) * this.globalAlpha);
        }
      }
    },
    // Two callers: the finished layer over the target at the identity, and a
    // tip stamped through translate/rotate/scale into a rectangle of its own.
    // One implementation for both - the destination rect through the current
    // transform, sampled back through its inverse - so the layer composite is
    // the same copy it always was (an identity transform at the tip's own size
    // maps pixel centres 1:1) and a stamp is whatever the transform says.
    // Nearest neighbour, which keeps the picture a deterministic function of
    // the transform; `imageSmoothingEnabled` changes no pixel here, so a test
    // that wants to see the hard edge has to read alpha rather than trust it.
    drawImage(src, dx = 0, dy = 0, dw = src.width, dh = src.height) {
      const back = inv(this.m);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [lx, ly] of [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]]) {
        const px = this.m.a * lx + this.m.c * ly + this.m.e;
        const py = this.m.b * lx + this.m.d * ly + this.m.f;
        x0 = Math.min(x0, px);
        x1 = Math.max(x1, px);
        y0 = Math.min(y0, py);
        y1 = Math.max(y1, py);
      }
      for (let py = Math.max(0, Math.floor(y0)); py <= Math.min(h - 1, Math.ceil(y1)); py++) {
        for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(w - 1, Math.ceil(x1)); px++) {
          const cx = px + 0.5;
          const cy = py + 0.5;
          const lx = back.a * cx + back.c * cy + back.e;
          const ly = back.b * cx + back.d * cy + back.f;
          const u = Math.floor(((lx - dx) / dw) * src.width);
          const v = Math.floor(((ly - dy) / dh) * src.height);
          if (u < 0 || v < 0 || u >= src.width || v >= src.height) continue;
          const j = (v * src.width + u) * 4;
          over((py * w + px) * 4, src.data[j], src.data[j + 1], src.data[j + 2],
            (src.data[j + 3] / 255) * this.globalAlpha);
        }
      }
    },
    getImageData(x, y, gw, gh) {
      cnv.reads++;
      const out = new Uint8ClampedArray(gw * gh * 4);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const s = ((y + j) * w + (x + i)) * 4;
          const t = (j * gw + i) * 4;
          for (let c = 0; c < 4; c++) out[t + c] = data[s + c];
        }
      }
      return { width: gw, height: gh, data: out };
    },
    putImageData(img, x, y) {
      cnv.writes++;
      for (let j = 0; j < img.height; j++) {
        for (let i = 0; i < img.width; i++) {
          const s = (j * img.width + i) * 4;
          const t = ((y + j) * w + (x + i)) * 4;
          for (let c = 0; c < 4; c++) data[t + c] = img.data[s + c];
        }
      }
    },
  };
  cnv.getContext = () => ctx;
  return cnv;
}

const alphaOf = (cnv) => {
  const a = new Uint8ClampedArray(cnv.width * cnv.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = cnv.data[j];
  return a;
};

const at = (cnv, x, y) => {
  const i = (Math.round(y) * cnv.width + Math.round(x)) * 4;
  return [cnv.data[i], cnv.data[i + 1], cnv.data[i + 2], cnv.data[i + 3]];
};

const W = 220;
const H = 60;

// A soft-tipped line across the canvas: hardness under 100 is what gives a
// stroke an alpha ramp to make denser.
const softLine = (extra) => ({
  size: 24,
  hardness: 30,
  spacing: 8,
  opacity: 1,
  color: '#000000',
  antialias: true,
  taperIn: { on: false },
  taperOut: { on: false },
  pts: [[24, 30, 1], [196, 30, 1]],
  ...extra,
});

// The brush as it comes out of the box: a flat opaque disc, whose rim the pass
// can only reach through the colour.
const hardLine = (extra) => softLine({ hardness: 100, ...extra });

function render(stroke, scale = 1, w = W, h = H) {
  const cnv = canvasOf(w * scale, h * scale);
  const ctx = cnv.getContext('2d');
  ctx.scale(scale, scale);
  drawInk(ctx, { on: true, strokes: [normalizeInkStroke(stroke)] }, (cw, ch) => canvasOf(cw, ch));
  return cnv;
}

describe('the watercolour edge on a soft tip', () => {
  it('makes the rim denser and leaves the core exactly where it was', () => {
    const off = alphaOf(render(softLine({ waterEdge: false })));
    const on = alphaOf(render(softLine({ waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.6 })));
    let rimOff = 0;
    let rimOn = 0;
    let rim = 0;
    for (let i = 0; i < off.length; i++) {
      // Nothing anywhere gets lighter, and the solid core - alpha that had
      // nothing fainter within the band of it - is untouched.
      expect(on[i]).toBeGreaterThanOrEqual(off[i]);
      if (off[i] === 255) expect(on[i]).toBe(255);
      if (off[i] > 0 && off[i] < 255) {
        rim++;
        rimOff += off[i];
        rimOn += on[i];
      }
    }
    expect(rim).toBeGreaterThan(100);
    expect(rimOn / rim).toBeGreaterThan(rimOff / rim);
  });

  it('runs once over the finished stroke, not once per stamp', () => {
    const k = normalizeInkStroke(softLine({ waterEdge: true }));
    expect(strokeStamps(k).length).toBeGreaterThan(50);
    expect(render(softLine({ waterEdge: true })).reads).toBe(0); // the layer is read, not the target
    const layers = [];
    drawInk(canvasOf(W, H).getContext('2d'), { on: true, strokes: [k] }, (w, h) => {
      const c = canvasOf(w, h);
      layers.push(c);
      return c;
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].reads).toBe(1);
    expect(layers[0].writes).toBe(1);
  });

  it('is off for an opaque anti-aliased stroke that did not ask for it', () => {
    // That stroke takes the fast path, which has no layer to run a pass over -
    // so the edge has to be a third reason to take the slow one.
    const plain = [];
    drawInk(
      canvasOf(W, H).getContext('2d'),
      { on: true, strokes: [normalizeInkStroke(softLine({ waterEdge: false }))] },
      (w, h) => {
        const c = canvasOf(w, h);
        plain.push(c);
        return c;
      },
    );
    expect(plain).toHaveLength(0);
  });

  it('draws nothing different at zero strength', () => {
    const off = render(softLine({ waterEdge: false })).data;
    const zero = render(softLine({ waterEdge: true, waterEdgePower: 0 })).data;
    expect(Array.from(zero)).toEqual(Array.from(off));
  });

  it('draws the same pixels twice', () => {
    const a = render(softLine({ waterEdge: true, waterEdgePower: 0.7 })).data;
    const b = render(softLine({ waterEdge: true, waterEdgePower: 0.7 })).data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// The default brush is a flat opaque disc. Its rim is already as dense as alpha
// goes, so an alpha-only pass would do nothing at all on it - the rim there is
// the colour going darker, which is what CSP draws and what the spec asks for.
describe('the watercolour edge on the default hard tip', () => {
  // Two pixels in from the outline of a 24 px tip centred on y = 30, against
  // the middle of the stroke where the tube is flat.
  const RIM = [110, 20];
  const CORE = [110, 30];

  it('darkens the rim of a grey stroke and leaves its core alone', () => {
    const off = render(hardLine({ color: '#808080', waterEdge: false }));
    const on = render(hardLine({ color: '#808080', waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.5 }));
    expect(at(off, ...RIM)).toEqual([128, 128, 128, 255]);
    // Half the band off a full-strength band is half the ink's own value.
    expect(at(on, ...RIM)).toEqual([64, 64, 64, 255]);
    expect(at(on, ...CORE)).toEqual(at(off, ...CORE));
    expect(at(on, ...CORE)).toEqual([128, 128, 128, 255]);
  });

  it('keeps a coloured stroke its own colour while it darkens', () => {
    const on = render(hardLine({ color: '#ff0000', waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.5 }));
    const [r, g, b, a] = at(on, ...RIM);
    const [cr] = at(on, ...CORE);
    expect(r).toBeLessThan(cr); // the rim is darker than the ink inside it
    expect(r).toBeGreaterThan(g); // and still red, not a grey smudge
    expect(r).toBeGreaterThan(b);
    expect(a).toBe(255); // an opaque stroke stays opaque
    expect(at(on, ...CORE)).toEqual([255, 0, 0, 255]);
  });

  it('survives the anti-aliasing snap, which only ever touches alpha', () => {
    // With anti-aliasing off the alpha is thrown to 0 or 255 straight after the
    // pass, so a rim that lived in alpha alone would be wiped by it.
    const on = render(hardLine({
      color: '#ff0000', antialias: false, waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 0.5,
    }));
    const [r, , , a] = at(on, ...RIM);
    expect(a).toBe(255);
    expect(r).toBeLessThan(at(on, ...CORE)[0]);
    expect(at(on, ...CORE)).toEqual([255, 0, 0, 255]);
  });

  it('reaches in from the outline as far as the band and no further', () => {
    const on = render(hardLine({ color: '#808080', waterEdge: true, waterEdgeWidth: 4, waterEdgePower: 1 }));
    // The tip is 24 px across on y = 30, so its outline is y = 18. Four px in
    // is the last darkened row; the fifth is the ink's own grey.
    expect(at(on, 110, 21)[0]).toBe(0);
    expect(at(on, 110, 23)[0]).toBe(128);
  });
});

// The parity rule the whole app runs on: the editor draws at the zoom, the
// exporter at its supersample, and the two have to be the same picture. A band
// stated in page px is the one part of the pass that could quietly stop being -
// it is the only thing measured in pixels rather than derived from the stroke.
describe('the watercolour edge at two scales', () => {
  // One dab of a fully soft tip, with nothing overlapping it: alpha falls
  // linearly from the centre to the rim, so the band adds a flat 255*r/R*power
  // across the cone and the arithmetic is readable straight off the picture.
  const tap = (extra) => ({
    size: 100,
    hardness: 0,
    spacing: 10,
    opacity: 1,
    color: '#000000',
    antialias: true,
    taperIn: { on: false },
    taperOut: { on: false },
    pts: [[80, 80, 1]],
    ...extra,
  });
  // The mean alpha over a rectangle stated in page px, whatever the scale it
  // was drawn at - which is the only way to compare two resolutions at all.
  const mean = (cnv, scale, x0, y0, x1, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = Math.round(y0 * scale); y < Math.round(y1 * scale); y++) {
      for (let x = Math.round(x0 * scale); x < Math.round(x1 * scale); x++) {
        sum += cnv.data[(y * cnv.width + x) * 4 + 3];
        n++;
      }
    }
    return sum / n;
  };
  // A patch a third of the way out from the centre: dense enough to be well
  // inside the ink, far enough from the middle that nothing there is clipped
  // at 255 and the band has room to show.
  const patch = (scale, extra) => mean(render(tap(extra), scale, 160, 160), scale, 100, 77, 110, 83);
  const added = (scale, width) =>
    patch(scale, { waterEdge: true, waterEdgeWidth: width, waterEdgePower: 0.5 }) -
    patch(scale, { waterEdge: false });

  it('darkens by the same amount at 1x, 2x and 3x', () => {
    const one = added(1, 4);
    expect(one).toBeGreaterThan(8);
    expect(added(2, 4)).toBeCloseTo(one, 0);
    expect(added(3, 4)).toBeCloseTo(one, 0);
  });

  it('is the band that decides it, not the resolution', () => {
    // Twice the band, twice the pigment - so the number above is measuring the
    // setting rather than something constant about the stroke.
    const ratio = added(2, 8) / added(2, 4);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });
});

describe('transformScale', () => {
  it('reads the device px a page px is worth off the transform', () => {
    // The editor's zoom, the exporter's supersample and the panel's pixel ratio
    // all arrive this way, and the band has to be the same page px in each.
    expect(transformScale({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(1);
    expect(transformScale({ a: 2, b: 0, c: 0, d: 2, e: 40, f: 9 })).toBe(2);
    expect(transformScale({ a: -3, b: 0, c: 0, d: 3, e: 0, f: 0 })).toBe(3);
    // A quarter turn at 2x is still 2x.
    expect(transformScale({ a: 0, b: 2, c: -2, d: 0, e: 0, f: 0 })).toBe(2);
  });

  it('falls back to 1 for a transform that collapses', () => {
    expect(transformScale({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBe(1);
    expect(transformScale(undefined)).toBe(1);
  });
});

describe('waterEdgePixels', () => {
  // Black ink whose alpha ramps 255 down to 0 over 25 columns, constant down
  // the rows: the arithmetic of the band is exact on it, and black ink takes
  // the colour half of the pass out of the picture.
  const ramp = (w, h) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = Math.max(0, Math.min(255, (50 - x) * 10));
    }
    return d;
  };
  const A = (d, w, x, y) => d[(y * w + x) * 4 + 3];

  it('adds the band the erosion took off, scaled by the power', () => {
    const w = 80;
    const h = 40;
    const before = ramp(w, h);
    const after = waterEdgePixels(ramp(w, h), w, h, 3, 0.5);
    // Down a falling ramp the smallest alpha within 3 px is the one 3 px along,
    // so the band is 30 and half of it goes back on.
    expect(A(after, w, 30, 20)).toBe(A(before, w, 30, 20) + 15);
    // Flat and saturated: the erosion takes nothing, so nothing is added.
    expect(A(after, w, 5, 20)).toBe(255);
    // Clear on both sides of the window: nothing to darken.
    expect(A(after, w, 70, 20)).toBe(0);
  });

  it('reaches in from the edge exactly as far as the radius', () => {
    // A half-dense field with a hard edge at column 50: every column within r
    // of that edge is the band, and no column further in is.
    const w = 80;
    const h = 40;
    const step = () => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < 50; x++) d[(y * w + x) * 4 + 3] = 128;
      return d;
    };
    const changed = (r) => {
      const before = step();
      const after = waterEdgePixels(step(), w, h, r, 1);
      let n = 0;
      // Away from the plane's own borders, which erode to nothing by design.
      for (let x = 30; x < 60; x++) if (A(after, w, x, 20) !== A(before, w, x, 20)) n++;
      return n;
    };
    expect(changed(3)).toBe(3);
    expect(changed(6)).toBe(6);
  });

  it('darkens the colour under the band and nothing outside it', () => {
    // Opaque grey with a hard edge at column 50: no alpha to add, so the rim is
    // the colour alone - the case the default brush is in.
    const w = 80;
    const h = 40;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 50; x++) {
        const i = (y * w + x) * 4;
        d[i] = 200;
        d[i + 1] = 200;
        d[i + 2] = 200;
        d[i + 3] = 255;
      }
    }
    waterEdgePixels(d, w, h, 4, 0.5);
    const px = (x) => Array.from(d.slice((20 * w + x) * 4, (20 * w + x) * 4 + 4));
    expect(px(48)).toEqual([100, 100, 100, 255]); // in the band: half as bright
    expect(px(40)).toEqual([200, 200, 200, 255]); // past it: the ink as it was
    expect(px(60)).toEqual([0, 0, 0, 0]); // clear stays clear, colour included
  });

  it('leaves the pixels alone at zero power', () => {
    const w = 40;
    const h = 20;
    const before = ramp(w, h);
    expect(Array.from(waterEdgePixels(ramp(w, h), w, h, 5, 0))).toEqual(Array.from(before));
  });
});

describe('erodeAlpha', () => {
  it('shrinks a solid block by the radius on every side', () => {
    const w = 30;
    const h = 30;
    const a = new Uint8ClampedArray(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) a[y * w + x] = 255;
    const e = erodeAlpha(a, w, h, 2);
    expect(e[15 * w + 15]).toBe(255); // the middle survives
    expect(e[15 * w + 11]).toBe(0); // within 2 of the left edge does not
    expect(e[11 * w + 15]).toBe(0); // and the pass is separable, so does the top
    expect(e[15 * w + 12]).toBe(255);
  });
});

describe('the watercolour edge on a stroke that predates it', () => {
  it('loads off, with the defaults ready for when it is switched on', () => {
    const k = normalizeInkStroke({ pts: [[1, 2, 1]] });
    expect(k.waterEdge).toBe(false);
    expect(k.waterEdgeWidth).toBe(4);
    expect(k.waterEdgePower).toBe(0.5);
  });

  it('reads anything but a literal true as off', () => {
    expect(normalizeInkStroke({ waterEdge: 'yes', pts: [[1, 2, 1]] }).waterEdge).toBe(false);
    expect(normalizeInkStroke({ waterEdge: 1, pts: [[1, 2, 1]] }).waterEdge).toBe(false);
    expect(normalizeInkStroke({ waterEdge: true, pts: [[1, 2, 1]] }).waterEdge).toBe(true);
  });

  it('drops an unreadable band or strength back to the default', () => {
    const k = normalizeInkStroke({
      waterEdge: true,
      waterEdgeWidth: NaN,
      waterEdgePower: 'thick',
      pts: [[1, 2, 1]],
    });
    expect(k.waterEdgeWidth).toBe(4);
    expect(k.waterEdgePower).toBe(0.5);
  });

  it('clamps a band and a strength that are out of range', () => {
    const k = normalizeInkStroke({
      waterEdgeWidth: 900,
      waterEdgePower: 5,
      pts: [[1, 2, 1]],
    });
    expect(k.waterEdgeWidth).toBe(20);
    expect(k.waterEdgePower).toBe(1);
    expect(normalizeInkStroke({ waterEdgeWidth: 0, pts: [[1, 2, 1]] }).waterEdgeWidth).toBe(1);
  });
});

// ===========================================================================
// Imported tips
// ===========================================================================
// A stroke whose brush resolves to an imported tip stamps that tip's pixels
// instead of the round dab: scaled so its longest side is the stamp's size,
// turned by the stroke's angle, squashed by its flatness, and tinted to the
// stroke's colour with the tip's own grey as the coverage. `drawInk` is
// synchronous and decoding a tip is not, so the tips arrive as a map the caller
// prefetched - and a stroke whose tip is not in that map draws round for that
// frame without losing the brush it was drawn with.

import { pickTipLevel, TINT_MAX } from './text-paint.js';

// A greyscale tip, ink at 255, exactly as the library hands one over: the
// wrapper's `image` is whatever the platform decoded, and here that is the
// smallest thing the canvas stub can sample.
const tipImage = (w, h, value) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = value(x, y);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
};

const tipOf = (id, image) => ({
  id,
  width: image.width,
  height: image.height,
  source: 'pixels',
  image,
  bytes: null,
});

// 2:1 and solid: the aspect is readable straight off the footprint.
const WIDE = tipOf('wide', tipImage(32, 16, () => 255));
// The same shape the other way up.
const TALL = tipOf('tall', tipImage(16, 32, () => 255));
// Ink in the left half only, so the picture says which way round the tip went
// down rather than only how big it was.
const HALF = tipOf('half', tipImage(32, 16, (x) => (x < 16 ? 255 : 0)));
// Grey ramping left to right: the tint's alpha has to follow it.
const RAMP = tipOf('ramp', tipImage(32, 16, (x) => Math.round((255 * x) / 31)));
// Big enough to have a mip chain: 128x64 halves once and then stops, because
// halving again would take the short side under the floor.
const BIG = tipOf('big', tipImage(128, 64, () => 255));

const tipMap = (...tips) => new Map(tips.map((t) => [t.id, t]));

const TW = 160;
const TH = 120;
const TX = 80;
const TY = 60;

// One stamp, dead centre, with everything that could move it turned off.
const dab = (extra) => ({
  brush: 'wide',
  size: 40,
  color: '#000000',
  opacity: 1,
  spacing: 100,
  hardness: 100,
  angle: 0,
  angleJitter: 0,
  flatness: 1,
  antialias: true,
  taperIn: { on: false, len: 0, ratio: 0 },
  taperOut: { on: false, len: 0, ratio: 0 },
  seed: 1,
  pts: [[TX, TY, 1]],
  ...extra,
});

function renderTip(stroke, tips, scale = 1) {
  const cnv = canvasOf(TW * scale, TH * scale);
  const ctx = cnv.getContext('2d');
  ctx.scale(scale, scale);
  drawInk(
    ctx,
    { on: true, strokes: [normalizeInkStroke(stroke)] },
    (cw, ch) => canvasOf(cw, ch),
    tips,
  );
  return cnv;
}

// The rectangle the ink actually covers, in the canvas's own px.
function footprint(cnv) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < cnv.height; y++) {
    for (let x = 0; x < cnv.width; x++) {
      if (cnv.data[(y * cnv.width + x) * 4 + 3] === 0) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe('stamping an imported tip', () => {
  it('stamps the tip rather than the round dab', () => {
    const f = footprint(renderTip(dab({}), tipMap(WIDE)));
    // 40 px on the longest side, half that on the other: a rectangle, and the
    // round dab of the same size would be a 40 x 40 disc.
    expect([f.w, f.h]).toEqual([40, 20]);
    // The corners of that rectangle are inked, which is the part a disc could
    // not fake however it was scaled.
    expect(at(renderTip(dab({}), tipMap(WIDE)), 61, 51)[3]).toBe(255);
  });

  it('scales the tip so its LONGEST side is the stamp size', () => {
    // The same tip turned on its side: the size means the same thing, so the
    // long axis is 40 either way and the short one follows the aspect.
    const f = footprint(renderTip(dab({ brush: 'tall' }), tipMap(TALL)));
    expect([f.w, f.h]).toEqual([20, 40]);
    // And a smaller stamp is the same rectangle, smaller.
    const small = footprint(renderTip(dab({ size: 20 }), tipMap(WIDE)));
    expect([small.w, small.h]).toEqual([20, 10]);
  });

  it('puts the tip down the way round it was drawn', () => {
    // Ink in the tip's left half only. Unturned it lands left of centre; turned
    // half a circle it lands right of it. An aspect check alone would pass on a
    // tip stamped mirrored or upside down.
    const straight = footprint(renderTip(dab({ brush: 'half' }), tipMap(HALF)));
    expect(straight.x1).toBeLessThanOrEqual(TX);
    expect(straight.x0).toBeCloseTo(TX - 20, -1);
    const turned = footprint(renderTip(dab({ brush: 'half', angle: 180 }), tipMap(HALF)));
    expect(turned.x0).toBeGreaterThanOrEqual(TX - 1);
  });

  it('turns the tip by the stroke angle', () => {
    const f = footprint(renderTip(dab({ angle: 90 }), tipMap(WIDE)));
    expect([f.w, f.h]).toEqual([20, 40]);
  });

  it('squashes the tip by the flatness, on the same axis as the round dab', () => {
    const f = footprint(renderTip(dab({ flatness: 0.5 }), tipMap(WIDE)));
    expect([f.w, f.h]).toEqual([40, 10]);
    // Under a quarter turn the squash goes with the tip, not with the canvas.
    const turned = footprint(renderTip(dab({ angle: 90, flatness: 0.5 }), tipMap(WIDE)));
    expect([turned.w, turned.h]).toEqual([10, 40]);
  });

  it('tints the tip to the stroke colour and takes its alpha from the grey', () => {
    const cnv = renderTip(dab({ brush: 'ramp', color: '#ff0000' }), tipMap(RAMP));
    // Two columns of the ramp, a quarter and seven eighths of the way across
    // the 40 px stamp that starts at x = 60.
    const [r1, g1, b1, a1] = at(cnv, 70, 60);
    const [r2, g2, b2, a2] = at(cnv, 95, 60);
    expect([r1, g1, b1]).toEqual([255, 0, 0]);
    expect([r2, g2, b2]).toEqual([255, 0, 0]);
    // Alpha follows the tip's own grey, which is what makes the PNG a mask
    // rather than a picture: a quarter in is about a quarter dense.
    expect(a1).toBeGreaterThan(40);
    expect(a1).toBeLessThan(100);
    expect(a2).toBeGreaterThan(200);
    // And the tip's black end paints nothing at all.
    expect(at(cnv, 61, 60)[3]).toBeLessThan(20);
  });

  it('ignores hardness, which belongs to the round tip', () => {
    const soft = renderTip(dab({ hardness: 0 }), tipMap(WIDE)).data;
    const hard = renderTip(dab({ hardness: 100 }), tipMap(WIDE)).data;
    expect(Array.from(soft)).toEqual(Array.from(hard));
  });

  it('draws the same pixels twice', () => {
    const a = renderTip(dab({ brush: 'ramp', color: '#204080' }), tipMap(RAMP)).data;
    const b = renderTip(dab({ brush: 'ramp', color: '#204080' }), tipMap(RAMP)).data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('keeps the taper, which resolves the size before the tip is scaled', () => {
    const line = dab({
      pts: [[20, 60, 1], [140, 60, 1]],
      spacing: 10,
      taperIn: { on: true, len: 40, ratio: 60 },
      taperOut: { on: true, len: 40, ratio: 60 },
    });
    // The ends taper to a hair, so the stroke is thinner where it starts than
    // where it is widest - the stamps carry the size, and the tip follows it.
    const height = (cnv, x) => {
      let n = 0;
      for (let y = 0; y < TH; y++) if (cnv.data[(y * TW + x) * 4 + 3] > 0) n++;
      return n;
    };
    const cnv = renderTip(line, tipMap(WIDE));
    expect(height(cnv, 80)).toBe(20);
    expect(height(cnv, 24)).toBeLessThan(10);
  });
});

describe('an imported tip with anti-aliasing off', () => {
  it('leaves every pixel either in the stroke or out of it', () => {
    const cnv = renderTip(dab({ brush: 'ramp', antialias: false }), tipMap(RAMP));
    let partial = 0;
    let solid = 0;
    for (let i = 3; i < cnv.data.length; i += 4) {
      if (cnv.data[i] === 0) continue;
      if (cnv.data[i] === 255) solid++;
      else partial++;
    }
    expect(partial).toBe(0);
    // Half the ramp is over the halfway mark, so half the stamp survives.
    expect(solid).toBeGreaterThan(300);
  });
});

describe('an imported tip that is not there', () => {
  it('draws the round dab when nothing was prefetched', () => {
    const f = footprint(renderTip(dab({}), undefined));
    expect([f.w, f.h]).toEqual([40, 40]); // a disc, not the 2:1 tip
    // A disc leaves the corners of its own bounding box clear.
    expect(at(renderTip(dab({}), undefined), 61, 41)[3]).toBe(0);
  });

  it('draws the round dab for a brush this install does not have', () => {
    const f = footprint(renderTip(dab({ brush: 'gone' }), tipMap(WIDE)));
    expect([f.w, f.h]).toEqual([40, 40]);
  });

  it('draws the round dab for a tip that has not decoded yet', () => {
    // The wrapper without an image: what a platform with no decoder hands back,
    // and what a tip mid-read looks like.
    const undecoded = { ...WIDE, image: null, bytes: new Uint8Array([1, 2, 3]) };
    const f = footprint(renderTip(dab({}), tipMap(undecoded)));
    expect([f.w, f.h]).toEqual([40, 40]);
  });

  it('keeps the brush id on the stroke it fell back for', () => {
    // The fallback is a reading, never a rewrite: importing the missing .sut
    // later has to bring the real tip back to this stroke.
    const k = normalizeInkStroke(dab({ brush: 'gone' }));
    drawInk(
      canvasOf(TW, TH).getContext('2d'),
      { on: true, strokes: [k] },
      (w, h) => canvasOf(w, h),
      new Map(),
    );
    expect(k.brush).toBe('gone');
  });
});

describe('the tinted mip chain', () => {
  it('is built once per tip and colour and then reused', () => {
    const tip = tipOf('big', BIG.image);
    const made = [];
    const alloc = (w, h) => {
      const c = canvasOf(w, h);
      made.push([w, h]);
      return c;
    };
    const paint = (color) => {
      const cnv = canvasOf(TW, TH);
      drawInk(
        cnv.getContext('2d'),
        { on: true, strokes: [normalizeInkStroke(dab({ brush: 'big', color }))] },
        alloc,
        tipMap(tip),
      );
    };
    paint('#000000');
    // The tinted tip and one halving of it: 128x64 halves to 64x32, and
    // halving that would take the short side under the floor.
    expect(made).toEqual([[128, 64], [64, 32]]);
    paint('#000000');
    expect(made).toHaveLength(2); // the second stroke allocates nothing
    paint('#ff0000');
    expect(made).toHaveLength(4); // a second colour is a second chain
    // The chain lives on the wrapper, so the library's cache owns its lifetime:
    // dropping the tip drops the canvases with it.
    expect(tip.tinted.size).toBe(2);
  });

  it('stamps a whole stroke from one chain, not one per dab', () => {
    const tip = tipOf('big', BIG.image);
    const made = [];
    const alloc = (w, h) => {
      made.push([w, h]);
      return canvasOf(w, h);
    };
    const k = normalizeInkStroke(dab({ brush: 'big', pts: [[20, 60, 1], [140, 60, 1]], spacing: 10 }));
    expect(strokeStamps(k).length).toBeGreaterThan(20);
    drawInk(canvasOf(TW, TH).getContext('2d'), { on: true, strokes: [k] }, alloc, tipMap(tip));
    expect(made).toHaveLength(2);
  });

  it('caps a huge tip rather than holding a second copy of it', () => {
    // The corpus has tips over 11000 px on a side. A tinted copy of one is
    // hundreds of megabytes held for as long as the library keeps the tip, and
    // nothing stamps a brush 2048 device px across.
    const tip = tipOf('huge', tipImage(TINT_MAX * 2, 64, () => 255));
    const made = [];
    const alloc = (w, h) => {
      made.push([w, h]);
      return canvasOf(w, h);
    };
    drawInk(
      canvasOf(TW, TH).getContext('2d'),
      { on: true, strokes: [normalizeInkStroke(dab({ brush: 'huge' }))] },
      alloc,
      tipMap(tip),
    );
    // The full-resolution read, then the capped chain it is shrunk into. The
    // first is handed back on the spot, which is what the zeroed size says.
    expect(made).toEqual([[TINT_MAX * 2, 64], [TINT_MAX, 32]]);
    // The chain keeps the tip's aspect - the cap changes the resolution it is
    // built at, never the shape a stamp is drawn as, which comes off the tip's
    // own dimensions rather than off any level.
    expect(tip.tinted.get('#000000').map((c) => [c.width, c.height])).toEqual([[TINT_MAX, 32]]);
  });

  it('keeps a page\'s palette of one tip and then lets the oldest go', () => {
    const tip = tipOf('big', BIG.image);
    for (const color of ['#101010', '#000000', '#ff0000', '#00ff00', '#0000ff']) {
      drawInk(
        canvasOf(TW, TH).getContext('2d'),
        { on: true, strokes: [normalizeInkStroke(dab({ brush: 'big', color }))] },
        (w, h) => canvasOf(w, h),
        tipMap(tip),
      );
    }
    // Four is a page's worth: a letterer who inks in three colours with one
    // brush must not evict a chain they are about to need again, because the
    // rebuild is a full-canvas tint in the middle of a pointer move.
    expect(tip.tinted.size).toBe(4);
    expect([...tip.tinted.keys()]).toEqual(['#000000', '#ff0000', '#00ff00', '#0000ff']);
  });
});

describe('pickTipLevel', () => {
  const levels = [{ width: 128, height: 64 }, { width: 64, height: 32 }, { width: 32, height: 16 }];

  it('takes the smallest level still at least as big as the stamp', () => {
    expect(pickTipLevel(levels, 64)).toBe(levels[1]);
    expect(pickTipLevel(levels, 65)).toBe(levels[0]);
    expect(pickTipLevel(levels, 32)).toBe(levels[2]);
  });

  it('takes the full-resolution level for a stamp bigger than the tip', () => {
    expect(pickTipLevel(levels, 1000)).toBe(levels[0]);
  });

  it('takes the smallest level for a stamp smaller than all of them', () => {
    expect(pickTipLevel(levels, 3)).toBe(levels[2]);
  });
});

describe('an imported tip at two scales', () => {
  // The parity rule: the editor draws at the zoom and the exporter at its
  // supersample, and the two have to be the same picture. A tip is the one
  // thing in the ink path measured in its OWN pixels, so it is the one that
  // could quietly stop scaling with the transform.
  const mean = (cnv, scale, x0, y0, x1, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = Math.round(y0 * scale); y < Math.round(y1 * scale); y++) {
      for (let x = Math.round(x0 * scale); x < Math.round(x1 * scale); x++) {
        sum += cnv.data[(y * cnv.width + x) * 4 + 3];
        n++;
      }
    }
    return sum / n;
  };

  it('covers the same page px at 1x and 2x', () => {
    const one = renderTip(dab({ brush: 'ramp' }), tipMap(RAMP), 1);
    const two = renderTip(dab({ brush: 'ramp' }), tipMap(RAMP), 2);
    // Over the whole stamp, and over one band of the ramp inside it.
    expect(mean(two, 2, 55, 45, 105, 75)).toBeCloseTo(mean(one, 1, 55, 45, 105, 75), -1);
    expect(mean(two, 2, 85, 55, 95, 65)).toBeCloseTo(mean(one, 1, 85, 55, 95, 65), -1);
  });

  it('lands on the same page px at 1x and 2x', () => {
    const f1 = footprint(renderTip(dab({}), tipMap(WIDE), 1));
    const f2 = footprint(renderTip(dab({}), tipMap(WIDE), 2));
    expect([f2.x0 / 2, f2.y0 / 2]).toEqual([f1.x0, f1.y0]);
    expect([f2.w / 2, f2.h / 2]).toEqual([f1.w, f1.h]);
  });
});
