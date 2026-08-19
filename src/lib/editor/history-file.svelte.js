// ===== The history file =====
// Only the page on screen keeps its undo stack in memory. Every other page's
// lives here, in the chapter's own directory, so a chapter with two hundred
// pages costs five entries of RAM rather than a thousand - and so undo survives
// a relaunch.
//
//   <chapter-dir>/logs/history.json
//
// History is a convenience. Nothing in this module may be able to fail an edit,
// a save or a page turn: every disk error is reported once and swallowed, and
// nothing on the document's own save path ever waits on this one.
import { fsx } from '../fsx.js';
import { toast, DOC_SAVE_MS } from '../store.svelte.js';
import {
  takeStack,
  peekStack,
  loadStack,
  resetHistory,
  setHistorySink,
  setOffscreenSink,
  MAX_STEPS,
} from './history.svelte.js';

export const emptyDoc = () => ({ version: 1, pages: {} });

// A document of a version this build does not know is not repaired, it is
// replaced - a file whose shape we cannot read is worth less than the undo it
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
  // that understands it. Accepted knowingly - `version` is what is supposed to
  // guard a format change, and a downgrade keeping records it can neither apply
  // nor show would be the worse trade.
  if (!undo.length && !redo.length) delete next.pages[key];
  else next.pages[key] = { undo, redo };
  return next;
}

// One entry onto the stack of a page whose stack is not in memory. Everything
// the live stack does to a new entry, done to a stored one: appended to the
// undo side, capped at the same depth, and the redo tail forfeited - a page the
// user had undone their way back through and then left has no branch forward
// once something new lands on it, exactly as it would have had none if they
// had been standing on it at the time.
//
// A pure function over the document, like `mergeStack` beside it, because that
// is what makes the one thing worth testing here testable without a disk.
export function appendEntry(doc, pageId, entry) {
  const cur = stackFrom(doc, pageId);
  return mergeStack(doc, pageId, { undo: [...cur.undo, entry].slice(-MAX_STEPS), redo: [] });
}

export function stackFrom(doc, pageId) {
  if (!doc || doc.version !== 1 || !doc.pages) return { undo: [], redo: [] };
  const s = doc.pages[String(pageId)];
  return { undo: s?.undo ?? [], redo: s?.redo ?? [] };
}

// Records made while a read was in flight sit on top of whatever that read
// brought back: the disk half is older by definition - it was written before
// this session started - so it goes underneath, and the newer half's redo
// branch is the one that stands, because anything recorded has already
// forfeited a redo. An untouched stack takes the stored one whole, which is
// what every ordinary open does.
export function graft(stored, live) {
  if (!live?.undo?.length && !live?.redo?.length) return stored;
  return { undo: [...stored.undo, ...live.undo].slice(-MAX_STEPS), redo: live.redo };
}

let dir = null;
let doc = emptyDoc();
// Which visit to a chapter is in force. Bumped every time a chapter is
// installed or torn down, and captured by anything that has to survive an
// await - because `dir` cannot answer the question those callers are actually
// asking. Two visits to the SAME chapter are two sessions and share a path, so
// a close comparing paths found its own path still in place after a reopen had
// landed underneath it and tore the new session down: stack wiped, `dir`
// nulled, and every later write returning early for the rest of the session.
let session = 0;
let saveT = null;
let told = false;
// The id of the page whose stack is live in memory. Every write merges it in
// first, so an edit reaches disk on its own debounce rather than waiting for a
// page switch that may never come.
let livePageId = null;
// True once this chapter has a history file to keep up to date - one found when
// it was opened, or one this session has written. Until then an empty document
// is not worth writing: a chapter the user opened, looked at and left has to
// leave nothing behind to explain, and this is the whole reason `logs/` is
// created on the way to a write rather than on the way in. Once there IS a
// file, an empty document is written like any other, or a history the user has
// undone their way out of would never actually clear.
let onDisk = false;

setHistorySink((pageId) => {
  livePageId = pageId;
  schedule();
});

// The off-screen write. Deliberately the only path that can add to a page other
// than the live one, and deliberately unable to move `livePageId`: that is the
// difference between filing one entry against page B and handing page A's whole
// stack to page B's key, which is what happened while `record` had nowhere else
// to put such an entry.
//
// Refused in two cases, both of which mean "there is no stored stack for this",
// and both of which leave the entry on the live stack where it has always been:
// no chapter open (nothing to merge into, and `flushHistory` would drop it), and
// no live page claimed - the test seam and the moment before a chapter's first
// page is loaded, where the module cannot say which page the stack in memory
// belongs to and must not guess.
setOffscreenSink((pageId, entry) => {
  if (!dir || livePageId == null || pageId === livePageId) return false;
  doc = appendEntry(doc, pageId, entry);
  schedule();
  return true;
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
  onDisk = false;
  // Including the session, or this seam would not stand in for an open at all:
  // what an open installs is a new session, and that is the whole of what tells
  // a close still in flight that the chapter it was tearing down is gone.
  session++;
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
  // Whatever chapter is open has a document nobody else will write, and
  // everything below resets it. Flushed first, so a chapter left inside the
  // debounce window does not lose its records - a page turn is not the only
  // thing that can end a chapter, and this module cannot rely on the caller
  // having closed the old one first.
  //
  // Not conditional on the chapter changing: a route re-entry into the chapter
  // already open lands here too, and it would drop the last 800ms of records
  // along with any page merged into `doc` but not yet written.
  if (dir) await flushHistory();
  clearTimeout(saveT);
  dir = chapterDir;
  doc = emptyDoc();
  told = false;
  livePageId = pageId;
  onDisk = false;
  resetHistory();
  // The session this open installs, claimed in the same synchronous breath as
  // `dir` so that two opens are ordered by the assignment that installed them:
  // the slower read then finds a session that is no longer its own and drops
  // what it read, rather than landing its document and its page's stack on top
  // of the newer chapter's.
  const mine = ++session;
  if (!dir) return;
  let loaded = emptyDoc();
  // A file that is there is one to keep up to date from here on, whatever was
  // in it - a corrupt one included, since the next write is what repairs it.
  let found = false;
  try {
    // The argument rather than `dir`, which can change under every await below.
    const { file } = await pathsFor(chapterDir);
    if (await fsx.exists(file)) {
      found = true;
      const parsed = JSON.parse(await fsx.readTextFile(file));
      if (parsed && parsed.version === 1 && parsed.pages) loaded = parsed;
    }
  } catch {
    // A corrupt or unreadable history file costs undo and nothing else. It is
    // replaced by the next write.
    loaded = emptyDoc();
  }
  // Not `dir !== chapterDir`: a close and a reopen of this very chapter, both
  // landing while the read was in flight, leave the same path in place while
  // everything the read was for has been thrown away and replaced.
  if (session !== mine) return;
  // Nothing above waited on the user. A page turn, an off-screen record, an
  // edit on this very page - all of them can have happened while the disk was
  // answering, and all of them are NEWER than what it answered with. So the
  // read lands underneath what is already here rather than over the top of it:
  // assigning `doc = loaded` was how a page turned during a chapter's load lost
  // the entries it had made, and how the stack of the page the open was started
  // for arrived on top of the page the user had moved to.
  const pages = { ...loaded.pages };
  for (const [key, live] of Object.entries(doc.pages ?? {})) {
    pages[key] = graft(stackFrom(loaded, key), live);
  }
  doc = { version: 1, pages };
  if (found) onDisk = true;
  // The page on screen NOW, which is not necessarily the one this open was
  // called for. Whatever is in there is replayed optimistically: an entry that
  // no longer fits the document is reported and dropped by history.svelte.js at
  // the moment it is pressed, not weeded out here - validating a stack against
  // a document would cost a walk of every page to save a message nobody may
  // see.
  loadStack(livePageId, graft(stackFrom(doc, livePageId), peekStack()));
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

// The same interval the document's own autosave uses, and the same constant
// rather than the same number written twice - the two describe one document, and
// a history file written on a different beat than the pages it addresses is the
// one way they can reach disk disagreeing about how many edits have happened.
// Its own timer all the same: the two never wait on each other, so a page turn
// is not held up by this write, and this write failing is not the document's
// problem.
function schedule() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    flushHistory();
  }, DOC_SAVE_MS);
}

// Writes are serialised. A debounce that has just fired and a close that flushes
// on the way out can both be in flight, each carrying its own snapshot of the
// document - and without a queue the older snapshot can land last and take the
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
  // Nothing to say, and nothing on disk saying otherwise: a chapter opened,
  // read and left leaves no `logs/` directory and no file behind.
  if (!Object.keys(doc.pages ?? {}).length && !onDisk) return;
  const body = JSON.stringify(doc);
  // Claimed here rather than after the write lands, so a flush queued behind
  // this one cannot decide there is no file to clear while this one is still
  // creating it. A write that then fails is reported, and the next attempt
  // writes the same document again.
  onDisk = true;
  const done = writing.then(() => write(mine, body));
  writing = done;
  await done;
}

// Both halves of the write are arguments, so nothing here can be overtaken by a
// chapter opened underneath it: the path names the chapter this write was
// started for and the body is the document that chapter had at that moment.
// That is why there is no re-check of `dir` between the awaits - abandoning
// would not protect any state, it would only throw away a correct write. What
// the checks would have enforced is enforced at the source instead: every path
// that moves `dir` - openHistory and closeHistory - flushes first.
async function write(mine, body) {
  try {
    const { logs, file } = await pathsFor(mine);
    // Created on the way to the first write, never up front: a chapter nobody
    // has edited has no logs directory to explain.
    await fsx.mkdir(logs);
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
  // Bound before the await, like everything else here that survives one. This
  // is called fire-and-forget by closeChapter, so a chapter can be opened while
  // the flush is still in flight: `openHistory` would finish first and this
  // would then wipe its document, its stack and its `dir` - and with `dir` null
  // every later flush returns early, so that chapter's undo would silently
  // never reach disk again. A close whose chapter has already been replaced has
  // nothing left to tear down; the flush above has already written it.
  //
  // The session and not the path, because the case that matters most is the one
  // a path cannot see: closing a chapter and going straight back into it - the
  // reader's own back button - installs a NEW session on the same directory. On
  // `dir !== mine` that read as "nothing happened here" and the teardown ran
  // over the top of the session the user was now in.
  const mine = session;
  await flushHistory();
  if (session !== mine) return;
  // Torn down, and the session with it: an `openHistory` still waiting on its
  // read belongs to the chapter this just closed, and must not land its
  // document on a module that no longer has one.
  session++;
  dir = null;
  doc = emptyDoc();
  onDisk = false;
  resetHistory();
}
