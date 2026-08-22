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
