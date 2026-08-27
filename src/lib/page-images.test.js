import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ===========================================================================
// The resident window, and the bitmap it holds open
// ===========================================================================
// `page-images.js` keeps five pages' pictures in memory and revokes the rest.
// The blob URL was always half the story: what a page turn actually waits on is
// the browser turning those bytes into a bitmap, so the window now pre-decodes
// what it mints and holds the decoded handle for as long as it holds the URL.
//
// That is a second thing to give back, and giving memory back at the moment the
// window moves - rather than whenever the GC gets to it - is this module's whole
// contract. So both halves are pinned here: the decode happens on the way in,
// and the handle is released on the way out.
//
// Everything below the module is a stub, because none of it is what is under
// test: `fsx` answers bytes, `URL` records what it minted and revoked, and
// `Image` is the smallest surface `predecode` touches.
vi.mock('./fsx.js', () => ({
  fsx: {
    join: async (...p) => p.join('/'),
    readFile: async (path) => {
      if (path.includes('missing')) throw new Error('ENOENT');
      return new Uint8Array([1, 2, 3]);
    },
  },
}));

const {
  setChapterImageDirs,
  setResidentWindow,
  releaseAllPageImages,
  releasePageImages,
} = await import('./page-images.js');

const { rememberPagePixels, pagePixelsHeld, forgetPagePixels } = await import('./page-pixels.js');

const real = {
  createObjectURL: globalThis.URL.createObjectURL,
  revokeObjectURL: globalThis.URL.revokeObjectURL,
  Image: globalThis.Image,
};

let minted;
let revoked;
let images;

// A stand-in for the element `predecode` builds. `decode` resolves on a
// microtask, which is exactly the shape the real one has and enough to catch a
// mint that files its URL before the bitmap is ready.
class FakeImage {
  #src = null;
  constructor() {
    this.decoding = null;
    // The URL this handle was built for, kept separately because `src` is what
    // the release clears - and a test about the release still has to be able to
    // say which page the handle belonged to.
    this.url = null;
    this.decoded = 0;
    this.releasedFrom = null;
    images.push(this);
  }
  get src() {
    return this.#src;
  }
  set src(v) {
    this.#src = v;
    if (v) this.url = v;
  }
  async decode() {
    this.decoded++;
  }
  removeAttribute(name) {
    this.releasedFrom = name;
    this.#src = null;
  }
}

const pages = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, file: `p${i + 1}.png`, raw: null, cleaned: null }));

beforeEach(() => {
  minted = [];
  revoked = [];
  images = [];
  let seq = 0;
  globalThis.URL.createObjectURL = () => {
    const url = `blob:page-${++seq}`;
    minted.push(url);
    return url;
  };
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
  globalThis.Image = FakeImage;
});

afterEach(() => {
  releaseAllPageImages();
  globalThis.URL.createObjectURL = real.createObjectURL;
  globalThis.URL.revokeObjectURL = real.revokeObjectURL;
  globalThis.Image = real.Image;
});

describe('pre-decoding what the window mints', () => {
  // The point of the window is that a page turn finds its neighbour already
  // there. "There" used to mean "a URL exists", and the decode - the expensive
  // half - still happened on the turn, on the main thread, once per `<img>`
  // pointing at it. Now it happens here, ahead of time, off the critical path.
  it('decodes every page it mints, before it hands the URL over', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(3);
    await setResidentWindow(ps, 0);
    expect(images.length).toBe(3);
    for (const img of images) {
      expect(img.decoding).toBe('async');
      expect(img.decoded).toBe(1);
      expect(minted).toContain(img.url);
    }
    expect(ps[0].raw).toBe(images[0].src);
  });

  // An optimisation is not allowed to be a failure mode. An environment with no
  // `Image` at all - node, an older engine - leaves the caller with exactly the
  // behaviour it had before any of this existed.
  it('mints as it always did where there is nothing to decode with', async () => {
    globalThis.Image = undefined;
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(1);
    await setResidentWindow(ps, 0);
    expect(ps[0].raw).toBe(minted[0]);
  });

  it('holds no handle for a page whose file will not read', async () => {
    setChapterImageDirs('/ch/missing', null);
    const ps = pages(1);
    await setResidentWindow(ps, 0);
    expect(ps[0].raw).toBe(null);
    expect(images.length).toBe(0);
  });
});

describe('giving the bitmap back', () => {
  // The URL and the handle are one thing to this module: revoking the first and
  // keeping the second is a bitmap the renderer has no reason to release, which
  // is the leak the window exists to close, one page at a time.
  it('releases the decoded handle with the URL it was decoded from', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(8);
    await setResidentWindow(ps, 0); // pages 1-3
    const held = images.slice();
    expect(held.length).toBe(3);
    await setResidentWindow(ps, 7); // pages 6-8, so 1-3 all go
    for (const img of held) {
      expect(img.releasedFrom).toBe('src');
      expect(revoked).toContain(img.url);
    }
  });

  it('releases it when one page is dropped on its own', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(1);
    await setResidentWindow(ps, 0);
    const img = images[0];
    releasePageImages(ps[0].id);
    expect(img.releasedFrom).toBe('src');
    expect(revoked).toEqual([minted[0]]);
    expect(ps[0].raw).toBe(null);
  });

  it('releases every one of them when the chapter closes', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(3);
    await setResidentWindow(ps, 1);
    const held = images.slice();
    releaseAllPageImages();
    expect(held.length).toBe(3);
    for (const img of held) expect(img.releasedFrom).toBe('src');
    expect(revoked.length).toBe(3);
  });

  // A page read for a window that has since moved on has no owner: its URL was
  // never filed, and neither was its handle. Both are dropped here rather than
  // left for a later page turn to sweep.
  it('drops the handle of a mint nobody wants any more', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(9);
    const prefetching = setResidentWindow(ps, 0);
    // The window moves before the reads land. Pages 1-3 were being minted for a
    // window that is now pages 7-9.
    const next = setResidentWindow(ps, 8);
    await Promise.all([prefetching, next]);
    const orphans = images.filter((i) => !ps.some((p) => p.raw === i.url));
    expect(orphans.length).toBeGreaterThan(0);
    for (const img of orphans) expect(img.releasedFrom).toBe('src');
  });
});

// ===========================================================================
// ...and the pixels that were decoded from it
// ===========================================================================
// `page-pixels.js` holds an `ImageData` per page - four bytes a pixel, so a
// print page is ~24MB - under bounds of its own: eight pages, or 256MB,
// whichever binds first. Those bounds know nothing about the window this module
// keeps, and that is the whole problem: they are four times bigger than it, so
// the pixels of pages whose pictures were revoked long ago went on occupying a
// quarter of a gigabyte until eight later pages happened to push them out.
//
// Nothing is lost by dropping them with the pictures. `revokeEntry` has just
// nulled the page's `raw`/`cleaned`, and a re-mint produces a NEW blob URL, so
// the cache's own src check could never hand that entry back again: every entry
// for a released page is unreachable by construction.
describe('the pixels go back with the picture', () => {
  const realDocument = globalThis.document;
  // The smallest surface `rememberPagePixels` touches - it is the bookkeeping
  // under test here, not the decode.
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    }),
  });
  const decoded = { naturalWidth: 4, naturalHeight: 4 };

  beforeEach(() => {
    globalThis.document = { createElement: canvas };
    forgetPagePixels();
  });
  afterEach(() => {
    forgetPagePixels();
    globalThis.document = realDocument;
  });

  it('forgets one page’s pixels when its images are released', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(3);
    await setResidentWindow(ps, 0);
    for (const p of ps) rememberPagePixels(p.id, p.raw, decoded);
    expect(pagePixelsHeld()).toBe(3);
    releasePageImages(ps[0].id);
    expect(pagePixelsHeld()).toBe(2);
  });

  // The window sliding is the same event one level up, and it is the one that
  // happens on every page turn.
  it('forgets them as the window slides', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(9);
    await setResidentWindow(ps, 0); // pages 1-3
    for (const p of ps) if (p.raw) rememberPagePixels(p.id, p.raw, decoded);
    expect(pagePixelsHeld()).toBe(3);
    await setResidentWindow(ps, 8); // pages 7-9, so 1-3 all go
    expect(pagePixelsHeld()).toBe(0);
  });

  // The path a chapter SWITCH takes. It never goes through `closeChapter`, so
  // this was the one route on which a whole chapter's pixels - up to the cache's
  // entire budget - stayed held for the rest of the session, filed under page
  // ids the next chapter reuses from one.
  it('forgets all of them when the chapter is replaced', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(3);
    await setResidentWindow(ps, 1);
    for (const p of ps) rememberPagePixels(p.id, p.raw, decoded);
    expect(pagePixelsHeld()).toBe(3);
    setChapterImageDirs('/other/raws', null);
    expect(pagePixelsHeld()).toBe(0);
  });

  // A pin is what a chapter export holds while the user turns pages underneath
  // it, and it covers the pixels for the same reason it covers the URL.
  it('keeps them while a job is holding the page open', async () => {
    const { withPageImages } = await import('./page-images.js');
    setChapterImageDirs('/ch/raws', null);
    const ps = pages(9);
    await setResidentWindow(ps, 0);
    await withPageImages(ps[0], async () => {
      rememberPagePixels(ps[0].id, ps[0].raw, decoded);
      await setResidentWindow(ps, 8);
      expect(pagePixelsHeld()).toBe(1);
    });
    expect(pagePixelsHeld()).toBe(0);
  });
});
