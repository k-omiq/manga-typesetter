import { describe, it, expect } from 'vitest';
import { normalizeStyle, defaultPathPts } from './data.js';
import { motionBlurTaps, motionBlurPreviewTaps, motionBlurExtent, clipActive } from './text-paint.js';
import { pathLayout, circleLayout, insertPathAnchor, removePathAnchor } from './measure.js';

describe('normalizeStyle effects schema', () => {
  it('supplies defaults for motionBlur, path, clip and circle on empty input', () => {
    const s = normalizeStyle({});
    expect(s.motionBlur).toEqual({ on: false, x: 2, y: 0, amount: 16 });
    expect(s.path).toEqual({ on: false, pts: [] });
    expect(s.clip).toEqual({ on: false, mode: 'exclude', brushSize: 20, shapes: [] });
    expect(s.circle).toEqual({ on: false, angle: 0, inside: false, r: 0 });
  });

  it('clamps motion blur direction x/y and amount, rounding amount to integer', () => {
    const over = normalizeStyle({ motionBlur: { x: 999, y: -999, amount: 99 } });
    expect(over.motionBlur.x).toBe(50);
    expect(over.motionBlur.y).toBe(-50);
    expect(over.motionBlur.amount).toBe(32);

    const under = normalizeStyle({ motionBlur: { x: -999, y: 999, amount: 0 } });
    expect(under.motionBlur.x).toBe(-50);
    expect(under.motionBlur.y).toBe(50);
    expect(under.motionBlur.amount).toBe(1);

    const rounded = normalizeStyle({ motionBlur: { amount: 16.7 } });
    expect(rounded.motionBlur.amount).toBe(17);
  });

  it('filters invalid path points and defaults handle offsets to zero', () => {
    const s = normalizeStyle({
      path: {
        on: true,
        pts: [
          { x: 10, y: 20 },
          { x: NaN, y: 30 },
          { x: 40, y: 'bad' },
          { x: 50, y: 60, ix: -5, iy: -2, ox: 5, oy: 2 },
        ],
      },
    });
    expect(s.path.on).toBe(true);
    expect(s.path.pts).toEqual([
      { x: 10, y: 20, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 50, y: 60, ix: -5, iy: -2, ox: 5, oy: 2 },
    ]);
  });

  it('normalizes clip properties: mode, brushSize and shapes', () => {
    expect(normalizeStyle({ clip: { on: 1 } }).clip.on).toBe(true);
    expect(normalizeStyle({ clip: { on: 'yes' } }).clip.on).toBe(true);
    expect(normalizeStyle({ clip: { on: 0 } }).clip.on).toBe(false);
    expect(normalizeStyle({ clip: { on: false } }).clip.on).toBe(false);
    expect(normalizeStyle({ clip: null }).clip.on).toBe(false);

    // mode normalization
    expect(normalizeStyle({ clip: { mode: 'include' } }).clip.mode).toBe('include');
    expect(normalizeStyle({ clip: { mode: 'exclude' } }).clip.mode).toBe('exclude');
    expect(normalizeStyle({ clip: { mode: 'junk' } }).clip.mode).toBe('exclude');
    expect(normalizeStyle({ clip: {} }).clip.mode).toBe('exclude');

    // brushSize clamps
    expect(normalizeStyle({ clip: { brushSize: 500 } }).clip.brushSize).toBe(200);
    expect(normalizeStyle({ clip: { brushSize: 1 } }).clip.brushSize).toBe(2);
    expect(normalizeStyle({ clip: { brushSize: 50 } }).clip.brushSize).toBe(50);
    expect(normalizeStyle({ clip: { brushSize: 'bad' } }).clip.brushSize).toBe(20);

    // shapes validation
    const s = normalizeStyle({
      clip: {
        shapes: [
          { kind: 'ellipse', cx: 10, cy: 20, rx: 30, ry: 40 },
          { kind: 'ellipse', cx: 10, cy: 20, rx: 0, ry: 40 }, // rx 0 -> dropped
          { kind: 'ellipse', cx: NaN, cy: 20, rx: 30, ry: 40 }, // non-finite -> dropped
          { kind: 'poly', pts: [[0, 0], [10, 0], [10, 10]] }, // 3 pts -> kept
          { kind: 'poly', pts: [[0, 0], [10, 0]] }, // 2 pts -> dropped
          { kind: 'poly', pts: [[0, 0], [NaN, 0], [10, 10]] }, // only 2 finite pairs -> dropped
          { kind: 'stroke', size: 10, pts: [[0, 0]] }, // 1 pt, size 10 -> kept
          { kind: 'stroke', size: 300, pts: [[0, 0], [1, 1]] }, // size 300 -> capped at 200
          { kind: 'stroke', size: 0, pts: [[0, 0]] }, // size 0 -> dropped
          { kind: 'stroke', size: 10, pts: [] }, // 0 pts -> dropped
          { kind: 'invalid' }, // unknown kind -> dropped
        ],
      },
    });
    expect(s.clip.shapes).toEqual([
      { kind: 'ellipse', cx: 10, cy: 20, rx: 30, ry: 40 },
      { kind: 'poly', pts: [[0, 0], [10, 0], [10, 10]] },
      { kind: 'stroke', size: 10, pts: [[0, 0]] },
      { kind: 'stroke', size: 200, pts: [[0, 0], [1, 1]] },
    ]);
  });

  it('normalizes circle angle into [0, 360)', () => {
    const over = normalizeStyle({ circle: { angle: 720 } });
    expect(over.circle.angle).toBe(0);

    const under = normalizeStyle({ circle: { angle: -90 } });
    expect(under.circle.angle).toBe(270);
  });

  it('coerces circle on and inside to boolean', () => {
    expect(normalizeStyle({ circle: { on: 1, inside: 0 } }).circle).toEqual({ on: true, angle: 0, inside: false, r: 0 });
    expect(normalizeStyle({ circle: { on: 'yes', inside: 'true' } }).circle).toEqual({ on: true, angle: 0, inside: true, r: 0 });
    expect(normalizeStyle({ circle: { on: 0, inside: false } }).circle).toEqual({ on: false, angle: 0, inside: false, r: 0 });
    expect(normalizeStyle({ circle: { on: false, inside: null } }).circle).toEqual({ on: false, angle: 0, inside: false, r: 0 });
    expect(normalizeStyle({ circle: null }).circle).toEqual({ on: false, angle: 0, inside: false, r: 0 });
  });

  it('clamps the circle radius and reads a missing one as auto', () => {
    expect(normalizeStyle({ circle: { r: 120 } }).circle.r).toBe(120);
    expect(normalizeStyle({ circle: { r: -5 } }).circle.r).toBe(0);
    expect(normalizeStyle({ circle: { r: 99999 } }).circle.r).toBe(4000);
    expect(normalizeStyle({ circle: { r: 'wide' } }).circle.r).toBe(0);
    // A style saved before the radius existed still means the auto ring.
    expect(normalizeStyle({ circle: { on: true } }).circle.r).toBe(0);
  });
});

describe('defaultPathPts', () => {
  it('shapes default anchors and handles for w=200, h=100', () => {
    const pts = defaultPathPts(200, 100);
    expect(pts).toEqual([
      { x: 0, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 100, y: 50, ix: -50, iy: 0, ox: 50, oy: 0 },
      { x: 200, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
    ]);
  });

  it('clamps handle span to a minimum of 10 for a tiny box', () => {
    const pts = defaultPathPts(20, 40);
    expect(pts).toEqual([
      { x: 0, y: 20, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 10, y: 20, ix: -10, iy: 0, ox: 10, oy: 0 },
      { x: 20, y: 20, ix: 0, iy: 0, ox: 0, oy: 0 },
    ]);
  });
});

describe('motionBlurTaps', () => {
  it('returns an empty array when x and y are both 0', () => {
    expect(motionBlurTaps(0, 0, 16)).toEqual([]);
    expect(motionBlurTaps(0, 0, 0)).toEqual([]);
    expect(motionBlurTaps('0', '0', 8)).toEqual([]);
  });

  it('produces exactly 4*amount+1 entries', () => {
    const taps8 = motionBlurTaps(2, 0, 8);
    expect(taps8).toHaveLength(4 * 8 + 1);

    const taps16 = motionBlurTaps(2, 3, 16);
    expect(taps16).toHaveLength(4 * 16 + 1);

    // Clamped amount
    const tapsClamped = motionBlurTaps(1, 1, 99);
    expect(tapsClamped).toHaveLength(4 * 32 + 1);
  });

  it('calculates expected centre tap weight', () => {
    const amount = 16;
    const taps = motionBlurTaps(2, 0, amount);
    const expectedCentreW = (0.227027027 * amount) / (amount + 1);
    expect(taps[0]).toEqual({ dx: 0, dy: 0, w: expectedCentreW });
  });

  it('has symmetric taps with equal weights for every non-centre tap', () => {
    const taps = motionBlurTaps(2, 1, 8);
    for (let i = 1; i < taps.length; i += 2) {
      const pos = taps[i];
      const neg = taps[i + 1];
      expect(neg.dx).toBeCloseTo(-pos.dx, 9);
      expect(neg.dy).toBeCloseTo(-pos.dy, 9);
      expect(neg.w).toBe(pos.w);
    }
  });

  it('sums total weight close to amount*0.9994594594/(amount+1)', () => {
    for (const amount of [1, 8, 16, 32]) {
      const taps = motionBlurTaps(2, 1, amount);
      const totalW = taps.reduce((sum, t) => sum + t.w, 0);
      const expectedW = (amount * (0.227027027 + 2 * 0.3162162162 + 2 * 0.0702702703)) / (amount + 1);
      expect(totalW).toBeCloseTo(expectedW, 6);
      expect(totalW).toBeCloseTo((amount * 0.9994594594) / (amount + 1), 2);
    }
  });
});

describe('motionBlurPreviewTaps', () => {
  it('is the full list when the amount is already within the cap', () => {
    expect(motionBlurPreviewTaps(2, 1, 8)).toEqual(motionBlurTaps(2, 1, 8));
    expect(motionBlurPreviewTaps(0, 0, 32)).toEqual([]);
  });

  it('caps the tap count above the cap', () => {
    expect(motionBlurPreviewTaps(2, 1, 32)).toHaveLength(4 * 8 + 1);
    expect(motionBlurPreviewTaps(2, 1, 32, 4)).toHaveLength(4 * 4 + 1);
  });

  it('keeps the full smear extent', () => {
    const reach = (taps) => taps.reduce((m, t) => Math.max(m, Math.abs(t.dx)), 0);
    expect(reach(motionBlurPreviewTaps(2, 0, 32))).toBeCloseTo(reach(motionBlurTaps(2, 0, 32)), 6);
  });

  it('keeps the full dimming, so preview and export match in tone', () => {
    const total = (taps) => taps.reduce((s, t) => s + t.w, 0);
    expect(total(motionBlurPreviewTaps(2, 1, 32))).toBeCloseTo(total(motionBlurTaps(2, 1, 32)), 6);
  });
});

describe('motionBlurExtent', () => {
  it('returns 0 when motion blur is off, direction is (0,0), or null', () => {
    expect(motionBlurExtent({ on: false, x: 2, y: 0, amount: 16 })).toBe(0);
    expect(motionBlurExtent({ on: true, x: 0, y: 0, amount: 16 })).toBe(0);
    expect(motionBlurExtent(null)).toBe(0);
  });

  it('computes extent per formula ceil(3.2307692308*hypot(x,y)*amount)+1 when on', () => {
    // x=2, y=0, amount=16 -> ceil(3.2307692308 * 2 * 16) + 1 = ceil(103.3846...) + 1 = 104 + 1 = 105
    expect(motionBlurExtent({ on: true, x: 2, y: 0, amount: 16 })).toBe(105);

    // x=3, y=4, amount=8 -> hypot=5, ceil(3.2307692308 * 5 * 8) + 1 = ceil(129.2307...) + 1 = 130 + 1 = 131
    expect(motionBlurExtent({ on: true, x: 3, y: 4, amount: 8 })).toBe(131);
  });
});

describe('clipActive', () => {
  it('returns true only when clip.on and clip.shapes.length > 0', () => {
    expect(clipActive({ on: true, shapes: [{ kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }] })).toBe(true);
    expect(clipActive({ on: true, shapes: [] })).toBe(false);
    expect(clipActive({ on: false, shapes: [{ kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }] })).toBe(false);
    expect(clipActive({ on: false, shapes: [] })).toBe(false);
    expect(clipActive(null)).toBe(false);
    expect(clipActive(undefined)).toBe(false);
  });
});

describe('insertPathAnchor', () => {
  it('splits straight 2-anchor path [(0,0),(100,0)] to 3 anchors with midpoint at (50,0) and handles (±25,0)', () => {
    const pts = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 100, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    const res = insertPathAnchor(pts);
    expect(res).toHaveLength(3);
    expect(res[0]).toEqual({ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 });
    expect(res[1]).toEqual({ x: 50, y: 0, ix: -25, iy: 0, ox: 25, oy: 0 });
    expect(res[2]).toEqual({ x: 100, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 });
  });

  it('returns input unchanged when pts has fewer than 2 entries or is invalid', () => {
    const single = [{ x: 10, y: 20, ix: 0, iy: 0, ox: 0, oy: 0 }];
    expect(insertPathAnchor(single)).toBe(single);
    expect(insertPathAnchor([])).toEqual([]);
    expect(insertPathAnchor(null)).toBeNull();
  });

  it('grows anchor count by exactly 1 and preserves first and last anchor positions', () => {
    const pts = defaultPathPts(200, 100);
    const res = insertPathAnchor(pts);
    expect(res).toHaveLength(pts.length + 1);
    expect(res[0].x).toBe(pts[0].x);
    expect(res[0].y).toBe(pts[0].y);
    expect(res[res.length - 1].x).toBe(pts[pts.length - 1].x);
    expect(res[res.length - 1].y).toBe(pts[pts.length - 1].y);
  });
});

describe('removePathAnchor', () => {
  it('refuses removal when pts.length <= 2 and returns input unchanged', () => {
    const pts2 = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 100, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    expect(removePathAnchor(pts2, 0)).toBe(pts2);
    expect(removePathAnchor(pts2, 1)).toBe(pts2);
  });

  it('removes anchor at specified index when length > 2', () => {
    const pts3 = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 50, y: 0, ix: -25, iy: 0, ox: 25, oy: 0 },
      { x: 100, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    const res = removePathAnchor(pts3, 1);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual(pts3[0]);
    expect(res[1]).toEqual(pts3[2]);
  });

  it('returns input unchanged when index is out of range', () => {
    const pts3 = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 50, y: 0, ix: -25, iy: 0, ox: 25, oy: 0 },
      { x: 100, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    expect(removePathAnchor(pts3, -1)).toBe(pts3);
    expect(removePathAnchor(pts3, 5)).toBe(pts3);
  });
});

describe('pathLayout', () => {
  it('returns empty array when preconditions are not met', () => {
    const pts = defaultPathPts(200, 100);
    const style = { size: 20, align: 'center', letterSpacing: 0, path: { on: true, pts } };

    expect(pathLayout('', style, 20, 200, 100)).toEqual([]);
    expect(pathLayout('test', style, 0, 200, 100)).toEqual([]);
    expect(pathLayout('test', { ...style, size: 0 }, 20, 200, 100)).toEqual([]);
    expect(pathLayout('test', { ...style, path: { on: true, pts: [] } }, 20, 200, 100)).toEqual([]);
    expect(
      pathLayout('test', { ...style, path: { on: true, pts: [{ x: 0, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 }] } }, 20, 200, 100),
    ).toEqual([]);
  });

  it('lays out characters along a straight horizontal path centered in box', () => {
    const pts = [
      { x: 0, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 200, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    const style = { size: 20, align: 'center', letterSpacing: 0, path: { on: true, pts } };
    const text = 'abcd';
    const layout = pathLayout(text, style, 20, 200, 100);

    expect(layout).toHaveLength(4);
    for (const g of layout) {
      expect(g.rot).toBeCloseTo(0, 6);
      expect(g.y).toBeCloseTo(0, 6);
      expect(g.w).toBeCloseTo(11, 6); // 0.55 * 20 in node
    }

    // x positions strictly increasing
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].x).toBeGreaterThan(layout[i - 1].x);
    }

    // Symmetric about 0
    expect(layout[0].x).toBeCloseTo(-layout[3].x, 6);
    expect(layout[1].x).toBeCloseTo(-layout[2].x, 6);
  });

  it('starts first glyph at left edge for left alignment', () => {
    const pts = [
      { x: 0, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 200, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    const style = { size: 20, align: 'left', letterSpacing: 0, path: { on: true, pts } };
    const text = 'abcd';
    const layout = pathLayout(text, style, 20, 200, 100);

    const w = layout[0].w;
    expect(layout[0].x).toBeCloseTo(-100 + w / 2, 6);
  });

  it('extrapolates along end tangents for text longer than path', () => {
    const pts = [
      { x: 0, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 50, y: 50, ix: 0, iy: 0, ox: 0, oy: 0 },
    ];
    const style = { size: 20, align: 'center', letterSpacing: 0, path: { on: true, pts } };
    const text = 'supercalifragilisticexpialidocious';
    const layout = pathLayout(text, style, 20, 200, 100);

    expect(layout).toHaveLength(text.length);
    for (const g of layout) {
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.y)).toBe(true);
      expect(Number.isFinite(g.rot)).toBe(true);
    }
  });
});

describe('circleLayout', () => {
  it('returns empty array when text is empty or size is 0', () => {
    const style = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: false } };
    expect(circleLayout('', style, 20)).toEqual([]);
    expect(circleLayout('abcd', style, 0)).toEqual([]);
    expect(circleLayout('abcd', { ...style, size: 0 }, 20)).toEqual([]);
    expect(circleLayout('abcd', null, 20)).toEqual([]);
  });

  it('lays out characters around a closed circle at the top', () => {
    const style = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: false } };
    const text = 'abcd';
    const sizePx = 20;
    const layout = circleLayout(text, style, sizePx);

    expect(layout).toHaveLength(4);
    const R = 44 / (2 * Math.PI);
    for (const g of layout) {
      expect(Math.hypot(g.x, g.y)).toBeCloseTo(R, 6);
      expect(g.w).toBeCloseTo(11, 6);
    }

    // First glyph sits at the top (y < 0, x small positive since its centre is 5.5/44 of the way around)
    expect(layout[0].y).toBeLessThan(0);
    expect(layout[0].x).toBeGreaterThan(0);
    expect(layout[0].rot).toBeCloseTo((2 * Math.PI * 5.5) / 44, 6);

    // Rotations strictly increase
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].rot).toBeGreaterThan(layout[i - 1].rot);
    }
  });

  it('shifts every rotation by Math.PI / 2 when angle is 90', () => {
    const style0 = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: false } };
    const style90 = { size: 20, letterSpacing: 0, circle: { on: true, angle: 90, inside: false } };
    const text = 'abcd';
    const layout0 = circleLayout(text, style0, 20);
    const layout90 = circleLayout(text, style90, 20);

    expect(layout90).toHaveLength(4);
    for (let i = 0; i < text.length; i++) {
      expect(layout90[i].rot).toBeCloseTo(layout0[i].rot + Math.PI / 2, 6);
    }
  });

  it('places first glyph at the bottom and flips rotation when inside is true', () => {
    const styleInside = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: true } };
    const text = 'abcd';
    const layout = circleLayout(text, styleInside, 20);

    expect(layout).toHaveLength(4);
    expect(layout[0].y).toBeGreaterThan(0);
    expect(layout[0].rot).toBeCloseTo(-((2 * Math.PI * 5.5) / 44), 6);
  });

  it('holds a chosen radius and centres the run on the angle', () => {
    // 'abcd' at 11px a glyph: an open arc of 44px advance on a radius-100 ring,
    // centred on twelve o'clock, so the run straddles it symmetrically.
    const style = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: false, r: 100 } };
    const layout = circleLayout('abcd', style, 20);

    expect(layout).toHaveLength(4);
    for (const g of layout) expect(Math.hypot(g.x, g.y)).toBeCloseTo(100, 6);
    // Half the advance short of the middle, then a glyph's half width in.
    expect(layout[0].rot).toBeCloseTo((5.5 - 22) / 100, 6);
    expect(layout[3].rot).toBeCloseTo((38.5 - 22) / 100, 6);
    expect(layout[0].x).toBeLessThan(0);
    expect(layout[3].x).toBeGreaterThan(0);
    for (const g of layout) expect(g.y).toBeLessThan(0);
  });

  it('scales the chosen radius with the drawn size, as letterSpacing scales', () => {
    const style = { size: 20, letterSpacing: 0, circle: { on: true, angle: 0, inside: false, r: 100 } };
    const layout = circleLayout('abcd', style, 40);
    for (const g of layout) expect(Math.hypot(g.x, g.y)).toBeCloseTo(200, 6);
  });

  it('pays n-1 gaps on a chosen radius, not the closed ring\'s n', () => {
    const style = { size: 20, letterSpacing: 10, circle: { on: true, angle: 0, inside: false, r: 100 } };
    const layout = circleLayout('abcd', style, 20);
    // advance 4x11 + 3x10 = 74, so the run spans 74/100 radians about the top.
    expect(layout[3].rot - layout[0].rot).toBeCloseTo((74 - 11) / 100, 6);
  });

  it('grows the ring with letterSpacing', () => {
    const style = { size: 20, letterSpacing: 10, circle: { on: true, angle: 0, inside: false } };
    const text = 'abcd';
    const layout = circleLayout(text, style, 20);

    const expectedR = 84 / (2 * Math.PI);
    expect(layout).toHaveLength(4);
    for (const g of layout) {
      expect(Math.hypot(g.x, g.y)).toBeCloseTo(expectedR, 6);
    }
  });
});
