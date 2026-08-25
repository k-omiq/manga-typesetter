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

import { widthFactors, buildStroke, defaultBrushSettings, DYN_SOURCES } from './brush.js';

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
