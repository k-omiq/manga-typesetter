// ===== The page's own pixels, decoded once =====
//
// `balloon.js` recovers a bubble's interior from the page's pixels, and it is
// deliberately agnostic about where those pixels come from: it takes an
// `ImageData`-shaped object and the caller decides. This module is that
// decision for the app.
//
// The requirement that shapes everything here is that placement asks
// SYNCHRONOUSLY. A click lands a box, and the box's size comes out of the fit -
// so the fit has to be available in the same turn as the click, or placement
// would have to become async and every caller of `placeActiveAt` (the canvas,
// the tests, the history) would have to learn about promises for the sake of one
// optional refinement. Decoding a 2000x3000 page costs tens of milliseconds and
// allocates 24 MB; doing that inside a click handler is not acceptable, and
// doing it once per page and remembering the answer is.
//
// Which raster. The canvas draws `p.cleaned ?? p.raw` and so does every
// exporter, so that is what gets decoded here - the detector must run on the
// picture the user is looking at. It matters when the two differ, which is
// exactly the case a clean creates: the raw still has the Japanese in it, and
// the flood fill seeded inside a text block would meet glyphs the cleaned page
// no longer has. Fitting the cleaned raster is both the better answer (a wiped
// balloon is a clean interior with nothing in it to trip over) and the
// consistent one (the shape is stored in page coordinates and drawn over the
// same art).
//
// The bound is the other half. A 200-page chapter decoded page by page would
// hold five gigabytes of `ImageData` alive, which is not a cache, it is a leak
// with a lookup table in front of it. So the map holds two pages, evicting the
// least recently used - two rather than one because the pager keeps a page and
// the one being turned to alive across a turn, and rather than ten because the
// only thing a hit buys is a click that does not stall. A miss is not an error:
// the caller falls back to the detector's rectangle, which is what it did before
// this module existed.

// Two pages, most-recently-used. See the note above on why the number is small.
const MAX_PAGES = 2;

// pageId -> { src, image }. A `Map` because its iteration order is insertion
// order, which is what makes "delete the oldest key" one line and "promote on
// hit" two.
const cache = new Map();

// Whether this environment can decode anything at all. Node cannot, and every
// function here answers null there, which puts placement straight onto its
// fallback path - the same behaviour as a page nobody has looked at yet.
const canDecode = () => typeof document !== 'undefined';

// The raster the canvas draws, and the one a fit must be measured against. One
// expression, exported, so the cache and its callers cannot drift into two
// different opinions about which image a page *is*.
export const pageRasterSrc = (p) => p?.cleaned ?? p?.raw ?? null;

function promote(pageId, entry) {
  cache.delete(pageId);
  cache.set(pageId, entry);
}

// Decode an already-loaded `<img>` into an `ImageData` and remember it under
// this page's id. Called from the canvas's own `onload`, which is the one moment
// in the app where a decoded page raster exists and nothing has to be fetched.
//
// `src` is stored alongside the pixels rather than trusted to stay current:
// object URLs are minted per blob, so a page whose cleaned raster is replaced
// gets a new URL, and a lookup that quotes the new URL against an entry holding
// the old one misses instead of handing back the pixels of art that is no longer
// on screen. That is the whole invalidation story for a clean landing - there is
// no event to subscribe to and nothing to remember to call.
export function rememberPagePixels(pageId, src, image) {
  if (pageId == null || !src || !canDecode()) return null;
  const w = image?.naturalWidth | 0;
  const h = image?.naturalHeight | 0;
  if (!w || !h) return null;
  let data = null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    // A decode that fails - a tainted canvas, a browser refusing the allocation
    // - costs the fit and nothing else. The caller falls back.
    return null;
  }
  const entry = { src, image: data };
  promote(pageId, entry);
  while (cache.size > MAX_PAGES) cache.delete(cache.keys().next().value);
  return data;
}

// The pixels for a page, or null. Synchronous by construction: this either
// answers from the map or it does not answer at all.
//
// The `src` check is what makes a hit safe. A page id is only unique within a
// document - `loadProjectPages` keeps the ids a chapter was saved with - so the
// id alone would let one chapter's page 3 hand its pixels to another's.
export function pagePixelsFor(p) {
  const id = p?.id;
  if (id == null) return null;
  const entry = cache.get(id);
  if (!entry) return null;
  if (entry.src !== pageRasterSrc(p)) return null;
  promote(id, entry);
  return entry.image;
}

// Drop one page, or the lot. The src check above already covers a raster being
// replaced; this is for the coarser event - a chapter closing or another one
// opening - where the ids themselves stop meaning what they meant and the memory
// should go back immediately rather than at the next decode.
export function forgetPagePixels(pageId) {
  if (pageId == null) cache.clear();
  else cache.delete(pageId);
}

// For tests and for the settings-modal sort of introspection: how many pages are
// currently held. Deliberately not the pixels themselves.
export const pagePixelsHeld = () => cache.size;
