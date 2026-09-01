import { describe, it, expect } from 'vitest';
import {
  LIQUIFY_MODES,
  EXPAND_STEP,
  TWIRL_MAX,
  defaultMaxSeg,
  falloff,
  resampleStroke,
  applyLiquify,
  liquifyField,
} from './liquify.js';
import { normalizeInkStroke } from './data.js';

// The worked example every hand-computed number below comes from: a tool of
// radius 100 centred at (200, 200). The falloff is (1 - (d/r)^2)^2, so
//
//   d = 0   -> 1
//   d = 50  -> (1 - 0.25)^2 = 0.5625
//   d = 60  -> (1 - 0.36)^2 = 0.4096
//   d = 80  -> (1 - 0.64)^2 = 0.1296
//   d = 100 -> 0
//
const CX = 200;
const CY = 200;
const R = 100;

// A stored stroke as the sanitiser leaves one, so anything built out of it can
// be checked for a clean round trip.
const stroke = (pts) =>
  normalizeInkStroke({ brush: 'round', size: 24, color: '#000000', seed: 7, pts });

// Deep-freeze, so a test that hands input in gets a TypeError (module code is
// strict-mode ESM) the moment anything writes to it, at any depth.
function freeze(v) {
  if (v && typeof v === 'object') {
    Object.getOwnPropertyNames(v).forEach((k) => freeze(v[k]));
    Object.freeze(v);
  }
  return v;
}

describe('falloff', () => {
  it('is 1 at the centre and 0 at the rim and beyond', () => {
    expect(falloff(0, R)).toBe(1);
    expect(falloff(R, R)).toBe(0);
    expect(falloff(R + 0.001, R)).toBe(0);
    expect(falloff(1e6, R)).toBe(0);
  });

  it('gives the hand-computed weights at three distances, decreasing', () => {
    expect(falloff(50, R)).toBeCloseTo(0.5625, 12);
    expect(falloff(60, R)).toBeCloseTo(0.4096, 12);
    expect(falloff(80, R)).toBeCloseTo(0.1296, 12);
    expect(falloff(50, R)).toBeGreaterThan(falloff(60, R));
    expect(falloff(60, R)).toBeGreaterThan(falloff(80, R));
  });

  it('is zero for a tool with no radius, and for anything unreadable', () => {
    expect(falloff(10, 0)).toBe(0);
    expect(falloff(10, -5)).toBe(0);
    expect(falloff(NaN, R)).toBe(0);
    expect(falloff(10, undefined)).toBe(0);
  });
});

describe('liquifyField: push', () => {
  const push = (x, y, strength, dx, dy) =>
    liquifyField('push', CX, CY, R, strength, dx, dy, x, y);

  it('moves a point at the centre by exactly the delta times the strength', () => {
    expect(push(CX, CY, 100, 10, -4)).toEqual([10, -4]);
    expect(push(CX, CY, 50, 10, -4)).toEqual([5, -2]);
    expect(push(CX, CY, 0, 10, -4)).toEqual([0, 0]);
  });

  it('scales the delta by the falloff away from the centre', () => {
    // d = 50, w = 0.5625, full strength.
    const [ox, oy] = push(CX + 50, CY, 100, 8, 0);
    expect(ox).toBeCloseTo(4.5, 12);
    expect(oy).toBeCloseTo(0, 12);
    // d = 60 along the diagonal-free axis, w = 0.4096, half strength.
    const [px, py] = push(CX, CY - 60, 50, 0, 10);
    expect(px).toBeCloseTo(0, 12);
    expect(py).toBeCloseTo(0.4096 * 0.5 * 10, 12);
  });

  it('moves nothing at the rim or outside it', () => {
    expect(push(CX + R, CY, 100, 10, 10)).toEqual([0, 0]);
    expect(push(CX + R + 1, CY, 100, 10, 10)).toEqual([0, 0]);
  });

  it('clamps strength above 100 rather than overshooting the delta', () => {
    expect(push(CX, CY, 400, 3, 3)).toEqual([3, 3]);
  });
});

describe('liquifyField: expand and pinch', () => {
  const at = (mode, x, y) => liquifyField(mode, CX, CY, R, 100, 0, 0, x, y);
  // Full strength at d = 50: w = 0.5625, step = radius * EXPAND_STEP = 5, so
  // the radial move is 0.5625 * 5 = 2.8125 px.
  const MOVE = 0.5625 * R * EXPAND_STEP;

  it('pushes a cardinal point straight away from the centre, on both axes', () => {
    const [ex, ey] = at('expand', CX + 50, CY);
    expect(ex).toBeCloseTo(MOVE, 12);
    expect(ey).toBeCloseTo(0, 12);
    const [dx, dy] = at('expand', CX, CY + 50);
    expect(dx).toBeCloseTo(0, 12);
    expect(dy).toBeCloseTo(MOVE, 12);
    // And on the negative side of each axis, away still means away.
    expect(at('expand', CX - 50, CY)[0]).toBeCloseTo(-MOVE, 12);
    expect(at('expand', CX, CY - 50)[1]).toBeCloseTo(-MOVE, 12);
  });

  it('pinches by exactly the same magnitude, the other way', () => {
    for (const p of [[CX + 50, CY], [CX, CY + 50], [CX - 30, CY + 40]]) {
      const e = at('expand', p[0], p[1]);
      const n = at('pinch', p[0], p[1]);
      expect(n[0]).toBeCloseTo(-e[0], 12);
      expect(n[1]).toBeCloseTo(-e[1], 12);
    }
  });

  it('keeps the move radial on a diagonal point', () => {
    // (30, 40) from the centre is d = 50 exactly, so the same weight applies
    // along the unit vector (0.6, 0.8).
    const [ox, oy] = at('expand', CX + 30, CY + 40);
    expect(ox).toBeCloseTo(MOVE * 0.6, 12);
    expect(oy).toBeCloseTo(MOVE * 0.8, 12);
  });

  it('leaves the exact centre alone, where there is no direction to move along', () => {
    expect(at('expand', CX, CY)).toEqual([0, 0]);
    expect(at('pinch', CX, CY)).toEqual([0, 0]);
  });
});

describe('liquifyField: twirl', () => {
  const twirl = (x, y, strength) => liquifyField('twirl', CX, CY, R, strength, 0, 0, x, y);

  it('turns a point at (cx + r/2, cy) towards +y - the positive rotation', () => {
    // w at d = 50 is 0.5625, so the angle is 0.5625 * 1 * TWIRL_MAX.
    const a = 0.5625 * TWIRL_MAX;
    const [ox, oy] = twirl(CX + 50, CY, 100);
    expect(ox).toBeCloseTo(50 * Math.cos(a) - 50, 12);
    expect(oy).toBeCloseTo(50 * Math.sin(a), 12);
    expect(oy).toBeGreaterThan(0);
  });

  it('conserves the distance to the centre over twenty applications', () => {
    let x = CX + 40;
    let y = CY - 15;
    const d0 = Math.hypot(x - CX, y - CY);
    for (let i = 0; i < 20; i++) {
      const [ox, oy] = twirl(x, y, 100);
      x += ox;
      y += oy;
    }
    expect(Math.hypot(x - CX, y - CY)).toBeCloseTo(d0, 9);
    // And it really did turn: twenty applications of the same weight is one
    // rotation by twenty times the angle.
    const a = 20 * falloff(d0, R) * TWIRL_MAX;
    expect(x - CX).toBeCloseTo(40 * Math.cos(a) - -15 * Math.sin(a), 9);
    expect(y - CY).toBeCloseTo(40 * Math.sin(a) + -15 * Math.cos(a), 9);
  });

  it('leaves the centre and the outside alone', () => {
    expect(twirl(CX, CY, 100)).toEqual([0, 0]);
    expect(twirl(CX + R, CY, 100)).toEqual([0, 0]);
  });
});

describe('liquifyField: the frame scale', () => {
  it('doubles the radial step at scale 2 and stops it dead at scale 0', () => {
    const one = liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 1);
    const two = liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 2);
    expect(two[0]).toBeCloseTo(one[0] * 2, 12);
    expect(liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 0)[0]).toBe(0);
    expect(liquifyField('pinch', CX, CY, R, 100, 0, 0, CX + 50, CY, 2)[0]).toBeCloseTo(
      -two[0],
      12,
    );
  });

  it('doubles the twirl ANGLE at scale 2 - the rotation is what is being rated', () => {
    const a = 0.5625 * TWIRL_MAX * 2;
    const [ox, oy] = liquifyField('twirl', CX, CY, R, 100, 0, 0, CX + 50, CY, 2);
    expect(ox).toBeCloseTo(50 * Math.cos(a) - 50, 12);
    expect(oy).toBeCloseTo(50 * Math.sin(a), 12);
    expect(liquifyField('twirl', CX, CY, R, 100, 0, 0, CX + 50, CY, 0)).toEqual([0, 0]);
  });

  it('leaves push alone: its magnitude is already the pointer delta', () => {
    const base = liquifyField('push', CX, CY, R, 100, 7, -3, CX + 50, CY);
    for (const sc of [0, 0.5, 1, 2]) {
      expect(liquifyField('push', CX, CY, R, 100, 7, -3, CX + 50, CY, sc)).toEqual(base);
    }
  });

  it('clamps the scale to 0..2 and reads a missing one as one frame', () => {
    const two = liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 2);
    expect(liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 99)).toEqual(two);
    const one = liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, 1);
    expect(liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY)).toEqual(one);
    expect(liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, NaN)).toEqual(one);
    expect(liquifyField('expand', CX, CY, R, 100, 0, 0, CX + 50, CY, -5)[0]).toBe(0);
  });
});

describe('liquifyField: the guards', () => {
  it('gives no displacement for a mode it does not know', () => {
    expect(liquifyField('smudge', CX, CY, R, 100, 5, 5, CX, CY)).toEqual([0, 0]);
    expect(liquifyField(undefined, CX, CY, R, 100, 5, 5, CX, CY)).toEqual([0, 0]);
  });

  it('gives no displacement for a tool or a point it cannot read', () => {
    expect(liquifyField('push', CX, CY, 0, 100, 5, 5, CX, CY)).toEqual([0, 0]);
    expect(liquifyField('push', NaN, CY, R, 100, 5, 5, CX, CY)).toEqual([0, 0]);
    expect(liquifyField('push', CX, CY, R, 100, 5, 5, NaN, CY)).toEqual([0, 0]);
    expect(liquifyField('push', CX, CY, R, 100, NaN, 5, CX, CY)).toEqual([0, 0]);
  });

  it('is a pure function of its arguments - the same call twice, the same answer', () => {
    const a = liquifyField('twirl', CX, CY, R, 63, 0, 0, CX + 33, CY + 12);
    const b = liquifyField('twirl', CX, CY, R, 63, 0, 0, CX + 33, CY + 12);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('resampleStroke', () => {
  it('cuts every segment down to the bound', () => {
    const s = stroke([[0, 0, 1], [30, 0, 1], [30, 45, 1]]);
    const out = resampleStroke(s, 10);
    for (let i = 1; i < out.pts.length; i++) {
      const d = Math.hypot(
        out.pts[i][0] - out.pts[i - 1][0],
        out.pts[i][1] - out.pts[i - 1][1],
      );
      expect(d).toBeLessThanOrEqual(10 + 1e-9);
    }
    // 30 px in threes and 45 px in fives: 1 + 3 + 5 points.
    expect(out.pts).toHaveLength(9);
  });

  it('keeps the original points, in order, exactly where they were', () => {
    const s = stroke([[0, 0, 1], [30, 0, 1], [30, 45, 1]]);
    const out = resampleStroke(s, 10);
    expect(out.pts[0]).toEqual([0, 0, 1]);
    expect(out.pts.at(-1)).toEqual([30, 45, 1]);
    // The interior original is still there, unmoved, ahead of the points that
    // were inserted after it.
    const at = out.pts.findIndex((p) => p[0] === 30 && p[1] === 0);
    expect(at).toBe(3);
    expect(out.pts[at]).toEqual([30, 0, 1]);
  });

  it('interpolates pressure linearly, so a midpoint is the mean', () => {
    const s = stroke([[0, 0, 0.2], [20, 0, 0.8]]);
    const out = resampleStroke(s, 10);
    expect(out.pts).toHaveLength(3);
    expect(out.pts[1][0]).toBeCloseTo(10, 12);
    expect(out.pts[1][2]).toBeCloseTo(0.5, 12);
    // A quarter of the way along is a quarter of the way up.
    const four = resampleStroke(s, 5);
    expect(four.pts).toHaveLength(5);
    expect(four.pts[1][2]).toBeCloseTo(0.35, 12);
    expect(four.pts[3][2]).toBeCloseTo(0.65, 12);
  });

  it('returns a stroke that is already fine enough BY REFERENCE', () => {
    const s = stroke([[0, 0, 1], [5, 0, 1], [5, 9, 1]]);
    expect(resampleStroke(s, 10)).toBe(s);
    // A segment of exactly the bound is not over it.
    const exact = stroke([[0, 0, 1], [10, 0, 1]]);
    expect(resampleStroke(exact, 10)).toBe(exact);
  });

  it('returns a stroke with nothing to cut by reference', () => {
    const one = stroke([[4, 4, 1]]);
    expect(resampleStroke(one, 1)).toBe(one);
    expect(resampleStroke({ pts: [] }, 1).pts).toEqual([]);
    expect(resampleStroke(null, 1)).toBe(null);
    // And a bound that is not a usable length is nothing to do either.
    const long = stroke([[0, 0, 1], [500, 0, 1]]);
    expect(resampleStroke(long, 0)).toBe(long);
    expect(resampleStroke(long, NaN)).toBe(long);
  });

  it('carries the rest of the stroke across and does not touch the input', () => {
    const s = freeze(stroke([[0, 0, 1], [40, 0, 1]]));
    const out = resampleStroke(s, 10);
    expect(out).not.toBe(s);
    expect(out.pts).not.toBe(s.pts);
    expect(s.pts).toHaveLength(2);
    expect(out.size).toBe(s.size);
    expect(out.seed).toBe(s.seed);
    expect(normalizeInkStroke(out)).toEqual(out);
  });
});

describe('applyLiquify', () => {
  const opts = (over) => ({
    mode: 'push',
    cx: CX,
    cy: CY,
    radius: R,
    strength: 100,
    dx: 10,
    dy: 0,
    ...over,
  });
  // One stroke through the middle of the tool, one well outside it.
  const inside = () => stroke([[CX - 60, CY, 1], [CX + 60, CY, 1]]);
  const outside = () => stroke([[CX + 400, CY, 1], [CX + 460, CY, 1]]);

  it('returns a new array, with untouched strokes by reference', () => {
    const a = inside();
    const b = outside();
    const list = freeze([a, b]);
    const out = applyLiquify(list, opts());
    expect(out).not.toBe(list);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(b);
    expect(out[0]).not.toBe(a);
  });

  it('leaves a stroke that only touches the rim by reference', () => {
    // A stroke whose nearest point is exactly `radius` away sits where the
    // falloff is zero, so there is nothing to move.
    const rim = stroke([[CX + R, CY, 1], [CX + R + 5, CY, 1]]);
    expect(applyLiquify([rim], opts())[0]).toBe(rim);
  });

  it('does not mutate its input, at any depth', () => {
    const a = freeze(inside());
    const before = JSON.stringify(a);
    applyLiquify(freeze([a]), opts({ mode: 'twirl' }));
    applyLiquify(freeze([a]), opts({ mode: 'expand' }));
    applyLiquify(freeze([a]), opts());
    expect(JSON.stringify(a)).toBe(before);
  });

  it('moves the points the field says and leaves pressure alone', () => {
    const s = stroke([[CX, CY, 0.4], [CX + 50, CY, 0.9]]);
    const out = applyLiquify([s], opts({ maxSeg: 100 }))[0];
    expect(out.pts).toHaveLength(2);
    // Centre point: the whole delta. d = 50 point: 0.5625 of it.
    expect(out.pts[0][0]).toBeCloseTo(CX + 10, 12);
    expect(out.pts[0][1]).toBeCloseTo(CY, 12);
    expect(out.pts[1][0]).toBeCloseTo(CX + 50 + 5.625, 12);
    expect(out.pts[1][1]).toBeCloseTo(CY, 12);
    expect(out.pts[0][2]).toBe(0.4);
    expect(out.pts[1][2]).toBe(0.9);
  });

  it('resamples before it displaces, so a long stroke can bend', () => {
    // One 300 px segment across the tool, radius 100 -> maxSeg 12. Both ends
    // are 150 px from the centre, well outside the circle.
    const s = stroke([[CX - 150, CY, 1], [CX + 150, CY, 1]]);
    const out = applyLiquify([s], opts())[0];
    expect(out.pts.length).toBeGreaterThan(s.pts.length);
    for (let i = 1; i < out.pts.length; i++) {
      // The gap can only have grown by the displacement, never from a cut that
      // was never made: every gap started at or under 12.
      expect(out.pts[i][0] - out.pts[i - 1][0]).toBeLessThanOrEqual(12 + 10 + 1e-9);
    }
    // The ends of the stroke are outside the tool and did not move.
    expect(out.pts[0]).toEqual([CX - 150, CY, 1]);
    expect(out.pts.at(-1)).toEqual([CX + 150, CY, 1]);
  });

  it('derives maxSeg from the radius, a quarter of it clamped to 2..12', () => {
    expect(defaultMaxSeg(40)).toBe(10);
    expect(defaultMaxSeg(4)).toBe(2);
    expect(defaultMaxSeg(200)).toBe(12);
    const s = stroke([[CX - 60, CY, 1], [CX + 60, CY, 1]]);
    // radius 40 -> maxSeg 10, and stating 10 gives the identical result.
    const derived = applyLiquify([s], opts({ radius: 40 }))[0];
    expect(derived.pts).toEqual(applyLiquify([s], opts({ radius: 40, maxSeg: 10 }))[0].pts);
    expect(derived.pts).not.toEqual(applyLiquify([s], opts({ radius: 40, maxSeg: 5 }))[0].pts);
    // radius 200 clamps to the ceiling rather than to 50.
    const big = applyLiquify([s], opts({ radius: 200 }))[0];
    expect(big.pts).toEqual(applyLiquify([s], opts({ radius: 200, maxSeg: 12 }))[0].pts);
  });

  it('survives the sanitiser unchanged, in every mode', () => {
    for (const mode of LIQUIFY_MODES) {
      const out = applyLiquify([inside()], opts({ mode }))[0];
      expect(normalizeInkStroke(out)).toEqual(out);
    }
  });

  it('matches liquifyField exactly, point for point, in every mode', () => {
    // maxSeg is huge so nothing is resampled and the points compared are the
    // ones written here: inside, at the centre, on the rim, and outside it.
    const pts = [
      [CX, CY, 1],
      [CX + 30, CY + 40, 0.5],
      [CX - 55, CY + 12, 0.9],
      [CX + R, CY, 1],
      [CX, CY + 300, 1],
    ];
    for (const mode of LIQUIFY_MODES) {
      for (const scale of [1, 1.5]) {
        const s = stroke(pts);
        const o = opts({ mode, scale, maxSeg: 1e6, dx: 7, dy: -3 });
        const out = applyLiquify([s], o)[0];
        expect(out.pts).toHaveLength(pts.length);
        // The agreement has to be about real numbers: if the field did nothing
        // here, matching it point for point would prove nothing.
        expect(out.pts.some((p, i) => p[0] !== s.pts[i][0] || p[1] !== s.pts[i][1])).toBe(true);
        out.pts.forEach((p, i) => {
          const [ox, oy] = liquifyField(
            mode, o.cx, o.cy, o.radius, o.strength, o.dx, o.dy,
            s.pts[i][0], s.pts[i][1], scale,
          );
          expect(p[0]).toBe(s.pts[i][0] + ox);
          expect(p[1]).toBe(s.pts[i][1] + oy);
          expect(p[2]).toBe(s.pts[i][2]);
        });
      }
    }
  });

  it('carries the frame scale through to the strokes it moves', () => {
    const s = stroke([[CX + 50, CY, 1], [CX + 55, CY, 1]]);
    const one = applyLiquify([s], opts({ mode: 'expand', maxSeg: 1e6 }))[0];
    const two = applyLiquify([s], opts({ mode: 'expand', scale: 2, maxSeg: 1e6 }))[0];
    expect(two.pts[0][0] - (CX + 50)).toBeCloseTo((one.pts[0][0] - (CX + 50)) * 2, 12);
    // Push is deliberately unrated, so its result does not move with the scale.
    const p1 = applyLiquify([s], opts({ maxSeg: 1e6 }))[0];
    const p2 = applyLiquify([s], opts({ scale: 2, maxSeg: 1e6 }))[0];
    expect(p2.pts).toEqual(p1.pts);
  });

  it('returns every stroke by reference when the field can do nothing', () => {
    const a = inside();
    for (const dead of [
      opts({ radius: 0 }),
      opts({ strength: 0 }),
      opts({ mode: 'smudge' }),
      opts({ cx: NaN }),
      // A pointer that did not move is a push that does nothing.
      opts({ dx: 0, dy: 0 }),
      opts({ dx: NaN }),
      // And a hold mode given no frame is the same story.
      opts({ mode: 'expand', scale: 0 }),
      opts({ mode: 'pinch', scale: 0 }),
      opts({ mode: 'twirl', scale: 0 }),
      opts({ mode: 'twirl', scale: -1 }),
    ]) {
      const out = applyLiquify([a], dead);
      expect(out[0]).toBe(a);
    }
    expect(applyLiquify([a], undefined)[0]).toBe(a);
  });

  it('leaves a stroke that ENCLOSES the tool by reference, and unresampled', () => {
    // The bounds test only asks whether the tool could reach the stroke's
    // rectangle. A square outline dragged in its own empty middle passes it
    // with no point anywhere near the circle - as do a C and an O - and before
    // this the resampled copy came back as a NEW object: the gesture read that
    // as "the ink moved", recorded a history entry for a drag that changed
    // nothing, and left the stroke permanently subdivided (4 points to 121).
    const square = stroke([
      [CX - 60, CY - 60, 1],
      [CX + 60, CY - 60, 1],
      [CX + 60, CY + 60, 1],
      [CX - 60, CY + 60, 1],
    ]);
    for (const mode of LIQUIFY_MODES) {
      const out = applyLiquify([square], opts({ mode, radius: 10 }));
      expect(out[0]).toBe(square);
      expect(out[0].pts).toHaveLength(4);
    }
  });

  it('still resamples and moves a stroke the tool really does reach', () => {
    // The other half of the claim above: the skip is about points that did not
    // move, not about leaving long strokes alone.
    const s = stroke([[CX - 150, CY, 1], [CX + 150, CY, 1]]);
    const out = applyLiquify([s], opts())[0];
    expect(out).not.toBe(s);
    expect(out.pts.length).toBeGreaterThan(2);
    // Against the plain resample of the same stroke: the same points, and at
    // least one of them somewhere else - so the copy is there because something
    // moved, not merely because the stroke was long.
    const dense = resampleStroke(s, defaultMaxSeg(R));
    expect(out.pts).toHaveLength(dense.pts.length);
    expect(out.pts.some((p, i) => p[0] !== dense.pts[i][0])).toBe(true);
  });

  it('takes anything that is not a list of strokes as an empty page', () => {
    expect(applyLiquify(null, opts())).toEqual([]);
    expect(applyLiquify(undefined, opts())).toEqual([]);
    // A stroke with no readable points cannot be reached, so it comes back as
    // it is rather than as junk.
    const junk = { pts: [] };
    expect(applyLiquify([junk], opts())[0]).toBe(junk);
  });

  it('is deterministic: the same call twice gives the same numbers', () => {
    const s = inside();
    const a = applyLiquify([s], opts({ mode: 'twirl', strength: 63 }))[0];
    const b = applyLiquify([s], opts({ mode: 'twirl', strength: 63 }))[0];
    expect(a.pts).toEqual(b.pts);
    expect(a).not.toBe(b);
  });
});
