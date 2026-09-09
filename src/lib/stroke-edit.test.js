import { describe, it, expect } from 'vitest';
import { cutStroke, cutToIntersection, adjustWidth, segmentCircle, segmentsCross } from './stroke-edit.js';

// Plain stroke objects rather than `normalizeInkStroke`'s: the sanitiser pads
// every point to three numbers, and half of what is checked below is what
// happens to a tuple that is shorter or longer than that.
const stroke = (pts, extra) => freeze({ brush: 'round', size: 24, color: '#000000', seed: 7, ...extra, pts });

// Deep-freeze, so a test that hands input in gets a TypeError (module code is
// strict-mode ESM) the moment anything writes to it, at any depth.
function freeze(v) {
  if (v && typeof v === 'object') {
    Object.getOwnPropertyNames(v).forEach((k) => freeze(v[k]));
    Object.freeze(v);
  }
  return v;
}

// A horizontal line from (0, 50) to (100, 50), the ruler most of the cuts below
// are measured against.
const line = (y = 50) => stroke([[0, y], [100, y]]);

describe('segmentCircle', () => {
  it('gives the two crossings of a chord', () => {
    // The circle at (50, 0) of radius 10 cuts the x axis at 40 and 60.
    expect(segmentCircle(0, 0, 100, 0, 50, 0, 10)).toEqual([0.4, 0.6]);
  });

  it('clips to the segment, so a segment starting inside enters at 0', () => {
    expect(segmentCircle(50, 0, 100, 0, 50, 0, 10)).toEqual([0, 0.2]);
    expect(segmentCircle(0, 0, 50, 0, 50, 0, 10)).toEqual([0.8, 1]);
  });

  it('is null for a miss, a tangent and an unusable radius', () => {
    expect(segmentCircle(0, 0, 100, 0, 50, 40, 10)).toBe(null);
    expect(segmentCircle(0, 0, 100, 0, 50, 10, 10)).toBe(null); // grazes the rim
    expect(segmentCircle(0, 0, 100, 0, 50, 0, 0)).toBe(null);
  });
});

describe('segmentsCross', () => {
  it('gives the fraction along each segment', () => {
    expect(segmentsCross(0, 0, 100, 0, 60, -50, 60, 50)).toEqual([0.6, 0.5]);
  });

  it('counts a line that ends ON this one, but not one that shares an endpoint', () => {
    // A T junction: the second segment stops dead on the first.
    expect(segmentsCross(0, 0, 100, 0, 50, -50, 50, 0)).toEqual([0.5, 1]);
    // Two legs of the same path meeting at a vertex are not a crossing.
    expect(segmentsCross(0, 0, 50, 0, 50, 0, 50, 50)).toBe(null);
  });

  it('is null for parallel segments, collinear ones included', () => {
    expect(segmentsCross(0, 0, 100, 0, 0, 10, 100, 10)).toBe(null);
    expect(segmentsCross(0, 0, 100, 0, 50, 0, 150, 0)).toBe(null);
  });
});

describe('cutStroke', () => {
  it('takes the touched part out of the middle and cuts on the circle', () => {
    const s = line();
    const out = cutStroke(s, 50, 50, 10);
    expect(out.length).toBe(2);
    expect(out[0].pts).toEqual([[0, 50], [40, 50]]);
    expect(out[1].pts).toEqual([[60, 50], [100, 50]]);
    // Both halves are still the stroke they came from.
    expect(out[0].brush).toBe('round');
    expect(out[0].size).toBe(24);
    expect(out[1].color).toBe('#000000');
    expect(out[0]).not.toBe(s);
  });

  it('interpolates the width factor at the cut', () => {
    const s = stroke([[0, 0, 0], [100, 0, 1]]);
    const out = cutStroke(s, 50, 0, 10);
    expect(out[0].pts).toEqual([[0, 0, 0], [40, 0, 0.4]]);
    expect(out[1].pts).toEqual([[60, 0, 0.6], [100, 0, 1]]);
  });

  it('interpolates every extra a five-tuple carries', () => {
    const s = stroke([[0, 0, 0, 0.2, 1], [100, 0, 1, 0.7, 0]]);
    const out = cutStroke(s, 50, 0, 10);
    const [x, y, w, o, f] = out[0].pts[1];
    expect([x, y]).toEqual([40, 0]);
    expect(w).toBeCloseTo(0.4, 12);
    expect(o).toBeCloseTo(0.4, 12); // 0.2 -> 0.7 at 0.4 of the way
    expect(f).toBeCloseTo(0.6, 12); // 1 -> 0 at 0.4 of the way
    // A kept point comes back whole, at the length it was stored with.
    expect(out[0].pts[0]).toEqual([0, 0, 0, 0.2, 1]);
    expect(out[1].pts[1]).toEqual([100, 0, 1, 0.7, 0]);
  });

  it('interpolates over the longer tuple, a missing factor reading as 1', () => {
    const s = stroke([[0, 0], [100, 0, 1, 0.5]]);
    const out = cutStroke(s, 50, 0, 10);
    const cut = out[0].pts[1];
    expect(cut.length).toBe(4);
    expect(cut[2]).toBeCloseTo(1, 12); // 1 (absent) -> 1
    expect(cut[3]).toBeCloseTo(0.8, 12); // 1 (absent) -> 0.5 at 0.4
    // And the untouched end of the stroke keeps its two numbers.
    expect(out[0].pts[0]).toEqual([0, 0]);
  });

  it('cuts a segment twice when the path dips in and back out of the circle', () => {
    // One long segment through a small circle is the same cut, stated as the
    // pair of crossings on a single segment.
    const out = cutStroke(stroke([[0, 0], [200, 0]]), 100, 0, 20);
    expect(out.map((p) => p.pts)).toEqual([[[0, 0], [80, 0]], [[120, 0], [200, 0]]]);
  });

  it('leaves one piece when the cut is at the start', () => {
    const out = cutStroke(line(), 0, 50, 10);
    expect(out.length).toBe(1);
    expect(out[0].pts).toEqual([[10, 50], [100, 50]]);
  });

  it('leaves nothing when the circle covers the whole stroke', () => {
    expect(cutStroke(stroke([[0, 0], [10, 0]]), 5, 0, 100)).toEqual([]);
  });

  it('drops a one-point sliver at a cut edge', () => {
    // The circle at (10, 0) of radius 10 passes exactly through the first
    // point, so the piece before the cut is that point and nothing else.
    const out = cutStroke(stroke([[0, 0], [5, 0], [100, 0]]), 10, 0, 10);
    expect(out.length).toBe(1);
    expect(out[0].pts.length).toBe(2);
    expect(out[0].pts[0][0]).toBeCloseTo(20, 9);
    expect(out[0].pts[1]).toEqual([100, 0]);
  });

  it('returns the same stroke when nothing is touched', () => {
    const s = line();
    const out = cutStroke(s, 50, 500, 10);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(s);
  });

  it('returns the same stroke for input it cannot use', () => {
    const s = line();
    expect(cutStroke(s, 50, 50, 0)[0]).toBe(s);
    expect(cutStroke(s, 50, 50, -5)[0]).toBe(s);
    expect(cutStroke(s, NaN, 50, 10)[0]).toBe(s);
    expect(cutStroke(s, 50, Infinity, 10)[0]).toBe(s);
    const empty = stroke([]);
    expect(cutStroke(empty, 50, 50, 10)[0]).toBe(empty);
  });

  it('is all or nothing for a tap', () => {
    const dot = stroke([[5, 5, 0.7]]);
    expect(cutStroke(dot, 5, 5, 10)).toEqual([]);
    expect(cutStroke(dot, 100, 100, 10)[0]).toBe(dot);
  });
});

describe('cutToIntersection', () => {
  // A cross: the horizontal line is the one being erased, the vertical one is
  // what it crosses.
  const across = (x) => stroke([[x, 0], [x, 100]]);

  it('takes a whisker off at the crossing when tapped near the end', () => {
    const s = line();
    const bar = across(60);
    const out = cutToIntersection(s, [s, bar], 95, 50, 5);
    expect(out.length).toBe(1);
    expect(out[0].pts).toEqual([[0, 50], [60, 50]]);
  });

  it('removes exactly between the crossings on either side', () => {
    const s = line();
    const all = [s, across(20), across(80)];
    const out = cutToIntersection(s, all, 50, 50, 10);
    expect(out.map((p) => p.pts)).toEqual([
      [[0, 50], [20, 50]],
      [[80, 50], [100, 50]],
    ]);
  });

  it('runs to the stroke ends when there is nothing to stop at', () => {
    const s = line();
    expect(cutToIntersection(s, [s], 50, 50, 10)).toEqual([]);
  });

  it('does not treat the stroke own vertices as crossings', () => {
    // A zigzag crosses nothing, itself included: adjacent segments share a
    // vertex, and a shared vertex is not a crossing. So a tap on it takes the
    // whole line, rather than cutting at the nearest corner.
    const s = stroke([[0, 0], [50, 50], [100, 0], [150, 50]]);
    expect(cutToIntersection(s, [s], 50, 50, 10)).toEqual([]);
  });

  it('uses a self-crossing of its own loop', () => {
    // A tail that comes back down through the stroke own first leg at (50, 0),
    // tapped below the crossing.
    const s = stroke([[0, 0], [100, 0], [100, 100], [50, 100], [50, -50]]);
    const out = cutToIntersection(s, [s], 50, -40, 10);
    expect(out.length).toBe(1);
    const pts = out[0].pts;
    expect(pts.length).toBe(5);
    expect(pts.slice(0, 4)).toEqual([[0, 0], [100, 0], [100, 100], [50, 100]]);
    expect(pts[4][0]).toBe(50);
    expect(pts[4][1]).toBeCloseTo(0, 9);
  });

  it('interpolates the extras at an intersection cut', () => {
    const s = stroke([[0, 50, 0], [100, 50, 1]]);
    const out = cutToIntersection(s, [s, across(60)], 95, 50, 5);
    expect(out[0].pts).toEqual([[0, 50, 0], [60, 50, 0.6]]);
  });

  it('merges the spans of two touched runs', () => {
    // A V whose two legs both pass through one circle, with a bar across both
    // of them further out: two runs, the same pair of crossings either side of
    // each, so one removal rather than two overlapping ones.
    const s = stroke([[0, 100], [50, 0], [100, 100]]);
    const bar = stroke([[-10, 80], [110, 80]]);
    const out = cutToIntersection(s, [s, bar], 50, 50, 30);
    expect(out.map((p) => p.pts)).toEqual([
      [[0, 100], [10, 80]],
      [[90, 80], [100, 100]],
    ]);
  });

  it('takes the board as it finds it: a copy of the stroke is the same line', () => {
    // The board may hold a rebuilt copy of the stroke being cut - every edit
    // here returns one - and a copy carrying the same points is that stroke,
    // not a second line crossing it.
    const s = line();
    const bar = across(60);
    const one = cutToIntersection(s, [s, bar], 95, 50, 5);
    const two = cutToIntersection(s, [s, { ...s }, bar], 95, 50, 5);
    expect(two.map((p) => p.pts)).toEqual(one.map((p) => p.pts));
  });

  it('returns the same stroke when nothing is touched, and for bad input', () => {
    const s = line();
    expect(cutToIntersection(s, [s], 50, 500, 10)[0]).toBe(s);
    expect(cutToIntersection(s, [s], 50, 50, 0)[0]).toBe(s);
    expect(cutToIntersection(s, null, 50, 500, 10)[0]).toBe(s);
  });

  it('is all or nothing for a tap', () => {
    const dot = stroke([[5, 5]]);
    expect(cutToIntersection(dot, [dot], 5, 5, 10)).toEqual([]);
    expect(cutToIntersection(dot, [dot], 100, 100, 10)[0]).toBe(dot);
  });
});

describe('adjustWidth', () => {
  // Three points 50 px apart, all at half width, and a tool of radius 30 over
  // the middle one: the ends sit outside it, so only the middle point moves.
  const three = (w = 0.5) => stroke([[0, 0, w], [50, 0, w], [100, 0, w]], { size: 20 });

  it('thickens the point at the centre and leaves the ones out of reach', () => {
    const s = three();
    const out = adjustWidth(s, 50, 0, 30, 1.2);
    expect(out).not.toBe(s);
    expect(out.size).toBe(20); // 20 * 0.5 * 1.2 = 12 px, under the size
    expect(out.pts[1][2]).toBeCloseTo(0.6, 12);
    // An untouched point is the tuple it was, not a copy of it.
    expect(out.pts[0]).toBe(s.pts[0]);
    expect(out.pts[2]).toBe(s.pts[2]);
  });

  it('eases the change off to nothing at the rim', () => {
    // falloff is (1 - (d/r)^2)^2: 0.5625 at half the radius, 0 at it.
    const s = stroke([[0, 0, 0.5], [15, 0, 0.5], [30, 0, 0.5]], { size: 20 });
    const out = adjustWidth(s, 0, 0, 30, 1.2);
    expect(out.pts[0][2]).toBeCloseTo(0.6, 12); // full at the centre
    expect(out.pts[1][2]).toBeCloseTo(0.5 * (1 + 0.2 * 0.5625), 12);
    expect(out.pts[2]).toBe(s.pts[2]); // exactly on the rim, so untouched
  });

  it('grows the size and renormalises when a point would pass full width', () => {
    const s = three(1);
    const out = adjustWidth(s, 50, 0, 30, 1.5);
    // The middle point wants 30 px, which no factor of a size-20 stroke can say.
    expect(out.size).toBe(30);
    expect(out.pts[1][2]).toBe(1);
    // The ends kept the 20 px they had, restated against the new size.
    expect(out.pts[0][2]).toBeCloseTo(2 / 3, 12);
    expect(out.pts[0][2] * out.size).toBeCloseTo(20, 12);
    expect(out.pts[2][2] * out.size).toBeCloseTo(20, 12);
  });

  it('never lets a factor past 1, however hard it is pushed', () => {
    const out = adjustWidth(three(1), 50, 0, 30, 5);
    expect(out.size).toBe(100);
    expect(Math.max(...out.pts.map((p) => p[2]))).toBe(1);
    expect(out.pts[0][2]).toBeCloseTo(0.2, 12);
  });

  it('narrows without touching the size', () => {
    const s = three(1);
    const out = adjustWidth(s, 50, 0, 30, 0.8);
    expect(out.size).toBe(20);
    expect(out.pts[1][2]).toBeCloseTo(0.8, 12);
    expect(out.pts[0]).toBe(s.pts[0]);
  });

  it('preserves the extras past the width factor', () => {
    const s = stroke([[0, 0, 0.5, 0.3, 0.7], [50, 0, 0.5, 0.3, 0.7]], { size: 20 });
    const out = adjustWidth(s, 50, 0, 30, 1.2);
    expect(out.pts[1].length).toBe(5);
    expect(out.pts[1][2]).toBeCloseTo(0.6, 12);
    expect(out.pts[1][3]).toBe(0.3);
    expect(out.pts[1][4]).toBe(0.7);
  });

  it('reads a point with no stored factor as full width', () => {
    const s = stroke([[0, 0], [50, 0]], { size: 20 });
    const out = adjustWidth(s, 50, 0, 30, 1.5);
    expect(out.size).toBe(30);
    expect(out.pts[1][2]).toBe(1);
    expect(out.pts[0]).toEqual([0, 0, 2 / 3]);
  });

  it('returns the same stroke when the tool reaches no point', () => {
    const s = three();
    expect(adjustWidth(s, 50, 500, 30, 1.2)).toBe(s);
    // The tool inside a shape whose points are all outside it: a bounding box
    // would say this stroke was touched, and no point of it was.
    const ring = stroke([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], { size: 20 });
    expect(adjustWidth(ring, 50, 50, 30, 1.2)).toBe(ring);
  });

  it('returns the same stroke for a factor of 1 and for input it cannot use', () => {
    const s = three();
    expect(adjustWidth(s, 50, 0, 30, 1)).toBe(s);
    expect(adjustWidth(s, 50, 0, 30, 0)).toBe(s);
    expect(adjustWidth(s, 50, 0, 30, -2)).toBe(s);
    expect(adjustWidth(s, 50, 0, 30, NaN)).toBe(s);
    expect(adjustWidth(s, 50, 0, 0, 1.2)).toBe(s);
    expect(adjustWidth(s, NaN, 0, 30, 1.2)).toBe(s);
  });

  it('leaves a point already at width zero alone', () => {
    const s = stroke([[0, 0, 0], [50, 0, 0]], { size: 20 });
    expect(adjustWidth(s, 25, 0, 100, 1.5)).toBe(s);
  });
});
