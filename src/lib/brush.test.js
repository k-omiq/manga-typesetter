import { describe, it, expect } from 'vitest';
import { resamplePath, strokeStamps, strokeBounds, mulberry32 } from './brush.js';
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

  it('carries the anti-alias choice onto the stroke it stores', () => {
    const on = buildStroke(raw(5), { ...defaultBrushSettings(), antialias: true });
    const off = buildStroke(raw(5), { ...defaultBrushSettings(), antialias: false });
    expect(on.antialias).toBe(true);
    expect(off.antialias).toBe(false);
    expect(normalizeInkStroke(off)).toEqual(off);
  });

  it('treats settings with no anti-alias field as anti-aliased', () => {
    const s = defaultBrushSettings();
    delete s.antialias;
    expect(buildStroke(raw(5), s).antialias).toBe(true);
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
