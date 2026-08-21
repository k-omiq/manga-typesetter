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

  it('leaves a project saved before ink existed untouched apart from the default', () => {
    const before = normalizeStyle({ size: 30, clip: { on: true, shapes: [] } });
    expect(before.ink).toEqual({ on: false, strokes: [] });
    expect(before.size).toBe(30);
  });
});
