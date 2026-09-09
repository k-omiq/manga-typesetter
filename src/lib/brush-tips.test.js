import { describe, it, expect } from 'vitest';
import { inkTipIds, boxTipIds, settleTips, settleInkTips, settleBoxTips } from './brush-tips.js';
import { __resetBrushLibrary } from './brush-library.svelte.js';

// The seam between the async library and the synchronous painter. Under node
// there is no Tauri host and therefore no installed brush, which is exactly the
// case a painter has to survive: every id comes back unresolved and every
// stroke draws with the round tip while keeping the brush it was drawn with.

const stroke = (brush) => ({ brush, pts: [[0, 0, 1]] });

describe('inkTipIds', () => {
  it('collects the imported brushes an ink block names', () => {
    const ids = inkTipIds({ strokes: [stroke('aaa'), stroke('bbb'), stroke('aaa')] });
    expect([...ids]).toEqual(['aaa', 'bbb']);
  });

  it('leaves out the round tip, which has no file behind it', () => {
    expect([...inkTipIds({ strokes: [stroke('round'), stroke(''), stroke(null)] })]).toEqual([]);
  });

  it('answers an empty set for ink that is not there', () => {
    expect([...inkTipIds(undefined)]).toEqual([]);
    expect([...inkTipIds({ strokes: null })]).toEqual([]);
  });

  it('adds to a set it is handed, so one pass covers several blocks', () => {
    const into = new Set(['zzz']);
    inkTipIds({ strokes: [stroke('aaa')] }, into);
    expect([...into]).toEqual(['zzz', 'aaa']);
  });
});

describe('boxTipIds', () => {
  const box = (ink) => ({ style: { ink } });

  it('walks every inked box on the page', () => {
    const ids = boxTipIds([
      box({ on: true, strokes: [stroke('aaa')] }),
      box({ on: true, strokes: [stroke('bbb')] }),
    ]);
    expect([...ids].sort()).toEqual(['aaa', 'bbb']);
  });

  it('skips a box whose ink is switched off - it paints nothing', () => {
    expect([...boxTipIds([box({ on: false, strokes: [stroke('aaa')] })])]).toEqual([]);
  });

  it('survives boxes with no style at all', () => {
    expect([...boxTipIds([{}, null, undefined])]).toEqual([]);
  });
});

describe('settleTips', () => {
  it('answers null when no stroke asks for an imported tip', async () => {
    expect(await settleTips(new Set())).toBe(null);
    expect(await settleInkTips({ strokes: [stroke('round')] })).toBe(null);
    expect(await settleBoxTips([])).toBe(null);
  });

  it('answers null rather than throwing when the brush is not installed', async () => {
    __resetBrushLibrary();
    // No Tauri host: the library loads empty, so every id is missing. The
    // painter reads that as "draw round this frame", which is the whole point.
    expect(await settleTips(new Set(['nothere']))).toBe(null);
  });

  it('answers null for a whole page of strokes drawn with brushes that are gone', async () => {
    __resetBrushLibrary();
    const boxes = [{ style: { ink: { on: true, strokes: [stroke('aaa'), stroke('bbb')] } } }];
    expect(await settleBoxTips(boxes)).toBe(null);
  });
});
