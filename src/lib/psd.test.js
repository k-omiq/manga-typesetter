import { describe, it, expect } from 'vitest';
import { numberBoxIds } from './psd.js';

// The shape toChapterPage hands the library: bytes and geometry elided, since
// only the boxes matter here.
const psdPage = (n, boxCount) => ({
  rawName: `page-00${n}.png`,
  w: 800,
  h: 1200,
  lines: [],
  boxes: Array.from({ length: boxCount }, (_, i) => ({ lineN: null, text: `p${n}-${i}` })),
});

describe('numberBoxIds', () => {
  it('numbers boxes across the whole document rather than restarting each page', () => {
    const pages = [psdPage(1, 2), psdPage(2, 3)];
    numberBoxIds(pages);
    expect(pages.map((p) => p.boxes.map((b) => b.id))).toEqual([
      ['b1', 'b2'],
      ['b3', 'b4', 'b5'],
    ]);
  });

  it('leaves no id owned by two boxes', () => {
    const pages = [psdPage(1, 4), psdPage(2, 4), psdPage(3, 4)];
    numberBoxIds(pages);
    const ids = pages.flatMap((p) => p.boxes.map((b) => b.id));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('does not spend an id on a page that carries no boxes', () => {
    const pages = [psdPage(1, 1), psdPage(2, 0), psdPage(3, 1)];
    numberBoxIds(pages);
    expect(pages[2].boxes[0].id).toBe('b2');
  });
});
