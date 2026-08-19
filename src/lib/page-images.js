// ===== How many of a chapter's page images are in memory at once =====
//
// A page's picture reaches the DOM as a blob URL, and a blob URL is not a
// pointer to a file: it is the file, held in the renderer's memory for as long
// as the URL is alive. `openChapter` used to mint one for every raw and every
// cleaned page in the chapter before it would show the first one, which made
// the cost of opening a chapter linear in its length and permanent for the
// session. A 200-page chapter at ~1.5 MB a page, raw and cleaned, is ~600 MB
// held from the moment it opens until it closes - dwarfing everything else the
// editor keeps (the box JSON for the same chapter is ~5 MB, and the undo
// history, which is delta-based, capped at five steps a page and already
// spilled to `logs/history.json`, is under one).
//
// So the pictures live in a window instead: the page on screen, two either
// side, and nothing else. Five pages is what makes a page turn instant in both
// directions - the neighbour is already decoded before the arrow is pressed -
// and it is the smallest number that does, which is the whole point. Everything
// outside the window is revoked, and the page objects have their `raw` and
// `cleaned` set back to null so nothing downstream is holding a URL that no
// longer resolves.
//
// Two things had to be true for that to be safe, and they are the two halves of
// this module's API:
//
//   The window is not the only reader. Chapter export, PSD export and batch
//   detect all walk every page in the chapter, and each of them needs one page's
//   picture at a time. `withPageImages` is that: it mints the page if the window
//   does not already hold it, pins it for the length of the job so a page turn
//   cannot revoke it mid-draw, and gives it back afterwards unless the window
//   wants it anyway.
//
//   Not every page's image is ours. A chapter imported from PSD carries blob
//   URLs minted by `psd.js` from layer data, with no file on disk behind them -
//   revoking one would destroy an image that cannot be re-read. Those pages are
//   left alone entirely: this module only ever touches a page it minted itself,
//   or an empty page it can mint from a filename under the chapter's own
//   directories.

import { fsx } from './fsx.js';

// The page on screen plus this many either side. See the note above on why it
// is small, and why it is not one.
export const RESIDENT_RADIUS = 2;

// Where this chapter's images live. Null until a chapter is open, and null is
// load-bearing: with no directories there is nothing this module can mint, so
// every entry point becomes a no-op and a PSD-imported document is untouched.
let dirs = null;

// pageId -> { page, raw, cleaned }. The page object is held so a release can
// null the fields it filled; the map is cleared whenever the chapter changes,
// so it never outlives the document it refers to.
const minted = new Map();

// pageId -> how many jobs are currently holding this page open. A page turn
// during a chapter export must not revoke the page the export is drawing.
const pins = new Map();

// pageId -> the mint in flight, so the canvas and a prefetch asking for the
// same page at the same moment read the file once.
const inflight = new Map();

// The window's own ids, so an unpinned job hands a page back to the window
// rather than revoking the one the user is looking at.
let resident = new Set();

// Which chapter the current mints belong to. A read that resolves after the
// chapter changed has produced a URL for a document nobody is looking at, and
// writing it onto a page object would put another chapter's picture on screen.
let epoch = 0;

const pinned = (id) => (pins.get(id) ?? 0) > 0;

// A page this module may act on: one with nothing on it yet (so a mint can fill
// it) or one it filled itself. A page carrying a URL it did not mint belongs to
// whoever made it.
const ours = (p) => p != null && (minted.has(p.id) || (!p.raw && !p.cleaned));

// Whether a raw page image exists at all - already in memory, or on disk under
// a name this module can resolve. The batch paths ask this instead of `p.raw`,
// which since the window exists only answers for the five pages nearest the
// one on screen.
//
// `dirs.raws`, not `dirs`: a chapter can be configured with a cleaned directory
// and no raws one, and the container being present says nothing about the half
// of it a raw would come from. Asking the wrong question there let a
// cleaned-only chapter answer "yes, there is a raw" for every page with a
// filename on it, and the batch paths went off to detect on pictures that could
// never be minted.
export const hasRawImage = (p) => !!(p?.raw || (dirs?.raws && p?.file));

// Every URL this module has minted for the chapter, the revoked ones included.
//
// An `<img>` decode outlives the eviction that revoked the URL it was loading:
// the load event still fires, and the canvas is then holding a measurement for
// a page whose fields no longer point at that URL, with no way to tell it from a
// picture nobody minted. This is that way. Bounded, because it is a debugging
// aid for a race rather than a ledger - a decode that lands this many mints
// later is not a case worth remembering, and forgetting one only returns the
// caller to the behaviour it had before.
const SRC_MEMORY = 256;
const mintedSrcs = new Set();
export const wasPageImage = (src) => !!src && mintedSrcs.has(src);

async function mintOne(dir, name) {
  if (!dir || !name) return null;
  try {
    const bytes = await fsx.readFile(await fsx.join(dir, name));
    const url = URL.createObjectURL(new Blob([bytes]));
    mintedSrcs.add(url);
    if (mintedSrcs.size > SRC_MEMORY) mintedSrcs.delete(mintedSrcs.values().next().value);
    return url;
  } catch {
    // A missing or unreadable file is a page that draws blank, exactly as it
    // did when `openChapter` swallowed the same failure. It is not a reason to
    // fail the page turn.
    return null;
  }
}

function revokeEntry(e) {
  if (e.raw) URL.revokeObjectURL(e.raw);
  if (e.cleaned) URL.revokeObjectURL(e.cleaned);
  if (e.page) {
    e.page.raw = null;
    e.page.cleaned = null;
  }
}

// Point the module at a chapter's image directories. Releases whatever the
// previous chapter had: page ids are per-document counters and collide freely
// across chapters, so nothing from the old one may survive into the new one's
// map.
export function setChapterImageDirs(rawsDir, cleanedDir) {
  releaseAllPageImages();
  dirs = { raws: rawsDir ?? null, cleaned: cleanedDir ?? null };
}

// Give every page image back. The chapter is closing, or being replaced.
export function releaseAllPageImages() {
  epoch++;
  for (const e of minted.values()) revokeEntry(e);
  minted.clear();
  pins.clear();
  inflight.clear();
  // `mintedSrcs` is deliberately NOT cleared: the decodes it exists to
  // recognise are exactly the ones still in flight over this call, and it is
  // bounded, so carrying it across a chapter change costs nothing and answers
  // for the case where the chapter itself is what evicted the picture.
  resident = new Set();
  dirs = null;
}

// Revoke one page's images, unless a job is holding it open.
export function releasePageImages(pageId) {
  if (pinned(pageId)) return;
  const e = minted.get(pageId);
  if (!e) return;
  minted.delete(pageId);
  revokeEntry(e);
}

// Make sure this page's images are in memory, minting them from disk if they
// are not. Resolves once `p.raw` and `p.cleaned` are whatever they are going to
// be - including both null, for a page whose files are missing.
export function ensurePageImages(p) {
  if (!dirs || !ours(p) || minted.has(p?.id)) return Promise.resolve(p);
  const running = inflight.get(p.id);
  if (running) return running;
  const mine = epoch;
  const job = (async () => {
    const [raw, cleaned] = await Promise.all([
      mintOne(dirs.raws, p.file),
      mintOne(dirs.cleaned, p.cleanedFile),
    ]);
    // The chapter changed while the file was being read, or another caller got
    // there first. Either way these URLs have no owner, and leaving them alive
    // is the leak this module exists to close.
    // Three ways this read is already stale by the time it lands, all of which
    // end the same way - the URLs have no owner and are dropped here rather
    // than left for someone else to notice:
    //
    //   the chapter changed under it (`epoch`);
    //   another caller minted the same page first (`minted`);
    //   the window moved on. That last one is the one a fast flick through a
    //   chapter produces by the handful: page 7 is prefetched from a window at
    //   page 5, the user jumps to page 20, and by the time the file is read
    //   page 7 is four windows behind. Without this it would be filed in
    //   `minted` anyway and sit there until some later page turn happened to
    //   sweep it - memory held by a page nobody asked for, which is the exact
    //   thing this module exists to stop. A pinned page is exempt: a batch job
    //   deliberately mints pages the window does not want.
    const wanted = resident.has(p.id) || pinned(p.id);
    if (mine !== epoch || minted.has(p.id) || !wanted) {
      if (raw) URL.revokeObjectURL(raw);
      if (cleaned) URL.revokeObjectURL(cleaned);
      return p;
    }
    minted.set(p.id, { page: p, raw, cleaned });
    p.raw = raw;
    p.cleaned = cleaned;
    return p;
  })().finally(() => {
    if (inflight.get(p.id) === job) inflight.delete(p.id);
  });
  inflight.set(p.id, job);
  return job;
}

// Hold the window over `index`, and let everything outside it go.
//
// Released before minted, deliberately: doing it the other way round makes the
// peak the old window plus the new one, which on a fast flick through a chapter
// is most of what the window was supposed to prevent. The page on screen is
// awaited; its neighbours are prefetch and are left to land when they land.
export function setResidentWindow(pages, index, radius = RESIDENT_RADIUS) {
  if (!dirs || !Array.isArray(pages) || !pages.length) return Promise.resolve();
  const lo = Math.max(0, index - radius);
  const hi = Math.min(pages.length - 1, index + radius);
  resident = new Set();
  for (let i = lo; i <= hi; i++) if (pages[i]) resident.add(pages[i].id);
  for (const id of [...minted.keys()]) if (!resident.has(id)) releasePageImages(id);
  const here = ensurePageImages(pages[index]);
  for (let i = lo; i <= hi; i++) if (i !== index) ensurePageImages(pages[i]);
  return here;
}

// Run `fn` with this page's images guaranteed present, then give them back
// unless the window wants them. The pin is what makes it safe for a job that
// takes seconds - a chapter export, a batch detect - to run while the user
// turns pages underneath it.
export async function withPageImages(p, fn) {
  if (!p) return fn();
  const id = p.id;
  // Which chapter this pin belongs to, for the same reason `ensurePageImages`
  // captures it: a job that takes seconds can outlive the chapter it started in.
  const mine = epoch;
  pins.set(id, (pins.get(id) ?? 0) + 1);
  try {
    await ensurePageImages(p);
    return await fn();
  } finally {
    // The chapter changed while `fn` was running. `releaseAllPageImages` has
    // already cleared every pin and revoked every image, so there is nothing of
    // this job's left to give back - and page ids are per-document counters that
    // collide freely across chapters, so the counter under this id is now
    // another chapter's page. Decrementing it there would hand back a pin this
    // job never took and revoke the picture a live export is drawing.
    //
    // An `if` around the body rather than an early `return`: a `return` in a
    // `finally` swallows whatever the `try` was throwing, and a failed export
    // has to keep its error.
    if (mine === epoch) {
      const n = (pins.get(id) ?? 1) - 1;
      if (n > 0) pins.set(id, n);
      else {
        pins.delete(id);
        if (!resident.has(id)) releasePageImages(id);
      }
    }
  }
}
