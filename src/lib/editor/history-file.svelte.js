// ===== The history file =====
// Only the page on screen keeps its undo stack in memory. Every other page's
// lives here, in the chapter's own directory, so a chapter with two hundred
// pages costs five entries of RAM rather than a thousand — and so undo survives
// a relaunch.
//
//   <chapter-dir>/logs/history.json
//
// History is a convenience. Nothing in this module may be able to fail an edit,
// a save or a page turn: every disk error is reported once and swallowed, and
// nothing on the document's own save path ever waits on this one.
import { fsx } from '../fsx.js';
import { toast } from '../store.svelte.js';
import { takeStack, peekStack, loadStack, resetHistory, setHistorySink } from './history.svelte.js';

export const emptyDoc = () => ({ version: 1, pages: {} });

// A document of a version this build does not know is not repaired, it is
// replaced — a file whose shape we cannot read is worth less than the undo it
// would cost to start over.
export function mergeStack(doc, pageId, stack) {
  const next =
    doc && doc.version === 1 && doc.pages ? { ...doc, pages: { ...doc.pages } } : emptyDoc();
  const key = String(pageId);
  const undo = stack?.undo ?? [];
  const redo = stack?.redo ?? [];
  // A page the user has undone their way out of leaves no key behind. Without
  // this the file only ever grows, one page at a time, for the life of the
  // chapter.
  //
  // The one thing this drops that a user might miss: `loadStack` discards
  // entries of a kind this build cannot apply, so a stack written by a NEWER
  // build comes back empty and is then deleted rather than left for the build
  // that understands it. Accepted knowingly — `version` is what is supposed to
  // guard a format change, and a downgrade keeping records it can neither apply
  // nor show would be the worse trade.
  if (!undo.length && !redo.length) delete next.pages[key];
  else next.pages[key] = { undo, redo };
  return next;
}

export function stackFrom(doc, pageId) {
  if (!doc || doc.version !== 1 || !doc.pages) return { undo: [], redo: [] };
  const s = doc.pages[String(pageId)];
  return { undo: s?.undo ?? [], redo: s?.redo ?? [] };
}

let dir = null;
let doc = emptyDoc();
let saveT = null;
let told = false;
// The id of the page whose stack is live in memory. Every write merges it in
// first, so an edit reaches disk on its own debounce rather than waiting for a
// page switch that may never come.
let livePageId = null;

setHistorySink((pageId) => {
  livePageId = pageId;
  schedule();
});

// Test seam. The app reaches this through openHistory, and this has to leave the
// module in the same state that would: a leftover live page id or a pending
// debounce from the previous chapter would file one chapter's entries into
// another's document.
export function __setDir(d) {
  clearTimeout(saveT);
  dir = d;
  doc = emptyDoc();
  told = false;
  livePageId = null;
}

// Takes the directory rather than reading `dir`, because every caller has
// already bound the chapter it is working for and `dir` can change under an
// await.
async function pathsFor(base) {
  const logs = await fsx.join(base, 'logs');
  return { logs, file: await fsx.join(logs, 'history.json') };
}

// Said once per chapter. A disk that refuses this file refuses it on every
// keystroke, and one lost convenience is not worth a toast a second.
function complainOnce(e) {
  if (told) return;
  told = true;
  toast(`Undo history is not being saved — ${e?.message ?? e}`);
}

export async function openHistory(chapterDir, pageId) {
  // The chapter being left has a document nobody else will write. Flushed
  // before anything is reset, so a chapter switched away from inside the
  // debounce window does not lose its records — a page turn is not the only
  // thing that can end a chapter, and this module cannot rely on the caller
  // having closed the old one first.
  if (dir && dir !== chapterDir) await flushHistory();
  clearTimeout(saveT);
  dir = chapterDir;
  doc = emptyDoc();
  told = false;
  livePageId = pageId;
  resetHistory();
  if (!dir) return;
  // Bound once, at entry, and read back into the module only at the end — two
  // chapters opened in quick succession would otherwise have the slower read
  // land its document, and its page's stack, on top of the newer one.
  const mine = dir;
  let loaded = emptyDoc();
  try {
    const { file } = await pathsFor(mine);
    if (await fsx.exists(file)) {
      const parsed = JSON.parse(await fsx.readTextFile(file));
      if (parsed && parsed.version === 1 && parsed.pages) loaded = parsed;
    }
  } catch {
    // A corrupt or unreadable history file costs undo and nothing else. It is
    // replaced by the next write.
    loaded = emptyDoc();
  }
  if (dir !== mine) return;
  doc = loaded;
  // Whatever is in there is replayed optimistically. An entry that no longer
  // fits the document is reported and dropped by history.svelte.js at the
  // moment it is pressed, not weeded out here — validating a stack against a
  // document would cost a walk of every page to save a message nobody may see.
  loadStack(pageId, stackFrom(doc, pageId));
}

export async function switchHistoryPage(fromPageId, toPageId) {
  // The caller need not know which page's stack is live; this module already
  // does. A caller that passes the wrong `from` would otherwise file one page's
  // entries under another page's key, where they would fail on the first press.
  const from = fromPageId ?? livePageId;
  if (from != null) doc = mergeStack(doc, from, takeStack());
  loadStack(toPageId, stackFrom(doc, toPageId));
  livePageId = toPageId;
  schedule();
}

// The same 800ms the document's own autosave uses, on its own timer. The two
// never wait on each other: a page turn is not held up by this write, and this
// write failing is not the document's problem.
function schedule() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    flushHistory();
  }, 800);
}

// Writes are serialised. A debounce that has just fired and a close that flushes
// on the way out can both be in flight, each carrying its own snapshot of the
// document — and without a queue the older snapshot can land last and take the
// newer one's records with it.
let writing = Promise.resolve();

export async function flushHistory() {
  clearTimeout(saveT);
  // Bound before the first await, and nothing below reads module state again.
  // Every await here is a window in which the user can close this chapter or
  // open another; read live, `dir` would name the chapter now in force and
  // `doc` would be its document, and the two halves of the write would come
  // from different chapters. saveOpenChapter and scanLibrary each document the
  // same trap at length.
  const mine = dir;
  if (!mine) return;
  // The live page's stack is only in memory until this point.
  if (livePageId != null) doc = mergeStack(doc, livePageId, peekStack());
  const body = JSON.stringify(doc);
  const done = writing.then(() => write(mine, body));
  writing = done;
  await done;
}

async function write(mine, body) {
  try {
    const { logs, file } = await pathsFor(mine);
    if (dir !== mine) return;
    // Created on the way to the first write, never up front: a chapter nobody
    // has edited has no logs directory to explain.
    await fsx.mkdir(logs);
    if (dir !== mine) return;
    await fsx.writeTextFileAtomic(file, body);
  } catch (e) {
    // Every failure ends here. This promise is the queue, so it must resolve
    // whatever the disk did, or one bad write would strand every later one.
    complainOnce(e);
  }
}

export async function closeHistory(pageId) {
  // Same as switchHistoryPage: the caller need not name the page. Guarding the
  // merge on the argument alone and then resetting regardless would silently
  // throw the live stack away.
  const pid = pageId ?? livePageId;
  if (pid != null) doc = mergeStack(doc, pid, takeStack());
  livePageId = null;
  await flushHistory();
  dir = null;
  doc = emptyDoc();
  resetHistory();
}
