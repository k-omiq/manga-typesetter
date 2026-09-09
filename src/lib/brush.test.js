import { describe, it, expect } from 'vitest';
import { resamplePath, strokeStamps, strokeBounds, scaleStroke, mulberry32 } from './brush.js';
import { normalizeInkStroke } from './data.js';

const line = (n, dx = 10) =>
  Array.from({ length: n }, (_, i) => [i * dx, 0, 1]);

describe('mulberry32', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const runA = [a(), a(), a()];
    const runB = [b(), b(), b()];
    expect(runA).toEqual(runB);
    for (const v of runA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('gives different runs for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('resamplePath', () => {
  it('walks a straight line at the requested spacing', () => {
    const out = resamplePath(line(2, 100), 25);
    expect(out.map((p) => p[0])).toEqual([0, 25, 50, 75, 100]);
    expect(out.every((p) => p[1] === 0)).toBe(true);
  });

  it('interpolates the width factor between the points it walks past', () => {
    const out = resamplePath([[0, 0, 0], [100, 0, 1]], 50);
    expect(out.map((p) => p[2])).toEqual([0, 0.5, 1]);
  });

  it('returns a single point unchanged - a tap is a dot, not a path', () => {
    expect(resamplePath([[5, 6, 0.4]], 10)).toEqual([[5, 6, 0.4]]);
  });

  it('returns an empty array for no points', () => {
    expect(resamplePath([], 10)).toEqual([]);
  });

  it('never divides by a zero step', () => {
    expect(resamplePath(line(2, 10), 0).length).toBeGreaterThan(0);
  });
});

describe('strokeStamps', () => {
  const base = (over = {}) =>
    normalizeInkStroke({ size: 20, spacing: 50, pts: line(2, 100), ...over });

  it('spaces stamps at the spacing percentage of the size', () => {
    // size 20, spacing 50% -> a stamp every 10 px along a 100 px line
    const stamps = strokeStamps(base());
    expect(stamps).toHaveLength(11);
    expect(stamps[0].x).toBe(0);
    expect(stamps[1].x).toBeCloseTo(10, 6);
    expect(stamps.at(-1).x).toBeCloseTo(100, 6);
  });

  it('scales each stamp by its point width factor', () => {
    const stamps = strokeStamps(base({ pts: [[0, 0, 0.5], [100, 0, 0.5]] }));
    expect(stamps.every((s) => s.size === 10)).toBe(true);
  });

  it('emits one stamp for a tap', () => {
    const stamps = strokeStamps(base({ pts: [[7, 8, 1]] }));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ x: 7, y: 8, size: 20 });
  });

  it('carries the stroke opacity onto every stamp', () => {
    const stamps = strokeStamps(base({ opacity: 0.5 }));
    expect(stamps.every((s) => s.alpha === 0.5)).toBe(true);
  });

  it('applies the base angle to every stamp when there is no jitter', () => {
    const stamps = strokeStamps(base({ angle: 30 }));
    expect(stamps.every((s) => s.angle === 30)).toBe(true);
  });

  it('is deterministic under jitter for a fixed seed', () => {
    const a = strokeStamps(base({ angleJitter: 100, seed: 3 }));
    const b = strokeStamps(base({ angleJitter: 100, seed: 3 }));
    expect(a).toEqual(b);
    const c = strokeStamps(base({ angleJitter: 100, seed: 4 }));
    expect(c).not.toEqual(a);
  });

  it('returns nothing for a stroke with a zero-width factor everywhere', () => {
    expect(strokeStamps(base({ pts: [[0, 0, 0], [100, 0, 0]] }))).toEqual([]);
  });
});

describe('strokeBounds', () => {
  it('includes the stamp radius, not just the path', () => {
    const b = strokeBounds(normalizeInkStroke({ size: 20, pts: line(2, 100) }));
    expect(b).toEqual({ minX: -10, minY: -10, maxX: 110, maxY: 10 });
  });

  it('returns null when nothing would be drawn', () => {
    expect(strokeBounds(normalizeInkStroke({ size: 20, pts: [[0, 0, 0]] }))).toBeNull();
  });

  it('reaches to the corner for an imported tip, which is a rectangle', () => {
    // The round dab reaches half its size in every direction; an image tip's
    // longest side IS its size, so turned 45 degrees it reaches the half
    // diagonal. The bound never sees the bitmap, so it takes the worst case.
    const b = strokeBounds(normalizeInkStroke({ brush: 'abc123', size: 20, pts: [[0, 0, 1]] }));
    const r = 20 * Math.SQRT1_2;
    expect(b).toEqual({ minX: -r, minY: -r, maxX: r, maxY: r });
  });

  it('leaves the round tip bound exactly where it was', () => {
    const round = strokeBounds(normalizeInkStroke({ brush: 'round', size: 20, pts: [[0, 0, 1]] }));
    expect(round).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  });
});

describe('scaleStroke', () => {
  it('scale by 2 doubles coordinates and widths', () => {
    const stroke = normalizeInkStroke({
      size: 20,
      waterEdgeWidth: 4,
      waterEdgeBlur: 2,
      taperIn: { on: true, len: 10, mode: 'px' },
      pts: [
        [10, 20, 1],
        [30, 40, 0.8, 0.9, 0.7],
      ],
    });
    const scaled = scaleStroke(stroke, 2);
    expect(scaled.pts[0]).toEqual([20, 40, 1]);
    expect(scaled.pts[1]).toEqual([60, 80, 0.8, 0.9, 0.7]);
    expect(scaled.size).toBe(40);
    expect(scaled.waterEdgeWidth).toBe(8);
    expect(scaled.waterEdgeBlur).toBe(4);
    expect(scaled.taperIn.len).toBe(20);
  });

  it('scale by 1 is identity', () => {
    const stroke = normalizeInkStroke({
      size: 20,
      pts: [
        [10, 20, 1],
        [30, 40, 1],
      ],
    });
    const scaled = scaleStroke(stroke, 1);
    expect(scaled).toEqual(stroke);
  });

  it('scales axes independently for non-uniform scaling', () => {
    const stroke = normalizeInkStroke({
      size: 20,
      pts: [
        [10, 20, 1],
        [30, 40, 1],
      ],
    });
    const scaled = scaleStroke(stroke, 2, 1);
    expect(scaled.pts[0]).toEqual([20, 20, 1]);
    expect(scaled.pts[1]).toEqual([60, 40, 1]);
    expect(scaled.size).toBeCloseTo(20 * Math.SQRT2);
  });

  it('does not mutate the original stroke', () => {
    const stroke = normalizeInkStroke({
      size: 20,
      pts: [[10, 20, 1]],
    });
    const copy = structuredClone(stroke.pts);
    scaleStroke(stroke, 2);
    expect(stroke.pts).toEqual(copy);
    expect(stroke.size).toBe(20);
  });
});


import { stabilisePath, smoothPath } from './brush.js';

describe('stabilisePath', () => {
  it('returns the path untouched at zero', () => {
    const pts = [[0, 0, 1], [10, 5, 1], [20, 0, 1]];
    expect(stabilisePath(pts, 0)).toEqual(pts);
  });

  it('pulls a spike towards its neighbours', () => {
    const spiked = [[0, 0, 1], [10, 0, 1], [20, 50, 1], [30, 0, 1], [40, 0, 1]];
    const out = stabilisePath(spiked, 80);
    expect(out[2][1]).toBeLessThan(50);
    expect(out[2][1]).toBeGreaterThan(0);
  });

  it('keeps the first point exactly where the pointer went down', () => {
    const pts = [[3, 4, 1], [10, 0, 1], [20, 0, 1]];
    expect(stabilisePath(pts, 100)[0]).toEqual([3, 4, 1]);
  });

  it('keeps the point count', () => {
    const pts = Array.from({ length: 9 }, (_, i) => [i, i % 2, 1]);
    expect(stabilisePath(pts, 50)).toHaveLength(9);
  });
});

describe('smoothPath', () => {
  it('returns the path untouched at zero strength', () => {
    const pts = [[0, 0, 1], [10, 9, 1], [20, 0, 1]];
    expect(smoothPath(pts, 0, 0)).toEqual(pts);
  });

  it('flattens a jagged middle', () => {
    const pts = [[0, 0, 1], [10, 9, 1], [20, 0, 1]];
    expect(smoothPath(pts, 100, 0)[1][1]).toBeLessThan(9);
  });

  it('leaves a corner sharper than the threshold alone', () => {
    // A right angle: 90 degrees of turn, well past a 45 degree threshold.
    const corner = [[0, 0, 1], [10, 0, 1], [10, 10, 1]];
    expect(smoothPath(corner, 100, 45)[1]).toEqual([10, 0, 1]);
    // With corner protection off, the same vertex does move.
    expect(smoothPath(corner, 100, 0)[1]).not.toEqual([10, 0, 1]);
  });

  it('never moves the endpoints', () => {
    const pts = [[0, 0, 1], [10, 9, 1], [20, 0, 1]];
    const out = smoothPath(pts, 100, 0);
    expect(out[0]).toEqual([0, 0, 1]);
    expect(out.at(-1)).toEqual([20, 0, 1]);
  });

  it('handles a stroke too short to have a middle', () => {
    expect(smoothPath([[0, 0, 1]], 100, 0)).toEqual([[0, 0, 1]]);
    expect(smoothPath([[0, 0, 1], [1, 1, 1]], 100, 0)).toEqual([[0, 0, 1], [1, 1, 1]]);
  });
});

import {
  widthFactors,
  buildStroke,
  curveEval,
  dynCurve,
  defaultBrushSettings,
  DYN_CURVE_MAX_POINTS,
  DYN_SOURCES,
} from './brush.js';

const raw = (n, dx = 10, dt = 10, pressure = 0.5) =>
  Array.from({ length: n }, (_, i) => ({ x: i * dx, y: 0, pressure, t: i * dt }));

describe('widthFactors', () => {
  it('is flat at 1 when the source is off', () => {
    expect(widthFactors(raw(4), 'off', 100, 1)).toEqual([1, 1, 1, 1]);
  });

  it('follows pen pressure', () => {
    const pts = [
      { x: 0, y: 0, pressure: 0, t: 0 },
      { x: 10, y: 0, pressure: 1, t: 10 },
    ];
    const w = widthFactors(pts, 'pressure', 100, 1);
    expect(w[0]).toBeLessThan(w[1]);
    expect(w[1]).toBeCloseTo(1, 6);
  });

  it('at amount 0 the source no longer changes anything', () => {
    const pts = [
      { x: 0, y: 0, pressure: 0, t: 0 },
      { x: 10, y: 0, pressure: 1, t: 10 },
    ];
    expect(widthFactors(pts, 'pressure', 0, 1)).toEqual([1, 1]);
  });

  it('thins the fast part of a stroke and leaves the slow ends thick', () => {
    // Slow, then fast, then slow - the same shape the guide describes.
    const pts = [
      { x: 0, y: 0, pressure: 0.5, t: 0 },
      { x: 5, y: 0, pressure: 0.5, t: 100 },
      { x: 200, y: 0, pressure: 0.5, t: 120 },
      { x: 205, y: 0, pressure: 0.5, t: 220 },
    ];
    const w = widthFactors(pts, 'velocity', 100, 1);
    expect(w[2]).toBeLessThan(w[0]);
    expect(w[2]).toBeLessThan(w[3]);
  });

  it('is deterministic for random with a fixed seed', () => {
    expect(widthFactors(raw(6), 'random', 100, 9))
      .toEqual(widthFactors(raw(6), 'random', 100, 9));
    expect(widthFactors(raw(6), 'random', 100, 9))
      .not.toEqual(widthFactors(raw(6), 'random', 100, 10));
  });

  it('never returns a factor outside 0..1', () => {
    for (const src of DYN_SOURCES) {
      for (const w of widthFactors(raw(8), src, 100, 2)) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it('handles a single point without dividing by zero', () => {
    expect(widthFactors(raw(1), 'velocity', 100, 1)).toEqual([1]);
  });
});

// The shape the imported corpus really uses: full size by 1% pressure, flat
// after. Without the curve this pen draws as a plain linear one, which is the
// visible loss phase 6.3 exists to close.
const STEEP = [[0, 0], [0.01, 1], [1, 1]];

describe('curveEval', () => {
  it('is the identity when there is no usable curve', () => {
    for (const c of [undefined, null, 'curve', [], [[0, 0]], [[0, 0], [1, 1], 'x']]) {
      for (const t of [0, 0.25, 0.5, 1]) expect(curveEval(c, t)).toBe(t);
    }
    // And the identity line itself is, unsurprisingly, the identity.
    expect(curveEval([[0, 0], [1, 1]], 0.37)).toBeCloseTo(0.37, 12);
  });

  it('interpolates linearly inside a segment', () => {
    const c = [[0, 0], [0.5, 0.25], [1, 1]];
    expect(curveEval(c, 0.25)).toBeCloseTo(0.125, 12);
    expect(curveEval(c, 0.5)).toBeCloseTo(0.25, 12);
    expect(curveEval(c, 0.75)).toBeCloseTo(0.625, 12);
  });

  it('holds the end values outside the curve rather than extrapolating', () => {
    // A graph that starts at 0.2 and stops at 0.8 says nothing outside them.
    const c = [[0.2, 0.3], [0.8, 0.9]];
    expect(curveEval(c, 0)).toBe(0.3);
    expect(curveEval(c, 0.1)).toBe(0.3);
    expect(curveEval(c, 0.9)).toBe(0.9);
    expect(curveEval(c, 1)).toBe(0.9);
    // Inputs outside 0..1 clamp before the lookup, so nothing runs off the end.
    expect(curveEval(c, -5)).toBe(0.3);
    expect(curveEval(c, 42)).toBe(0.9);
    expect(curveEval(c, NaN)).toBe(0.3);
  });

  it('reads a repeated x as a step rather than dividing by zero', () => {
    const c = [[0, 0], [0.5, 0.2], [0.5, 0.8], [1, 1]];
    expect(curveEval(c, 0.5)).toBe(0.2);
    expect(curveEval(c, 0.6)).toBeCloseTo(0.84, 12);
    expect(Number.isFinite(curveEval([[0.5, 0.1], [0.5, 0.9]], 0.5))).toBe(true);
  });

  it('takes the drastic corpus shape at its word', () => {
    expect(curveEval(STEEP, 0)).toBe(0);
    expect(curveEval(STEEP, 0.005)).toBeCloseTo(0.5, 12);
    expect(curveEval(STEEP, 0.01)).toBe(1);
    expect(curveEval(STEEP, 0.4)).toBe(1);
  });

  it('is pure and deterministic', () => {
    const c = [[0, 0.2], [1, 0.9]];
    const once = curveEval(c, 0.3);
    expect(curveEval(c, 0.3)).toBe(once);
    expect(c).toEqual([[0, 0.2], [1, 0.9]]);
  });
});

describe('dynCurve', () => {
  it('accepts a graph and clamps its points into range', () => {
    expect(dynCurve([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
    expect(dynCurve([[-1, 2], [5, -3]])).toEqual([[0, 1], [1, 0]]);
    expect(dynCurve([['0.2', '0.4'], [0.9, 0.5]])).toEqual([[0.2, 0.4], [0.9, 0.5]]);
  });

  it('refuses a graph whole rather than dropping a point out of it', () => {
    for (const bad of [
      null,
      'curve',
      [],
      [[0, 0]],
      [[0, 0], [1, Infinity]],
      [[0, 0], [1, 'wide']],
      [[0, 0], 7],
      // x going backwards has no single output for an input.
      [[0, 0], [0.8, 0.5], [0.3, 0.9]],
      // Past the node cap the array is damage, not a graph.
      Array.from({ length: DYN_CURVE_MAX_POINTS + 1 }, (_, i) => [i / 40, 0.5]),
    ]) {
      expect(dynCurve(bad)).toBeNull();
    }
    expect(dynCurve(Array.from({ length: DYN_CURVE_MAX_POINTS }, (_, i) => [i / 40, 0.5])))
      .toHaveLength(DYN_CURVE_MAX_POINTS);
  });
});

describe('widthFactors with a response curve', () => {
  // A pressure ramp from nothing to full, which is what a light-to-heavy
  // gesture gives the engine.
  const ramp = (n = 11) =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, pressure: i / (n - 1), t: i * 10 }));

  it('brings a drastic curve to full width where a linear pen is still thin', () => {
    const plain = widthFactors(ramp(), 'pressure', 100, 1);
    const curved = widthFactors(ramp(), 'pressure', 100, 1, STEEP);
    // At 10% pressure the linear pen is at a tenth of its width; the curve's is
    // already at full size, which is the whole difference.
    expect(plain[1]).toBeCloseTo(0.1, 6);
    expect(curved[1]).toBe(1);
    // Only the very first sample, at zero pressure, is still thin.
    expect(curved[0]).toBeCloseTo(0.08, 6);
    for (let i = 1; i < curved.length; i++) expect(curved[i]).toBe(1);
  });

  it('leaves an identity curve and a missing one identical', () => {
    const want = widthFactors(ramp(), 'pressure', 70, 1);
    expect(widthFactors(ramp(), 'pressure', 70, 1, [[0, 0], [1, 1]])).toEqual(want);
    expect(widthFactors(ramp(), 'pressure', 70, 1, null)).toEqual(want);
    expect(widthFactors(ramp(), 'pressure', 70, 1, [[0, 0], [1, 'x']])).toEqual(want);
  });

  it('composes with the strength slider rather than replacing it', () => {
    // The curve says full width; amount 0 still means no dynamics at all.
    expect(widthFactors(ramp(), 'pressure', 0, 1, STEEP)).toEqual(new Array(11).fill(1));
    // Halfway up the slider a curve that says "thin" is only half applied.
    const flat = [[0, 0], [1, 0]];
    const half = widthFactors(ramp(2), 'pressure', 50, 1, flat);
    for (const w of half) expect(w).toBeCloseTo(1 - 0.5 * (1 - 0.08), 6);
  });

  it('remaps velocity and random too, not just pressure', () => {
    const flat = [[0, 0.5], [1, 0.5]];
    for (const src of ['velocity', 'random']) {
      for (const w of widthFactors(raw(8), src, 100, 3, flat)) {
        expect(w).toBeCloseTo(0.5, 6);
      }
    }
  });

  it('never returns a factor outside 0..1 whatever the curve', () => {
    for (const src of DYN_SOURCES) {
      for (const c of [STEEP, [[0, 1], [1, 0]], [[0.3, 0], [0.4, 1]]]) {
        for (const w of widthFactors(raw(8), src, 100, 2, c)) {
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('rides through buildStroke and survives the save', () => {
    // The curve is a capture-time input: `buildStroke` bakes its answer into
    // each point's width, so a saved project reproduces the stroke exactly
    // without the curve having to travel with it.
    const base = { ...defaultBrushSettings(), dyn: { src: 'pressure', amount: 100 } };
    const gesture = ramp(6);
    const plain = buildStroke(gesture, base);
    const curved = buildStroke(gesture, { ...base, dyn: { ...base.dyn, curve: STEEP } });
    expect(curved.pts.map((p) => p[2])).not.toEqual(plain.pts.map((p) => p[2]));
    expect(curved.pts[1][2]).toBeGreaterThan(plain.pts[1][2]);
    // Round trip through the data model unchanged, widths and all.
    expect(normalizeInkStroke(curved)).toEqual(curved);
    expect(normalizeInkStroke(curved).pts).toEqual(curved.pts);
    // And no `dyn` rides along: there is nothing left for it to decide.
    expect(curved.dyn).toBeUndefined();
    expect(normalizeInkStroke(curved).dyn).toBeUndefined();
  });
});

describe('buildStroke', () => {
  it('produces a stroke the data model accepts unchanged', () => {
    const s = { ...defaultBrushSettings(), size: 30 };
    const k = buildStroke(raw(5), s);
    expect(k).not.toBeNull();
    expect(k.size).toBe(30);
    expect(k.brush).toBe('round');
    expect(k.pts.length).toBeGreaterThan(1);
    expect(k.pts[0]).toHaveLength(3);
    expect(normalizeInkStroke(k)).toEqual(k);
  });

  it('keeps a tap as a one-point stroke', () => {
    const k = buildStroke(raw(1), defaultBrushSettings());
    expect(k.pts).toHaveLength(1);
  });

  it('returns null for an empty gesture', () => {
    expect(buildStroke([], defaultBrushSettings())).toBeNull();
    expect(buildStroke(null, defaultBrushSettings())).toBeNull();
  });

  it('gives every stroke its own seed so two identical drags differ under jitter', () => {
    const s = { ...defaultBrushSettings(), angleJitter: 100 };
    expect(buildStroke(raw(5), s).seed).not.toBe(buildStroke(raw(5), s).seed);
  });

  it('bakes correction into the points rather than storing the settings', () => {
    const shaky = [
      { x: 0, y: 0, pressure: 0.5, t: 0 },
      { x: 10, y: 40, pressure: 0.5, t: 10 },
      { x: 20, y: 0, pressure: 0.5, t: 20 },
    ];
    const s = { ...defaultBrushSettings(), stabilise: 90, postCorrect: 100 };
    const k = buildStroke(shaky, s);
    expect(k.stabilise).toBeUndefined();
    expect(k.postCorrect).toBeUndefined();
    expect(Math.max(...k.pts.map((p) => p[1]))).toBeLessThan(40);
  });

  it('carries the anti-alias grade onto the stroke it stores', () => {
    const on = buildStroke(raw(5), { ...defaultBrushSettings(), antialias: true });
    const off = buildStroke(raw(5), { ...defaultBrushSettings(), antialias: false });
    const weak = buildStroke(raw(5), { ...defaultBrushSettings(), antialias: 1 });
    expect(on.antialias).toBe(3);
    expect(off.antialias).toBe(0);
    expect(weak.antialias).toBe(1);
    expect(normalizeInkStroke(off)).toEqual(off);
  });

  it('treats settings with no anti-alias field as Strong', () => {
    const s = defaultBrushSettings();
    delete s.antialias;
    expect(buildStroke(raw(5), s).antialias).toBe(3);
  });

  it('carries the flips, the blend, the grain and the corner threshold', () => {
    const s = {
      ...defaultBrushSettings(),
      flipX: 'random', flipY: 'on', blend: 'density',
      texture: { on: true, density: 0.8, scale: 300, stress: true },
      sharpAngles: { on: true, deg: 60 },
    };
    const k = buildStroke(raw(5), s);
    expect([k.flipX, k.flipY, k.blend, k.corners]).toEqual(['random', 'on', 'density', 60]);
    expect(k.texture).toEqual({ on: true, density: 0.8, scale: 300, stress: true });
    expect(normalizeInkStroke(k)).toEqual(k);
    // Sharp angles off: no corners are pointed, whatever the threshold says.
    expect(buildStroke(raw(5), { ...s, sharpAngles: { on: false, deg: 60 } }).corners).toBe(0);
    // And settings from before any of it existed read as off.
    const old = buildStroke(raw(5), defaultBrushSettings());
    expect([old.flipX, old.flipY, old.blend, old.corners, old.texture.on]).toEqual(['off', 'off', 'over', 0, false]);
  });

  it('carries the watercolour edge onto the stroke it stores', () => {
    const s = { ...defaultBrushSettings(), waterEdge: true, waterEdgeWidth: 7, waterEdgePower: 0.25 };
    const k = buildStroke(raw(5), s);
    expect(k.waterEdge).toBe(true);
    expect(k.waterEdgeWidth).toBe(7);
    expect(k.waterEdgePower).toBe(0.25);
    expect(normalizeInkStroke(k)).toEqual(k);
  });

  it('treats settings with no watercolour edge as plain ink', () => {
    // The opposite reading to anti-aliasing: the rim is a look, so nothing but
    // a deliberate true asks for it.
    const s = defaultBrushSettings();
    delete s.waterEdge;
    delete s.waterEdgeWidth;
    delete s.waterEdgePower;
    const k = buildStroke(raw(5), s);
    expect(k.waterEdge).toBe(false);
    expect(k.waterEdgeWidth).toBe(4);
    expect(k.waterEdgePower).toBe(0.5);
    expect(normalizeInkStroke(k)).toEqual(k);
  });

  it('starts the tool with the edge off', () => {
    expect(defaultBrushSettings().waterEdge).toBe(false);
  });
});

import { strokeHit } from './brush.js';

describe('strokeHit', () => {
  const k = normalizeInkStroke({ size: 20, spacing: 25, pts: [[0, 0, 1], [100, 0, 1]] });

  it('hits a point on the stroke', () => {
    expect(strokeHit(k, 50, 0, 1)).toBe(true);
  });

  it('hits within the stamp radius, not only on the centre line', () => {
    expect(strokeHit(k, 50, 9, 1)).toBe(true);
  });

  it('misses beyond the stamp radius plus the eraser radius', () => {
    expect(strokeHit(k, 50, 40, 5)).toBe(false);
  });

  it('misses past the end of the stroke', () => {
    expect(strokeHit(k, 200, 0, 5)).toBe(false);
  });

  it('is false for a stroke that paints nothing', () => {
    expect(strokeHit(normalizeInkStroke({ size: 20, pts: [[0, 0, 0]] }), 0, 0, 5)).toBe(false);
  });
});

// ===========================================================================
// Sharp angles and rounded ones
// ===========================================================================
// A corner is protected by BOTH corrections or by neither: stabilisation
// rounds it before smoothing ever sees it, so the guard has to sit in front of
// both. And smoothing is stated in page px, not in samples: a hand that slows
// into a corner leaves points a px apart, a hand that sweeps leaves them ten
// apart, and the same slider has to round both the same amount.
import { sharpCorners } from './brush.js';

// An L, right then down, sampled every `step` px.
const ell = (step) => {
  const out = [];
  for (let x = 0; x <= 100; x += step) out.push([x, 0, 1]);
  for (let y = step; y <= 100; y += step) out.push([100, y, 1]);
  return out;
};
const cornerMiss = (pts) => Math.min(...pts.map(([x, y]) => Math.hypot(x - 100, y)));

describe('sharpCorners', () => {
  it('finds a corner the hand spread over several points, once', () => {
    const spread = [[0, 0, 1], [4, 0, 1], [8, 0, 1], [10, 0, 1], [11, 1, 1], [12, 3, 1], [12, 7, 1], [12, 11, 1], [12, 15, 1]];
    const pins = [...sharpCorners(spread, 45)];
    expect(pins).toHaveLength(1);
    expect([3, 4, 5]).toContain(pins[0]);
  });

  it('finds nothing at a threshold of zero, and nothing in a one-px wobble', () => {
    expect(sharpCorners(ell(4), 0).size).toBe(0);
    const wobble = Array.from({ length: 30 }, (_, i) => [i, i % 2, 1]);
    expect(sharpCorners(wobble, 45).size).toBe(0);
  });
});

describe('a protected corner', () => {
  it('survives stabilisation exactly, and moves without the guard', () => {
    const pts = ell(4);
    expect(stabilisePath(pts, 60, 45)).toContainEqual([100, 0, 1]);
    expect(cornerMiss(stabilisePath(pts, 60, 0))).toBeGreaterThan(1);
  });

  it('survives both passes end to end with the hand steadied hard', () => {
    const raw = ell(4).map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
    const s = { ...defaultBrushSettings(), stabilise: 40, postCorrect: 60, sharpAngles: { on: true, deg: 45 }, dyn: { src: 'off' } };
    expect(buildStroke(raw, s).pts).toContainEqual([100, 0, 1]);
  });
});

describe('a rounded corner', () => {
  it('is rounded the same whether the hand was slow or fast', () => {
    const slow = cornerMiss(smoothPath(ell(1), 100, 0));
    const fast = cornerMiss(smoothPath(ell(4), 100, 0));
    expect(slow).toBeGreaterThan(2);
    expect(Math.abs(slow - fast)).toBeLessThan(0.5);
  });

  it('is rounded less at a lower setting, and not at all when protected', () => {
    expect(cornerMiss(smoothPath(ell(2), 35, 0))).toBeLessThan(cornerMiss(smoothPath(ell(2), 100, 0)));
    expect(cornerMiss(smoothPath(ell(2), 100, 45))).toBe(0);
  });

  it('leaves a straight run straight', () => {
    const run = Array.from({ length: 40 }, (_, i) => [i * 3, 10, 1]);
    for (const [, y] of smoothPath(run, 100, 0)) expect(y).toBeCloseTo(10, 9);
  });
});

// ===========================================================================
// What phase 7 added: the CSP settings the corpus actually uses
// ===========================================================================
import { taperPx, tipIndex, speedProfile, smoothReach, TIP_ORDERS } from './brush.js';

describe('taperPx', () => {
  it('reads a percentage taper against the brush size and a px one as is', () => {
    expect(taperPx({ len: 30, mode: 'pct' }, 200)).toBe(60);
    expect(taperPx({ len: 30, mode: 'px' }, 200)).toBe(30);
    expect(taperPx({ len: 30 }, 200)).toBe(30);
  });

  it('rides through strokeStamps: the same percentage tapers a bigger brush further', () => {
    const k = (size) => normalizeInkStroke({
      size, spacing: 10, taperIn: { on: true, len: 50, ratio: 0, mode: 'pct' }, taperOut: { on: false },
      pts: line(60, 10),
    });
    const at = (size, x) => strokeStamps(k(size)).find((s) => Math.abs(s.x - x) < 0.6).size / size;
    // Half the size in: the 20 px brush is past its 10 px taper, the 100 px
    // brush is still climbing its 50 px one.
    expect(at(20, 20)).toBeCloseTo(1, 5);
    expect(at(100, 20)).toBeLessThan(0.5);
  });
});

describe('tipIndex', () => {
  it('cycles, ping-pongs, stops, or draws at random', () => {
    const seq = (order, n, count) => Array.from({ length: count }, (_, i) => tipIndex(order, i, n, () => 0.6));
    expect(seq('repeat', 3, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(seq('reverse', 3, 7)).toEqual([0, 1, 2, 1, 0, 1, 2]);
    expect(seq('once', 3, 5)).toEqual([0, 1, 2, 2, 2]);
    expect(seq('random', 3, 3)).toEqual([1, 1, 1]);
    expect(tipIndex('repeat', 5, 1, () => 0)).toBe(0);
    expect(TIP_ORDERS).toContain('random');
  });

  it('is put on the stamps of a stroke that carries a cycle, and on no other', () => {
    const k = normalizeInkStroke({ size: 10, spacing: 100, tips: ['a', 'b'], tipOrder: 'repeat', pts: line(5, 10) });
    expect(strokeStamps(k).map((s) => s.tip)).toEqual([0, 1, 0, 1, 0]);
    const one = normalizeInkStroke({ size: 10, spacing: 100, tips: ['a'], pts: line(3, 10) });
    expect(one.tips).toBeUndefined();
    expect(strokeStamps(one)[0].tip).toBeUndefined();
  });
});

describe('a ribbon stroke', () => {
  it('is cut into slices that tile the path, each facing along it', () => {
    const k = normalizeInkStroke({ size: 24, spacing: 10, ribbon: true, angle: 0, pts: line(11, 10) });
    const st = strokeStamps(k);
    expect(st.length).toBeGreaterThan(20);
    // The slices cover the path once: their lengths sum to its length.
    expect(st.reduce((a, s) => a + s.len, 0)).toBeCloseTo(100, 0);
    // Along a rightward line every slice stands up 90 degrees to it.
    for (const s of st) expect(s.angle).toBeCloseTo(-90, 5);
    expect(st.at(-1).d).toBeCloseTo(100, 0);
  });

  it('turns with the path, as a stamped tip does under follow-direction', () => {
    const down = [[0, 0, 1], [0, 50, 1], [0, 100, 1]];
    const rib = strokeStamps(normalizeInkStroke({ size: 24, ribbon: true, pts: down }));
    expect(rib[5].angle).toBeCloseTo(0, 5); // heading 90, less the quarter turn
    const follow = strokeStamps(normalizeInkStroke({ size: 24, spacing: 50, followDir: true, angle: 10, pts: down }));
    expect(follow[1].angle).toBeCloseTo(100, 5);
    const fixed = strokeStamps(normalizeInkStroke({ size: 24, spacing: 50, angle: 10, pts: down }));
    expect(fixed[1].angle).toBe(10);
  });
});

describe('speedProfile and the speed-aware corrections', () => {
  const gesture = (speeds) => {
    let x = 0;
    return speeds.map((v, i) => {
      x += v * 10;
      return { x, y: 0, pressure: 0.5, t: i * 10 };
    });
  };

  it('is the speed at each point against the fastest, 0..1', () => {
    const p = speedProfile(gesture([1, 1, 4, 1]));
    expect(p[2]).toBe(1);
    expect(p[1]).toBeCloseTo(0.25, 5);
    expect(p[0]).toBe(p[1]);
    expect(speedProfile([{ x: 0, y: 0, t: 0 }])).toEqual([0]);
  });

  it('reach grows past the old 12 px at the top of the slider', () => {
    expect(smoothReach(35)).toBeCloseTo(12.4, 0);
    expect(smoothReach(100)).toBe(60);
    expect(smoothReach(0)).toBe(0);
  });

  it('smooths a fast stretch harder than a slow one when asked', () => {
    // A wobble at the same amplitude in a slow stretch and a fast one.
    const pts = [];
    const speed = [];
    for (let i = 0; i < 40; i++) {
      pts.push([i * 2, i % 2 ? 6 : 0, 1]);
      speed.push(0.1);
    }
    for (let i = 0; i < 40; i++) {
      pts.push([80 + i * 2, i % 2 ? 6 : 0, 1]);
      speed.push(1);
    }
    const out = smoothPath(pts, 40, 0, speed);
    const wobble = (from, to) => {
      let m = 0;
      for (let i = from; i < to; i++) m = Math.max(m, Math.abs(out[i][1] - 3));
      return m;
    };
    expect(wobble(10, 30)).toBeGreaterThan(wobble(50, 70));
  });

  it('shortens the taper of an end the hand crawled through', () => {
    const slowIn = gesture([0.2, 0.2, 0.2, 0.2, 1, 1, 1, 1, 1, 1, 1, 1]);
    const s = { ...defaultBrushSettings(), taperBySpeed: true, taperIn: { on: true, len: 20, ratio: 0, mode: 'px' }, dyn: { src: 'off' } };
    const k = buildStroke(slowIn, s);
    expect(k.taperIn.len).toBeLessThan(20);
    expect(k.taperIn.len).toBeGreaterThanOrEqual(4);
    expect(buildStroke(slowIn, { ...s, taperBySpeed: false }).taperIn.len).toBe(20);
  });
});

import { splinePath, aaLevel, FLIP_MODES, BLEND_MODES, AA_LEVELS } from './brush.js';

describe('aaLevel', () => {
  it('reads the old switch as the two ends and a grade as itself', () => {
    expect(aaLevel(true)).toBe(3);
    expect(aaLevel(false)).toBe(0);
    expect(aaLevel(undefined)).toBe(3);
    expect(aaLevel(2)).toBe(2);
    expect(aaLevel('1')).toBe(1);
    expect(aaLevel(7)).toBe(3);
    expect(aaLevel(-1)).toBe(0);
    expect(aaLevel('weak')).toBe(3);
    expect(AA_LEVELS).toHaveLength(4);
    expect(FLIP_MODES).toEqual(['off', 'on', 'random']);
    expect(BLEND_MODES).toEqual(['over', 'density']);
  });
});

describe('the flips on the stamps', () => {
  const k = (extra) => normalizeInkStroke({ size: 10, spacing: 50, pts: [[0, 0, 1], [100, 0, 1]], seed: 3, ...extra });

  it('marks every stamp when fixed, none when off, and some when random', () => {
    expect(strokeStamps(k({})).every((s) => s.fx === undefined && s.fy === undefined)).toBe(true);
    expect(strokeStamps(k({ flipX: 'on' })).every((s) => s.fx === -1 && s.fy === 1)).toBe(true);
    expect(strokeStamps(k({ flipY: 'on' })).every((s) => s.fy === -1)).toBe(true);
    const rand = strokeStamps(k({ flipX: 'random' }));
    expect(rand.some((s) => s.fx === -1)).toBe(true);
    expect(rand.some((s) => s.fx === undefined || s.fx === 1)).toBe(true);
    expect(strokeStamps(k({ flipX: 'random' }))).toEqual(rand);
  });

  it('does not shift the angle jitter or the tip cycle', () => {
    const plain = strokeStamps(k({ angleJitter: 100, tips: ['a', 'b', 'c'], tipOrder: 'random' }));
    const flipped = strokeStamps(k({ angleJitter: 100, tips: ['a', 'b', 'c'], tipOrder: 'random', flipX: 'random' }));
    expect(flipped.map((s) => s.angle)).toEqual(plain.map((s) => s.angle));
    expect(flipped.map((s) => s.tip)).toEqual(plain.map((s) => s.tip));
  });
});

describe('splinePath', () => {
  it('passes through every point and keeps the ends exactly', () => {
    const pts = [[0, 0, 1], [10, 20, 0.5], [30, 0, 1], [40, 30, 1]];
    const out = splinePath(pts);
    expect(out[0]).toEqual([0, 0, 1]);
    expect(out[out.length - 1]).toEqual([40, 30, 1]);
    for (const p of pts) {
      expect(out.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 1e-9)).toBe(true);
    }
    expect(out.length).toBeGreaterThan(pts.length);
    // Width rides along: between 1 and 0.5 the samples sit between them.
    for (const [, , w] of out) {
      expect(w).toBeGreaterThanOrEqual(0.5);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('bends a polyline into a curve, and leaves a protected corner sharp', () => {
    // A zigzag of three points: the middle one is a corner. Unprotected the
    // curve overshoots past it; protected it does not.
    const pts = [[0, 0, 1], [50, 0, 1], [50, 50, 1]];
    const free = splinePath(pts, 0);
    const pinned = splinePath(pts, 45);
    expect(Math.max(...free.map(([x]) => x))).toBeGreaterThan(50.5);
    expect(Math.max(...pinned.map(([x]) => x))).toBeLessThanOrEqual(50 + 1e-9);
    expect(Math.min(...pinned.map(([, y]) => y))).toBeGreaterThanOrEqual(-1e-9);
  });

  it('is what buildStroke fits when asked, and only then', () => {
    const wobble = Array.from({ length: 30 }, (_, i) => ({ x: i * 4, y: (i % 3) * 3, pressure: 0.5, t: i * 10 }));
    const base = { ...defaultBrushSettings(), stabilise: 0, postCorrect: 40, dyn: { src: 'off' } };
    const poly = buildStroke(wobble, base);
    const curve = buildStroke(wobble, { ...base, postBezier: true });
    expect(curve.pts.length).toBeGreaterThan(poly.pts.length);
    expect(curve.pts[0]).toEqual(poly.pts[0]);
    expect(curve.pts.at(-1)).toEqual(poly.pts.at(-1));
    // No post correction, no curve: the option is under that slider.
    expect(buildStroke(wobble, { ...base, postCorrect: 0, postBezier: true }).pts).toHaveLength(30);
  });
});

describe('stabilisation by speed', () => {
  it('steadies a slow stretch harder than a fast one when asked', () => {
    const pts = [];
    const speed = [];
    for (let i = 0; i < 40; i++) {
      pts.push([i * 2, i % 2 ? 6 : 0, 1]);
      speed.push(0.1);
    }
    for (let i = 0; i < 40; i++) {
      pts.push([80 + i * 2, i % 2 ? 6 : 0, 1]);
      speed.push(1);
    }
    const out = stabilisePath(pts, 60, 0, speed);
    const wobble = (from, to) => {
      let m = 0;
      for (let i = from; i < to; i++) m = Math.max(m, Math.abs(out[i][1] - 3));
      return m;
    };
    expect(wobble(10, 30)).toBeLessThan(wobble(50, 70));
    // Without the profile both halves are treated alike.
    const flat = stabilisePath(pts, 60, 0);
    const w2 = (from, to) => Math.max(...flat.slice(from, to).map((p) => Math.abs(p[1] - 3)));
    expect(Math.abs(w2(10, 30) - w2(50, 70))).toBeLessThan(0.5);
  });

  it('is switched on from the settings', () => {
    const slowThenFast = [];
    for (let i = 0; i < 20; i++) slowThenFast.push({ x: i * 2, y: i % 2 ? 6 : 0, pressure: 0.5, t: i * 40 });
    for (let i = 0; i < 20; i++) slowThenFast.push({ x: 40 + i * 8, y: i % 2 ? 6 : 0, pressure: 0.5, t: 800 + i * 10 });
    const base = { ...defaultBrushSettings(), stabilise: 60, postCorrect: 0, dyn: { src: 'off' } };
    const off = buildStroke(slowThenFast, base).pts;
    const on = buildStroke(slowThenFast, { ...base, stabiliseBySpeed: true }).pts;
    const wob = (pts, from, to) => Math.max(...pts.slice(from, to).map((p) => Math.abs(p[1] - 3)));
    expect(wob(on, 5, 18)).toBeLessThanOrEqual(wob(off, 5, 18));
    expect(wob(on, 25, 38)).toBeGreaterThanOrEqual(wob(off, 25, 38));
  });
});

describe('the pointed corners on the stamps', () => {
  const bend = (extra) => normalizeInkStroke({
    size: 20, spacing: 10, pts: [[0, 0, 1], [60, 0, 1], [60, 60, 1]], seed: 1,
    taperIn: { on: false }, taperOut: { on: false }, ...extra,
  });

  it('adds stamps that reach the square corner and shrink towards it', () => {
    const extra = strokeStamps(bend({ corners: 45 })).slice(strokeStamps(bend({})).length);
    expect(extra.length).toBeGreaterThan(0);
    // Every extra stamp sits outside the turn - above and to the right of
    // the vertex - and inside the square corner at (70, -10).
    for (const s of extra) {
      expect(s.x).toBeGreaterThan(60);
      expect(s.y).toBeLessThan(0);
      expect(s.x + s.size / 2).toBeLessThanOrEqual(70 + 1e-6);
      expect(s.y - s.size / 2).toBeGreaterThanOrEqual(-10 - 1e-6);
    }
    // The nearest to the point is the smallest.
    const tipmost = extra.reduce((a, b) => (Math.hypot(b.x - 70, b.y + 10) < Math.hypot(a.x - 70, a.y + 10) ? b : a));
    expect(tipmost.size).toBeLessThan(1);
    expect(Math.hypot(tipmost.x - 70, tipmost.y + 10)).toBeLessThan(0.5);
  });

  it('caps a hairpin at the mitre limit rather than running off', () => {
    const hairpin = normalizeInkStroke({
      size: 20, spacing: 10, pts: [[0, 0, 1], [60, 0, 1], [0, 4, 1]], seed: 1,
      taperIn: { on: false }, taperOut: { on: false }, corners: 45,
    });
    for (const s of strokeStamps(hairpin)) expect(s.x).toBeLessThan(60 + 10 * 4 + 1);
    // And the bounds follow the stamps, so the export pads for the point.
    const b = strokeBounds(bend({ corners: 45 }));
    expect(b.maxX).toBeGreaterThanOrEqual(69.5);
    expect(b.minY).toBeLessThanOrEqual(-9.5);
  });

  it('leaves a ribbon alone', () => {
    expect(strokeStamps(bend({ corners: 45, ribbon: true })).every((s) => s.len > 0)).toBe(true);
  });
});

import { dynFactors, mixPoint, movePoint, ptFactor, PT_O, PT_F } from './brush.js';

describe('the opacity and thickness factors on a point', () => {
  const pts5 = [[0, 0, 1, 1, 1], [100, 0, 0.5, 0.2, 0.4]];

  it('mixPoint interpolates every factor and treats a missing one as 1', () => {
    expect(mixPoint(pts5[0], pts5[1], 0.5)).toEqual([50, 0, 0.75, 0.6, 0.7]);
    expect(mixPoint([0, 0, 1], [10, 0, 0, 0, 0], 0.5)).toEqual([5, 0, 0.5, 0.5, 0.5]);
    expect(mixPoint([0, 0], [10, 0], 0.5)).toEqual([5, 0, 1]);
  });

  it('movePoint keeps the factors and pads a bare pair to a width of 1', () => {
    expect(movePoint([1, 2, 0.5, 0.3, 0.9], 7, 8)).toEqual([7, 8, 0.5, 0.3, 0.9]);
    expect(movePoint([1, 2], 7, 8)).toEqual([7, 8, 1]);
    expect(ptFactor([0, 0, 0.5], PT_O)).toBe(1);
    expect(ptFactor([0, 0, 0.5, 0.25, 0.75], PT_F)).toBe(0.75);
  });

  it('survive resampling, both corrections and the spline', () => {
    const p = [[0, 0, 1, 1, 1], [50, 5, 1, 0.5, 0.5], [100, 0, 1, 0, 0]];
    for (const out of [stabilisePath(p, 60), smoothPath(p, 60, 0), splinePath(p)]) {
      expect(out.every((q) => q.length === 5)).toBe(true);
      const mid = out[Math.floor(out.length / 2)];
      expect(mid[PT_O]).toBeGreaterThan(0);
      expect(mid[PT_O]).toBeLessThan(1);
      expect(out.at(-1).slice(2)).toEqual([1, 0, 0]);
    }
    // The resample walks by arc length and stops short of the end, so its last
    // point is interpolated rather than copied.
    const re = resamplePath(p, 10);
    expect(re.every((q) => q.length === 5)).toBe(true);
    expect(re.at(-1)[PT_O]).toBeLessThan(0.05);
    expect(re[Math.floor(re.length / 2)][PT_F]).toBeCloseTo(0.5, 1);
  });

  it('fade the stamps and squash them', () => {
    const k = normalizeInkStroke({ brush: 'round', size: 10, opacity: 0.8, flatness: 0.5, spacing: 50, pts: pts5 });
    const st = strokeStamps(k);
    expect(st[0].alpha).toBeCloseTo(0.8);
    expect(st[0].flat).toBeUndefined();
    expect(st.at(-1).alpha).toBeCloseTo(0.8 * 0.2);
    expect(st.at(-1).flat).toBeCloseTo(0.5 * 0.4);
    // A plain stroke's stamps carry neither.
    const plain = strokeStamps(normalizeInkStroke({ brush: 'round', size: 10, pts: [[0, 0, 1], [100, 0, 1]] }));
    expect(plain.every((s) => s.alpha === 1 && s.flat === undefined)).toBe(true);
  });

  it('reach the pointed corners', () => {
    const k = normalizeInkStroke({
      brush: 'round', size: 12, opacity: 1, spacing: 25, corners: 45,
      pts: [[0, 0, 1, 0.5, 0.5], [40, 0, 1, 0.5, 0.5], [40, 40, 1, 0.5, 0.5]],
    });
    const st = strokeStamps(k);
    expect(st.length).toBeGreaterThan(0);
    expect(st.every((s) => Math.abs(s.alpha - 0.5) < 1e-9 && Math.abs(s.flat - 0.5) < 1e-9)).toBe(true);
  });
});

describe('dynFactors and buildStroke with three dynamics', () => {
  const pressing = (n) =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, pressure: i / (n - 1), t: i * 10 }));

  it('is all ones when only the size is driven, and the stroke stays three numbers wide', () => {
    const s = { ...defaultBrushSettings(), dyn: { src: 'pressure', amount: 100 } };
    const f = dynFactors(pressing(5), s, 1);
    expect(f.o).toEqual([1, 1, 1, 1, 1]);
    expect(f.f).toEqual([1, 1, 1, 1, 1]);
    expect(f.w[0]).toBeLessThan(f.w[4]);
    const k = buildStroke(pressing(5), s);
    expect(k.pts.every((p) => p.length === 3)).toBe(true);
  });

  it('lets opacity fade to nothing but keeps the width and thickness off the floor', () => {
    const s = {
      ...defaultBrushSettings(),
      dyn: { src: 'pressure', amount: 100 },
      dynOpacity: { src: 'pressure', amount: 100 },
      dynThick: { src: 'pressure', amount: 100 },
    };
    const f = dynFactors(pressing(5), s, 1);
    expect(f.o[0]).toBe(0);
    expect(f.w[0]).toBeGreaterThan(0);
    expect(f.f[0]).toBeGreaterThan(0);
    expect(f.o[4]).toBe(1);
    const k = buildStroke(pressing(5), s);
    expect(k.pts.every((p) => p.length === 5)).toBe(true);
    expect(k.pts[0][PT_O]).toBe(0);
    expect(k.pts[4][PT_O]).toBe(1);
    expect(normalizeInkStroke(k)).toEqual(k);
  });

  it('gives each random source its own stream', () => {
    const s = {
      ...defaultBrushSettings(),
      dyn: { src: 'random', amount: 100 },
      dynOpacity: { src: 'random', amount: 100 },
      dynThick: { src: 'random', amount: 100 },
    };
    const f = dynFactors(pressing(8), s, 3);
    expect(f.w).not.toEqual(f.o);
    expect(f.o).not.toEqual(f.f);
    // And the same seed gives the same draw, so a saved stroke is stable.
    expect(dynFactors(pressing(8), s, 3)).toEqual(f);
  });

  it('honours an opacity amount below full and a response curve', () => {
    const s = {
      ...defaultBrushSettings(),
      dynOpacity: { src: 'pressure', amount: 50, curve: [[0, 1], [1, 1]] },
    };
    // The curve holds the output at 1 whatever the pressure: nothing fades.
    expect(dynFactors(pressing(4), s, 1).o).toEqual([1, 1, 1, 1]);
    const half = { ...defaultBrushSettings(), dynOpacity: { src: 'pressure', amount: 50 } };
    expect(dynFactors(pressing(3), half, 1).o[0]).toBeCloseTo(0.5);
  });

  it('settings with no opacity or thickness dynamics at all still build', () => {
    const s = defaultBrushSettings();
    delete s.dynOpacity;
    delete s.dynThick;
    const k = buildStroke(pressing(4), s);
    expect(k.pts.every((p) => p.length === 3)).toBe(true);
  });
});
