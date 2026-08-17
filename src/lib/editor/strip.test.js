import { describe, it, expect } from 'vitest';
import {
  stripOffsets,
  pageIndexAtCenter,
  maxPageWidth,
  fitWidthZoom,
  residentRadiusFor,
  scrollFraction,
  scrollTopForFraction,
  visibleHeightOf,
  focusHoldsIndex,
  RESIDENT_MIN,
  RESIDENT_MAX,
} from './strip.js';

const pages = (...hs) => hs.map((h, i) => ({ id: i + 1, w: 800, h }));

describe('stripOffsets', () => {
  it('stacks the pages with no gap between them', () => {
    expect(stripOffsets(pages(100, 200, 50))).toEqual({ tops: [0, 100, 300], total: 350 });
  });

  it('scales every offset and the total by the zoom', () => {
    expect(stripOffsets(pages(100, 200), 0.5)).toEqual({ tops: [0, 50], total: 150 });
  });

  it('gives an unmeasured page no height rather than a guessed one', () => {
    expect(stripOffsets([{ h: 0 }, { h: 100 }]).tops).toEqual([0, 0]);
  });

  it('answers for a chapter with no pages', () => {
    expect(stripOffsets([])).toEqual({ tops: [], total: 0 });
    expect(stripOffsets(null)).toEqual({ tops: [], total: 0 });
  });
});

describe('pageIndexAtCenter', () => {
  const tops = stripOffsets(pages(1000, 1000, 1000)).tops; // 0, 1000, 2000

  it('names the page the viewport is looking at, not the one at its top edge', () => {
    // The top edge is still on page one; the middle of the screen is on page two.
    expect(pageIndexAtCenter(tops, 600, 800)).toBe(1);
  });

  it('follows the centre down the strip', () => {
    expect(pageIndexAtCenter(tops, 0, 800)).toBe(0);
    expect(pageIndexAtCenter(tops, 1000, 800)).toBe(1);
    expect(pageIndexAtCenter(tops, 2000, 800)).toBe(2);
  });

  it('holds at the last page when the centre falls past the end of the strip', () => {
    expect(pageIndexAtCenter(tops, 9000, 800)).toBe(2);
  });

  it('holds at the first page when the centre is above the first frame', () => {
    // A stage that pads the column down leaves the top of the scroll range above
    // page one.
    expect(pageIndexAtCenter([60, 1060], 0, 100)).toBe(0);
  });

  it('answers zero for a chapter with no frames', () => {
    expect(pageIndexAtCenter([], 500, 800)).toBe(0);
  });

  it('opens an unmeasured chapter at its first page, not its last', () => {
    // Every page `h: 0` until a decode lands: the frames all start at the same
    // offset, and naming the last of them would put the queue and the prefetch
    // window at the end of a chapter the reader has not opened yet.
    const flat = stripOffsets(pages(0, 0, 0, 0)).tops; // 0, 0, 0, 0
    expect(pageIndexAtCenter(flat, 0, 800, [0, 0, 0, 0])).toBe(0);
    // …and with no heights to hand, from the offsets alone.
    expect(pageIndexAtCenter(flat, 0, 800)).toBe(0);
  });

  it('skips a page that has not decoded and names the one the centre is really in', () => {
    // Page three is still `h: 0`, so it starts where page four does.
    const tops = stripOffsets(pages(1000, 1000, 0, 1000)).tops; // 0, 1000, 2000, 2000
    const heights = [1000, 1000, 0, 1000];
    expect(pageIndexAtCenter(tops, 1800, 800, heights)).toBe(3);
    expect(pageIndexAtCenter(tops, 1800, 800)).toBe(3);
    // The measured pages either side are unaffected.
    expect(pageIndexAtCenter(tops, 0, 800, heights)).toBe(0);
    expect(pageIndexAtCenter(tops, 800, 800, heights)).toBe(1);
  });

  it('holds at the first page when only the pages below the centre have decoded', () => {
    expect(pageIndexAtCenter([0, 0, 0], 0, 800, [0, 0, 0])).toBe(0);
  });
});

describe('the focused page holds the index while the reader is working', () => {
  const tops = [0, 1000, 2000];
  const heights = [1000, 1000, 1000];

  it('measures how much of a frame is on screen', () => {
    expect(visibleHeightOf(1000, 1000, 800, 800)).toBe(600);
    expect(visibleHeightOf(1000, 1000, 3000, 800)).toBe(0);
    expect(visibleHeightOf(1000, 0, 900, 800)).toBe(0);
  });

  it('holds while any worthwhile part of the focused page is still visible', () => {
    // Editing a box on page one while the viewport's centre has crossed onto
    // page two: page one is still on screen, so it keeps the index.
    expect(focusHoldsIndex(tops, heights, 0, 600, 800)).toBe(true);
  });

  it('lets go once the focused page has been scrolled off screen', () => {
    expect(focusHoldsIndex(tops, heights, 0, 1200, 800)).toBe(false);
  });

  it('lets go for a sliver too thin to be what the reader is looking at', () => {
    // Four pixels of page one left at the top of the viewport.
    expect(focusHoldsIndex(tops, heights, 0, 996, 800)).toBe(false);
  });

  it('holds for a slice shorter than the threshold, while any of it shows', () => {
    expect(focusHoldsIndex([0, 4], [4, 1000], 0, 0, 800)).toBe(true);
  });

  it('never holds for a page with no height, or an index off the end', () => {
    expect(focusHoldsIndex(tops, [0, 1000, 1000], 0, 0, 800)).toBe(false);
    expect(focusHoldsIndex(tops, heights, 9, 0, 800)).toBe(false);
    expect(focusHoldsIndex(tops, heights, -1, 0, 800)).toBe(false);
  });
});

describe('fit is fit-width in a strip', () => {
  it('measures against the widest page, not the first', () => {
    expect(maxPageWidth([{ w: 600, h: 1 }, { w: 900, h: 1 }])).toBe(900);
    expect(fitWidthZoom([{ w: 600 }, { w: 900 }], 1000, 100)).toBeCloseTo(900 / 900);
  });

  it('spends the stage padding before it divides', () => {
    expect(fitWidthZoom([{ w: 800 }], 1000, 120)).toBeCloseTo(1.1);
  });

  it('ignores the height entirely — the column scrolls', () => {
    const tall = [{ w: 800, h: 40000 }];
    expect(fitWidthZoom(tall, 800, 0)).toBe(1);
  });

  it('answers 0 when there is nothing measured to fit to', () => {
    expect(fitWidthZoom([{ w: 0, h: 0 }], 1000, 100)).toBe(0);
    expect(fitWidthZoom([], 1000, 100)).toBe(0);
    // A viewport narrower than its own padding is not a fit.
    expect(fitWidthZoom([{ w: 800 }], 100, 120)).toBe(0);
  });
});

describe('residentRadiusFor', () => {
  const uniform = (n, h) => Array.from({ length: n }, () => h);

  it('stays at the paged radius when one slice is already several screens tall', () => {
    expect(residentRadiusFor(uniform(40, 8000), 20, 800)).toBe(RESIDENT_MIN);
  });

  it('grows until three screens of art sit either side', () => {
    // 800px viewport wants 2400px each way; 1000px slices need three of them.
    expect(residentRadiusFor(uniform(40, 1000), 20, 800)).toBe(3);
    // Half the slice height, twice the pages.
    expect(residentRadiusFor(uniform(40, 500), 20, 800)).toBe(5);
  });

  it('never grows past the cap, however short the slices are', () => {
    expect(residentRadiusFor(uniform(200, 20), 100, 900)).toBe(RESIDENT_MAX);
  });

  it('counts the two sides separately, so the end of the chapter cannot inflate the window', () => {
    // One page from the end: the tail is satisfied by having run out of
    // chapter, and the radius is decided by what is still above.
    const heights = uniform(10, 1000);
    expect(residentRadiusFor(heights, 9, 800)).toBe(3);
  });

  it('falls back to the paged radius when there is nothing to measure', () => {
    expect(residentRadiusFor([], 0, 800)).toBe(RESIDENT_MIN);
    expect(residentRadiusFor(uniform(10, 1000), 0, 0)).toBe(RESIDENT_MIN);
  });

  it('takes its floor, target and cap from the caller when asked', () => {
    expect(residentRadiusFor(uniform(40, 1000), 20, 800, { screens: 1 })).toBe(RESIDENT_MIN);
    expect(residentRadiusFor(uniform(40, 1000), 20, 800, { max: 2 })).toBe(2);
  });
});

describe('slaving one scroll container to another', () => {
  const canvas = { scrollTop: 500, scrollHeight: 3000, clientHeight: 1000 };
  const side = { scrollHeight: 9000, clientHeight: 900 };

  it('carries the fraction across, not the pixels', () => {
    // A quarter of the way down the canvas is a quarter of the way down the
    // reference, whatever the two columns' heights are.
    expect(scrollFraction(canvas)).toBeCloseTo(0.25);
    expect(scrollTopForFraction(scrollFraction(canvas), side)).toBeCloseTo(0.25 * 8100);
  });

  it('reads a container with nothing to scroll as the top of it', () => {
    expect(scrollFraction({ scrollTop: 0, scrollHeight: 800, clientHeight: 900 })).toBe(0);
    expect(scrollTopForFraction(0.5, { scrollHeight: 800, clientHeight: 900 })).toBe(0);
  });

  it('clamps a fraction that came from a container mid-rubber-band', () => {
    expect(scrollFraction({ scrollTop: -40, scrollHeight: 3000, clientHeight: 1000 })).toBe(0);
    expect(scrollTopForFraction(1.4, side)).toBe(8100);
  });
});
