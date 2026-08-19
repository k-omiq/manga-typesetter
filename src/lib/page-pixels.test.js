import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rememberPagePixels,
  pagePixelsFor,
  forgetPagePixels,
  pagePixelsHeld,
  pageRasterSrc,
} from './page-pixels.js';

// ===========================================================================
// The page's pixels, decoded once
// ===========================================================================
// Balloon fitting needs an `ImageData` of the page, synchronously, inside a
// click handler. This module is the app's answer, and the two things worth
// pinning about a cache are the two things a cache gets wrong: handing back
// something stale, and never letting go.
//
// The stub is the smallest surface `rememberPagePixels` touches - an element
// with `width`, `height` and a 2D context that can draw an image and read the
// bytes back - because what is under test is the bookkeeping, not the decode.
// `getImageData` returns a distinguishable buffer so a test can tell one page's
// pixels from another's.
const realDocument = globalThis.document;
let decodes;

const fakeCanvas = () => ({
  width: 0,
  height: 0,
  getContext: () => ({
    drawImage(img) {
      decodes.push(img.tag);
    },
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  }),
});

const img = (tag, w = 4, h = 4) => ({ tag, naturalWidth: w, naturalHeight: h });

beforeEach(() => {
  decodes = [];
  globalThis.document = { createElement: () => fakeCanvas() };
  forgetPagePixels();
});

afterEach(() => {
  globalThis.document = realDocument;
  forgetPagePixels();
});

describe('pageRasterSrc', () => {
  // One expression of "which image a page IS", shared by the cache and its
  // callers, because the canvas draws `cleaned ?? raw` and a fit measured
  // against the other one would be a fit of the wrong picture.
  it('is the cleaned raster when there is one, else the raw', () => {
    expect(pageRasterSrc({ raw: 'blob:r', cleaned: 'blob:c' })).toBe('blob:c');
    expect(pageRasterSrc({ raw: 'blob:r', cleaned: null })).toBe('blob:r');
    expect(pageRasterSrc(null)).toBe(null);
  });
});

describe('remembering and reading back', () => {
  it('hands the decoded pixels back for the page they were filed against', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    const data = rememberPagePixels(p.id, pageRasterSrc(p), img('a', 6, 8));
    expect([data.width, data.height]).toEqual([6, 8]);
    expect(pagePixelsFor(p)).toBe(data);
    // Decoded once. A decode per click is the thing this module exists to
    // prevent.
    expect(decodes).toEqual(['a']);
  });

  // The whole invalidation story for a clean landing, and it needs no event to
  // subscribe to: the cleaned raster is a new object URL, so the page no longer
  // quotes the src the pixels were filed under and the lookup misses.
  it('misses once the page’s raster has been replaced', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    rememberPagePixels(p.id, pageRasterSrc(p), img('a'));
    expect(pagePixelsFor(p)).not.toBe(null);
    p.cleaned = 'blob:c1';
    expect(pagePixelsFor(p)).toBe(null);
  });

  // Page ids are per-document counters and collide freely across chapters, so
  // the id alone would let one chapter's page 3 hand its pixels to another's.
  it('will not serve one document’s page to another with the same id', () => {
    rememberPagePixels(3, 'blob:chapter-a-3', img('a'));
    expect(pagePixelsFor({ id: 3, raw: 'blob:chapter-b-3' })).toBe(null);
  });

  it('answers null for a page nobody has looked at', () => {
    expect(pagePixelsFor({ id: 9, raw: 'blob:r9' })).toBe(null);
    expect(pagePixelsFor(null)).toBe(null);
  });

  it('refuses an image that has not decoded, rather than caching nothing', () => {
    expect(rememberPagePixels(1, 'blob:r1', img('a', 0, 0))).toBe(null);
    expect(rememberPagePixels(1, 'blob:r1', null)).toBe(null);
    expect(rememberPagePixels(null, 'blob:r1', img('a'))).toBe(null);
    expect(rememberPagePixels(1, '', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });

  it('is a no-op where there is nothing to decode with', () => {
    globalThis.document = undefined;
    expect(rememberPagePixels(1, 'blob:r1', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });

  // A decode that throws - a tainted canvas, a browser refusing the allocation
  // - costs the fit and nothing else. Placement falls back.
  it('survives a decode that throws', () => {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => {
          throw new Error('no');
        },
      }),
    };
    expect(rememberPagePixels(1, 'blob:r1', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });
});

describe('the bound', () => {
  const p = (id) => ({ id, raw: `blob:r${id}` });
  const remember = (id) => rememberPagePixels(id, `blob:r${id}`, img(`i${id}`));

  // A 200-page chapter decoded page by page would hold gigabytes of ImageData
  // alive. Two, because the pager keeps the page being left and the one being
  // arrived at in play across a turn.
  it('holds two pages and drops the least recently used', () => {
    remember(1);
    remember(2);
    remember(3);
    expect(pagePixelsHeld()).toBe(2);
    expect(pagePixelsFor(p(1))).toBe(null);
    expect(pagePixelsFor(p(2))).not.toBe(null);
    expect(pagePixelsFor(p(3))).not.toBe(null);
  });

  // Least recently USED, not least recently added: a reader keeps a page alive.
  it('promotes a page on every hit', () => {
    remember(1);
    remember(2);
    pagePixelsFor(p(1));
    remember(3);
    expect(pagePixelsFor(p(1))).not.toBe(null);
    expect(pagePixelsFor(p(2))).toBe(null);
  });

  it('re-decoding a page replaces its entry rather than adding one', () => {
    remember(1);
    remember(1);
    expect(pagePixelsHeld()).toBe(1);
  });

  // The coarse event the src check cannot cover: a chapter closing gives the
  // memory back at once rather than at the next decode.
  it('gives everything back on demand, or one page at a time', () => {
    remember(1);
    remember(2);
    forgetPagePixels(1);
    expect(pagePixelsHeld()).toBe(1);
    expect(pagePixelsFor(p(1))).toBe(null);
    forgetPagePixels();
    expect(pagePixelsHeld()).toBe(0);
  });
});
